# The Jev step

[Jev](https://docs.typesafe.ai) is a hosted model from TypeSafe. It answers typed questions about
a piece of state. This step uses its Noul question type, whose answer is a probability between 0
(no) and 1 (yes). Get a key from https://console.typesafe.ai and set `TYPESAFE_API_KEY` where the
server runs. Without a key, the demo and the eval skip the step and use the Postgres order.

The step lives in `src/rerank.ts`, with the HTTP call in `src/jev.ts`. It runs on the results page
only, after `search.query_distinct`. `JEV_MODEL` sets the model (default `jev-latest`) and
`JEV_THRESHOLD` the threshold (default 0.3).

## The request

One `POST https://api.typesafe.ai/v1/systemone` per search, with the top 10 results as candidates
and one Noul question per candidate. For `crackers` with two candidates, the body is:

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

The answer holds `answers.c0.noul` and `answers.c1.noul`.

## Keep or sink, never sort

Candidates at or above the threshold keep their order. Candidates below it move to the bottom of
the 10, also in their original order. Results past the 10th are not touched. The step never sorts
by score: a correct product scores near 1 whether it is the best match or a close variant, so
sorting would reorder good results on noise. The Postgres order stays in charge: Jev can only move
a candidate down within the top 10.

These are the cases it is meant for. All come from the word step on the USDA data (2025-12-18
release), as the top 10 of `search.query_distinct(q, '{}', 10)` joined to `search.documents`:

- `pepper`: 7 of the top 10 are drinks from Dr. Pepper/Seven Up, Inc., matched through the owner
  name. Position 1 is a product named only SODA. Sunkist, 7UP and Canada Dry are also there.
  Pepper itself appears only as a flavor: salt and pepper nuts and a roasted red pepper hummus.
- `cream`: sour cream and onion or cheddar and sour cream potato chips hold positions 1, 3, 7, 9
  and 10.
- `crackers`: position 1 is a product named CRACKERS, which is Barnum's Animals, filed under
  Cookies & Biscuits.
- `apple`: position 2 is SKITTLES ORIGINAL (one flavor is green apple), and position 5 is a gummy
  bear mix that includes apple.

What Jev does with these cases was not measured for this release, because no key was available.
To measure it, put `TYPESAFE_API_KEY` in `.env` (it is in `.gitignore`) and run:

```sh
node --env-file=.env scripts/eval.ts
```

With a key, the eval adds `jev hit@1` and `jev hit@3` columns and a count of calls that reranked,
were skipped, or failed. Jev's hit@10 always equals the plain hit@10, because it only reorders the
top 10. The 0.3 default was not calibrated on this data; rerun the eval with other `JEV_THRESHOLD`
values to choose one. `jev-latest` is an alias that moves when TypeSafe ships a new release, so
once a threshold is tuned, pin the versioned model it was tuned against with `JEV_MODEL`, as
[TypeSafe's models page](https://docs.typesafe.ai/models) recommends.

## When the call is skipped

The call is skipped when fewer than 2 results come back, or when all of the top 10 share one
group. The group is `group_key`, or the normalized name when `group_key` is null. Rows in one group
are the same thing, such as pack sizes of one product, so their scores would differ only by
noise. The demo sends rows from `search.query_distinct`, which already has one row per group, so
on the demo only the first rule applies.

## Fail open

Every failure keeps the Postgres order: a missing key, a network error, a non-2xx response, the
1.5-second timeout, a threshold that is not a number, or an answer without a numeric score for
every candidate. There is one request and no retry. `rerank` returns `{ results, sunk, reranked,
ms, error }`, so the page can show whether Jev ran and how long it took.

To use the step in another server language, port `skills/postgres-search/rerank.ts`, which holds
both files in one. Keep the key on the server.
