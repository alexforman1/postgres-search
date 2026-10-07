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

Measured on 2026-10-07 on the full USDA load (2025-12-18 release) with `jev-1.13.0`, over three
runs of the eval. This table was the same in all three ([measurements](measurements.md#jev)):

| on `eval/queries.json`, 50 queries       | hit@1 | hit@3 | hit@10 |
|------------------------------------------|------:|------:|-------:|
| Postgres order                           | 82%   | 84%   | 88%    |
| with Jev's keep or sink                  | 86%   | 88%   | 88%    |
| and following "Did you mean" when shown  | 96%   | 98%   | 98%    |

"Did you mean" appeared on 11 of the 50 queries, all misspellings, and each suggestion was the
intended word. It fixes the misses the typo step cannot: `parmesean`, `gaucamole`,
`tortila chips` and `choclate milk`, whose misspellings some product also carries, and `dortios`,
whose swapped letters score under the trigram cutoff.

The spelling question was also scored on `eval/spelling.json`, 30 misspellings and 20 correctly
spelled words written for this test and kept out of every probe. Jev suggested the intended
spelling for 23 to 25 of the 30 misspellings, suggested nothing for all 20 correct words, and
never suggested a wrong word. The table compares it with a simple rule (respell a word to its most
common close word when that word is used ten times as often):

|                                   | Jev        | frequency rule |
|-----------------------------------|-----------:|---------------:|
| misspellings fixed, of 30         | 23 to 25   | 22             |
| correct words left alone, of 20   | 20         | 12             |
| wrong suggestions                 | 0          | 16             |

The rule's wrong suggestions include `fritos` to "frito", `harissa` to "harris", `lemonaid` to
"lemon" and `tostitoes` to "tomatoes". Jev left the first two alone and fixed the other two.

The no-match line appeared for 10 of the 15 household goods in `eval/absent.json`, such as
`shampoo` (first result: SHAMROCK FARMS ORIGINAL SOUR CREAM) and `motor oil` (first result: a
MOTOR CITY MIX popcorn). Of the other five, two returned no results, one returned a single result,
and two returned products that do carry the words: a jelly bean mix with a TOOTHPASTE flavor,
and LIGHT BULBS icing decorations. On the 50 eval queries the line appeared once, for `peanut buter`, whose top 10 are
peanut butter cookies, crackers and pretzels rather than peanut butter.

## Cost and time

TypeSafe charges $0.042 per million input tokens for `jev-1.13.0`; output tokens are free
([models](https://docs.typesafe.ai/models)). On the 50 eval queries:

| call                 | ran on | input tokens, median | ms, median | ms, p90    |
|----------------------|-------:|---------------------:|-----------:|-----------:|
| keep or sink         | 44     | 1,827                | 153 to 165 | 183 to 209 |
| spelling             | 47     | 494                  | 155 to 170 | 196 to 212 |

Averaged over every search, including those where a call was skipped, the step costs $0.000087
per search, or about 9 cents per 1,000 searches. The spelling question is about $0.00002 of that.

The two calls run at the same time, so the page waits for the slower one. Compared with the
Postgres query alone, the step adds 157 to 168 ms at the median and 203 to 216 ms at the 90th
percentile. Before the spelling question was added, the keep or sink call alone added 160 to 164
ms and cost $0.000065 per search, so the second question costs time only when it is the slower of
the two. These times are network round trips from one machine; measure from your own servers.

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
whose few trigrams match too much, and it leaves out words that only finish the typed word,
because the prefix step already finds those. That last rule came from the eval: `blueb muff` was
offered "blueberry muff", which finds less than the prefix step did.

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
        "s4": "\"parm\"", "s5": "\"parmeasn\"", "s6": "\"parmezen\"", "s7": "\"parma\"",
        "s8": "\"parmaesan\""
      }
    }
  }
}
```

The answer's `probabilities` gives each option a share of 1. A respelling with 0.6 or more becomes
the suggestion; `parmesan` got 0.71 to 0.77 in the three runs. The page shows it as a link and never
searches it without a click. The `note` tells Jev what the catalog holds; the default says "a
product search box", and the demo names groceries. Say what your search holds.

This question needs only the query, so the server sends it while Postgres is still searching. It
also runs when the search returns one result or none, where question 1 is skipped.

The 0.6 bar was set before `eval/spelling.json` was scored. Before that, a probe of 15 queries, 14
of them from `eval/queries.json`, gave the intended respelling 0.68 or more on all 7
misspellings, and the query as typed won on the other 8 with 0.60 to 1.00. So the "Did you mean"
results on `eval/queries.json` are not held out; the `eval/spelling.json` results are.

## No match

`rerank` returns `noMatch` when Jev scores every top result below the threshold and none of them
holds the typed words, in order and each at the start of a word, in its name or other names. Jev
judges products, so for a brand typed alone (`general mills`) or an unfinished word (`strawb`) it
scores every product low; the typed-words check keeps the line off those pages. The demo shows the
line only when there is no suggestion, and the results stay on the page.

The typed-words check was added after the eval showed the line on `general mills`, `kraft heinz`
and `strawb`, so the one false line in 50 queries is a count after that fix. Before the check, the
line also appeared for 12 of the 15 household goods; the check removed it from `toothpaste` and
`light bulbs`, whose results carry those words.

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
every candidate, or a spelling answer without probabilities. Each question is one request with no retry. `rerank` returns
`{ results, sunk, reranked, noMatch, ms, error, model, inputTokens }` and `checkSpelling` returns
`{ suggestion, p, ran, ms, options, error, model, inputTokens }`, so the page can show whether
Jev ran and how long it took.

## Limits

- Probabilities move between runs, by up to 0.12 in the three runs, so a respelling near 0.6 can
  be suggested on one run and not the next (`vinegarette` got 0.59 on one run and 0.60 on
  another).
- One word is respelled per option, so a query with two misspelled words is not fixed.
- Respellings come from trigrams, which miss some swaps: for `granloa`, granola is not among the 8
  closest words, so Jev never sees it.
- Jev declined some real misspellings: `fettucine`, `funyons`, `skittels` and `jalepeno` stayed
  under 0.6 in all three runs, and `cappucino` in two.
- The no-match line needs question 1, so a page with a single wrong result shows no line.
- The thresholds were not tuned beyond what is described here. `jev-latest` is an alias that moves
  when TypeSafe ships a new release, so pin the versioned model your thresholds were checked
  against with `JEV_MODEL`, as [TypeSafe's models page](https://docs.typesafe.ai/models)
  recommends.

## Measure it yourself

Put `TYPESAFE_API_KEY` in `.env` (it is in `.gitignore`) and run:

```sh
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/eval.ts
```

The eval adds the Jev columns, the cost and time lines, the suggestions it made, the spelling and
absent tables, and what the run cost. One run makes about 160 Jev calls and costs under a cent.

To use the step in another server language, port `skills/postgres-search/rerank.ts`, which holds
all of `src/jev.ts`, `src/rerank.ts`, `src/spelling.ts` and `src/tokens.ts` in one file. Keep the
key on the server.
