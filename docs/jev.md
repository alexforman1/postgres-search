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

Measured on 2026-10-07 with `jev-1.13.0` in five runs of `scripts/compare.ts` over 615 queries. The
[README](../README.md#4-results) gives the method, the statistical tests and the figures, and
[`results/report.md`](../results/report.md) has every number.

| hit@1, median of five runs | hand-written (50) | held-out (50) | synthetic (500) |
|----------------------------|------------------:|--------------:|----------------:|
| this SQL | 82% | 64% | 68% |
| + keep or sink | 86% | 68% | 73% |
| + "Did you mean", one click | 92% | 86% | 77% |
| + both, one click | 96% | 90% | 79% |

On the 550 queries nothing was tuned on (held-out and synthetic), keep or sink (72% against 68%)
and "Did you mean" (78% against 68%) are both significant after Holm's correction. "Did you mean"
appeared on the same 12 of the 50 hand-written queries in every run, all misspellings, each with
the intended word, among them `parmesean`, `dortios`, `gaucamole`, `tortila chips` and
`choclate milk`, which the SQL alone cannot fix.

A Norvig-style dictionary corrector over `search.words` beats the spelling question on
single-edit non-word misspellings (85% against 78% hit@1 out of sample). The spelling question is
better where the misspelling is itself a word some product uses, which that corrector keeps by
design, and on the held-out set it made no wrong suggestion where that corrector respelled
`hellmanns` and `kelloggs`. On the 220 correctly spelled controls the two tie at 2 respellings
each; a frequency rule respelled 84.

## Cost and time

TypeSafe charges \$0.042 per million input tokens for `jev-1.13.0`; output tokens are free
([models](https://docs.typesafe.ai/models)). Five runs pooled, 3,075 queries:

| call | sent on | ms, median | ms, p90 |
|------|--------:|-----------:|--------:|
| keep or sink, 10 results judged | 94% of searches | 162 | 207 |
| spelling, median 7 options | 88% of searches | 157 | 202 |

On the hand-written queries a search used 1,912 input tokens on average, \$0.080 per 1,000
searches; across the four query sets it was \$0.077 to \$0.089 per 1,000. The two calls run at the
same time, so the page waits for the slower one: the step adds 166 ms at the median and 219 ms at
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

`search.words` lists every word products use, with the number of products that use it.
`search.similar_words(q)` returns, for each query word, up to 8 words spelled close to it (trigram
similarity 0.3 or more), closest first. It skips words under four letters and words with digits,
whose few trigrams match too much, and stop words, which the search ignores. It offers only words
that more products use than the typed word, so a common, correctly spelled word usually gets no
options and no Jev call. And it leaves out words that only finish the typed word, because the
prefix step already finds those. That last rule came from the eval: `blueb muff` was offered
"blueberry muff", which finds less than the prefix step did.

`spellings()` in `src/spelling.ts` turns those rows into options: the query as typed, then the
query with one word changed, every word's closest alternative before any word's second, up to 16
options. For `parmesean`, the request is:

```json
{
  "model": "jev-latest",
  "state": {
    "query": "parmesean",
    "note": "A user typed `query` into the search box of a grocery and packaged food product search."
  },
  "questions": {
    "meant": {
      "type": "choice",
      "instructions": "Which of these searches did the user mean to type? Pick the one that is spelled the way the user intended. The first option is exactly what they typed.",
      "criteria": {
        "s0": "\"parmesean\"", "s1": "\"parmesan\"", "s2": "\"parmesano\"", "s3": "\"parmela\"",
        "s4": "\"parm\"", "s5": "\"parma\""
      }
    }
  }
}
```

The answer's `probabilities` gives each option a share of 1. A respelling with 0.6 or more becomes
the suggestion; `parmesan` got 0.71 to 0.79 in five runs. The page shows it as a link and never
searches it without a click. The `note` tells Jev what the catalog holds; the default says "a
product search box", and the demo names groceries. Say what your search holds.

This question needs only the query, so the server sends it while Postgres is still searching. It
also runs when the search returns one result or none, where question 1 is skipped. A filter click
repeats the search with the same words, so it does not ask the question again.

The 0.6 bar was set before `eval/spelling.json` was scored. Before that, a probe of 15 queries, 14
of them from `eval/queries.json`, gave the intended respelling 0.68 or more on all 7
misspellings, and the query as typed won on the other 8 with 0.60 to 1.00. So the "Did you mean"
results on `eval/queries.json` are not held out; the `eval/spelling.json` results are.

## No match

`rerank` returns `noMatch` when Jev scores every top result below the threshold and none of them
holds the typed words, in order and from the start of a word, in its name or other names. The
check ignores accents and the spaces and punctuation between words, so "almond milk" is found in
ALMONDMILK and "jalapeno" in JALAPEÑO. Jev judges products, so for a brand typed alone
(`general mills`) or an unfinished word (`strawb`) it scores every product low; the typed-words
check keeps the line off those pages. The demo shows the line only when there is no suggestion,
and the results stay on the page.

In the five runs the page said that nothing matches for 12 of the 15 household goods in
`eval/absent.json`, and for 27 to 32 of the 600 answerable queries, 4 to 6 of them with a match in
the top 10. Plain full-text search shows an empty page for 12 of the 15 too, but also for 314 of the
600. The flag changed between runs on 14 of the 51 queries where it was raised at least once.

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

- Answers move between identical runs: over five runs, the suggestion changed for 10% of the
  queries that got one in any run, and a probability by up to 0.18. A respelling near 0.6 can be
  suggested on one run and not the next.
- One word is respelled per option, so a query with two misspelled words is not fixed.
- Respellings come from trigrams, which miss some swaps: for `granloa`, granola is not among the 8
  closest words, so Jev never sees it.
- Jev declines many single-edit misspellings that a dictionary corrector fixes: of 300 synthetic
  ones it fixed 172 to 177, guessed wrong on 14 to 18 and declined the rest. Among the held-out
  words, `marshmellow`, `jalepeno`, `funyons` and `skittels` got no suggestion in any run.
- The no-match line needs question 1, so a page with a single wrong result shows no line.
- The thresholds were not tuned beyond what is described here. `jev-latest` is an alias that moves
  when TypeSafe ships a new release, so pin the versioned model your thresholds were checked
  against with `JEV_MODEL`, as [TypeSafe's models page](https://docs.typesafe.ai/models)
  recommends.

## Measure it yourself

Put `TYPESAFE_API_KEY` in `.env` (it is in `.gitignore`) and run:

```sh
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/eval.ts      # the 50 eval queries, under a cent
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts   # all 615 queries, about $0.065
node scripts/report.ts                                          # tables and figures from results/
```

The eval adds the Jev columns, the cost and time lines, the suggestions it made, and the spelling
and absent tables. The comparison writes one file per run to `results/`, and the report builds
`results/report.md` and the figures from every file there.

To use the step in another server language, port `skills/postgres-search/rerank.ts`, which holds
all of `src/jev.ts`, `src/rerank.ts`, `src/spelling.ts` and `src/tokens.ts` in one file. Keep the
key on the server.
