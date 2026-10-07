# postgres-search

Algolia-style search in plain Postgres: whole words, partial words, typos, barcodes, typeahead,
and facet counts, all in SQL. An optional step asks [Jev](https://docs.typesafe.ai) two questions
per search: which results are wrong, so they move down the page, and which spelling the user
meant, so the page can offer "Did you mean". When Jev judges every top result wrong, the page
says so.

The demo searches the USDA FoodData Central branded foods list. On the full 2025-12-18 release
(440,302 products), the warm results query takes about 2 ms for `cheerios`, 22 ms for `milk` and
53 ms for the misspelled `cheerois`; facet counts for `milk` take 128 to 135 ms
([measurements](docs/measurements.md)).

## Plain Postgres, this SQL, and this SQL with Jev

`scripts/compare.ts` runs three searches over the same 440,302 products and the same 115 queries
([measurements](docs/measurements.md#three-searches-compared)):

- **plain Postgres**: full-text search as the Postgres manual shows it (`to_tsvector`,
  `plainto_tsquery`, a GIN index, ordered by `ts_rank`), one row per name.
- **this SQL**: `search.query_distinct`, with its barcode, word, prefix and typo steps.
- **with Jev**: the same SQL plus the Jev step, `jev-1.13.0`, as the page shows it and after one
  click on its "Did you mean" link.

|                                                  | plain Postgres | this SQL     | with Jev      | with Jev, one click |
|--------------------------------------------------|---------------:|-------------:|--------------:|--------------------:|
| right product first, 50 hand-written queries     | 52%            | 82%          | 86%           | 96%                 |
| right product first, 50 held-out words           | 42%            | 64%          | 66 to 70%     | 86 to 90%           |
| right product first, 30 held-out misspellings    | 10%            | 43%          | 43 to 50%     | 77 to 83%           |
| queries with no results at all, of those 100     | 28             | 0            | 0             | 0                   |
| household goods shown as having no match, of 15  | 12             | 2            | 12            |                     |
| time per query, median                           | 3 to 4 ms      | 12 to 28 ms  | 194 to 231 ms |                     |
| time per query, 90th percentile                  | 10 to 34 ms    | 141 to 312 ms | 309 to 342 ms |                     |

Plain Postgres is the fastest and the strictest: it returned nothing for 23 of the 48 misspelled
queries and for every barcode. This SQL returned something for all 100, which finds the right
product far more often but also returns Shamrock Farms sour cream for "shampoo". Jev is what
tells the two apart. In one call it judges each
of the top 10 results, in 161 to 176 ms at the median; in a second call, sent while Postgres is
still searching, it picks the spelling the user meant from about 9 close words that products use,
in 159 to 168 ms. The SQL cannot make either judgment: by trigrams, "dortios" is closer to
DORTMUNDER than to DORITOS.

The held-out words were written before any Jev call on them and nothing was tuned on them. The
hand-written queries also shaped the spelling step's bar and two of its rules, so read that row as
in-sample. On the held-out words, Jev fixed 23 to 25 of 30 misspellings, left all 20 correctly
spelled words alone, and made no wrong suggestion; a rule that picks the most common close word
made 16 wrong ones ([the Jev step](docs/jev.md)).

The Jev step costs $0.087 per 1,000 searches: TypeSafe charges $0.042 per million input tokens,
and a search uses about 2,100 on average. Typeahead never calls Jev, and any Jev failure leaves the
Postgres order.

## Try it

Needs Docker and Node 22.18 or later.

```sh
git clone https://github.com/alexforman1/postgres-search
cd postgres-search
npm install
npm run db      # Postgres 16 in Docker on port 5432
npm run load    # 100,000-product sample, about 10 seconds
npm start       # http://localhost:3000
```

The server listens on `PORT` (default 3000). The server and scripts connect to `DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/search_demo`). If port 5432 is taken, run the
`docker run` line from the `db` script in `package.json` with another host port, such as
`-p 127.0.0.1:5433:5432`, and point `DATABASE_URL` at it. The loader drops and recreates its
tables, so it refuses a database not named `search_demo` unless given `--any-database`. After a
reboot, start the database again with `docker start postgres-search`.

`npm run load -- --full` downloads the whole release (447 MB) instead of using the sample. It
needs `unzip`.

To try the Jev step, set a TypeSafe API key before `npm start`, then search for `parmesean`,
`dortios` or `shampoo`:

```sh
TYPESAFE_API_KEY=... npm start
```

Without a key everything else works the same.

## Use it with your data

Write one view, `search.source`, that maps your table to seven columns, then run two SQL files.
[docs/your-data.md](docs/your-data.md) walks through it.

With a coding agent, install the skill and ask it to add search to your project:

```sh
npx skills add alexforman1/postgres-search
```

## How it works

`search.query` tries four steps in order and returns the first that finds anything: barcode
prefix, whole words, word prefixes, then typo matching with trigrams. Steps never mix, which keeps
fuzzy matches out of good results. Facet counts come from the same rows the search returned.

Without Jev, a correct product is first for 82% of the 50 eval queries and in the top 10 for 88%.

- [How it works](docs/how-it-works.md)
- [The search steps](docs/search-steps.md)
- [Typeahead](docs/typeahead.md)
- [Facets](docs/facets.md)
- [The Jev step](docs/jev.md)
- [Using your own data](docs/your-data.md)
- [Moving from Algolia](docs/from-algolia.md)
- [Measurements](docs/measurements.md)

## Limits

Without Jev, a misspelling that some product also carries hides the correctly spelled products:
USDA lists one PARMESEAN product, so `parmesean` never shows the 2,734 parmesan rows. Transposed
letters can be missed; trigram matching scores "dortios" at 0.375 against DORITOS, under the 0.5
cutoff. Jev's "Did you mean" covers both, but it respells one word per query and missed 5 to 7 of
the 30 held-out misspellings. A typo of a very common word is slow: the demo page waits about
1.25 s for "chocolatte". The materialized views are stale until refreshed.
[How it works](docs/how-it-works.md#what-it-does-not-do) lists each cost.

## Contributing

See [AGENTS.md](AGENTS.md) for setup, checks, and rules. They apply to people and coding agents
alike.

## Data

Product data from [USDA FoodData Central](https://fdc.nal.usda.gov/), Branded Foods, released
2025-12-18. The data is public domain (CC0).

## License

MIT
