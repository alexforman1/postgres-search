# The search steps

Examples use the USDA Branded Foods release of 2025-12-18 (440,302 products), loaded with
`npm run load -- --full`. Each number has a command in [measurements](measurements.md).

`search.query` lower-cases the input and splits it into words on anything that is not a letter or
digit, so no query syntax from the user reaches Postgres. It keeps the first 256 characters and
the first 32 words. A query made only of English stop words ("the", "and") returns nothing.

## The four steps

Each step runs only when every step before it returned nothing.

1. `code`: the input is all digits, and at least 4 digits remain after removing leading zeros.
   It matches codes that start with those digits. Leading zeros are removed on both sides, so a
   12-digit UPC finds the same barcode stored as a 14-digit GTIN.
2. `word`: `search_vector @@ plainto_tsquery('english', query)`. Every word, stemmed, must appear
   in `name` or `other_names`.
3. `prefix`: stop words are dropped, and at least one remaining word must have 3 or more
   characters. Every remaining word becomes a prefix (`straw:* & j:*`) matched against
   `prefix_vector`. That vector is not stemmed, because a partial word such as "chocolat" is
   longer than the stem of "chocolate" ("chocol") and would never match it.
4. `typo`: stop words are dropped, and the rest of the query (`typo_q`) must satisfy
   `typo_q <% name OR typo_q <% other_names`. `<%` is pg_trgm's word similarity operator; the
   function sets its threshold to 0.5.

On the demo data, `016000275287` is answered by the code step (Cheerios Cereal), `cheerios` by
the word step, `strawb` by the prefix step, and `cheerois` by the typo step (Frosted Cheerios).

## Steps never mix

The word step finds 566 rows for `oreo`. If the typo step also ran, it would add 1,005 more at
word similarity 0.5 or higher: TREO coconut water first, then Ore-Ida potatoes, 222 names with
OREGANO (Hunt's tomatoes with basil, garlic and oregano), and rows whose maker has OREGON in its
name. The typo step runs only when nothing else matched, which is also why its loose threshold is
safe.

The rule has two costs. First, a misspelling that some product also carries hides every correct
product. USDA names include PARMESEAN, GAUCAMOLE, TORTILA CHIPS and CHOCLATE, so the word step
answers those queries with the misspelled rows and the typo step never runs. `parmesean` returns
one product and none of the 2,734 rows whose name contains PARMESAN. These are 4 of the 5 typo
misses in the eval. Algolia's default `typoTolerance` (`true`) ranks exact matches first but still
returns misspelled matches after them, so it would show the parmesan products. Its `"min"` setting
returns only the records with the fewest typos, which is close to the rule used here and has the
same cost.

Second, a rare whole word beats a prefix. `grano` finds 13 rows with the whole word GRANO: SACRED
GRAINS GRANO (filed under Rice) and Italian pastas made from GRANO DURO. The prefix step,
which would find granola, never runs. On the results page, `chee` lists LANCE, TOAST CHEE first.
Typeahead avoids this by completing names before it searches words ([typeahead](typeahead.md)).

## Order inside a step

In the word and prefix steps, a row whose whole name equals the query comes first, then `rank`
from high to low with nulls last, then `id`. The typo step orders by similarity, then `rank`, then
`id`. `id` is unique, so the order is total: the same query on the same data returns the same rows
in the same order, and `lim` always cuts in the same place. Each step sorts with `ORDER BY ...
LIMIT` in a subquery, so Postgres keeps only the top rows instead of sorting all 15,770 rows that
match `milk`.

On the demo, `rank` is the number of barcodes that share a name. It favors product lines sold in
many sizes: `cheerios` lists Frosted Cheerios before plain Cheerios, and `strawb` lists Skittles
first (rank 20). What `rank` means for your data is up to your `search.source`.

## One row per product

One USDA product can have many barcodes: M&M'S MILK CHOCOLATE CANDIES has 114. Without
collapsing, the top results for `milk` were one product repeated. `search.query_distinct` keeps
the best row of each group (`group_key`, or the normalized name when `group_key` is null) at that
row's position. This is Algolia's `distinct: true` with `attributeForDistinct`. It collapses only
the first 1000 matches, so a broad query can return fewer rows than asked: `chocolate` returns 48
products, not 50. Algolia's option of several rows per group has no equivalent here.

## Word similarity and the threshold

`similarity` compares two whole strings. `word_similarity` compares the query with the part of the
name that matches it best. For `cherios` against "Honey Nut Cheerios Medley Crunch Cereal",
`similarity` is 0.184 and `word_similarity` is 0.700. Queries are short and USDA names are long,
so whole-string similarity would miss most typos at any useful threshold. Rows whose name scores
at or above each threshold:

| query         | 0.4    | 0.5   | 0.6   |
|---------------|-------:|------:|------:|
| cheerois      | 33,668 | 390   | 0     |
| stawberry jam | 10,929 | 1,826 | 154   |
| peanut buter  | 12,904 | 8,381 | 6,946 |
| dortios       | 41     | 3     | 0     |

At pg_trgm's default of 0.6, `cheerois` finds nothing. At 0.4 none of these queries found
anything new, `dortios` still found no Doritos, and `cheerois` had 86 times as many candidates. So
it is 0.5.

## Transposed letters

`dortios` scores 0.375 against DORITOS, under the threshold, and 0.500 against DORTMUNDER, so the
typo step returns GREAT LAKES BREWING DORTMUNDER GOLD BEER LAGER MUSTARD. `cheerois` scores 0.556
against CHEERIOS and is found, but CHEERFUL scores the same, so `rank` decides between them.
Algolia counts a swap of two letters as one typo, so it would match both. A word-level correction
step would fix this; it is not in this version.

## Splitting words

Postgres's default parser reads letters joined by a dot or a slash as one host or file name:
`S.PELLEGRINO` is indexed as `s.pellegrino` and `BUTTER/OREO` as `butter/oreo`, so neither word
can be found. Both vectors are therefore built from the words `search.tokens` returns, the same
split every query gets. `pellegrino` found 8 of the 106 names containing it before this change and
43 after; the other 63 spell it SANPELLEGRINO.

Two side effects. A unit glued to a decimal splits at the dot, so "1.5OZ" is indexed as "1" and
"5oz". Owner names split too: "Dr. Pepper/Seven Up, Inc." now indexes `pepper`, so 7 of the top 10
for `pepper` are that company's drinks, among them Sunkist, 7UP and Canada Dry ([Jev](jev.md)).

## Typos of very common words are slow

The typo step's cost depends on how many rows share the query's trigrams, not on the query's
length. `chocolatte` scores 0.750 against MILK CHOCOLATE, so it matches 39,149 rows and scores
each one. Warm, `search.query_distinct('chocolatte')` takes 349 to 356 ms and
`search.facets('chocolatte')` 1.24 to 1.26 s; the page sends both at once and waits about 1.25 s.
Before autoanalyze ran, the planner chose a sequential scan and each call took 1.4 to 1.9 s. The
threshold does not help, since 0.750 is above both 0.5 and 0.6.

Set a `statement_timeout` for the role that searches; the demo server uses 5 seconds. A GiST
trigram index read with `ORDER BY typo_q <<-> name LIMIT n` would avoid scoring every candidate,
but it is untested here.
