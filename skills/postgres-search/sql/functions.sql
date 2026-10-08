-- search.query runs four steps in order and returns the rows of the first step that matches
-- anything. Later steps never add rows to an earlier step's results. Pass lim => NULL for every
-- matching row (search.facets does this). A word that no name uses, when the most common word
-- that starts with it has another stem, is still being typed. The word step is skipped for it:
-- its stem would match other words ("monke" finds monk) before the prefix step could finish it.
-- When the completion has the same stem ("imagin", "imagine"), the word step already finds it.
CREATE OR REPLACE FUNCTION search.query(q text, filters jsonb DEFAULT '{}', lim int DEFAULT 50)
RETURNS TABLE (id text, step text, pos int)
LANGUAGE plpgsql STABLE
SET search_path = search, public, extensions
SET pg_trgm.word_similarity_threshold = 0.5
-- A cached generic plan scans the whole facets index when filters is empty.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  -- Long input builds huge queries, and a very long word pushes the typo step off its index.
  -- No real search needs more than 256 characters or 32 words.
  tokens text[]  := (search.tokens(left(q, 256)))[1:32];
  -- ts_lexize returns an empty array for stop words, which mean nothing on their own.
  kept   text[]  := ARRAY(SELECT t FROM unnest(tokens) AS t WHERE ts_lexize('english_stem', t) IS DISTINCT FROM '{}');
  query  text    := array_to_string(tokens, ' ');
  typo_q text    := array_to_string(kept, ' ');
  code_q text    := ltrim(query, '0');
  f      jsonb   := coalesce(filters, '{}');
  n      int     := CASE WHEN lim IS NULL THEN NULL ELSE least(greatest(lim, 1), 1000) END;
  words  tsquery;
  prefix tsquery;
BEGIN
  IF cardinality(kept) = 0 THEN
    RETURN;
  END IF;

  IF query ~ '^[0-9]+$' AND length(code_q) >= 4 THEN
    RETURN QUERY
      SELECT r.id, 'code'::text, (row_number() OVER (ORDER BY r.code, r.id))::int
      FROM (
        SELECT d.id, d.code FROM search.documents d
        WHERE d.code LIKE code_q || '%' AND d.facets @> f
        ORDER BY d.code, d.id
        LIMIT n
      ) r
      ORDER BY 3;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  words := plainto_tsquery('english', query);
  IF numnode(words) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(kept) AS t
    WHERE length(t) >= 3
      AND NOT EXISTS (SELECT 1 FROM search.words w WHERE w.word = t)
      AND (
        SELECT w.stem FROM search.words w
        WHERE w.word ~>=~ t AND w.word ~<~ (t || chr(1114111))
        ORDER BY w.match_count DESC, w.word LIMIT 1
      ) <> coalesce((ts_lexize('english_stem', t))[1], t)
  ) THEN
    RETURN QUERY
      SELECT r.id, 'word'::text, (row_number() OVER (ORDER BY r.exact DESC, r.rank DESC NULLS LAST, r.id))::int
      FROM (
        SELECT d.id, d.name_key = query AS exact, d.rank FROM search.documents d
        WHERE d.search_vector @@ words AND d.facets @> f
        ORDER BY exact DESC, d.rank DESC NULLS LAST, d.id
        LIMIT n
      ) r
      ORDER BY 3;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- prefix_vector keeps stop words, so only kept words go in. At least one word needs three or
  -- more letters; alone, shorter prefixes match too much to be useful.
  IF (SELECT max(length(t)) FROM unnest(kept) AS t) >= 3 THEN
    prefix := to_tsquery('simple', array_to_string(ARRAY(SELECT t || ':*' FROM unnest(kept) AS t), ' & '));
  END IF;

  IF numnode(prefix) > 0 THEN
    RETURN QUERY
      SELECT r.id, 'prefix'::text, (row_number() OVER (ORDER BY r.exact DESC, r.rank DESC NULLS LAST, r.id))::int
      FROM (
        SELECT d.id, d.name_key = query AS exact, d.rank FROM search.documents d
        WHERE d.prefix_vector @@ prefix AND d.facets @> f
        ORDER BY exact DESC, d.rank DESC NULLS LAST, d.id
        LIMIT n
      ) r
      ORDER BY 3;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Stop words would lower the similarity of every name, so the typo step leaves them out.
  RETURN QUERY
    SELECT r.id, 'typo'::text, (row_number() OVER (ORDER BY r.sim DESC, r.rank DESC NULLS LAST, r.id))::int
    FROM (
      SELECT d.id,
             greatest(word_similarity(typo_q, d.name), word_similarity(typo_q, coalesce(d.other_names, ''))) AS sim,
             d.rank
      FROM search.documents d
      WHERE (typo_q <% d.name OR typo_q <% d.other_names) AND d.facets @> f
      ORDER BY sim DESC, d.rank DESC NULLS LAST, d.id
      LIMIT n
    ) r
    ORDER BY 3;
END
$$;

-- One row per group (group_key, or the name when group_key is null), like Algolia's distinct
-- setting. It collapses the first 1000 matches, so a group that fills all of them hides the rest.
CREATE OR REPLACE FUNCTION search.query_distinct(q text, filters jsonb DEFAULT '{}', lim int DEFAULT 50)
RETURNS TABLE (id text, step text, pos int)
LANGUAGE sql STABLE
SET search_path = search, public, extensions
AS $$
  SELECT g.id, g.step, (row_number() OVER (ORDER BY g.pos))::int
  FROM (
    SELECT DISTINCT ON (coalesce(d.group_key, d.name_key)) r.id, r.step, r.pos
    FROM search.query(q, filters, 1000) r
    JOIN search.documents d ON d.id = r.id
    ORDER BY coalesce(d.group_key, d.name_key), r.pos
  ) g
  ORDER BY g.pos
  LIMIT least(greatest(coalesce(lim, 50), 1), 1000)
$$;

-- Typeahead completes names, so it lists names that start with the input first. Typed input is
-- usually a partial word, and the word step would answer it with any rare whole word or
-- abbreviation that happens to match ("pean" finds "Peans" before "Peanut Butter"). Only when
-- too few names start with the input does search.query fill the rest.
CREATE OR REPLACE FUNCTION search.suggest(q text, lim int DEFAULT 8)
RETURNS TABLE (name text, id text, doc_count int)
LANGUAGE plpgsql STABLE
SET search_path = search, public, extensions
-- A cached generic plan cannot use the prefix range on search.names and scans all of it.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  words  text[] := search.tokens(left(q, 256));
  query  text   := array_to_string(words, ' ');
  n      int    := least(greatest(coalesce(lim, 8), 1), 50);
  listed int;
BEGIN
  IF query = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.name, s.sample_id, s.doc_count FROM search.names s
    WHERE s.name_key LIKE query || '%'
    ORDER BY s.doc_count DESC, s.name_key
    LIMIT n;
  GET DIAGNOSTICS listed = ROW_COUNT;
  -- When every word is under four characters the fill would run the typo step on a few trigrams,
  -- which is slow and matches unrelated names ("cng" finds ground beef and ketchup).
  IF listed >= n OR (SELECT max(length(w)) FROM unnest(words) AS w) < 4 THEN
    RETURN;
  END IF;

  -- Fewer than n rows means every name starting with the input is already listed. Many rows can
  -- share a name, so a wide window is collapsed to distinct names.
  RETURN QUERY
    SELECT s.name, h.id, s.doc_count
    FROM (
      SELECT DISTINCT ON (d.name_key) d.name_key, r.id, r.pos
      FROM search.query(q, '{}', 1000) r
      JOIN search.documents d ON d.id = r.id
      WHERE d.name_key NOT LIKE query || '%'
      ORDER BY d.name_key, r.pos
    ) h
    JOIN search.names s ON s.name_key = h.name_key
    ORDER BY h.pos
    LIMIT n - listed;
END
$$;

-- Facet counts over every row search.query matched, never a separate text match.
CREATE OR REPLACE FUNCTION search.facets(q text, filters jsonb DEFAULT '{}', per_facet int DEFAULT 20)
RETURNS TABLE (facet text, value text, doc_count bigint)
LANGUAGE sql STABLE
SET search_path = search, public, extensions
AS $$
  SELECT c.facet, c.value, c.doc_count
  FROM (
    SELECT kv.key AS facet, kv.value, count(*) AS doc_count,
           row_number() OVER (PARTITION BY kv.key ORDER BY count(*) DESC, kv.value) AS n
    FROM search.query(q, filters, NULL) r
    JOIN search.documents d ON d.id = r.id
    CROSS JOIN LATERAL jsonb_each_text(d.facets) AS kv
    WHERE kv.value IS NOT NULL
    GROUP BY kv.key, kv.value
  ) c
  WHERE c.n <= least(greatest(coalesce(per_facet, 20), 1), 1000)
  ORDER BY c.facet, c.doc_count DESC, c.value
$$;

-- Every string one edit from w: a letter deleted, two neighbors swapped, a letter changed, or one
-- added (Damerau, 1964). About 54 times the length of w, so a lookup costs that many index probes.
CREATE OR REPLACE FUNCTION search.edits1(w text)
RETURNS SETOF text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT DISTINCT e FROM (
    SELECT left(w, i) || substr(w, i + 2) FROM generate_series(0, length(w) - 1) AS i
    UNION ALL
    SELECT left(w, i) || substr(w, i + 2, 1) || substr(w, i + 1, 1) || substr(w, i + 3)
    FROM generate_series(0, length(w) - 2) AS i
    UNION ALL
    SELECT left(w, i) || c || substr(w, i + 2)
    FROM generate_series(0, length(w) - 1) AS i, unnest(string_to_array('abcdefghijklmnopqrstuvwxyz', NULL)) AS c
    UNION ALL
    SELECT left(w, i) || c || substr(w, i + 1)
    FROM generate_series(0, length(w)) AS i, unnest(string_to_array('abcdefghijklmnopqrstuvwxyz', NULL)) AS c
  ) x(e)
  WHERE e <> w
$$;

-- Words that products use and that are spelled close to each query word, for the Jev step's
-- spelling question; this only finds them. Words one edit away come first, most found first, then
-- words with trigram similarity of 0.3 or more, closest first. Counts are what the word step finds,
-- so "hersheys" counts the Hershey products and is not offered "hershey". An alternative is offered
-- only if its stem differs from the typed word's and the search finds it in more products than
-- both the typed word and the most common word, of another stem, that starts with the typed word.
-- A word still being typed (see search.query) gets none, so the prefix step answers ("strawb" finds
-- strawberries, and is not offered "straw"), unless an alternative is found in finish_ratio times
-- as many products as the most common word that starts with it. Then the alternatives come with
-- that word, marked completes, so Jev can weigh "health" against HEALHTY for "healht". Words
-- under four letters, words with digits and stop words get none.
DROP FUNCTION IF EXISTS search.similar_words(text, int);
CREATE OR REPLACE FUNCTION search.similar_words(q text, per_word int DEFAULT 8, finish_ratio int DEFAULT 100)
RETURNS TABLE (pos int, word text, word_matches int, alternative text, alternative_matches int, completes boolean)
LANGUAGE sql STABLE
SET search_path = search, public, extensions
SET pg_trgm.similarity_threshold = 0.3
AS $$
  WITH typed AS (
    SELECT t.pos::int AS pos, t.word, coalesce((ts_lexize('english_stem', t.word))[1], t.word) AS stem
    FROM unnest((search.tokens(left(q, 256)))[1:32]) WITH ORDINALITY AS t(word, pos)
    WHERE length(t.word) >= 4 AND t.word !~ '[0-9]' AND ts_lexize('english_stem', t.word) IS DISTINCT FROM '{}'
  ), counted AS (
    SELECT ty.*, coalesce((SELECT max(s.match_count) FROM search.words s WHERE s.stem = ty.stem), 0) AS matches,
           ARRAY(SELECT search.edits1(ty.word)) AS edits,
           cs.completion_stems, cs.completion_counts, cs.completion_words,
           coalesce(cs.completion_stems[1] <> ty.stem, false)
             AND NOT EXISTS (SELECT 1 FROM search.words s WHERE s.word = ty.word) AS unfinished
    FROM typed ty
    -- The two most common stems among words that start with the typed word, with their counts and
    -- most used word. The byte range is the prefix match that the index on word text_pattern_ops
    -- can serve.
    CROSS JOIN LATERAL (
      SELECT array_agg(x.stem ORDER BY x.n DESC, x.stem) AS completion_stems,
             array_agg(x.n ORDER BY x.n DESC, x.stem) AS completion_counts,
             array_agg(x.w ORDER BY x.n DESC, x.stem) AS completion_words
      FROM (
        SELECT s.stem, max(s.match_count) AS n, (array_agg(s.word ORDER BY s.doc_count DESC, s.word))[1] AS w
        FROM search.words s
        WHERE s.word ~>=~ ty.word AND s.word ~<~ (ty.word || chr(1114111)) AND s.word <> ty.word
        GROUP BY s.stem ORDER BY n DESC, s.stem LIMIT 2
      ) x
    ) cs
  ), offered AS (
    SELECT c.pos, c.word, c.matches, x.alternative, x.alternative_matches,
           row_number() OVER (PARTITION BY c.pos ORDER BY x.kind, x.sim DESC, x.alternative_matches DESC, x.alternative) AS n,
           max(x.alternative_matches) OVER (PARTITION BY c.pos) AS best
    FROM counted c
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (y.alternative) y.*
      FROM (
        SELECT s.word AS alternative, s.match_count AS alternative_matches, 1 AS kind, 0::real AS sim
        FROM search.words s
        -- The edits are built once per word, and = ANY of them probes the index.
        WHERE s.word = ANY (c.edits)
          AND s.stem <> c.stem AND s.match_count > c.matches
          AND s.match_count > CASE WHEN s.stem = c.completion_stems[1] THEN coalesce(c.completion_counts[2], 0)
                                   ELSE coalesce(c.completion_counts[1], 0) END
        UNION ALL
        SELECT t.word, t.match_count, 2, t.sim
        FROM (
          SELECT s.word, s.match_count, similarity(s.word, c.word) AS sim
          FROM search.words s
          WHERE s.word % c.word
            AND s.stem <> c.stem AND s.match_count > c.matches AND s.word NOT LIKE c.word || '%'
            AND s.match_count > CASE WHEN s.stem = c.completion_stems[1] THEN coalesce(c.completion_counts[2], 0)
                                     ELSE coalesce(c.completion_counts[1], 0) END
          ORDER BY sim DESC, s.match_count DESC, s.word
          LIMIT least(greatest(coalesce(per_word, 8), 1), 50)
        ) t
      ) y
      ORDER BY y.alternative, y.kind
    ) x
  ), kept AS (
    SELECT o.pos, o.word, o.matches, o.alternative, o.alternative_matches, false AS completes, o.n
    FROM offered o JOIN counted c ON c.pos = o.pos
    WHERE o.n <= least(greatest(coalesce(per_word, 8), 1), 50)
      AND (NOT c.unfinished OR (o.best >= greatest(coalesce(finish_ratio, 100), 1)::bigint * c.completion_counts[1]
                                AND o.alternative <> c.completion_words[1]))
    UNION ALL
    SELECT c.pos, c.word, c.matches, c.completion_words[1], c.completion_counts[1], true, 0
    FROM counted c
    WHERE c.unfinished
      AND EXISTS (SELECT 1 FROM offered o WHERE o.pos = c.pos
                  AND o.best >= greatest(coalesce(finish_ratio, 100), 1)::bigint * c.completion_counts[1])
  )
  SELECT k.pos, k.word, k.matches, k.alternative, k.alternative_matches, k.completes
  FROM kept k
  ORDER BY k.pos, k.n
$$;

CREATE OR REPLACE FUNCTION search.refresh()
RETURNS void
LANGUAGE plpgsql
SET search_path = search, public, extensions
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY search.documents;
  REFRESH MATERIALIZED VIEW CONCURRENTLY search.names;
  REFRESH MATERIALIZED VIEW CONCURRENTLY search.words;
END
$$;
