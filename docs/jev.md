# The Jev step

[Jev](https://docs.typesafe.ai) is a hosted model from TypeSafe. It answers typed questions about
a piece of state and returns probabilities, not text. The Jev step asks it two questions on each
search:

1. **Is each of the top 10 results what the user meant?** One Noul (yes or no) question per
   result. Results Jev rejects move to the bottom of the 10.
2. **Which spelling did the user mean?** One Choice question over the query as typed and close
   respellings that products use. A respelling Jev picks becomes a "Did you mean" link.

When Jev rejects every top result and nothing better is spelled close by, the page also says that
none of the results matches.

Get a key from https://console.typesafe.ai and set `TYPESAFE_API_KEY` where the server runs.
Without a key, the demo and the eval skip the step and use the Postgres order. The code is in
`src/rerank.ts` (question 1), `src/spelling.ts` (question 2) and `src/jev.ts` (the HTTP call).
`JEV_MODEL` sets the model (default `jev-latest`) and `JEV_THRESHOLD` the keep or sink threshold
(default 0.3).

## What it changes

Measured on 2026-10-07 with `jev-1.13.0` in five runs of `scripts/compare.ts` over 3,188 queries.
Version 2.2 of the spelling question was frozen before its two test sets, synthetic test 3 and
truncation 2, were made. The [README](../README.md#4-results) gives the method, the statistical
tests and the figures, and [`results/report.md`](../results/report.md) has every number.

| hit@1, median of five runs | hand-written (50) | synthetic test 3 (500) | truncation 2 (300) | Wikipedia (473) |
|----------------------------|------------------:|-----------------------:|-------------------:|----------------:|
| this SQL | 82% | 62% | 75% | 42% |
| + keep or sink | 86% | 69% | 73% | 48% |
| + "Did you mean", one click | 92% | 83% | 76% | 70% |
| + both, one click | 96% | 84% | 74% | 70% |
| Norvig-style corrector instead, one click | 82% | 83% | 30% | 64% |

On synthetic test 3, keep or sink (69% against 62%) and "Did you mean" (83% against 62%) are both
significant after Holm's correction, and "Did you mean" ties the dictionary corrector (83% each).
That set matches the corrector's own error model. On words cut short as a user types them, "Did
you mean" leaves the prefix step's results alone (76% against 75% for this SQL), while the
corrector respells them and finds the right product for 30%. On real misspellings from Wikipedia,
a test set for version 2, Jev leads 70% to 64%, and 84% to 31% on the 32 misspellings that are
themselves words some product uses.

## Cost and time

TypeSafe charges \$0.042 per million input tokens for `jev-1.13.0`; output tokens are free
([models](https://docs.typesafe.ai/models)). Five runs pooled, 15,940 queries:

| call | sent on | ms, median | ms, p90 |
|------|--------:|-----------:|--------:|
| keep or sink, 10 results judged | 94% of searches | 168 | 214 |
| spelling, median 7 options | 73% of searches | 165 | 208 |

On the hand-written queries a search used 1,969 input tokens on average, \$0.083 per 1,000
searches; across the ten query sets it was \$0.077 to \$0.097 per 1,000. The two calls run at the
same time, so the page waits for the slower one: the step adds 173 ms at the median and 223 ms at
the 90th percentile to the Postgres query. These are round trips from one machine; measure from
your own servers.

## Question 1: keep or sink, never sort

One `POST https://api.typesafe.ai/v1/systemone` with the top 10 results as candidates and one Noul
question per candidate. For `crackers` with two candidates, the body is:

```json
{
  "model": "jev-latest",
  "state": {
    "query": "crackers",
    "note": "A user typed the query into a product search box. Each candidate is a record the search returned.",
    "candidates": [
      { "index": 0, "name": "CRACKERS", "other_names": "BARNUM'S ANIMALS",
        "facets": { "category": "Cookies & Biscuits" } },
      { "index": 1, "name": "CHEEZ-IT ORIGINAL BAKED SNACK CRACKERS, ORIGINAL",
        "other_names": "Sunshine Biscuits, Inc.",
        "facets": { "brand": "CHEEZ-IT", "category": "Flavored Snack Crackers" } }
    ]
  },
  "questions": {
    "c0": {
      "type": "noul",
      "instructions": "Is candidate 0 what the user was looking for?",
      "criteria": {
        "true": "Candidate 0 is the product the query names or describes, allowing for typos and abbreviations.",
        "false": "Candidate 0 only shares letters or a word with the query, or is a different product."
      }
    },
    "c1": {
      "type": "noul",
      "instructions": "Is candidate 1 what the user was looking for?",
      "criteria": {
        "true": "Candidate 1 is the product the query names or describes, allowing for typos and abbreviations.",
        "false": "Candidate 1 only shares letters or a word with the query, or is a different product."
      }
    }
  }
}
```

The answer holds `answers.c0.noul` and `answers.c1.noul`. Candidates at or above the threshold
keep their order. Candidates below it move to the bottom of the 10, also in their original order.
Results past the 10th are not touched. The step never sorts by score: a correct product scores
near 1 whether it is the best match or a close variant, so sorting would reorder good results on
noise. Jev can only move a candidate down within the top 10.

A Choice question over the results does not work here, because several results are usually right
at once. Asked to choose among the top 10 for `oreo`, Jev gave 0.99 to one Oreo product and almost
nothing to nine other Oreo products, so a rule that sinks low choices would sink real matches.
For `crackers` it chose "none of these" at 0.52 over a list of crackers. One Noul per result asks
about each result on its own, which is the question a product search needs.

These are the cases the question is meant for, from the word step on the USDA data:

- `pepper`: 7 of the top 10 are drinks from Dr. Pepper/Seven Up, Inc., matched through the owner
  name. Position 1 is a product named only SODA.
- `cream`: sour cream and onion or cheddar and sour cream potato chips hold positions 1, 3, 7, 9
  and 10.
- `crackers`: position 1 is a product named CRACKERS, which is Barnum's Animals, filed under
  Cookies & Biscuits.
- `apple`: position 2 is SKITTLES ORIGINAL (one flavor is green apple), and position 5 is a gummy
  bear mix that includes apple.

## Question 2: did you mean

`search.words` lists every word products use: how many products' names hold it, its English stem,
and how many products the word step finds for it. `search.similar_words(q)` returns, for each query
word, up to 8 candidates: every word one edit away (`search.edits1`: a letter added, removed or
replaced, or two neighbors swapped), most found first, then trigram neighbors with similarity 0.3
or more, closest first. It skips words under four letters, words with digits and stop words. A
word that the search finds in no product but that starts some word in the index gets no
candidates: the user may still be typing it, and the prefix step already shows the products of the
words it starts (`strawb`, strawberries; `captai`, Captain's). For any other word, a candidate must
have a different stem from the typed word and must be found in more products than both the typed
word and the most common word, of another stem, that starts with the typed word. Counting what the search finds, not how often the word itself appears, keeps possessives such as
`hellmanns` from looking misspelled: the search finds 85 HELLMANN'S products for it.

`checkSpelling()` in `src/spelling.ts` turns those rows into options, the query as typed and then
the query with one word changed, every word's closest candidate before any word's second, up to
16, and tells Jev for each option how many edits separate it from what was typed and how many
products the search finds for its words. For `parmesean`, the request is:

```json
{
  "model": "jev-latest",
  "state": {
    "query": "parmesean",
    "note": "A user typed `query` into the search box of a grocery and packaged food product search.",
    "evidence": "Each option says how many edits separate it from what was typed, where an edit is one letter added, removed or replaced or two neighboring letters swapped, and how many of the catalog's products the search finds for the words it changes. A word the search finds in no product is not a word this catalog uses, so searching it shows nothing."
  },
  "questions": {
    "meant": {
      "type": "choice",
      "instructions": "Which of these searches did the user mean to type? Pick the one that is spelled the way the user intended. The first option is exactly what they typed.",
      "criteria": {
        "s0": "\"parmesean\", exactly as typed. The search finds parmesean in 1 product.",
        "s1": "\"parmesan\", 1 edit from what was typed. The search finds parmesan in 2,732 products.",
        "s2": "\"parmesano\", 2 edits from what was typed. The search finds parmesano in 2 products.",
        "s3": "\"parmela\", 3 edits from what was typed. The search finds parmela in 17 products.",
        "s4": "\"parm\", 5 edits from what was typed. The search finds parm in 65 products.",
        "s5": "\"parma\", 4 edits from what was typed. The search finds parma in 26 products."
      }
    }
  }
}
```

The answer's `probabilities` gives each option a share of 1. The likeliest respelling becomes the
suggestion when Jev finds it at least twice as likely as the spelling typed and at least 0.3
likely (`ratio` and `suggestAt` change both). Comparing it with the typed spelling rather than with
a fixed bar keeps a suggestion when Jev splits the rest among several close words. The page shows
it as a link and never searches it without a click. The `note` tells Jev what the catalog holds;
the default says "a product search box", and the demo names groceries. Say what your search holds.

This question needs only the query, so the server sends it while Postgres is still searching. It
also runs when the search returns one result or none, where question 1 is skipped. A filter click
repeats the search with the same words, so it does not ask the question again.

### How this design came about

The first version offered only trigram neighbors, showed Jev the bare spellings, and suggested at
0.6. On 300 synthetic misspellings it fixed 174 and lost to a Norvig-style dictionary corrector,
which fixed 272. Two causes accounted for most of the gap: 40 intended words were never among the
options, and 75 were offered but declined, because Jev could not tell a misspelling from a rare
brand without knowing which spellings the catalog uses. The one-edit candidates, the counts, the
edits and the twice-as-likely rule fix those; the rule was chosen with `scripts/spelling-rules.ts`
on the development sets. That version 2 was frozen and tested on two sets made afterwards.

Version 2 then showed one more fault: on a word cut short it barred the full word as a candidate,
so Jev chose another nearby word (`strawb`, "straw"; `shee`, "ghee") and pulled the user away
from the prefix step's right results. Version 2.1 kept those candidates unless they beat the most
common completion, and allowed one-letter completions. It failed on a test set of 300 words cut
short, made after it was frozen: it still offered a nearby word for most of them (`yellowf`,
"yellow"; `orna`, "orca") and found the right product less often than the SQL alone. Version 2.2
gives no candidates to a word that finds nothing but starts an index word, and leaves it to the
prefix step. It was frozen and tested on two more sets made afterwards. The
[README](../README.md#4-results) reports every stage.

## No match

`rerank` returns `noMatch` when Jev scores every top result below the threshold and none of them
holds the typed words, in order and from the start of a word, in its name or other names. The
check ignores accents and the spaces and punctuation between words, so "almond milk" is found in
ALMONDMILK and "jalapeno" in JALAPEÑO. Jev judges products, so for a brand typed alone
(`general mills`) or an unfinished word (`strawb`) it scores every product low; the typed-words
check keeps the line off those pages. The demo shows the line only when there is no suggestion,
and the results stay on the page.

In the five runs the page said that nothing matches for 12 of the 15 household goods in
`eval/absent.json`, and for 106 to 108 of the 3,173 answerable queries, 7 to 9 of them with a
match in the top 10. Plain full-text search shows an empty page for 12 of the 15 too, but also for
2,038 of the 3,173. The flag changed between runs on 83 of the 300 queries where it was raised at
least once.

The typed-words check was added after the eval showed the line on `general mills`, `kraft heinz`
and `strawb`. Before the check, the line also appeared for `toothpaste` and `light bulbs`, whose
results carry those words.

## When a call is skipped

Question 1 is skipped when fewer than 2 results come back, or when all of the top 10 share one
group. The group is `group_key`, or the normalized name when `group_key` is null. Rows in one group
are the same thing, such as pack sizes of one product, so their scores would differ only by noise.
The demo sends rows from `search.query_distinct`, which already has one row per group, so on the
demo only the first rule applies.

Question 2 is skipped when no query word has a close spelling: every word is under four letters,
has a digit, or matches nothing in `search.words`.

## Fail open

Every failure leaves the page as Postgres made it: a missing key, a network error, a non-2xx
response, the 1.5-second timeout, a threshold that is not a number, an answer without a score for
every candidate, or a spelling answer without probabilities. Each question is one request with no
retry. `rerank` returns `{ results, sunk, reranked, noMatch, scores, ms, error, model, inputTokens }`
and `checkSpelling` returns `{ suggestion, p, ran, ms, options, probabilities, error, model,
inputTokens }`, so the page can show whether Jev ran and how long it took.

## Limits

- Answers move between identical runs: over five runs, the suggestion changed for 2% of the
  queries that got one in any run, and the no-match flag for 28% of those where it was raised.
- One word is respelled per option, so a query with two misspelled words is not fixed.
- A word whose last letter was dropped is left to the prefix step, which finds the full word
  unless the cut text is itself a word, or has the stem of one: `monke` finds MONK FRUIT
  sweeteners through the word step, and the prefix step never runs.
- On rare brand names Jev tends to choose a common word (`foyster` to "oyster" for foster,
  `djraft` to "kraft" for draft), where a dictionary corrector picks the closest known word.
- The no-match line needs question 1, so a page with a single wrong result shows no line.
- The keep-or-sink threshold was not tuned, and the suggestion rule was chosen on the development
  sets only. `jev-latest` is an alias that moves
  when TypeSafe ships a new release, so pin the versioned model your thresholds were checked
  against with `JEV_MODEL`, as [TypeSafe's models page](https://docs.typesafe.ai/models)
  recommends.

## Measure it yourself

Put `TYPESAFE_API_KEY` in `.env` (it is in `.gitignore`) and run:

```sh
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/eval.ts      # the 50 eval queries, under a cent
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts   # all 3,188 queries, about $0.29
node scripts/report.ts                                          # tables and figures from results/
```

The eval adds the Jev columns, the cost and time lines, the suggestions it made, and the spelling
and absent tables. The comparison writes one file per run to `results/`, and the report builds
`results/report.md` and the figures from every file there.

To use the step in another server language, port `skills/postgres-search/rerank.ts`, which holds
all of `src/jev.ts`, `src/rerank.ts`, `src/spelling.ts` and `src/tokens.ts` in one file. Keep the
key on the server.
