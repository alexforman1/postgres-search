---
name: postgres-search
description: Add Algolia-style search (word, prefix, and typo matching, typeahead, facets) to a Postgres database with plain SQL, plus an optional Jev step that sinks wrong results. Use when a project wants to replace Algolia or add product or catalog search on Postgres.
---

# postgres-search

Adds search to a Postgres database. All logic is SQL in a schema named `search`. The files in
`sql/` next to this one are the source of truth; do not rewrite them.

Reference and full guide: https://github.com/alexforman1/postgres-search

## Steps

### 1. Map the data (ask before writing)

Read the project's schema (migrations, ORM models, or `\d` output). Propose a view
`search.source` with exactly these columns:

| column | type | meaning |
|---|---|---|
| id | any | row key |
| name | text | main name, searched and shown |
| other_names | text | extra searched text (brand, maker, aliases), may be null |
| group_key | text | rows that are the same thing, may be null |
| code | text | barcode or SKU for digit-prefix search, may be null |
| facets | jsonb | flat object of facet name to string value |
| rank | number | tie-breaker, higher first, may be null |

Put filters for rows that should never be searchable (archived, draft, deleted) in the view.
Show the proposed view to the user and wait for confirmation before continuing.

### 2. Install

In one migration, in this order:
1. `CREATE SCHEMA IF NOT EXISTS search;` and the confirmed `CREATE VIEW search.source ...`
2. the contents of `sql/schema.sql`
3. the contents of `sql/functions.sql`

Use the project's migration tool if it has one; otherwise give the user a single `.sql` file.
`CREATE EXTENSION pg_trgm` needs a role allowed to create extensions; on managed hosts, check the
provider's extension settings.

If the database is exposed through PostgREST or Supabase, add:

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA search FROM PUBLIC;
GRANT USAGE ON SCHEMA search TO <role>;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA search TO <role>;
GRANT SELECT ON ALL TABLES IN SCHEMA search TO <role>;
```

Anyone who can call `search.query` can ask for every match with `lim => NULL`. If searches come
straight from untrusted clients, put them behind the app's server or a wrapper function.

### 3. Keep it current

`search.documents` is a materialized view. Add `SELECT search.refresh();` after the project's
import jobs, or on a schedule. Ask the user which. For data that changes constantly, suggest a
trigger-maintained table instead (see the guide's docs/your-data.md).

### 4. Call it

```sql
SELECT d.* FROM search.query($1, $2::jsonb, 50) r
JOIN search.documents d ON d.id = r.id ORDER BY r.pos;      -- results
-- use search.query_distinct instead when many rows are variants of one product
-- (sizes, colors); it returns one row per group_key
SELECT * FROM search.suggest($1);                            -- typeahead, name + id
SELECT * FROM search.facets($1, $2::jsonb);                  -- facet, value, doc_count
```

Never build facet counts with a separate `LIKE`/`ILIKE` query; always use `search.facets`.
Never call Jev from typeahead.

### 5. Optional: the Jev step

Only if the user has a TypeSafe key (`TYPESAFE_API_KEY`). Port `rerank.ts` in this folder to the
project's server language. Keep these rules:
- one request for the top 10, one Noul question per candidate;
- move candidates below the threshold (default 0.3) to the bottom of the 10; never sort by score;
- skip the call when fewer than 2 results or all share one group;
- on any error, timeout (1.5 s), or missing answer, return the original order;
- the key never reaches the browser.

### 6. Verify

Run a few real queries and check each step fires: a full word, a partial word (3+ letters), a
misspelling, and a barcode if `code` is set. Run `EXPLAIN ANALYZE` on the inner query of the word
step and confirm a bitmap scan on `documents_search_vector`. Time each call on a warm connection
(run it ten times in one session), since that is how a pooled app calls it. Report results to the
user.
