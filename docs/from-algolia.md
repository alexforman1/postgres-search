# Moving from Algolia

## Settings

`objectID` becomes `id` in `search.source`. Keep the same values and the two engines' results can
be compared row by row.

`searchableAttributes` becomes `name` and `other_names`. Both go into one text vector with equal
weight. Algolia ranks a match in an earlier attribute higher; here the only name-specific rule is
that a row whose whole name equals the query comes first in its step.

`customRanking` becomes `rank`: one number, higher first, nulls last. Algolia applies it after its
text criteria. Here it comes after the exact-name rule inside a step, and a step's rows never mix
with another step's.

`distinct` with `attributeForDistinct` becomes `group_key` and `search.query_distinct`, which
keeps the best row of each group, like `distinct: true`. Algolia's option of several rows per
group has no equivalent, and `search.query_distinct` collapses only the first 1000 matches.

`attributesForFaceting` becomes the `facets` object, with string values. Counts are over rows, not
groups, like an Algolia facet without `afterDistinct`. Filters combine with AND, one value per
facet; there is no OR within a facet ([facets](facets.md)).

`typoTolerance` becomes the typo step, which runs only when no code, word or prefix match exists.
Algolia's default (`true`) returns exact and misspelled matches together, fewest typos first. Its
`"min"` setting returns only the records with the fewest typos, which is close to how the steps
behave here. The typo step scores trigrams, so there is no per-word length rule like
`minWordSizefor1Typo`. Algolia counts two swapped letters as one typo; trigram scoring does not,
so `dortios` misses Doritos ([search steps](search-steps.md)).

`queryType` becomes the prefix step. Algolia's default, `prefixLast`, treats the last word as a
prefix. The prefix step treats every word as a prefix, like `prefixAll`, needs at least one word of
3 or more letters, and runs only when no whole word matched.

The Query Suggestions index becomes `search.names`. Algolia builds that index mainly from past
searches in its analytics and rebuilds it daily. `search.names` is built from your own names, so
it completes product names, needs no search history, and changes when you run `search.refresh()`
([typeahead](typeahead.md)).

## Moving over

Run both engines behind a flag, with Algolia still receiving every index update, so switching back
is one setting.

Write `eval/queries.json` cases for your own data: the queries your users run most, a few
misspellings, partial words and codes, each with a pattern a correct result must match, and
`eval/suggest.json` cases for typeahead. Run `node scripts/eval.ts` against your database until the
results are ones you would ship.

`scripts/compare-algolia.ts` runs the same queries against your Algolia index and prints how many
of each top 10 the two engines share. It reads this side through `search.query_distinct`, so
compare against an index with `distinct` set the same way, and it assumes `objectID` equals `id`:

```sh
ALGOLIA_APP_ID=... ALGOLIA_SEARCH_KEY=... ALGOLIA_INDEX=... node scripts/compare-algolia.ts
```

A low overlap is not a verdict; read the queries where the lists differ and decide which list is
right.

Send a small share of real traffic to Postgres. Before raising the share, use the page yourself
with the new engine: type slowly to see the typeahead, try misspellings, click facets. Watch query
times on the database, especially for typos of common words. Remove the flag and the Algolia index
last, once the new engine has carried all traffic through at least one `search.refresh()`.

## What you lose

A swap of two letters is not treated as one typo. Algolia's analytics and dashboards have no
equivalent here, and neither do its synonyms. Algolia scales the search service for you; here
search load lands on your database, so size it and set a `statement_timeout`.

## What you gain

One less service to pay for, and no index updates to send to it. No per-record size limit, which
Algolia sets by plan. Search runs inside your database's transactions and permissions: a query can
join your own tables, filter by the same rules as the rest of your app, and see a row as soon as
the refresh that includes it commits.
