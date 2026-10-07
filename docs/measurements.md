# Measurements

Measured on 2026-09-22 against the USDA FoodData Central Branded Foods release of 2025-12-18,
loaded with `npm run load -- --full`, without Jev. `search.words`, `search.similar_words` and the
[Jev](#jev-and-the-three-way-comparison) numbers were measured on 2026-10-07 on the same machine
and load; the `search.similar_words` times were taken with a load average of about 11 from other
programs. Machine: Intel Core i5-10500H (12 logical CPUs,
2.50 GHz), 7 GB of RAM, PostgreSQL 16.12 in the `postgres:16` Docker image on a local disk, default
settings (`shared_buffers` 128MB, `work_mem` 4MB), Node 22.23.

## Data

The load keeps one row per barcode: the newest record, with leading zeros ignored.

| what                                         | size            |
|----------------------------------------------|----------------:|
| products in `search.documents`               | 440,302         |
| distinct names in `search.names`             | 386,091         |
| distinct words in `search.words`             | 44,179          |
| `search.documents`, with / without indexes   | 343 MB / 231 MB |
| `search.names` with its index                | 87 MB           |
| `search.words` with its two indexes          | 4.6 MB          |
| release zip (`npm run load -- --full`)       | 447 MB          |
| committed sample, `data/sample.csv.gz`       | 4.3 MB          |

Indexes on `search.documents`: `documents_name_trgm` 40 MB, `documents_other_names_trgm` 17 MB,
`documents_id`, `documents_code` and `documents_prefix_vector` 13 MB each,
`documents_search_vector` 12 MB, `documents_facets` 4 MB. Sizes come from
`pg_size_pretty(pg_total_relation_size(oid))` over the relations in schema `search`.

## Build and refresh

`npm run load` (the 100,000-product sample) took 9.4 s and 9.7 s. `npm run load -- --full`, with
the zip already downloaded, took 70 s. `SELECT search.refresh()` over 440,302 rows took 29.3 s and
28.4 s. These times are from before `search.words` existed. Refreshing it alone took 2.8 s and
2.2 s, so the loader and `search.refresh()` now take about that much longer.

## Query speed

Each call ran ten times in one psql session with `\timing on`; the table gives the range of the
last five, in milliseconds, and the guide's other timings were taken the same way. Rows matched is
`count(*)` of `search.query(q, '{}', NULL)`.

| call                                    | step   | rows matched | warm ms        |
|-----------------------------------------|--------|-------------:|---------------:|
| `search.query_distinct('016000275287')` | code   | 1            | 0.4 to 0.5     |
| `search.query_distinct('cheerios')`     | word   | 226          | 2.0 to 2.2     |
| `search.query_distinct('milk')`         | word   | 15,770       | 21.2 to 22.2   |
| `search.query_distinct('strawb')`       | prefix | 11,646       | 20.5 to 21.0   |
| `search.query_distinct('cheerois')`     | typo   | 392          | 52.8 to 54.0   |
| `search.query_distinct('chocolatte')`   | typo   | 39,149       | 349 to 356     |
| `search.suggest('milk')`                |        |              | 0.3 to 0.4     |
| `search.suggest('ch')`                  |        |              | 1.7 to 1.8     |
| `search.suggest('kiwi')`, which fills   |        |              | 5.4 to 5.5     |
| `search.suggest('chocolatt')`           |        |              | 0.9 to 1.0     |
| `search.suggest('chocolatte')`          |        |              | 352 to 359     |
| `search.facets('milk')`                 | word   | 15,770       | 128 to 135     |
| `search.facets('chocolate')`            | word   | 38,068       | 311 to 335     |
| `search.facets('chocolatte')`           | typo   | 39,149       | 1,238 to 1,262 |
| `search.similar_words('parmesean')`     |        |              | 0.8 to 2.6     |
| `search.similar_words('chocolatte')`    |        |              | 1.7 to 3.3     |
| `search.similar_words('tortila chips')` |        |              | 3.3 to 5.8     |

## Evaluation

`npm run eval` scores `eval/queries.json` (50 queries through `search.query_distinct`) and
`eval/suggest.json` (126 typeahead inputs). A hit is a result that matches the case's pattern.
With a TypeSafe key it also scores the Jev step, `eval/spelling.json` and `eval/absent.json`.
The tables here are without Jev; the Jev numbers come from `scripts/compare.ts`
([below](#jev-and-the-three-way-comparison)).

| kind   | cases | hit@1 | hit@3 | hit@10 |
|--------|------:|------:|------:|-------:|
| exact  | 20    | 95%   | 95%   | 100%   |
| typo   | 18    | 72%   | 72%   | 72%    |
| prefix | 6     | 50%   | 67%   | 83%    |
| brand  | 3     | 100%  | 100%  | 100%   |
| code   | 3     | 100%  | 100%  | 100%   |
| all    | 50    | 82%   | 84%   | 88%    |

The typo step answers 11 of the 18 typo cases and hits 10 (not `dortios`); the word step answers
the other 7 and misses 4, whose misspellings exist in USDA names.

| typeahead              | cases | before hit@1 | before hit@8 | now hit@1 | now hit@8 |
|------------------------|------:|-------------:|-------------:|----------:|----------:|
| first 4 letters        | 49    | 35%          | 49%          | 90%       | 100%      |
| first 5 letters        | 50    | 38%          | 60%          | 100%      | 100%      |
| whole short word       | 27    | 89%          | 96%          | 85%       | 93%       |

"Before" is the `search.suggest` of commit `3f78545`, scored on a copy of the database. Stop
`npm start` first: `CREATE DATABASE ... TEMPLATE` refuses while anything is connected to
`search_demo`.

```sh
docker exec -i postgres-search psql -U postgres -c "CREATE DATABASE suggest_before TEMPLATE search_demo"
git show 3f78545:sql/functions.sql | docker exec -i postgres-search psql -U postgres -d suggest_before
DATABASE_URL=postgres://postgres:postgres@localhost:5432/suggest_before npm run eval
docker exec -i postgres-search psql -U postgres -c "DROP DATABASE suggest_before"
```

## Examples in the other pages

```sql
SET pg_trgm.word_similarity_threshold = 0.5;   -- oreo: 1,005 rows the typo step would add, 222 OREGANO
SELECT count(*), count(*) FILTER (WHERE name ILIKE '%oregano%') FROM search.documents
WHERE ('oreo' <% name OR 'oreo' <% other_names) AND NOT search_vector @@ plainto_tsquery('english', 'oreo');
SELECT q, count(*) FILTER (WHERE s >= 0.4), count(*) FILTER (WHERE s >= 0.5), count(*) FILTER (WHERE s >= 0.6)
FROM (VALUES ('cheerois'), ('stawberry jam'), ('peanut buter'), ('dortios')) v(q),
     LATERAL (SELECT word_similarity(q, name) AS s FROM search.documents) x GROUP BY q;  -- 9.5 s
SELECT similarity('cherios', 'Honey Nut Cheerios Medley Crunch Cereal'),       -- 0.184
       word_similarity('cherios', 'Honey Nut Cheerios Medley Crunch Cereal'),  -- 0.700
       word_similarity('dortios', 'DORITOS'), word_similarity('dortios', 'DORTMUNDER'), -- 0.375, 0.500
       word_similarity('cheerois', 'CHEERIOS'), word_similarity('cheerois', 'CHEERFUL'), -- 0.556, 0.556
       word_similarity('chocolatte', 'MILK CHOCOLATE');                        -- 0.750
SELECT facets->>'category', count(*) FROM search.documents WHERE name ILIKE '%ham%' GROUP BY 1 ORDER BY 2 DESC LIMIT 8;
SELECT value, doc_count FROM search.facets('ham', '{}', 8) WHERE facet = 'category';
SELECT count(*), count(DISTINCT facets->>'category'),                         -- 5,823, 139, 80
       (SELECT count(*) FROM search.facets('ham', '{}', 1000) WHERE facet = 'category')
FROM search.documents WHERE name ILIKE '%ham%';
SELECT (SELECT count(*) FROM search.documents WHERE name ILIKE '%parmesan%'),  -- 2,734
       (SELECT max(doc_count) FROM search.names), (SELECT count(*) FROM search.query_distinct('chocolate'));  -- 114, 48
SELECT count(r.id), count(*) FROM search.documents d LEFT JOIN search.query('pellegrino', '{}', NULL) r
  ON r.id = d.id WHERE d.name ILIKE '%pellegrino%';                            -- 43, 106
SELECT q, count(*) FROM (VALUES ('oreo', '{}'), ('che', '{}'), ('ore', '{}'), ('grano', '{}'),
  ('pb and j', '{}'), ('häagen', '{}'), ('haagen', '{}'), ('chocolatt', '{}'), ('ham', '{}'),
  ('ham', '{"category": "Breads & Buns"}')) v(q, f), search.query(q, f::jsonb, NULL) GROUP BY q, f;
-- oreo 566, che 4, ore 106, grano 13, pb and j 81, häagen 2, haagen 188, chocolatt 2, ham 2,464,
-- ham in Breads & Buns 592
```

Three numbers describe code before a later change and need that commit to reproduce: `pellegrino`
found 8 names before `a48f595`; `suggest` took 462 to 930 ms for `aed`, `bld` and `cng` between
`a007c4c` and `b291178`; and each `chocolatte` call took 1.4 to 1.9 s on a sequential scan plan,
before autoanalyze ran after a reload.

## Jev and the three-way comparison

Measured on 2026-10-07 with `jev-1.13.0`, the model every answer reported, in five runs of:

```sh
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts
node scripts/report.ts
```

`scripts/compare.ts` runs 615 queries (`eval/queries.json`, `eval/spelling.json`,
`eval/synthetic.json`, `eval/absent.json`) through plain Postgres full-text search, this SQL, and
this SQL with the Jev step, and writes every query's outcome to `results/`. `scripts/report.ts`
turns those files into [`results/report.md`](../results/report.md), the full record with every
group, system and test, and into the figures in `docs/figures/`. The
[README](../README.md#3-method) gives the method and discusses the results; the numbers below are
copied from `results/report.md`.

The Jev calls are network round trips from this machine to `api.typesafe.ai`, so their times
depend on where the server runs. A browser was running during the runs, with a load average of 5
to 13, which makes the Postgres times noisier than the table above.

| hit@1, median of five runs | hand-written (50) | held-out (50) | synthetic (500) |
|----------------------------|------------------:|--------------:|----------------:|
| plain Postgres full-text search | 52% | 42% | 36% |
| this SQL | 82% | 64% | 68% |
| this SQL + Jev keep or sink | 86% | 68% | 73% |
| this SQL + Jev "Did you mean", one click | 92% | 86% | 77% |
| this SQL + both, one click | 96% | 90% | 79% |
| this SQL + Norvig corrector, one click | 82% | 66% | 87% |

| ms, five runs pooled | median | p90 | p99 |
|----------------------|-------:|----:|----:|
| plain Postgres full-text search | 3 | 21 | 227 |
| this SQL | 25 | 202 | 667 |
| this SQL + Jev, whole page | 196 | 314 | 669 |
| time Jev adds to the page | 166 | 219 | 382 |
| one keep-or-sink call | 162 | 207 | 362 |
| one spelling call | 157 | 202 | 331 |

Cost is input tokens times \$0.042 per million ([TypeSafe models](https://docs.typesafe.ai/models));
output tokens are free. On the hand-written queries a search used 1,912 input tokens on average,
\$0.080 per 1,000 searches; across the four sets it was \$0.077 to \$0.089 per 1,000. One run of
`scripts/compare.ts`, including a research-only variant of the spelling question, sends about 1.5
million input tokens and costs \$0.065.

Numbers in this file from before 2026-10-07 that concern Jev, and the eval runs made before the
review fixes of that day, are in the git history; they describe earlier code.
