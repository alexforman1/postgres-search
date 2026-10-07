# postgres-search

Product search inside PostgreSQL: whole words, partial words, typos, barcodes, typeahead and facet
counts, all in SQL, with an optional second stage that asks [Jev](https://docs.typesafe.ai), a
hosted model that returns probabilities instead of text, two questions per search. This README is also
a report on how much that second stage helps, where it does not, what it costs, and how it compares
with Algolia.

[Try it](#try-it) · [Use it with your data](#use-it-with-your-data) · [The guide](#the-guide)

## Contents

1. [Summary](#summary)
2. [System](#2-system)
3. [Method](#3-method)
4. [Results](#4-results)
5. [Failure analysis](#5-failure-analysis)
6. [Discussion](#6-discussion)
7. [Cost, and the comparison with Algolia](#7-cost-and-the-comparison-with-algolia)
8. [Threats to validity](#8-threats-to-validity)
9. [Reproducing the results](#9-reproducing-the-results)
10. [References](#references)

## Summary

We compare three ways to search the 440,302 products of the USDA Branded Foods release: PostgreSQL
full-text search as its manual presents it, this repository's SQL, and this SQL followed by Jev.
The test is 615 queries in four sets, among them 500 one-edit misspellings and controls generated
from a fixed seed before any model saw them. Each system ran five times with the model pinned to
`jev-1.13.0`.

On the 550 queries nothing was tuned on, the right product came first for 37% of queries with
plain full-text search and 68% with this SQL. Jev's keep-or-sink reorder raised that to 72%
(p = 0.0002, Holm-corrected), its "Did you mean" link alone to 78% when followed (p < 0.0001), and
the two together to 80%. The two Jev
questions take 162 ms and 157 ms at the median, run at the same time, and add 166 ms to the page.
They cost \$0.080 per 1,000 searches on the hand-written queries.

The results also show where a model is not the right tool. On non-word misspellings, a
dictionary corrector in the style of Norvig (2007), working from the index's own vocabulary,
fixed 91% to Jev's 59%, and it costs nothing. Jev's value lies in judgments that rules cannot make well:

- **Which results are wrong.** The reorder is significant on 550 queries.
- **When not to respell.** On the held-out set Jev's suggestions were all correct (precision
  100%), against 79% for the dictionary corrector, which changed `hellmanns` to "hellmann" and
  `kelloggs` to "kellogg". On the 220 correctly spelled controls the two tie, at 2 each; a
  frequency rule respelled 84.
- **Saying that nothing matches.** For 12 of 15 queries that have no answer in a grocery catalog,
  Jev says nothing matches; it says so for 30 of 600 queries that do have one.
- **Probabilities that can be thresholded.** When Jev gave a spelling 0.9 or more, it was right
  96.6% of the time, and raising the bar trades fixes for false alarms in a steady way. Below 0.7
  it is overconfident by 10 to 20 points.

For the 440,302 records of this demo, Algolia's published Grow price comes to \$136 a month for
records alone. The same search with Jev costs \$8.03 a month at 100,000 searches, before database
hosting.

## 2. System

### 2.1 Retrieval in SQL

`search.query(q, filters, lim)` runs four steps in order and returns the rows of the first step
that matches anything. Later steps never add rows to an earlier step's results, which keeps loose
fuzzy matches out of good results.

| step | matches | index | order |
|------|---------|-------|-------|
| code | an all-digit query of 4 or more digits, as a barcode prefix | btree, `text_pattern_ops` | code |
| word | every word, stemmed (`plainto_tsquery('english')`) | GIN on `search_vector` | exact name first, then `rank` |
| prefix | every word as a prefix (`word:*`) | GIN on `prefix_vector` | exact name first, then `rank` |
| typo | trigram word similarity of 0.5 or more | GIN trigram on `name` and `other_names` | similarity, then `rank` |

`search.query_distinct` keeps one row per group, `search.suggest` serves typeahead from
`search.names`, and `search.facets` counts facet values over the same rows `search.query` matched.
[The search steps](docs/search-steps.md) explains each choice and its cost.

### 2.2 The Jev step

Jev is a hosted model from TypeSafe. It answers typed questions about a piece of state and returns
probabilities, not text. The step asks two questions per search, each in one HTTP request, and
code, not the model, decides what reaches the page.

```mermaid
flowchart LR
  Q([query]) --> S["search.query_distinct<br/>code, word, prefix, typo"]
  Q --> W["search.similar_words<br/>close words that products use"]
  S --> R{{"Jev: is each of the top 10 what the user meant?<br/>one Noul question per result, one request"}}
  W --> P{{"Jev: which spelling did the user mean?<br/>one Choice question, one request"}}
  R --> K["keep or sink:<br/>scores under 0.3 move down"]
  R --> N["no-match line:<br/>every score under 0.3"]
  P --> D["Did you mean link:<br/>a respelling at 0.6 or more"]
  K --> Page([results page])
  N --> Page
  D --> Page
```

**Keep or sink.** Let c₁ … cₖ (k ≤ 10) be the top results in Postgres order. One request asks a Noul
(yes or no) question per candidate and returns sᵢ, Jev's probability that cᵢ is what the user
meant. With τ = 0.3, the page shows

```math
\langle c_i : s_i \ge \tau \rangle \;\Vert\; \langle c_i : s_i < \tau \rangle \;\Vert\; \langle c_{k+1}, c_{k+2}, \dots \rangle
```

each part in Postgres order. The step never sorts by sᵢ: a correct product scores near 1 whether
it is the best match or a close variant, so sorting would reorder good results on noise. The call
is skipped when k < 2 or every candidate is in one group.

**Did you mean.** For each query word w of four or more letters, without digits and not a stop
word, `search.similar_words` returns up to 8 words a from `search.words` with trigram similarity of
0.3 or more, used by more products than w, and not a completion of w (the prefix step finds
those). The options are the query as typed, o₀, followed by the query with one word replaced, each
word's closest alternative before any word's second, up to 16 options. One request asks a Choice
question over them and returns a distribution p. The page offers

```math
o^{*} = \arg\max_{i > 0} \; p(o_i) \quad \text{as a link, if } p(o^{*}) \ge 0.6
```

and never searches o* without a click. This question needs only the query, so the server sends it
while Postgres is still searching.

**No match.** The page says that no result matches when every sᵢ < τ, no candidate holds the
typed words (ignoring accents, spaces and punctuation), and there is no suggestion. The results
stay on the page.

**Failure.** Any error, timeout (1.5 s) or incomplete answer leaves the page as Postgres made it.
[The Jev step](docs/jev.md) shows both request bodies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/timeline-dark.svg">
  <img alt="Timeline of one search at the medians: Postgres takes about 18 ms and the keep-or-sink call about 162 ms on one path; the spelling call takes about 157 ms on the other; the page median is 196 ms." src="docs/figures/timeline-light.svg" width="860">
</picture>

## 3. Method

### 3.1 Data

The USDA FoodData Central Branded Foods release of 2025-12-18, one row per barcode with leading
zeros ignored: 440,302 products, 386,091 distinct names and 44,179 distinct words. The searchable
name puts the brand in front when the description leaves it out, and `other_names` holds the brand
owner. All three systems search the same text.

### 3.2 Query sets

| set | queries | written | a hit is a result that | role |
|-----|--------:|---------|------------------------|------|
| hand-written, [`eval/queries.json`](eval/queries.json) | 50: 20 exact, 18 misspelled, 6 prefix, 3 brand, 3 barcode | by hand, before this work | matches the case's regular expression | the original eval; it shaped the spelling bar and two rules, so it is partly in-sample for Jev |
| held-out, [`eval/spelling.json`](eval/spelling.json) | 50: 30 misspelled, 20 correctly spelled | by hand, before any Jev call on them | carries the intended word | first out-of-sample check |
| synthetic, [`eval/synthetic.json`](eval/synthetic.json) | 500: 300 misspelled, 200 correctly spelled | by [`scripts/make-spelling-set.ts`](scripts/make-spelling-set.ts), seed 20261007, committed before any Jev call on them | carries the intended word | main out-of-sample test |
| absent, [`eval/absent.json`](eval/absent.json) | 15 household goods | by hand | (none should match) | can a system say no? |

The synthetic words are sampled uniformly from the 4,907 words of five or more letters, without
digits and not stop words, that appear in at least 20 product names and in no other eval file.
Each of 300 gets one Damerau edit at a position other than the first letter, 75 of each type
(deletion, insertion, substitution, transposition). A result that is itself a word in the index is
redrawn, up to ten times, before the generator moves to the next word, so these are non-word
errors in the sense of Kukich (1992): the misspelling is not a word in the vocabulary. Damerau
(1964) found that about 80% of non-word misspellings are a single such edit. The
next 200 sampled words are the correctly spelled controls. Real-word errors, misspellings that
some product also carries (`parmesean`, `cinamon`), appear only in the two hand-written sets.

A result "carries the intended word" when the intended words appear in order from the start of a
word, ignoring accents, spaces and punctuation, so "almond milk" matches ALMONDMILK and "jalapeno"
matches JALAPEÑO.

### 3.3 Systems

| system | what it does |
|--------|--------------|
| plain Postgres full-text search | `to_tsvector('english', name \|\| ' ' \|\| other_names)` with a GIN index, `plainto_tsquery`, ordered by `ts_rank`, one row per name |
| this SQL | `search.query_distinct` (section 2.1) |
| + keep or sink | this SQL with Jev's reorder, as the page shows it |
| + Did you mean | this SQL, and where a suggestion appears, the results of the suggested search (one click) |
| + both | the reorder, and the suggested search where one appears |
| Norvig corrector | Norvig (2007) over `search.words`: a known word stays; otherwise the most common known word one edit away, else two. Used in place of Jev's spelling question. |
| frequency rule | the most common close word from `search.similar_words`, if used ten times as often as the typed word |

Two research-only variants appear in the full report: Jev's spelling question over a wider option
list (the trigram words plus the Norvig corrector's edit-distance words), and a cascade that uses
the Norvig corrector for unknown words and Jev otherwise.

### 3.4 Protocol and statistics

[`scripts/compare.ts`](scripts/compare.ts) runs every query through every system in sequence,
after one untimed pass so each timed query runs on a warm cache. Five runs, model pinned to
`jev-1.13.0` (every answer reported that version), PostgreSQL 16.12 in Docker with default
settings, Node 22.23, an Intel Core i5-10500H with 12 logical CPUs and 8 GB of RAM. The machine was
also running a browser; the load average was between 5 and 13 during the runs. Times are measured
in Node around each call, so they include the round trip to Postgres and, for Jev, to
`api.typesafe.ai`.

Each run writes every query's outcome, Jev scores, probabilities and timings to
[`results/`](results/), and [`scripts/report.ts`](scripts/report.ts) computes every number and
figure here from those files. Plain Postgres and this SQL are deterministic. For systems that call
Jev, tables give the median of five runs and the range when runs differ.

Proportions carry 95% Wilson (1927) intervals, computed on the median run, so they do not include
run-to-run variation. Paired systems are compared with the exact two-sided McNemar (1947) test,
once per run. Four comparisons on the 550 out-of-sample queries are primary and corrected with
Holm's (1979) method; all other tests are exploratory. Calibration is summarized by the expected
calibration error over ten equal-width bins (Guo et al., 2017) and the Brier (1950) score.

## 4. Results

### 4.1 Finding the right product

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/accuracy-dark.svg">
  <img alt="Dot plot of hit@1 with 95% Wilson intervals: on the synthetic set, plain Postgres 36%, this SQL 68%, Norvig corrector 87%, keep or sink 73%, both Jev questions 79%." src="docs/figures/accuracy-light.svg" width="860">
</picture>

Right product first (hit@1), median of five runs, 95% Wilson interval of that run:

| system | hand-written (50) | held-out (50) | synthetic (500) | out-of-sample (550) |
|--------|------------------:|--------------:|----------------:|--------------------:|
| plain Postgres full-text search | 52% [39, 65] | 42% [29, 56] | 36% [32, 41] | 37% [33, 41] |
| this SQL | 82% [69, 90] | 64% [50, 76] | 68% [64, 72] | 68% [64, 72] |
| + keep or sink | 86% [74, 93] | 68% [54, 79] | 73% [69, 76] | 72% [68, 76] |
| + Did you mean | 92% [81, 97] | 86% [74, 93] | 77% [74, 81] | 78% [74, 81] |
| + both | **96%** [87, 99] | **90%** [79, 96] | 79% [75, 83] | 80% [77, 83] |
| this SQL + Norvig corrector | 82% [69, 90] | 66% [52, 78] | **87%** [84, 90] | **85%** [82, 88] |

Right product in the top 10 (hit@10), out-of-sample: plain 40%, this SQL 79%, + keep or sink 79%
(it only reorders the top 10), + Did you mean 87%, + both 87%, Norvig corrector 92%. The full
matrix, with every group and every system, is in [`results/report.md`](results/report.md).

### 4.2 Primary comparisons

On the 550 out-of-sample queries, exact McNemar with Holm's correction across these four, the
largest adjusted p of the five runs:

| comparison | hit@1 | right only in the first | right only in the second | adjusted p |
|------------|------:|------------------------:|-------------------------:|-----------:|
| this SQL vs plain full-text search | 68% vs 37% | 178 | 7 | < 0.0001 |
| + keep or sink vs this SQL | 72% vs 68% | 22 to 28 | 2 to 3 | 0.0002 |
| + Did you mean vs this SQL | 78% vs 68% | 67 to 69 | 11 to 14 | < 0.0001 |
| + Did you mean vs Norvig corrector | 78% vs 85% | 20 to 22 | 57 to 61 | 0.0001 |

The first three favor the method; the fourth favors the baseline. On the 50-query sets, the reorder
alone is not significant (2 of 50 on the hand-written set, p = 0.5); its effect shows only at
n = 550.

### 4.3 Spelling correction against classical correctors

A suggestion is "fixed" when it equals the intended word, "wrong" when it is another word, and a
"false alarm" when it respells a correctly spelled control.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/error-types-dark.svg">
  <img alt="Bar chart of misspellings fixed: real-word errors (n = 18), Jev 83%, Norvig 0%, frequency rule 83%, cascade 83%; non-word errors (n = 312), Jev 59%, Norvig 91%, frequency rule 44%, cascade 91%." src="docs/figures/error-types-light.svg" width="860">
</picture>

| held-out and synthetic, median run | Jev | Norvig corrector | frequency rule |
|------------------------------------|----:|-----------------:|---------------:|
| real-word errors fixed (18) | 15 (83%), 0 wrong | 0, by design | 15 (83%), 3 wrong |
| non-word errors fixed (312) | 183 (59%), 15 wrong | 283 (91%), 29 wrong | 137 (44%), 168 wrong |
| correct words respelled (220) | 2 (0.9%) | 2 (0.9%) | 84 (38.2%) |
| precision on the held-out set | 100% | 79% | 54% |
| precision on the synthetic set | 91% | 91% | 36% |

The Norvig corrector never changes a known word, so it cannot fix a real-word error; that row
measures the definition, not the corrector. The 18 real-word errors all come from the held-out set,
which we wrote, so the frequency rule and Jev tie on them; Jev's difference is that it made no
wrong suggestion and almost never respelled a correct word.

On the synthetic set Jev's misses are mostly declines (111 of 300) rather than wrong guesses (15).
The intended word was among its options for 260 of 300 misspellings. Across the held-out and
synthetic sets, when the intended word was offered, Jev picked it 197 times out of 289 (68%). So
the shortfall is in the choice, not only in the candidates. Giving Jev
the corrector's edit-distance words as well raises the synthetic fixes from 174 to 189 and helps
most with transpositions (51% to 68%), still below the corrector.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/spelling-by-edit-dark.svg">
  <img alt="Bar chart of synthetic misspellings fixed by edit type: Jev 52% deletion, 75% insertion, 53% substitution, 51% transposition; the Norvig corrector 79%, 99%, 91%, 95%." src="docs/figures/spelling-by-edit-light.svg" width="860">
</picture>

| synthetic, by edit (75 each) | Jev | Norvig corrector | frequency rule | Jev, wider options | intended word offered to Jev |
|------------------------------|----:|-----------------:|---------------:|-------------------:|-----------------------------:|
| deletion | 52% | 79% | 29% | 55% | 79% |
| insertion | 75% | 99% | 57% | 76% | 100% |
| substitution | 53% | 91% | 53% | 53% | 96% |
| transposition | 51% | 95% | 35% | 68% | 72% |

### 4.4 Knowing when nothing matches

An empty page, or for Jev the no-match line, counts as saying that nothing matches.

| queries | plain full-text search | this SQL | this SQL + Jev |
|---------|-----------------------:|---------:|---------------:|
| absent (15): says nothing matches | 12 | 2 | 12 |
| answerable (600): says nothing matches | 314 | 15 | 30 (27 to 32) |
| answerable, says so while a match is in the top 10 | 0 | 0 | 4 (4 to 6) |

Plain full-text search says no to absent queries because it says no to most queries: it returned
nothing for 314 of the 600 that have an answer. This SQL returns something for almost everything,
including Shamrock Farms sour cream for "shampoo". With Jev the page separates the two cases: 12 of
15 absent queries against 30 of 600 answerable ones. Of the three absent queries it misses, two
return products that do carry the words (a jelly bean mix with a TOOTHPASTE flavor, LIGHT BULBS
icing decorations) and one returns a single result, where the keep-or-sink question does not run.

### 4.5 Calibration

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/reliability-dark.svg">
  <img alt="Reliability diagram of the spelling choice: points run close to the diagonal; answers at 0.9 to 1.0 were right 96.6% of the time." src="docs/figures/reliability-light.svg" width="520">
</picture>

Over 2,424 spelling answers (held-out and synthetic, five runs), the probability of the option Jev
ranked first is well calibrated at the top and overconfident in the middle: answers between 0.3
and 0.7 were right 10 to 20 points less often than their probability. The expected calibration
error is 0.049 and the Brier score 0.122; the error is low mainly because 1,041 of the answers fall
between 0.9 and 1.0, where Jev was right 96.6% of the time.

| Jev's probability | answers | right |
|-------------------|--------:|------:|
| 0.3 to 0.4 | 44 | 15.9% |
| 0.5 to 0.6 | 250 | 38.8% |
| 0.6 to 0.7 | 243 | 56.4% |
| 0.8 to 0.9 | 419 | 89.3% |
| 0.9 to 1.0 | 1,041 | 96.6% |

The bar still behaves predictably: raising it lowers both the fixes and the false alarms, steadily.
The sweep below was computed after the fact, from the recorded probabilities, and the page still
uses 0.6.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/threshold-dark.svg">
  <img alt="Suggestion rates by bar: at 0.3, 71.9% of misspellings fixed and 5.6% of correct words respelled; at 0.6, 60.0% and 1.0%; at 0.9, 31.2% and 0.0%." src="docs/figures/threshold-light.svg" width="860">
</picture>

| bar | misspellings fixed | correct words respelled | precision |
|----:|-------------------:|------------------------:|----------:|
| 0.30 | 71.9% | 5.6% | 79.7% |
| 0.50 | 65.1% | 1.8% | 88.5% |
| **0.60** | **60.0%** | **1.0%** | **91.8%** |
| 0.70 | 54.2% | 0.7% | 95.9% |
| 0.90 | 31.2% | 0.0% | 98.5% |

The keep-or-sink scores separate results that carry the query from results that do not with an
area under the ROC curve of 0.758 over 27,395 scored results. The labels are the eval's string
matches, which count a peanut butter cookie as peanut butter, so this is agreement with a noisy
label, not accuracy.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/noul-dark.svg">
  <img alt="Histogram of keep-or-sink scores: results that do not match their query cluster below 0.3; results that match spread from 0.2 to 0.9." src="docs/figures/noul-light.svg" width="860">
</picture>

### 4.6 Stability

Jev's answers vary between identical runs. Over five runs, "Did you mean" changed for 23 of the
237 queries that got one in any run (10%), the no-match line for 14 of 51 (27%), and the first
result after keep or sink for 45 of 615 (7%). The largest change in a suggestion's probability was
0.18. A cache keyed by query would make repeated searches consistent for a user.

### 4.7 Time

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/latency-dark.svg">
  <img alt="Cumulative distribution of time per query on a log scale: plain full-text search median 3 ms, this SQL median 25 ms, this SQL with Jev median 196 ms." src="docs/figures/latency-light.svg" width="860">
</picture>

Five runs pooled, 3,075 queries per system, milliseconds:

| measure | median | p90 | p99 |
|---------|-------:|----:|----:|
| plain Postgres full-text search | 3 | 21 | 227 |
| this SQL | 25 | 202 | 667 |
| this SQL + Jev, whole page | 196 | 314 | 669 |
| time Jev adds to the page | 166 | 219 | 382 |
| one keep-or-sink call (10 results judged) | 162 | 207 | 362 |
| one spelling call (median 7 options) | 157 | 202 | 331 |

Plain full-text search is the fastest system by a wide margin, and Jev is the slowest. Each Jev call
returns its whole set of judgments in one round trip: ten product judgments in 162 ms, or a choice
among seven spellings in 157 ms. Because the two calls run at the same time, the page waits for the
slower one, and the second question adds little time. The spelling question is sent on 88% of these
searches and keep or sink on 94%.

## 5. Failure analysis

Examples that held in all five runs:

| kind | query | this SQL, first result | with Jev, first result or suggestion |
|------|-------|------------------------|--------------------------------------|
| reorder fixes | `wheat thins` | RITZ CREAM CHEESE & ONION CRISP & THINS POTATO AND WHEAT CHIPS | WHEAT THINS ORIGINAL SNACKS |
| reorder fixes | `lays` | FRITOS THE ORIGINAL CORN CHIPS | LAY'S CLASSIC POTATO CHIPS |
| reorder fixes | `sockyee` | JELLY BELLY JELLY BEANS ... STINKY SOCKS ... | WILD CAUGHT SOCKEYE SALMON |
| reorder fixes | `funyons` | BUNYONS HOT GIARDINIERA | FUNYUNS ONION FLAVORED RINGS |
| reorder hurts | `chimlchurri` | FRESH EXPRESS CHIMICHURRI CHICKEN ... SALAD | RALEY'S ROASTED RED POTATOES, CHIMCHURRI SAUCE |
| reorder hurts | `beerages` | FITZ'S PREMIUM BEVERAGES | MEXICO Y YO MICHELADA SPICY MIX FOR BEVERAGE & BEER |
| spelling fixes what Norvig cannot | `parmesean`, `tumeric`, `expresso`, `siracha` | the misspelled products | parmesan, turmeric, espresso, sriracha |
| spelling declines | `marshmellow`, `jalepeno`, `skittels`, `funyons` | | no suggestion in at least four runs |
| spelling guesses wrong | `raisnets`, `mnior`, `heayrth` | | raisins, junior, health (meant raisinets, minor, hearth) |
| scoring artifact | `lettucse` | | lettuce (meant lettuces, counted wrong) |
| no-match line, wrongly | `francb` | SAN FRANCISCO STYLE SOURDOUGH | line shown; the word meant was "france" |

The reorder wins 23 queries in every run and loses 2. Its losses are cases where Jev prefers a
product whose name matches better while the search already had a correct one first. The wrong
spelling guesses are mostly reasonable words that differ from an uncommon intended one; the
generator samples brand names (squeez, sabatino, matlaw) as often as common words.

## 6. Discussion

The measurements support a narrower claim than "a model makes search better". Jev helps where the
decision is a judgment about meaning and a wrong answer is costly. It moved wrong results down a
list. It declined to respell possessive brand names that the dictionary corrector changed
(`hellmanns`, `kelloggs`), and many more that a frequency rule mangled (`fritos` to "frito",
`harissa` to "harris"). It told answerable queries from unanswerable ones. And its probabilities,
though overconfident in the middle, were reliable enough at the top to set a bar by. It did not beat a
dictionary corrector at the problem that corrector was designed for, a single edit away from a
common word, and the synthetic set is made of exactly that problem.

That points to a division of labor: deterministic correction where the error model is known, and
the model where it is not. A cascade that sends unknown words to the Norvig corrector and
everything else to Jev scored 94%, 90% and 88% hit@1 on the three sets, and would send the spelling
question on only 38% of the searches that send it now. We computed it after seeing these results,
and its edge on real-word errors rests on 18 self-written cases. Testing it needs a fresh, labeled
set of real-word errors from search logs; until then it is a hypothesis.

## 7. Cost, and the comparison with Algolia

### 7.1 What Algolia charges

Algolia's self-serve prices, read on 2026-10-07 from [algolia.com/pricing](https://www.algolia.com/pricing)
and its help center:

| plan | included each month | records past that | search requests past that |
|------|---------------------|------------------:|--------------------------:|
| Free | 10,000 requests, 50,000 records | blocked | blocked |
| Grow | 10,000 requests, 100,000 records | \$0.40 per 1,000 | \$0.50 per 1,000 |
| Grow Plus | 10,000 requests, 100,000 records | \$0.40 per 1,000 | \$1.75 per 1,000 |
| Elevate | by contract | by contract | by contract |

Records are billed on the month's highest count, ignoring the three highest days. A search request
is one network call to the search endpoint. Each keystroke in an instant-search box is a request,
and so is each facet click, sort change and empty query
([how requests are counted](https://support.algolia.com/hc/en-us/articles/17245378392977)).
Dynamic re-ranking and AI synonyms need Grow Plus; NeuralSearch needs Elevate.

### 7.2 What this costs

The Jev step is billed by input token, \$0.042 per million, and output tokens are free
([TypeSafe models](https://docs.typesafe.ai/models)). A search used 1,912 input tokens on average
on the hand-written queries, \$0.080 per 1,000 searches, and \$0.077 to \$0.089 per 1,000 across
the four sets. Typeahead runs in Postgres and never calls Jev, so keystrokes cost nothing, and
there is no charge per record.

The database is not free. Search runs on it: this SQL took 25 ms at the median and 202 ms at the
90th percentile here, and a typo of a very common word keeps the page with facets waiting about
1.25 s ([measurements](docs/measurements.md)). The search objects take 434 MB for 440,302 products.
The comparison below leaves out database hosting, which depends on what the database already
costs.

For N records, S searches a month and k billed requests per search:

```math
C_{\text{Algolia Grow}} = 0.40 \cdot \frac{\max(0,\, N - 100{,}000)}{1{,}000} + 0.50 \cdot \frac{\max(0,\, kS - 10{,}000)}{1{,}000}
\qquad
C_{\text{Jev}} = 0.0000803 \cdot S
```

k = 5 is an assumption, standing for a user who types five characters into an instant-search box
before choosing a result.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-dark.svg">
  <img alt="Monthly cost against searches per month, log scales: for 440,302 records Algolia Grow starts at about $136 a month and the Jev step at under $1; at one million searches Algolia costs $631 to $2,631 and the Jev step $80." src="docs/figures/cost-light.svg" width="860">
</picture>

| searches per month | Algolia Grow, 1 request per search | Algolia Grow, 5 requests per search | this SQL + Jev |
|-------------------:|-----------------------------------:|------------------------------------:|---------------:|
| 10,000 | \$136 | \$156 | \$0.80 |
| 100,000 | \$181 | \$381 | \$8.03 |
| 1,000,000 | \$631 | \$2,631 | \$80.30 |
| 10,000,000 | \$5,131 | \$25,131 | \$803 |

For this demo's 440,302 records, Algolia's record charge alone is \$136 a month before any search.
The author's own Algolia invoices fit the model: close to \$100 a month with 287,000 records and
close to \$200 with about 500,000, the record charge plus requests.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-records-dark.svg">
  <img alt="Algolia's record charge rises from zero at 100,000 records to $200 at 600,000; two invoices sit above the line at about $100 for 287,000 records and $200 for 500,000; the Jev step costs $8 at 100,000 searches whatever the record count." src="docs/figures/cost-records-light.svg" width="860">
</picture>

### 7.3 What Algolia provides that this does not

None of these was measured here, and each should weigh in a choice between the two:

- **Latency and scaling.** Algolia serves from its own clusters. Here the search load lands on your
  database, and the Jev step adds 166 ms to the page at the median.
- **Tools around search.** Analytics, A/B tests, merchandising rules, and Query Suggestions built
  from search history.
- **Typo tolerance inside retrieval.** Algolia counts a swap of two letters as one typo while it
  retrieves. Here a swap is fixed only through "Did you mean".
- **Ranking quality.** Algolia's ranking on this data was not measured.
  [`scripts/compare-algolia.ts`](scripts/compare-algolia.ts) reports top-10 overlap for a reader
  who has an index and keys.

## 8. Threats to validity

- **Who wrote the tests.** We wrote the hand-written and held-out sets, and the hand-written set
  shaped the 0.6 bar, the rule against completions and the typed-words check. The synthetic set
  comes from a fixed seed and was committed before any Jev call on it. But its error model, one
  edit from a word used in at least 20 product names, is the model the Norvig corrector assumes,
  which favors that corrector by construction. Phonetic misspellings ("expresso", "tumeric") are
  absent from it.
- **Strict scoring of corrections.** A correction counts only if it equals the intended word, so
  "lettuce" for "lettuces" is wrong. Many synthetic targets are brand names, where declining to
  respell is defensible. Search accuracy is the better summary, and the correction tables are
  stricter.
- **Labels are string matches.** No person judged relevance.
- **One machine, one network.** The laptop was also running a browser, with a load average of 5 to
  13, and it reached `api.typesafe.ai` from one location. Postgres times depend on the hardware and
  Jev times on the distance to TypeSafe.
- **Nondeterminism.** Five runs bound the variation reported here.
- **Post hoc analyses.** The bar sweep and the cascade were computed after the results were seen.
- **Scope.** The study covers one English grocery catalog and one model version. It has no
  comparison with Algolia's ranking and none with a general-purpose language model doing the same
  judgments.

## 9. Reproducing the results

```sh
npm install && npm run db && npm run load -- --full             # 440,302 products
node scripts/make-spelling-set.ts                                # rewrites eval/synthetic.json; same seed, same file
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts     # one run: about 7 minutes, $0.065
node scripts/report.ts                                           # results/report.md and docs/figures/*.svg
```

[`results/`](results/) holds the five runs reported here, one JSON file each, with every query's
outcome, Jev's scores and probabilities, timings, versions and machine load.
`scripts/report.ts` reads only those files, so every table and figure in this README can be
rebuilt without a database or a key.

## Try it

Needs Docker and Node 22.18 or later.

```sh
git clone https://github.com/alexforman1/postgres-search
cd postgres-search
npm install
npm run db      # Postgres 16 in Docker on port 5432
npm run load    # 100,000-product sample, about 10 seconds
npm start       # http://localhost:3000
```

The server listens on `PORT` (default 3000). The server and scripts connect to `DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/search_demo`). If port 5432 is taken, run the
`docker run` line from the `db` script in `package.json` with another host port, such as
`-p 127.0.0.1:5433:5432`, and point `DATABASE_URL` at it. The loader drops and recreates its
tables, so it refuses a database not named `search_demo` unless given `--any-database`. After a
reboot, start the database again with `docker start postgres-search`.

`npm run load -- --full` downloads the whole release (447 MB) instead of using the sample. It
needs `unzip`.

To try the Jev step, set a TypeSafe API key before `npm start`, then search for `parmesean`,
`dortios` or `shampoo`:

```sh
TYPESAFE_API_KEY=... npm start
```

Without a key everything else works the same.

## Use it with your data

Write one view, `search.source`, that maps your table to seven columns, then run two SQL files.
[docs/your-data.md](docs/your-data.md) walks through it.

With a coding agent, install the skill and ask it to add search to your project:

```sh
npx skills add alexforman1/postgres-search
```

## The guide

- [How it works](docs/how-it-works.md)
- [The search steps](docs/search-steps.md)
- [Typeahead](docs/typeahead.md)
- [Facets](docs/facets.md)
- [The Jev step](docs/jev.md)
- [Using your own data](docs/your-data.md)
- [Moving from Algolia](docs/from-algolia.md)
- [Measurements](docs/measurements.md)

## Limits

Without Jev, a misspelling that some product also carries hides the correctly spelled products:
USDA lists one PARMESEAN product, so `parmesean` never shows the 2,734 parmesan rows. Transposed
letters can be missed; trigram matching scores "dortios" at 0.375 against DORITOS, under the 0.5
cutoff. Jev's "Did you mean" covers both, but it respells one word per query and declines many
single-edit errors that a dictionary corrector fixes (section 4.3). A typo of a very common word is
slow: the demo page waits about 1.25 s for "chocolatte". The materialized views are stale until
refreshed. [How it works](docs/how-it-works.md#what-it-does-not-do) lists each cost.

## References

- Brier, G. W. (1950). Verification of forecasts expressed in terms of probability. *Monthly
  Weather Review*, 78(1), 1-3.
- Damerau, F. J. (1964). A technique for computer detection and correction of spelling errors.
  *Communications of the ACM*, 7(3), 171-176.
- Guo, C., Pleiss, G., Sun, Y., and Weinberger, K. Q. (2017). On calibration of modern neural
  networks. *Proceedings of the 34th International Conference on Machine Learning*, PMLR 70,
  1321-1330.
- Holm, S. (1979). A simple sequentially rejective multiple test procedure. *Scandinavian Journal
  of Statistics*, 6(2), 65-70.
- Kukich, K. (1992). Techniques for automatically correcting words in text. *ACM Computing
  Surveys*, 24(4), 377-439.
- McNemar, Q. (1947). Note on the sampling error of the difference between correlated proportions
  or percentages. *Psychometrika*, 12(2), 153-157.
- Norvig, P. (2007). How to write a spelling corrector. https://norvig.com/spell-correct.html
- Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference.
  *Journal of the American Statistical Association*, 22(158), 209-212.

## Contributing

See [AGENTS.md](AGENTS.md) for setup, checks, and rules. They apply to people and coding agents
alike.

## Data

Product data from [USDA FoodData Central](https://fdc.nal.usda.gov/), Branded Foods, released
2025-12-18. The data is public domain (CC0).

## License

MIT
