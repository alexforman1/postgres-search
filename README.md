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

## What Jev adds

On 50 hand-written queries against the full release, with `jev-1.13.0`
([measurements](docs/measurements.md#jev)):

|                                    | right product first | right product in the top 10 |
|------------------------------------|--------------------:|----------------------------:|
| Postgres alone                     | 82%                 | 88%                         |
| with Jev moving wrong results down | 86%                 | 88%                         |
| following Jev's "Did you mean"     | 96%                 | 98%                         |

All 18 misspelled queries show the right product first once the suggestion is followed, against
13 without Jev. `parmesean` gets "Did you mean parmesan" and `dortios` gets "doritos", two cases the
SQL cannot fix. These 50 queries also shaped the spelling step's bar and two of its rules, so the
table is not a clean test. On 50 more words written as a held-out test, Jev fixed 23 to 25 of 30
misspellings, left all 20 correctly spelled words alone, and made no wrong suggestion; a rule that
picks the most common close word made 16 wrong ones.

It costs $0.087 per 1,000 searches: TypeSafe charges $0.042 per million input tokens, and a search
uses about 2,100 on average. It adds 157 to 168 ms to the results page at the median and 203 to
216 ms at the 90th percentile; the two questions run at the same time, the spelling one while
Postgres is still searching. Typeahead never calls Jev. Any Jev failure leaves the Postgres order.
[The Jev step](docs/jev.md) shows both requests, the rules, and the limits.

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
