# Typeahead

`search.suggest(q, lim => 8)` returns up to `lim` rows of `name`, `id` and `doc_count`. Examples
use the USDA Branded Foods release of 2025-12-18.

## Names that start with the input come first

`search.suggest` first lists names from `search.names` whose normalized name starts with the
input, most documents first, then alphabetically. If that gives fewer than `lim` names, and the
longest typed word has 4 or more letters, it fills the rest from `search.query(q, '{}', 1000)`,
one row per name, in search order.

Typed input is usually a partial word, and the word step answers a partial word with any rare whole
word or abbreviation that matches it. `search.query('che')` returns 4 rows, all from the word
step: CHE-CRI GOUDA CHEESE CRISPS, a beef jerky called CHE-POTLE GUEVARA, PETITS PAINS BRIO-CHE
SLIDER BUNS and CHE! ARGENTINE MEAT MARINADE. `search.query('ore')` returns 106 rows led by
ORE-IDA potatoes. Completing names instead puts Oreo first:

```
SELECT name, doc_count FROM search.suggest('ore');

 OREO CHOCOLATE SANDWICH COOKIES, CHOCOLATE                          43
 OREO DOUBLE STUF CHOCOLATE SANDWICH COOKIES, DOUBLE STUF CHOCOLATE  10
 OREO GOLDEN DOUBLE STUF SANDWICH COOKIES, GOLDEN DOUBLE STUF         8
 OREO GOLDEN SANDWICH COOKIES, GOLDEN                                 8
 OREO CHOCOLATE MINI SANDWICH COOKIES, CHOCOLATE                      5
 ORE-IDA GOLDEN CRINKLES FRENCH FRIED POTATOES                        4
 ...
```

`doc_count` orders these names, so the `rank` column in `search.source` does not. `rank` only
orders the fill.

## Before and after

The previous version (commit `3f78545`) used `search.query` for any input of 4 or more
characters. `npm run eval` scores typeahead with `eval/suggest.json`: the first 4 and the first 5
letters of common food words, and 27 whole short words. A hit is a suggestion that matches the
case's pattern, for example a word starting with "cheese" for `chee`.

| input                  | cases | before hit@1 | before hit@8 | now hit@1 | now hit@8 |
|------------------------|------:|-------------:|-------------:|----------:|----------:|
| first 4 letters        | 49    | 35%          | 49%          | 90%       | 100%      |
| first 5 letters        | 50    | 38%          | 60%          | 100%      | 100%      |
| whole short word       | 27    | 89%          | 96%          | 85%       | 93%       |

Before, abbreviations in USDA names took over: `cinn` suggested GENERAL MILLS GMILLS CINN TST
CRNCH, `shrim` suggested SEA BEST 41/50 CKD P&D T/OFF SHRIM, and `ketch` suggested WESTERN FAMILY
EXTRA FANCY TOMATO KETCH UP.

Whole short words got worse. USDA names start with the brand, so a whole word can complete to a
brand that begins with it: `pear` suggests PEARSON'S SALTED NUT ROLL first and `cola` suggests
COLAVITA. `lamb` (LAMBERT'S SWEET RUB O'MINE BARBEQUE) and `fish` (FISHER CHOPPED WALNUTS) have no
lamb or fish products in their 8 suggestions.

Input made only of words of 3 letters or fewer never gets the fill. `pb and j` gets no suggestions
while typing. Pressing Enter still searches, and the word step finds 81 rows, led by WELCH'S PB&J
TRAIL MIX. The guard exists because the fill ran the typo step on a few trigrams: `aed`, `bld` and
`cng` took 462 to 930 ms, and `cng` suggested ground beef and ketchup. With the guard they return
nothing in 0.1 to 0.2 ms.

## Speed

Warm, on the full data: `suggest('milk')` 0.3 to 0.4 ms, `suggest('ch')` 1.7 to 1.8 ms,
`suggest('kiwi')` 5.4 to 5.5 ms (fewer than 8 names start with "kiwi", so it fills). A typo of a
common word goes through the typo step in the fill: `suggest('chocolatte')` takes 352 to 359 ms.
One letter earlier, `suggest('chocolatt')` takes about 1 ms, because the prefix step finds 2 rows
and the typo step never runs.

## No Jev here

The page asks for suggestions 120 ms after each keystroke. A Jev call is a network round trip with
a 1.5-second timeout, added to a query that takes 0.3 to 1.8 ms for `milk` and `ch`.

## Stale answers

Two requests can finish out of order, and a late answer must not replace a newer list. `suggest()`
in `public/app.js` numbers each request:

```js
const id = ++suggestId
...
if (id !== suggestId || q !== input.value.trim()) return
```

An answer is dropped if a newer request started or the text changed while it was in flight.
Closing the list (Escape, blur, a search) also increments `suggestId`, so an answer that arrives
after the list closed is dropped too. A failed request closes the list, unless a newer request has
started.
