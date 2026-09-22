-- search.query runs four steps in order and returns the rows of the first step that matches
-- anything. Later steps never add rows to an earlier step's results. Pass lim => NULL for every
-- matching row (search.facets does this).
CREATE OR REPLACE FUNCTION search.query(q text, filters jsonb DEFAULT '{}', lim int DEFAULT 50)
RETURNS TABLE (id text, step text, pos int)
LANGUAGE plpgsql STABLE
SET search_path = search, public, extensions
SET pg_trgm.word_similarity_threshold = 0.5
AS $$
DECLARE
  tokens text[]  := search.tokens(q);
  query  text    := array_to_string(tokens, ' ');
  code_q text    := ltrim(query, '0');
  f      jsonb   := coalesce(filters, '{}');
  n      int     := CASE WHEN lim IS NULL THEN NULL ELSE least(greatest(lim, 1), 1000) END;
  kept   text[];
  words  tsquery;
  prefix tsquery;
BEGIN
  IF query = '' THEN
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
  IF numnode(words) > 0 THEN
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

  -- Stop words are dropped, since prefix_vector keeps them. Prefixes of one or two letters match
  -- too much to be useful.
  SELECT array_agg(t) INTO kept FROM unnest(tokens) AS t
  WHERE ts_lexize('english_stem', t) IS DISTINCT FROM '{}';
  IF (SELECT min(length(t)) FROM unnest(kept) AS t) >= 3 THEN
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

  RETURN QUERY
    SELECT r.id, 'typo'::text, (row_number() OVER (ORDER BY r.sim DESC, r.rank DESC NULLS LAST, r.id))::int
    FROM (
      SELECT d.id,
             greatest(word_similarity(query, d.name), word_similarity(query, coalesce(d.other_names, ''))) AS sim,
             d.rank
      FROM search.documents d
      WHERE (query <% d.name OR query <% d.other_names) AND d.facets @> f
      ORDER BY sim DESC, d.rank DESC NULLS LAST, d.id
      LIMIT n
    ) r
    ORDER BY 3;
END
$$;

-- Typeahead. Under four characters the word step is easily taken over by rare words, so short
-- input is matched against the list of distinct names instead.
CREATE OR REPLACE FUNCTION search.suggest(q text, lim int DEFAULT 8)
RETURNS TABLE (name text, id text, doc_count int)
LANGUAGE plpgsql STABLE
SET search_path = search, public, extensions
AS $$
DECLARE
  query text := array_to_string(search.tokens(q), ' ');
  n     int  := least(greatest(coalesce(lim, 8), 1), 50);
BEGIN
  IF query = '' THEN
    RETURN;
  END IF;

  IF length(query) < 4 THEN
    RETURN QUERY
      SELECT s.name, s.sample_id, s.doc_count FROM search.names s
      WHERE s.name_key LIKE query || '%'
      ORDER BY s.doc_count DESC, s.name_key
      LIMIT n;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.name, h.id, s.doc_count
    FROM (
      SELECT DISTINCT ON (d.name_key) d.name_key, r.id, r.pos
      FROM search.query(q, '{}', 80) r
      JOIN search.documents d ON d.id = r.id
      ORDER BY d.name_key, r.pos
    ) h
    JOIN search.names s ON s.name_key = h.name_key
    ORDER BY h.pos
    LIMIT n;
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
    GROUP BY kv.key, kv.value
  ) c
  WHERE c.n <= per_facet
  ORDER BY c.facet, c.doc_count DESC, c.value
$$;

CREATE OR REPLACE FUNCTION search.refresh()
RETURNS void
LANGUAGE plpgsql
SET search_path = search, public, extensions
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY search.documents;
  REFRESH MATERIALIZED VIEW CONCURRENTLY search.names;
END
$$;
