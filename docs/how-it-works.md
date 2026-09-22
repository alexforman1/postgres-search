# How it works

## Postgres finds, Jev judges

Every result comes from Postgres. `search.query` finds the candidates and puts them in order. The
optional Jev step reads only the top 10 of that list and may move some of them to the bottom of
the 10. It cannot add a row that Postgres did not return, so recall has to come from the SQL. That
is why most of this guide is about the SQL. See [The Jev step](jev.md).

## The pieces

Everything lives in a schema named `search`, so `DROP SCHEMA search CASCADE` removes it all.

- `search.source`: a view you write over your own tables. It is the only input.
- `search.documents`: a materialized view over `search.source`, with a normalized name, the code
  without leading zeros, two text-search vectors, and the indexes.
- `search.names`: one row per distinct name, with the number of documents that share it.
- `search.tokens(text)`: splits text into lower-cased words. Names and queries use the same split.
- `search.query(q, filters, lim)`: the four search steps. Returns `id`, `step`, and `pos`.
- `search.query_distinct(q, filters, lim)`: the same, with one row per group.
- `search.suggest(q, lim)`: typeahead over `search.names`.
- `search.facets(q, filters, per_facet)`: facet counts over the rows `search.query` matched.
- `search.refresh()`: refreshes both materialized views.

`sql/schema.sql` creates `search.tokens`, `search.documents` and `search.names` once
`search.source` exists, and `sql/functions.sql` creates the functions.
[Using your own data](your-data.md) covers the view.

## A request in the demo

```
public/app.js
  typing (120 ms after the last key)  GET /suggest?q=
  Enter, or a click on a suggestion   GET /search and GET /facets, sent together
        |
server.ts
  /suggest  search.suggest(q)
  /search   search.query_distinct(q, filters) joined to search.documents
            then rerank() on the top 10, only if TYPESAFE_API_KEY is set
  /facets   search.facets(q, filters)
        |
public/app.js
  results with the step that matched each one, and "Moved down by Jev" on sunk rows
  facet buttons with counts
```

The server's connection pool sets `statement_timeout` to 5 seconds, so a slow query fails the
request instead of holding it open. The server has no documented endpoints. It exists to run the
page.

## What it does not do

There is no HTTP API, no npm package, and no vector search. Jev is not used for typeahead, because
it would add a network call to every keystroke. Facets are not disjunctive: a filter narrows every
facet's counts, and the demo allows one active value per facet. Transposed letters are not
corrected.

The costs of the design are stated where they occur. Steps never mix, so a misspelling that some
product also carries hides every correctly spelled product ([search steps](search-steps.md)).
Typeahead completes names by their first letters, so a short whole word can complete to a brand
first ([typeahead](typeahead.md)). A typo of a very common word is slow: on the USDA data
(2025-12-18 release), the page waits about 1.25 seconds for `chocolatte`. There is no accent
folding: `häagen` finds 2 rows and `haagen` 188. The materialized views show old data until
`search.refresh()` runs. Anyone who can call `search.query` can ask for every match with
`lim => NULL`; limit who can call it ([using your own data](your-data.md)).
