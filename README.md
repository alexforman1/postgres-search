# postgres-search

Product search inside PostgreSQL: whole words, partial words, typos, barcodes, typeahead and facet
counts, all in SQL, with an optional second stage that asks [Jev](https://docs.typesafe.ai), a
hosted model that returns probabilities instead of text, two questions per search. This README is
also a report on that second stage: how much it helps, how a first version failed and was fixed,
what it costs, and how it compares with Algolia.

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
Jev's second question, "which spelling did the user mean?", is also compared with two spelling
correctors that use no model, among them one in the style of Norvig (2007). The final design was
frozen before two test sets were made: 500 seeded one-edit misspellings and controls, and 473 real
misspellings from Wikipedia's list of common misspellings. Every system ran five times on 1,588
queries with the model pinned to `jev-1.13.0`.

On the 973 test queries, the right product came first for 22% of queries with plain full-text
search and 54% with this SQL. Jev's keep-or-sink reorder raised that to 59%, and its "Did you mean"
link, when followed, to 78%. The dictionary corrector reached 75%, and Jev's lead over it holds
after Holm's correction in every run (p ≤ 0.040). On the real misspellings Jev led 70% to 64%; on
the 32 of them that are themselves words some product uses, 84% to 31%. On the synthetic set,
whose errors are exactly the kind a dictionary corrector is built for, the two tied (85% and 86%).

That result came from a failure. The first version of the spelling question lost to the same
corrector (78% to 85%, p = 0.0001). It had withheld what the corrector uses: candidates one edit
away, and how many products each spelling finds. Given both, Jev went from picking the intended
word 68% of the time it was offered to 88%.

Each Jev call returns all its judgments in one round trip: ten product judgments in 159 ms at the
median, or a choice among eight spellings in 155 ms. The two calls run at the same time and add
165 ms to the page. They cost \$0.087 per 1,000 searches on the hand-written queries. The spelling
probabilities are well calibrated (expected calibration error 0.031; right 96.8% of the time at 0.9
or more), and the page says that nothing matches for 12 of 15 queries that have no answer in a
grocery catalog against 77 of 1,573 that do. For this demo's 440,302 records, Algolia's published
Grow price is \$136 a month for records alone, before any search.

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
  Q --> W["search.similar_words<br/>one-edit and trigram neighbors,<br/>with what the search finds for each"]
  S --> R{{"Jev: is each of the top 10 what the user meant?<br/>one Noul question per result, one request"}}
  W --> P{{"Jev: which spelling did the user mean?<br/>one Choice question, one request"}}
  R --> K["keep or sink:<br/>scores under 0.3 move down"]
  R --> N["no-match line:<br/>every score under 0.3"]
  P --> D["Did you mean link:<br/>twice as likely as the typed spelling"]
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
word, `search.similar_words` collects candidates from `search.words`: every word one edit from w (a
letter added, removed or replaced, or two neighbors swapped; Damerau, 1964), most found first, then
words with trigram similarity of 0.3 or more, closest first, up to 8 in all. A candidate must have
a different English stem from w (the search already treats one stem alike, so `hellmanns` is not
a misspelling of "hellmann"), and the search must find it in more products than both w and the
most common word, of another stem, that starts with w. For an unfinished word the prefix step
shows that word's products, so `strawb` is not offered "straw" while 11,614 strawberry products
start with it. A word one letter longer than w can be offered (`captai`, "captain"); longer
completions are left to the prefix step. The options are the query as typed, o₀, then the query
with one word replaced, each word's closest candidate before any word's second, up to 16.
Each option tells Jev how many edits separate it from what was typed and how many products the
search finds for the word it changes, the evidence a dictionary corrector works from. One request
asks a Choice question over the options and returns a distribution p. The page offers

```math
o^{*} = \arg\max_{i > 0} \; p(o_i) \quad \text{as a link, if } p(o^{*}) \ge 2\,p(o_0) \text{ and } p(o^{*}) \ge 0.3
```

and never searches o* without a click. Comparing o* with the spelling typed, rather than with a
fixed bar, keeps a suggestion when Jev splits the rest of its probability among several close
words. The question needs only the query, so the server sends it while Postgres is still searching.

**No match.** The page says that no result matches when every sᵢ < τ, no candidate holds the
typed words (ignoring accents, spaces and punctuation), and there is no suggestion. The results
stay on the page.

**Failure.** Any error, timeout (1.5 s) or incomplete answer leaves the page as Postgres made it.
[The Jev step](docs/jev.md) shows both request bodies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/timeline-dark.svg">
  <img alt="Timeline of one search at the medians: Postgres takes about 22 ms and the keep-or-sink call about 159 ms on one path; the spelling call takes about 155 ms on the other; the page median is 201 ms." src="docs/figures/timeline-light.svg" width="860">
</picture>

## 3. Method

### 3.1 Data

The USDA FoodData Central Branded Foods release of 2025-12-18, one row per barcode with leading
zeros ignored: 440,302 products, 386,091 distinct names and 44,179 distinct words. The searchable
name puts the brand in front when the description leaves it out, and `other_names` holds the brand
owner. All three systems search the same text.

### 3.2 Query sets

| set | queries | made | a hit is a result that | role |
|-----|--------:|------|------------------------|------|
| hand-written, [`eval/queries.json`](eval/queries.json) | 50: 20 exact, 18 misspelled, 6 prefix, 3 brand, 3 barcode | by hand, before this work | matches the case's regular expression | development |
| held-out, [`eval/spelling.json`](eval/spelling.json) | 50: 30 misspelled, 20 correctly spelled | by hand | carries the intended word | development |
| synthetic, [`eval/synthetic.json`](eval/synthetic.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261007 | carries the intended word | development |
| synthetic test, [`eval/synthetic-test.json`](eval/synthetic-test.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261008, after version 2 was frozen | carries the intended word | test for version 2; informed 2.1 |
| Wikipedia, [`eval/wikipedia.json`](eval/wikipedia.json) | 473 real misspellings of 307 words | from Wikipedia's list, after version 2 was frozen | carries the intended word | test for version 2, rescored for 2.1 |
| synthetic test 2, [`eval/synthetic-test-2.json`](eval/synthetic-test-2.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261009, after version 2.1 was frozen | carries the intended word | **test** |
| truncation, [`eval/truncation.json`](eval/truncation.json) | 300 words cut short | seed 20261010, after version 2.1 was frozen | carries the full word | **test** |
| absent, [`eval/absent.json`](eval/absent.json) | 15 household goods | by hand | (none should match) | can a system say no? |

The three synthetic sets come from [`scripts/make-spelling-set.ts`](scripts/make-spelling-set.ts). It
samples words uniformly from those of five or more letters, without digits and not stop words,
that appear in at least 20 product names and in no other eval file. Each of 300 gets one Damerau
edit at a position other than the first letter, 75 of each type, redrawn up to ten times while the
result is itself a word in the index, so these are non-word errors in the sense of Kukich (1992).
Damerau (1964) found that about 80% of non-word misspellings are a single such edit. The next 200
sampled words are the controls. The truncation set uses the same sampling and cuts each word to a
length from four letters to one letter short of the word, skipping cuts that are themselves words
in the index; because many sampled words are short, 162 of the 300 lose one letter. Each set leaves
out every word of the sets made before it.

The Wikipedia set comes from [`scripts/make-wikipedia-set.ts`](scripts/make-wikipedia-set.ts),
which reads "Lists of common misspellings/For machines" at revision 1199637275 (CC BY-SA 4.0) and
keeps the 473 pairs whose correct word appears in at least 20 product names and in no other eval
file. These are errors people made, not generated ones. 32 of them are real-word errors: the
misspelling is itself a word some product uses. 55 have a stop word as the correct word
(`abotu` for "about"); the search ignores stop words, so a correct suggestion for them finds
nothing. They stay in the set and are separated in a post hoc row.

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
| frequency rule | the most common candidate from `search.similar_words`, if found ten times as often as the typed word |

The full report also has a cascade, computed after the fact, that uses the Norvig corrector for
unknown words and Jev otherwise.

### 3.4 Protocol

The work had two stages.

1. **Version 1.** The first spelling question offered only trigram neighbors, showed Jev the bare
   spellings, and suggested at 0.6. It ran five times on the three development sets and the absent
   set ([`results/v1/`](results/v1/report.md)) and lost to the Norvig corrector.
2. **Diagnosis and version 2.** We traced the losses (section 4.1), changed the candidates and the
   evidence, and chose the suggestion rule on the development sets with
   [`scripts/spelling-rules.ts`](scripts/spelling-rules.ts). One development run is in
   [`results/dev/`](results/dev/report.md). The design was then frozen in commit `9eb9f3a`, the two
   test sets were generated and committed in `4f8e718`, and only then did any model see them. Its
   five runs are in [`results/v2/`](results/v2/report.md).
3. **Version 2.1.** Version 2's results showed it overriding the prefix step on unfinished words
   (`strawb`). We added the completion test on the development sets, checked it with one run
   ([`results/dev21/`](results/dev21/report.md)), froze it in `5fb118e`, and generated two more test
   sets in `b4b0956` before any model saw them. The version 2 test sets are rescored; one of them,
   the synthetic test set, showed the fault, so it is not a clean test for this change.

[`scripts/compare.ts`](scripts/compare.ts) runs every query through every system in sequence, after
one untimed pass so each timed query runs on a warm cache. Five runs per version, model pinned to
`jev-1.13.0` (every answer reported that version), PostgreSQL 16.12 in Docker with default
settings, Node 22.23, an Intel Core i5-10500H with 12 logical CPUs and 8 GB of RAM. The machine was
also running a browser; the load average was between 3 and 14. Times are measured in Node around
each call, so they include the round trip to Postgres and, for Jev, to `api.typesafe.ai`.

Each run writes every query's outcome, Jev scores, probabilities and timings to
[`results/`](results/), and [`scripts/report.ts`](scripts/report.ts) computes every number and
figure here from those files ([`results/report.md`](results/report.md)). Plain Postgres and this
SQL are deterministic. For systems that call Jev, tables give the median of five runs and the range
when runs differ.

### 3.5 Statistics

Proportions carry 95% Wilson (1927) intervals, computed on the median run, so they do not include
run-to-run variation. Paired systems are compared with the exact two-sided McNemar (1947) test,
once per run. Four comparisons on the 973 test queries are primary and corrected with Holm's (1979)
method; all other tests are exploratory. Calibration is summarized by the expected calibration
error over ten equal-width bins (Guo et al., 2017) and the Brier (1950) score.

## 4. Results

### 4.1 What the first version got wrong

On the 300 synthetic development misspellings, version 1 fixed 174 at the median, guessed wrong on
15 and made no suggestion for 111, while the Norvig corrector fixed 272. Tracing the misses of its
first run gave two causes:

- **The intended word was not among the options** for 40 of them. Trigram similarity misses many
  deletions and swaps, which an edit-distance search finds. The corrector fixed 35 of these.
- **Jev declined although the intended word was offered**, for 75. It rated the typed spelling
  above the intended one (median 0.43 against 0.32). It had no way to know that the typed
  spelling appears in no product, so a misspelling looked like a rare brand. The corrector fixed
  59 of these.

A probe that only added product counts to the same 75 declined cases fixed 45 of them, and
respelled 1 of 40 correct words. Version 2 adds the one-edit candidates, the counts (counted the
way the search finds them, so possessives do not look misspelled), the number of edits, and the
twice-as-likely rule. On the development sets:

| hit@1, median of five runs | version 1 | version 2 | Norvig corrector |
|----------------------------|----------:|----------:|-----------------:|
| held-out, "Did you mean" | 86% | 92% | 66% |
| synthetic, "Did you mean" | 77% | 84% | 87% |
| held-out and synthetic, both questions | 80% | 87% | 85% |

| synthetic development misspellings (300) | fixed | wrong | no suggestion | intended word offered |
|------------------------------------------|------:|------:|---------:|----------------------:|
| version 1 | 174 | 15 | 111 | 260 |
| version 2 | 248 | 35 | 17 | 282 |

When the intended word was among the options, version 1 picked it 197 times out of 289 (68%) and
version 2 273 times out of 309 (88%). The suggestion rule was chosen from four candidates scored on
one run of the development sets; at a bar of 0.6, version 2 fixed 265 of 330 with 4 false alarms
in 220 controls, and with the twice-as-likely rule 274 with 1 false alarm.

### 4.2 Finding the right product, on the test sets

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/accuracy-dark.svg">
  <img alt="Dot plot of hit@1 with 95% Wilson intervals: on real Wikipedia misspellings, plain Postgres 5%, this SQL 42%, Norvig corrector 64%, keep or sink 48%, both Jev questions 71%; on the synthetic test set the corrector and Jev reach 86% and 85%." src="docs/figures/accuracy-light.svg" width="860">
</picture>

Right product first (hit@1), median of five runs, 95% Wilson interval of that run:

| system | synthetic test (500) | Wikipedia (473) | Wikipedia, real-word errors (32) | test, both sets (973) |
|--------|---------------------:|----------------:|---------------------------------:|----------------------:|
| plain Postgres full-text search | 37% [33, 41] | 5% [4, 8] | 28% [16, 45] | 22% [19, 24] |
| this SQL | 65% [61, 69] | 42% [38, 47] | 31% [18, 49] | 54% [51, 57] |
| + keep or sink | 70% [66, 74] | 48% [44, 52] | 31% [18, 49] | 59% [56, 62] |
| + Did you mean | 85% [81, 87] | 70% [66, 74] | **84%** [68, 93] | **78%** [75, 80] |
| + both | 85% [82, 88] | **71%** [67, 75] | **84%** [68, 93] | **78%** [76, 81] |
| this SQL + Norvig corrector | **86%** [83, 89] | 64% [60, 68] | 31% [18, 49] | 75% [73, 78] |

Right product in the top 10 (hit@10) on the 973 test queries: plain 24%, this SQL 64%, + keep or
sink 64% (it only reorders the top 10), + Did you mean 83%, + both 83%, Norvig corrector 81%. On
the 418 Wikipedia cases whose correct word is not a stop word, a split made after the results were
seen, hit@1 is 78% for "Did you mean" and 72% for the corrector. On the hand-written development
queries the full system reaches 94% (this SQL 82%, plain 52%).

### 4.3 Primary comparisons

On the 973 test queries, exact McNemar with Holm's correction across these four, the largest
adjusted p of the five runs:

| comparison | hit@1 | right only in the first | right only in the second | adjusted p |
|------------|------:|------------------------:|-------------------------:|-----------:|
| this SQL vs plain full-text search | 54% vs 22% | 325 | 11 | < 0.0001 |
| + keep or sink vs this SQL | 59% vs 54% | 53 to 55 | 2 to 4 | < 0.0001 |
| + Did you mean vs this SQL | 78% vs 54% | 276 to 278 | 46 to 48 | < 0.0001 |
| + Did you mean vs Norvig corrector | 78% vs 75% | 48 to 49 | 26 to 29 | 0.040 |

All four favor the method. The reorder, which was not significant on the 50-query sets of the
first study, wins 53 to 55 queries and loses 2 to 4 here.

### 4.4 Spelling correction against classical correctors

A suggestion is "fixed" when it equals the intended word, "wrong" when it is another word, and a
"false alarm" when it respells a correctly spelled control. This is stricter than search accuracy:
"lettuce" for an intended "lettuces" counts as wrong though both searches find lettuce.

| test sets, median run | Jev | Norvig corrector | frequency rule |
|-----------------------|----:|-----------------:|---------------:|
| real-word errors fixed (32) | 23 (72%), 2 wrong | 0, by design | 17 (53%), 9 wrong |
| non-word errors fixed (741) | 588 (79%), 92 wrong | 639 (86%), 98 wrong | 322 (43%), 371 wrong |
| correct words respelled (200) | 2 (1.0%) | 0 | 65 (32.5%) |
| precision, synthetic test | 89% | 91% | 39% |
| precision, Wikipedia | 85% | 84% | 47% |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/error-types-dark.svg">
  <img alt="Bar chart of misspellings fixed on the test sets: real-word errors (n = 32), Jev 72%, Norvig 0%, frequency rule 53%, cascade 72%; non-word errors (n = 741), Jev 79%, Norvig 86%, frequency rule 43%, cascade 87%." src="docs/figures/error-types-light.svg" width="860">
</picture>

By exact word, the corrector still produces the intended word more often on non-word errors, 86%
to 79%. By what the user finds, Jev is ahead. Three things separate the two measures: real-word
errors, which the corrector cannot touch; the 55 stop-word targets, where the corrector earns a
"fix" (`abotu` to "about") whose search shows nothing; and Jev choices that differ from the
intended word but find the same products. When the intended word was offered, Jev picked it 611
times out of 666 (91.7%).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/spelling-by-edit-dark.svg">
  <img alt="Bar chart of synthetic test misspellings fixed by edit type: Jev 64% deletion, 95% insertion, 93% substitution, 89% transposition; the Norvig corrector 71%, 100%, 99%, 93%." src="docs/figures/spelling-by-edit-light.svg" width="860">
</picture>

| synthetic test, by edit (75 each) | Jev | Norvig corrector | frequency rule | intended word offered to Jev |
|-----------------------------------|----:|-----------------:|---------------:|-----------------------------:|
| deletion | 64% | 71% | 37% | 81% |
| insertion | 95% | 100% | 57% | 100% |
| substitution | 93% | 99% | 47% | 97% |
| transposition | 89% | 93% | 45% | 100% |

Deletions remain the weakest case: 19% of them never reach Jev's options. In the first run all 14
of those drop the last letter ("captai" for "captain"), and the completion rule leaves them to the
prefix step.

### 4.5 Knowing when nothing matches

An empty page, or for Jev the no-match line, counts as saying that nothing matches.

| queries | plain full-text search | this SQL | this SQL + Jev |
|---------|-----------------------:|---------:|---------------:|
| absent (15): says nothing matches | 12 | 2 | 12 |
| answerable (1,573): says nothing matches | 1,001 | 59 | 77 (75 to 78) |
| answerable, says so while a match is in the top 10 | 0 | 0 | 7 (7 to 8) |

Plain full-text search says no to absent queries because it says no to most queries: it returned
nothing for 1,001 of the 1,573 that have an answer. This SQL returns something for almost
everything, including Shamrock Farms sour cream for "shampoo". With Jev the page separates the
two: 12 of 15 absent queries against 77 of 1,573 answerable ones.

### 4.6 Calibration

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/reliability-dark.svg">
  <img alt="Reliability diagram of the spelling choice on the test sets: points run close to the diagonal above 0.5; answers at 0.9 to 1.0 were right 96.8% of the time." src="docs/figures/reliability-light.svg" width="520">
</picture>

Over 4,380 spelling answers on the test sets (five runs), the probability of the option Jev ranked
first tracks how often it was right: expected calibration error 0.031, Brier score 0.086. Most
answers (2,970) fall between 0.9 and 1.0, where Jev was right 96.8% of the time. Below 0.9 it is
overconfident, by 3 to 26 points, most in the 210 answers under 0.5.

| Jev's probability | answers | right |
|-------------------|--------:|------:|
| 0.3 to 0.4 | 70 | 8.6% |
| 0.5 to 0.6 | 175 | 48.6% |
| 0.6 to 0.7 | 251 | 53.8% |
| 0.8 to 0.9 | 492 | 82.1% |
| 0.9 to 1.0 | 2,970 | 96.8% |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/threshold-dark.svg">
  <img alt="Suggestion rates as the floor moves, with the twice-as-likely rule: from 0.2 to 0.4 about 79% of misspellings fixed and 0.9% of correct words respelled; at 0.9, 62.5% and 0.5%." src="docs/figures/threshold-light.svg" width="860">
</picture>

Moving the rule's floor after the fact shows that the twice-as-likely test does most of the work:
any floor from 0.2 to 0.4 gives about 79% of misspellings fixed and 0.9% of correct words
respelled; a floor of 0.9 would give up a fifth of the fixes to halve the false alarms.

The keep-or-sink scores separate results that carry the query from results that do not with an
area under the ROC curve of 0.717 over 69,710 scored results. The labels are string matches, which
count a peanut butter cookie as peanut butter, so this is agreement with a noisy label.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/noul-dark.svg">
  <img alt="Histogram of keep-or-sink scores: results that do not match their query cluster below 0.3; results that match spread from 0.2 to 0.9." src="docs/figures/noul-light.svg" width="860">
</picture>

### 4.7 Stability

Jev's answers vary between identical runs. Over five runs, "Did you mean" changed for 30 of the
1,040 queries that got one in any run (3%, against 10% in version 1), the no-match line for 58 of
225 (26%), and the first result after keep or sink for 122 of 1,588 (8%). A cache keyed by query
would make repeated searches consistent for a user.

### 4.8 Time

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/latency-dark.svg">
  <img alt="Cumulative distribution of time per query on a log scale: plain full-text search median 2 ms, this SQL median 26 ms, this SQL with Jev median 201 ms." src="docs/figures/latency-light.svg" width="860">
</picture>

Five runs pooled, 7,940 queries per system, milliseconds:

| measure | median | p90 | p99 |
|---------|-------:|----:|----:|
| plain Postgres full-text search | 2 | 11 | 140 |
| this SQL | 26 | 231 | 688 |
| this SQL + Jev, whole page | 201 | 324 | 698 |
| time Jev adds to the page | 165 | 213 | 332 |
| one keep-or-sink call (10 results judged) | 159 | 203 | 312 |
| one spelling call (median 8 options) | 155 | 199 | 332 |

Plain full-text search is the fastest system by a wide margin, and Jev is the slowest. Each Jev
call returns its whole set of judgments in one round trip, and the two calls run at the same time,
so the page waits for the slower one. The close-word lookup now takes 6 to 20 ms in Postgres, up
from 1 to 6 ms in version 1, but it runs beside the search and the page time did not change: Jev
added 166 ms at the median in version 1 and 165 ms now.

## 5. Failure analysis

Examples that held in all five runs:

| kind | query | this SQL, first result | with Jev |
|------|-------|------------------------|----------|
| reorder fixes | `wheat thins` | RITZ CREAM CHEESE & ONION CRISP & THINS POTATO AND WHEAT CHIPS | WHEAT THINS ORIGINAL SNACKS |
| reorder fixes | `rooihos` | CALIDAD NACHOS ROUND TORTILLA CHIPS | PRIVATE SELECTION ROOIBOS CAFFEINE-FREE RED TEA |
| reorder fixes | `liqyorice` | MENTOS, DROP, CHEWY SWEETS, LICORICE | AUSSIE BLACK LIQUORICE NUGGETS |
| fixes the corrector cannot | `carribean`, `ceasar`, `coctail`, `holliday` | | caribbean, caesar, cocktail, holiday; each misspelling is in some product name, so the corrector keeps it |
| the corrector fixes, Jev does not | `foyster`, `djraft`, `oliveir` | | oyster, kraft, oliver (meant foster, draft, olivier): a common word chosen over a rare brand |
| no answer possible | `abotu`, `agian` | | abbott, asian (meant about, again, stop words the search ignores) |
| new in version 2 | `strawb` | the prefix step finds strawberries | suggests "straw" (in one run "straws"), a one-edit deletion the user did not mean |
| no-match line, wrongly | `independant` | CULINARY SECRETS FANCY TOMATO KETCHUP | line shown; all ten results match only through the brand owner Independent Marketing Alliance |

On the test sets the reorder wins 52 queries in every run and loses 2. Jev's wrong spellings are
mostly reasonable common words where the intended word is an uncommon brand; the generator samples
brands (koppers, kunzler, sabatino) as often as common words.

## 6. Discussion

The first version gave Jev less information than a 2007 spelling corrector uses, and lost. Given
the same evidence, edit distance and how often the catalog uses each spelling, it matched the
corrector on errors made to fit the corrector's assumptions and beat it on errors people made. Its
advantage concentrates where the decision is a judgment rather than a lookup: a misspelling that
is itself a word in some product name (84% against 31%), a possessive that only looks misspelled,
a list of results where some are wrong, and a query with no answer at all. Its probabilities are
calibrated well enough above 0.8 to act on.

The lesson for building with a model like this is the one the first version taught. The model was
not short of judgment; it was short of evidence. The classical method's features belong in the
model's input, not beside it: the post hoc cascade, which hands unknown words to the corrector and
the rest to Jev, now scores 77% on the test sets, no better than Jev alone at 78%.

Two weaknesses remain. Deletions at the end of a word rarely reach the options, and the edit
candidates can suggest a shorter word for an unfinished one (`strawb` to "straw"). Both are
candidate-generation problems, testable on the development sets without touching the test sets.

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
([TypeSafe models](https://docs.typesafe.ai/models)). A search used 2,076 input tokens on average
on the hand-written queries, \$0.087 per 1,000 searches, and \$0.087 to \$0.097 per 1,000 across
the six query sets; the counts and edits in version 2's options cost about 9% more than version 1.
Typeahead runs in Postgres and never calls Jev, so keystrokes cost nothing, and there is no charge
per record.

The database is not free. Search runs on it: this SQL took 26 ms at the median and 231 ms at the
90th percentile here, and a typo of a very common word keeps the page with facets waiting about
1.25 s ([measurements](docs/measurements.md)). The search objects take 436 MB for 440,302
products. The comparison below leaves out database hosting, which depends on what the database
already costs.

For N records, S searches a month and k billed requests per search:

```math
C_{\text{Algolia Grow}} = 0.40 \cdot \frac{\max(0,\, N - 100{,}000)}{1{,}000} + 0.50 \cdot \frac{\max(0,\, kS - 10{,}000)}{1{,}000}
\qquad
C_{\text{Jev}} = 0.0000872 \cdot S
```

k = 5 is an assumption, standing for a user who types five characters into an instant-search box
before choosing a result.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-dark.svg">
  <img alt="Monthly cost against searches per month, log scales: for 440,302 records Algolia Grow starts at about $136 a month and the Jev step at under $1; at one million searches Algolia costs $631 to $2,631 and the Jev step $87." src="docs/figures/cost-light.svg" width="860">
</picture>

| searches per month | Algolia Grow, 1 request per search | Algolia Grow, 5 requests per search | this SQL + Jev |
|-------------------:|-----------------------------------:|------------------------------------:|---------------:|
| 10,000 | \$136 | \$156 | \$0.87 |
| 100,000 | \$181 | \$381 | \$8.72 |
| 1,000,000 | \$631 | \$2,631 | \$87 |
| 10,000,000 | \$5,131 | \$25,131 | \$872 |

For this demo's 440,302 records, Algolia's record charge alone is \$136 a month before any search.
The author's own Algolia invoices fit the model: close to \$100 a month with 287,000 records and
close to \$200 with about 500,000, the record charge plus requests.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-records-dark.svg">
  <img alt="Algolia's record charge rises from zero at 100,000 records to $200 at 600,000; two invoices sit above the line at about $100 for 287,000 records and $200 for 500,000; the Jev step costs about $9 at 100,000 searches whatever the record count." src="docs/figures/cost-records-light.svg" width="860">
</picture>

### 7.3 What Algolia provides that this does not

None of these was measured here, and each should weigh in a choice between the two:

- **Latency and scaling.** Algolia serves from its own clusters. Here the search load lands on your
  database, and the Jev step adds 165 ms to the page at the median.
- **Tools around search.** Analytics, A/B tests, merchandising rules, and Query Suggestions built
  from search history.
- **Typo tolerance inside retrieval.** Algolia counts a swap of two letters as one typo while it
  retrieves. Here a swap is fixed only through "Did you mean".
- **Ranking quality.** Algolia's ranking on this data was not measured.
  [`scripts/compare-algolia.ts`](scripts/compare-algolia.ts) reports top-10 overlap for a reader
  who has an index and keys.

## 8. Threats to validity

- **Development and test.** We wrote the hand-written and held-out sets, and the development sets
  shaped version 2: the candidates, the evidence and the suggestion rule. The test sets were made
  after the design was frozen and committed before any model saw them, and nothing was changed
  after they were scored. The `strawb` regression, found after scoring, is reported, not fixed.
- **The synthetic error model.** One edit from a word used in at least 20 product names is the
  model a Norvig corrector assumes, which favors that corrector by construction, and the generator
  samples brand names as often as common words.
- **The Wikipedia set.** Its words are general English filtered to words some product uses, not
  grocery queries, and 55 of its 473 cases have a stop word as the correct word. The search ignores
  stop words, so a correct suggestion for those finds nothing; they favor the corrector on the
  exact-word count, which credits it for them.
- **Strict scoring of corrections.** A correction counts only if it equals the intended word.
  Search accuracy is the primary measure.
- **Labels are string matches.** No person judged relevance.
- **One machine, one network.** The laptop was also running a browser, with a load average of 3 to
  14, and it reached `api.typesafe.ai` from one location. Postgres times depend on the hardware and
  Jev times on the distance to TypeSafe.
- **Nondeterminism.** Five runs bound the variation reported here.
- **Post hoc analyses.** The floor sweep, the cascade and the stop-word split were computed after
  the results were seen.
- **Scope.** The study covers one English grocery catalog and one model version. It has no
  comparison with Algolia's ranking and none with a general-purpose language model doing the same
  judgments.

## 9. Reproducing the results

```sh
npm install && npm run db && npm run load -- --full                         # 440,302 products
node scripts/make-spelling-set.ts                                            # eval/synthetic.json, seed 20261007
node scripts/make-spelling-set.ts --seed 20261008 --out synthetic-test.json  # eval/synthetic-test.json
node scripts/make-wikipedia-set.ts                                           # eval/wikipedia.json
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts                 # one run: about 12 minutes, $0.15
node scripts/report.ts                                                       # results/report.md and docs/figures/*.svg
node scripts/report.ts results/v1                                            # the first version's report
```

The generators write the same files again on the same load; the Wikipedia generator reads a fixed
page revision. [`results/`](results/) holds the five runs reported here, one JSON file each, with
every query's outcome, Jev's scores and probabilities, timings, versions and machine load;
`results/v1/` and `results/dev/` hold the earlier runs. `scripts/report.ts` reads only those files,
so every table and figure in this README can be rebuilt without a database or a key.

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
cutoff. Jev's "Did you mean" covers both, but it respells one word per query, rarely reaches a
word whose last letter was dropped, and can offer a shorter word for an unfinished one (`strawb`
to "straw"). A typo of a very common word is slow: the demo page waits about 1.25 s for
"chocolatte". The materialized views are stale until refreshed.
[How it works](docs/how-it-works.md#what-it-does-not-do) lists each cost.

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
- Wikipedia contributors. Lists of common misspellings/For machines, revision 1199637275 (2024).
  https://en.wikipedia.org/w/index.php?title=Wikipedia:Lists_of_common_misspellings/For_machines&oldid=1199637275,
  CC BY-SA 4.0; adapted in `eval/wikipedia.json`.
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
