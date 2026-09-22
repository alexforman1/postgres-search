-- Raw FoodData Central files with every column as text. Column order matches the CSV headers of
-- the 2025-12-18 release.
DROP TABLE IF EXISTS usda_branded_food, usda_food;

CREATE UNLOGGED TABLE usda_branded_food (
  fdc_id text, brand_owner text, brand_name text, subbrand_name text, gtin_upc text,
  ingredients text, not_a_significant_source_of text, serving_size text, serving_size_unit text,
  household_serving_fulltext text, branded_food_category text, data_source text,
  package_weight text, modified_date text, available_date text, market_country text,
  discontinued_date text, preparation_state_code text, trade_channel text,
  short_description text, material_code text
);

CREATE UNLOGGED TABLE usda_food (
  fdc_id text, data_type text, description text, food_category_id text, publication_date text,
  market_country text, trade_channel text, microbe_data text
);
