# postgres-search

Algolia-style search in plain Postgres: whole words, partial words, typos, barcodes, typeahead,
and facet counts, all in SQL. An optional step asks [Jev](https://docs.typesafe.ai) to push
clearly wrong results down the page.

The demo searches the USDA FoodData Central branded foods list. On the full 2025-12-18 release
(440,302 products), the warm results query takes about 2 ms for `cheerios`, 22 ms for `milk` and
53 ms for the misspelled `cheerois`; facet counts for `milk` take 128 to 135 ms
([measurements](docs/measurements.md)).

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

To try the Jev step, set a TypeSafe API key before `npm start`:

```sh
TYPESAFE_API_KEY=... npm start
```

Without a key everything else works the same. Jev's effect on the demo data has not been measured;
see [the Jev step](docs/jev.md).

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

On 50 hand-written queries against the full release, a correct product is first for 82% of them
and in the top 10 for 88%.

- [How it works](docs/how-it-works.md)
- [The search steps](docs/search-steps.md)
- [Typeahead](docs/typeahead.md)
- [Facets](docs/facets.md)
- [The Jev step](docs/jev.md)
- [Using your own data](docs/your-data.md)
- [Moving from Algolia](docs/from-algolia.md)
- [Measurements](docs/measurements.md)

## Limits

A misspelling that some product also carries hides the correctly spelled products: USDA lists one
PARMESEAN product, so `parmesean` never shows the 2,734 parmesan rows. Transposed letters can be
missed; trigram matching scores "dortios" at 0.375 against DORITOS, under the 0.5 cutoff. A typo
of a very common word is slow: the demo page waits about 1.25 s for "chocolatte". The materialized
view is stale until refreshed. [How it works](docs/how-it-works.md#what-it-does-not-do) lists
each cost.

## Contributing

See [AGENTS.md](AGENTS.md) for setup, checks, and rules. They apply to people and coding agents
alike.

## Data

Product data from [USDA FoodData Central](https://fdc.nal.usda.gov/), Branded Foods, released
2025-12-18. The data is public domain (CC0).

## License

MIT
