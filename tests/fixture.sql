CREATE TABLE fixture_items (
  id         int PRIMARY KEY,
  name       text NOT NULL,
  brand      text,
  code       text,
  category   text,
  popularity int
);

INSERT INTO fixture_items VALUES
  (1,  'Cheerios Cereal',           'General Mills',  '00016000275287', 'Cereal',  90),
  (2,  'Honey Nut Cheerios Cereal', 'General Mills',  '00016000124790', 'Cereal',  50),
  (3,  'Cheerios',                  'General Mills',  '0016000503687',  'Cereal',  10),
  (4,  'Strawberry Jam',            'Smucker',        '051500000011',   'Spreads', 20),
  (5,  'Strawberries',              'Driscoll',       '071430000019',   'Produce', 30),
  (6,  'Chocolate Milk',            'Horizon',        '742365000012',   'Dairy',   40),
  (7,  'Whole Milk',                'Horizon',        '742365000029',   'Dairy',   60),
  (8,  'Milk Chocolate Bar',        'Hershey',        '034000002405',   'Candy',   70),
  (9,  'Häagen-Dazs Vanilla',       'Nestle',         '074570000014',   'Frozen',  15),
  (10, 'Cheerioz Oat Rings',        'Store Brand',    '041190000017',   'Cereal',  80),
  (11, 'Vanilla Häagen-Dazs Bar',   'Nestle',         '074570000021',   'Frozen',  99),
  (12, 'Whole Milk',                'Organic Valley', '093966000016',   'Dairy',    5),
  (13, 'Oat Rings 16000 Pack',      'Store Brand',    '041190000024',   'Cereal',  35),
  (14, 'Wheat Thins',               'Nabisco',        '044000032029',   'Snacks',  30);

CREATE SCHEMA search;

CREATE VIEW search.source AS
SELECT id, name, brand AS other_names,
       CASE WHEN name ILIKE '%cheerios%' THEN 'cheerios' END AS group_key, code,
       jsonb_build_object('category', category, 'brand', brand) AS facets,
       popularity AS rank
FROM fixture_items;
