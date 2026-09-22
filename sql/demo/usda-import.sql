-- One row per barcode: its newest record, unless that record is discontinued.
INSERT INTO products (gtin_upc, description, brand_name, brand_owner, category, modified_date)
SELECT gtin_upc, description, brand_name, brand_owner, category, modified_date
FROM (
  SELECT DISTINCT ON (b.gtin_upc)
    b.gtin_upc,
    btrim(f.description)                        AS description,
    nullif(btrim(b.brand_name), '')             AS brand_name,
    nullif(btrim(b.brand_owner), '')            AS brand_owner,
    nullif(btrim(b.branded_food_category), '')  AS category,
    nullif(b.modified_date, '')::date           AS modified_date,
    coalesce(b.discontinued_date, '')           AS discontinued_date
  FROM usda_branded_food b
  JOIN usda_food f ON f.fdc_id = b.fdc_id
  WHERE b.gtin_upc ~ '^[0-9]{8,14}$'
  ORDER BY b.gtin_upc, nullif(b.modified_date, '')::date DESC NULLS LAST, b.fdc_id::bigint DESC
) newest
WHERE discontinued_date = '' AND description <> '';

DROP TABLE usda_branded_food, usda_food;
