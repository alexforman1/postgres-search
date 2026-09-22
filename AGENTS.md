# Working on postgres-search

## Setup

    npm install
    npm run db            # Postgres 16 in Docker on port 5432
    npm run load          # 100,000-product sample; add -- --full for the whole USDA release
    npm start             # demo at http://localhost:3000
    npm run eval          # search and typeahead scores on the full load

Node 22.18 or later runs the `.ts` files directly. There is no build step.

The Jev step needs a TypeSafe API key. Put `TYPESAFE_API_KEY=...` in `.env` (git ignores it) and
run `node --env-file=.env server.ts` or `node --env-file=.env scripts/eval.ts`. Everything else
works without it.

## Checks (all must pass before a pull request)

    npx tsc -p .
    npm test              # needs the database; uses a separate search_test database
    npm run check-skill-sql

## Layout

- `sql/` is the product. `schema.sql` builds the search objects from `search.source`;
  `functions.sql` holds `search.query`, `search.query_distinct`, `search.suggest`,
  `search.facets`, `search.refresh`.
- `src/` is the optional Jev step and a database helper.
- `server.ts` and `public/` are the demo only. Do not grow them into an API.
- `skills/postgres-search/` is a copy for other projects. When `sql/` changes, copy the two files
  over (CI compares them). When `src/rerank.ts` or `src/jev.ts` changes, update
  `skills/postgres-search/rerank.ts` by hand.
- `docs/` is the guide. Numbers in it come from `docs/measurements.md`; rerun the commands there
  when a change affects speed or results.

## Rules

- Search behavior changes need a test in `tests/sql.test.ts` that fails without the change.
- Do not tune the search to `eval/queries.json`. Fix a bad eval case instead of the search.
- Plain, short English in code, comments, docs, and commit messages. Comment only what the code
  cannot say. No padding, no marketing words, no em dashes.
- No new runtime dependencies without a reason in the pull request.
