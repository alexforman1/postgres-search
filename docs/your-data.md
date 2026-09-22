# Using your own data

You write one view. Everything else is built from it.

## 1. Create search.source

```sql
CREATE SCHEMA IF NOT EXISTS search;

CREATE VIEW search.source AS
SELECT
  p.id,                                   -- unique; any type, stored as text
  p.title                  AS name,       -- searched and displayed
  concat_ws(' ', p.brand, p.maker, p.sku) AS other_names,  -- searched, may be null
  NULL::text               AS group_key,  -- rows that are the same product; null groups by name
  p.upc                    AS code,       -- all digits, matched by prefix; may be null
  jsonb_build_object('category', p.category, 'brand', p.brand) AS facets,
  p.sales_last_30_days     AS rank        -- tie-breaker, higher first; may be null
FROM products p
WHERE NOT p.archived;
```

Put every rule about which rows are searchable in this view. Columns are cast when
`search.documents` is built, so an integer `id` or a `varchar` name works. `id` must be unique,
because the concurrent refresh needs a unique index on it. `facets` is a flat object of string
values; null values are left out of the counts. The code step runs only when the query is all
digits, so put a barcode in `code` and an alphanumeric SKU in `other_names`. Leading zeros in
`code` are ignored on both sides, so `012345` and `12345` find each other.

## 2. Build the search objects

```sh
psql "$DATABASE_URL" -f sql/schema.sql -f sql/functions.sql
```

Or add both files to your migration tool as one migration, after the view. `schema.sql` installs
`pg_trgm`, which needs permission to create extensions. The functions set their `search_path` to
`search, public, extensions`, so they find `pg_trgm` in either `public` or `extensions` (where
Supabase puts it). The database needs a UTF-8 locale (the default for most installs): under the
`C` locale, letters such as "ä" are not treated as letters when names are split into words, and
"Häagen-Dazs" becomes "h", "agen" and "dazs".

## 3. Keep it current

`search.documents` is a materialized view, so it changes only when refreshed:

```sql
SELECT search.refresh();
```

Run it after each import, or on a schedule (`pg_cron`, a cron job, your job runner). It refreshes
concurrently, so searches keep working during the refresh. On the 440,302-product USDA demo
(2025-12-18 release) it takes about 29 seconds ([measurements](measurements.md)). It must run as
the role that owns the two materialized views, usually the one that ran `schema.sql`; the grants
below do not let another role refresh them. To refresh as another role, hand the views over with
`ALTER MATERIALIZED VIEW search.documents OWNER TO <role>` and the same for `search.names`.

If your data changes constantly, replace the materialized view with a table of the same columns
and indexes, filled by triggers on your source tables that compute `name_key`, `code` and the two
vectors the way `schema.sql` does. `search.query`, `search.suggest` and `search.facets` read it
the same way. Dropping the materialized view also drops `search.names`, so recreate that from
`schema.sql`. `search.refresh()` then fails with `"documents" is not a materialized view`;
run `REFRESH MATERIALIZED VIEW CONCURRENTLY search.names;` instead. Typeahead lags until it runs.

## 4. Changing the view

Materialized views depend on `search.source`. To change its columns:

```sql
DROP MATERIALIZED VIEW search.documents CASCADE;  -- also drops search.names
-- recreate search.source, then run sql/schema.sql again
```

## 5. Access control

Postgres lets every role execute new functions. If the database is reachable through PostgREST or
Supabase, limit who can search:

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA search FROM PUBLIC;
GRANT USAGE ON SCHEMA search TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA search TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA search TO app_user;
```

The functions run with the caller's privileges, so the `SELECT` grant also lets that role read
`search.documents` and `search.names` directly. `lim` is clamped to 1000, but `lim => NULL`
returns every match. Grant to the role your server connects as, never to a browser-facing role
such as Supabase's `anon`.

## 6. Calling it

```sql
SELECT * FROM search.query('cheerios');                             -- id, step, pos
SELECT * FROM search.query('milk', '{"category": "Dairy"}', 20);    -- filtered, 20 rows
SELECT * FROM search.query_distinct('milk');                        -- one row per group_key
SELECT * FROM search.suggest('che');                                -- name, id, doc_count
SELECT * FROM search.facets('milk');                                -- facet, value, doc_count
```

`search.suggest` returns at most 50 names; with `lim => NULL` it returns the default 8.
`search.query_distinct` collapses at most the first 1000 matches, so it can return fewer rows than
`lim`, and `lim => NULL` returns up to 50.

Join `search.query` to `search.documents` (or your own table) on `id` to get the rows, and order
by `pos`:

```sql
SELECT d.name, r.step FROM search.query('cheerios') r
JOIN search.documents d ON d.id = r.id
ORDER BY r.pos;
```

## 7. The Jev step

It runs in your server, not in the database. `skills/postgres-search/rerank.ts` holds the HTTP
call and the keep/sink step in one file of 126 lines, with no dependency beyond `fetch`
(`src/jev.ts` and `src/rerank.ts` are the same code in two files). Port it to your language and
keep the key on the server. [The Jev step](jev.md) lists the rules a port must keep.
