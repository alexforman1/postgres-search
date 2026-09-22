-- Run after creating the view search.source (see docs/your-data.md).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS search;

-- Lower-cased words, split on anything that is not a letter or digit.
CREATE OR REPLACE FUNCTION search.tokens(q text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(string_to_array(nullif(btrim(regexp_replace(lower(coalesce(q, '')), '[^[:alnum:]]+', ' ', 'g')), ''), ' '), '{}')
$$;

CREATE MATERIALIZED VIEW IF NOT EXISTS search.documents AS
SELECT
  s.id::text                                         AS id,
  s.name::text                                       AS name,
  array_to_string(search.tokens(s.name), ' ')        AS name_key,
  s.other_names::text                                AS other_names,
  s.group_key::text                                  AS group_key,
  nullif(ltrim(s.code::text, '0'), '')               AS code,
  coalesce(s.facets::jsonb, '{}')                    AS facets,
  s.rank::real                                       AS rank,
  -- search_vector stems words so "cookies" matches "cookie". prefix_vector does not, because a
  -- partial word such as "chocolat" is longer than the stem of "chocolate" ("chocol").
  to_tsvector('english', w.words) AS search_vector,
  to_tsvector('simple', w.words)  AS prefix_vector
FROM search.source s
-- Both vectors index the words search.tokens finds, the same split every query gets. Postgres's
-- own parser would keep "Lemon/Lime" whole as a file path and "Cran.Apple" as a host name.
CROSS JOIN LATERAL (
  SELECT array_to_string(search.tokens(coalesce(s.name, '') || ' ' || coalesce(s.other_names, '')), ' ') AS words
) w;

CREATE UNIQUE INDEX IF NOT EXISTS documents_id ON search.documents (id);
CREATE INDEX IF NOT EXISTS documents_search_vector ON search.documents USING gin (search_vector);
CREATE INDEX IF NOT EXISTS documents_prefix_vector ON search.documents USING gin (prefix_vector);
CREATE INDEX IF NOT EXISTS documents_name_trgm ON search.documents USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_other_names_trgm ON search.documents USING gin (other_names gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_facets ON search.documents USING gin (facets jsonb_path_ops);
CREATE INDEX IF NOT EXISTS documents_code ON search.documents (code text_pattern_ops);

-- One row per distinct name, for typeahead: search.suggest completes names from it.
CREATE MATERIALIZED VIEW IF NOT EXISTS search.names AS
SELECT
  d.name_key,
  mode() WITHIN GROUP (ORDER BY d.name)                  AS name,
  count(*)::int                                          AS doc_count,
  (array_agg(d.id ORDER BY d.rank DESC NULLS LAST, d.id))[1] AS sample_id
FROM search.documents d
WHERE d.name_key <> ''
GROUP BY d.name_key;

CREATE UNIQUE INDEX IF NOT EXISTS names_name_key ON search.names (name_key text_pattern_ops);
