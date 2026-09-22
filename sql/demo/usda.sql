CREATE TABLE IF NOT EXISTS products (
  gtin_upc      text PRIMARY KEY,
  description   text NOT NULL,
  brand_name    text,
  brand_owner   text,
  category      text,
  modified_date date
);

-- Lower-cased words separated by single spaces, padded with a space on each side, so that
-- strpos() can match whole words ("alo" is not found in "aloe").
CREATE OR REPLACE FUNCTION usda_words(t text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT ' ' || btrim(regexp_replace(lower(t), '[^[:alnum:]]+', ' ', 'g')) || ' '
$$;

CREATE SCHEMA IF NOT EXISTS search;

-- USDA descriptions usually leave out the brand ("TOASTED WHOLE GRAIN OAT CEREAL"), so the
-- searchable name puts it in front. rank is how many barcodes share that name.
CREATE OR REPLACE VIEW search.source AS
SELECT n.id, n.name, n.other_names, NULL::text AS group_key, n.id AS code, n.facets,
       count(*) OVER (PARTITION BY usda_words(n.name)) AS rank
FROM (
  SELECT p.gtin_upc AS id,
         CASE WHEN p.brand_name IS NULL OR strpos(usda_words(p.description), usda_words(p.brand_name)) > 0
              THEN p.description
              ELSE p.brand_name || ' ' || p.description
         END AS name,
         p.brand_owner AS other_names,
         jsonb_strip_nulls(jsonb_build_object('category', p.category, 'brand', p.brand_name)) AS facets
  FROM products p
) n;
