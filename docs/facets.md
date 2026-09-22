# Facets

`search.facets(q, filters => '{}', per_facet => 20)` returns `facet`, `value` and `doc_count`.
Examples use the USDA Branded Foods release of 2025-12-18.

## Counts come from the search rows

```sql
FROM search.query(q, filters, NULL) r
JOIN search.documents d ON d.id = r.id
CROSS JOIN LATERAL jsonb_each_text(d.facets) AS kv
```

`lim => NULL` makes `search.query` return every row of the step that matched, so the counts cover
every row the search matched, whichever step answered: when the typo step answers, the counts are
over typo matches. Each facet keeps its `per_facet` most common values (clamped to
1 to 1000), and JSON null values are skipped.

The counts are rows, not groups. The demo lists one row per name through `search.query_distinct`,
but a facet count includes every barcode. Algolia counts the same way unless the facet is declared
with `afterDistinct`.

## Why not a separate text match

Counting with `name ILIKE '%ham%'` matches "ham" inside other words. It finds 5,823 rows in 139
categories; `search.query('ham')` matches 2,464 rows in 80 categories. The top 8 categories of
each:

| `ILIKE '%ham%'`                          | rows  | `search.facets('ham')`               | rows  |
|------------------------------------------|------:|--------------------------------------|------:|
| Pepperoni, Salami & Cold Cuts            | 1,288 | Pepperoni, Salami & Cold Cuts        | 1,288 |
| Breads & Buns                            | 600   | Prepared Subs & Sandwiches           | 220   |
| Cookies & Biscuits                       | 517   | Frozen Appetizers & Hors D'oeuvres   | 78    |
| Candy                                    | 225   | Cooked & Prepared                    | 69    |
| Pickles, Olives, Peppers & Relishes      | 221   | Pickles, Olives, Peppers & Relishes  | 63    |
| Prepared Subs & Sandwiches               | 220   | Pizza                                | 63    |
| Popcorn, Peanuts, Seeds & Related Snacks | 215   | Prepared Wraps and Burittos          | 59    |
| Ice Cream & Frozen Yogurt                | 181   | Frozen Breakfast Sandwiches, ...     | 58    |

Four of the `ILIKE` categories come from other words: HAMBURGER buns in Breads & Buns, GRAHAM
crackers in Cookies & Biscuits, HAMMOND candy in Candy, and HAMPTON peanuts in Popcorn, Peanuts,
Seeds & Related Snacks. `search.query('ham')` has no rows in Breads & Buns
at all. `search.facets` never runs a text match of its own, so it cannot offer a count for rows
the search did not return.

## Filters

`filters` is a JSON object, applied in every step as `facets @> filters`. Every key must match and
each key holds one value, so filters combine with AND across facets and allow one value per facet:

```sql
SELECT * FROM search.facets('chocolate', '{"category": "Chocolate", "brand": "LINDT"}');
```

Because filters apply inside each step, a filter can change which step answers. `ham` has no
whole-word match in Breads & Buns, so `search.query('ham', '{"category": "Breads & Buns"}')` falls
through to the prefix step and returns 592 rows, nearly all of them hamburger buns. The demo only
offers values from the current counts, so its page never sends that filter.

Disjunctive faceting is not built. Showing "Candy or Chocolate", with each facet's counts computed
as if its own selection were not applied, would need an OR filter (for example
`d.facets->>'category' = ANY($1)`) and one count query per facet with that facet's filter left
out. The demo allows one active value per facet for this reason.

## Cost

`search.facets` reads every matching row, so it has no top-N shortcut and costs more than the
search itself. Warm, on the full data: `search.facets('milk')` takes 128 to 135 ms and
`search.facets('chocolate')` 311 to 335 ms over 38,068 rows. A typo of a common word is the worst
case: `search.facets('chocolatte')` takes 1.24 to 1.26 s ([search steps](search-steps.md)). The
demo page sends `/facets` at the same time as `/search`, so the page waits for the slower of the
two.
