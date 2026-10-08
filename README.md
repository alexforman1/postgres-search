# postgres-search

Product search inside PostgreSQL: whole words, partial words, typos, barcodes, typeahead and facet
counts, all in SQL, with an optional second stage that asks [Jev](https://docs.typesafe.ai), a
hosted model that returns probabilities instead of text, two questions per search. This README is
also a report on that second stage: how much it helps, how each version failed and was fixed, what
it costs, and how it compares with Algolia.

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
correctors that use no model, among them one in the style of Norvig (2007). The design went through
six versions. Each change was made on data already seen and frozen in a commit; new test sets were
then generated, committed before any model saw them, and scored under an analysis plan fixed at the
freeze. The current version, 2.4, was scored on three such sets: 500 one-edit misspellings and
controls, 179 words cut short as a user types them, and 200 correctly spelled words that each sit
one edit from a far more common word. Every system ran five times on 5,067 queries with the model
pinned to `jev-1.13.0`.

On the 500 misspellings and controls, the right product came first for 35% of queries with plain
full-text search and 63% with this SQL. Jev's keep-or-sink reorder raised that to 66%, and its "Did
you mean" link, when followed, to 81% (82% with both questions); all three gains hold after Holm's
correction in every run (adjusted p ≤ 0.003). The dictionary corrector reached 80%. Across the five
synthetic test sets, each scored by the version it was made for, the two have stayed within two
points of each other, as they should on errors made to fit the corrector's own model. Where the
errors are not of that kind, they part. On real misspellings from Wikipedia's list Jev leads 71% to
64%, and 84% to 31% on the 32 that are themselves words some product uses. On words cut short,
this SQL with Jev finds the right product first for 75% and the corrector, which respells what the
user has not finished typing, for 28%. The corrector's one structural advantage is the opposite
case: it never changes a word that some product name uses, so of the 200 tempting correct words it
respells none, where Jev respells 8.

The design came from failures, each found on a set made after a freeze. Version 1 withheld the
evidence a corrector uses, candidates one edit away and how many products each spelling finds, and
lost 78% to 85%; given both, Jev picked the intended word 88% of the time it was offered, up from
68%. Version 2 kept completions out of the options and offered "straw" for `strawb`; version 2.1's
fix failed its own test (57% against 81% for this SQL on words cut short). Version 2.2 left a cut
word that shares a stem with other words to the wrong step (`monke` found monk fruit); version 2.3
fixed that, raising words cut short from 75% to 81% against version 2.2 on the same queries.
Version 2.4 added one change and rejected another by a rule set before its development run.

Each Jev call returns all its judgments in one round trip: ten product judgments in 159 ms at the
median, or a choice among seven spellings in 155 ms. The two calls run at the same time; on the
searches that send them they add 164 ms to the page, and a word still being typed usually sends
neither. They cost \$0.081 per 1,000 searches on the hand-written queries. The spelling
probabilities are well calibrated (expected calibration error 0.010; right 97.7% of the time at
0.9 or more), and the page says that nothing matches for 12 of 15 queries that have no answer in a
grocery catalog against 145 of 5,052 that do. For this demo's 440,302 records, Algolia's published
Grow price is \$136 a month for records alone, before any search; at 100,000 searches a month it is
\$181 to \$381, against \$8.14 for the Jev step.

| median of five runs | plain Postgres full-text search | this SQL | this SQL + Jev | this SQL + Norvig corrector |
|---------------------|--------------------------------:|---------:|---------------:|----------------------------:|
| right product first, one-edit misspellings and controls, clean test (500) | 35% | 63% | **82%** | 80% |
| right product first, words cut short, clean test (179) | 11% | **76%** | 75% | 28% |
| right product first, tempting correct words, clean test (200) | **94%** | 93% | 91% | 93% |
| right product first, real misspellings from Wikipedia (473) | 5% | 43% | **71%** | 64% |
| right product first, real-word errors among them (32) | 28% | 31% | **84%** | 31% |
| tempting correct words respelled (200) | | | 8 | **0** |
| says nothing matches, queries with no answer (15) | 12 | 2 | 12 | |
| says nothing matches, queries with an answer (5,052) | 2,975 | 115 | 145 | |
| time per search, median | 1 ms | 10 ms | 186 ms with a Jev call, 177 ms over all | |
| cost per 1,000 searches, beyond the database | | | \$0.081 | |

"This SQL + Jev" asks both questions and follows a "Did you mean" link when one appears.

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

A word that no name uses is one the user may still be typing when the most common word that starts
with it has another stem. The word step is skipped for it, because its stem would match other
words first: `monke` would find MONK FRUIT sweetener, and the prefix step finds monkey bread. When
the completion has the same stem (`imagin`, "imagine"), the word step already finds it and runs as
usual.

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
is skipped when k < 2, when every candidate is in one group, or when the prefix step found the
rows. Those pages answer words still being typed, and Jev cannot know which completion is meant.

**Did you mean.** For each query word w of four or more letters, without digits and not a stop
word, `search.similar_words` collects candidates from `search.words`: every word one edit from w (a
letter added, removed or replaced, or two neighbors swapped; Damerau, 1964), most found first, then
words with trigram similarity of 0.3 or more, closest first, up to 8 in all. A candidate must have
a different English stem from w (the search already treats one stem alike, so `hellmanns` is not a
misspelling of "hellmann"), and the search must find it in more products than both w and the most
common word, of another stem, that starts with w. A word the user may still be typing, by the rule
of section 2.1, gets no candidates, since the prefix step already shows the products of the words
it starts (`strawb` shows strawberries, `monke` monkey bread). The exception is a word with a
candidate found in at least 100 times as many products as the most common word that starts with it
(`healht`: "health" in 1,532 products, HEALHTY in 1); it gets its candidates, and that completion
is offered too, marked as finishing what was typed. The options are the query as typed, o₀, then
the query with one word replaced, each word's closest candidate before any word's second, up to 16.
Each option tells Jev how many edits separate it from what was typed and how many products the
search finds for the word it changes, the evidence a dictionary corrector works from. One request
asks a Choice question over the options and returns a distribution p. With C the completions
offered, the page offers

```math
o^{*} = \arg\max_{i > 0,\; o_i \notin C} \; p(o_i) \quad \text{as a link, if } p(o^{*}) \ge 2\Big(p(o_0) + \sum_{c \in C} p(c)\Big) \text{ and } p(o^{*}) \ge 0.3
```

and never searches o* without a click. A completion counts with the spelling typed because the
prefix step already shows it: choosing it suggests nothing. Comparing o* with the spelling typed,
rather than with a fixed bar, keeps a suggestion when Jev splits the rest of its probability among
several close words. The question needs only the query, so the server sends it while Postgres is
still searching.

**No match.** The page says that no result matches when every sᵢ < τ, no candidate holds the
typed words (ignoring accents, spaces and punctuation), and there is no suggestion. The results
stay on the page.

**Failure.** Any error, timeout (1.5 s) or incomplete answer leaves the page as Postgres made it.
[The Jev step](docs/jev.md) shows both request bodies.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/timeline-dark.svg">
  <img alt="Timeline of one search at the medians of searches that send a Jev call: Postgres takes about 9 ms and the keep-or-sink call about 159 ms on one path; the spelling call takes about 155 ms on the other; the page median is 186 ms." src="docs/figures/timeline-light.svg" width="860">
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
| synthetic test, [`eval/synthetic-test.json`](eval/synthetic-test.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261008, after version 2 was frozen | carries the intended word | test for version 2; informed 2.1 and 2.2 |
| Wikipedia, [`eval/wikipedia.json`](eval/wikipedia.json) | 473 real misspellings of 307 words | from Wikipedia's list, after version 2 was frozen | carries the intended word | test for version 2; checked while making 2.2 |
| synthetic test 2, [`eval/synthetic-test-2.json`](eval/synthetic-test-2.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261009, after version 2.1 was frozen | carries the intended word | test for version 2.1; rescored |
| truncation, [`eval/truncation.json`](eval/truncation.json) | 300 words cut short | seed 20261010, after version 2.1 was frozen | carries the full word | test for version 2.1; informed 2.2 |
| synthetic test 3, [`eval/synthetic-test-3.json`](eval/synthetic-test-3.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261011, after version 2.2 was frozen | carries the intended word | test for version 2.2; informed 2.3 |
| truncation 2, [`eval/truncation-2.json`](eval/truncation-2.json) | 300 words of 7 or more letters cut short | seed 20261012, after version 2.2 was frozen | carries the full word | test for version 2.2; informed 2.3 |
| synthetic test 4, [`eval/synthetic-test-4.json`](eval/synthetic-test-4.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261013, after version 2.3 was frozen | carries the intended word | test for version 2.3; informed 2.4 |
| truncation 3, [`eval/truncation-3.json`](eval/truncation-3.json) | 300 words of 7 or more letters cut short | seed 20261014, after version 2.3 was frozen | carries the full word | test for version 2.3; informed 2.4 |
| near words, [`eval/near-words.json`](eval/near-words.json) | 200 correctly spelled words one edit from a far more common word | seed 20261015 | carries the word | development |
| synthetic test 5, [`eval/synthetic-test-5.json`](eval/synthetic-test-5.json) | 500: 300 misspelled, 200 correctly spelled | seed 20261016, after version 2.4 was frozen | carries the intended word | **test** |
| truncation 4, [`eval/truncation-4.json`](eval/truncation-4.json) | 179 words of 7 or more letters cut short | seed 20261017, after version 2.4 was frozen | carries the full word | **test** |
| near words test, [`eval/near-words-test.json`](eval/near-words-test.json) | 200 correctly spelled words one edit from a far more common word | seed 20261018, after version 2.4 was frozen | carries the word | **test** |
| absent, [`eval/absent.json`](eval/absent.json) | 15 household goods | by hand | (none should match) | can a system say no? |

The six synthetic sets, the four truncation sets and the two near-word sets come from
[`scripts/make-spelling-set.ts`](scripts/make-spelling-set.ts). It samples words uniformly from
those of five or more letters, without digits and not stop words, that appear in at least 20
product names and in no other eval file. Each of 300 gets one Damerau edit at a position other than
the first letter, 75 of each type, redrawn up to ten times while the result is itself a word in the
index, so these are non-word errors in the sense of Kukich (1992). Damerau (1964) found that about
80% of non-word misspellings are a single such edit. The next 200 sampled words are the controls.
The truncation sets use the same sampling and cut each word to a length from four letters to one
letter short of the word, skipping cuts that are themselves words in the index. In the first, many
sampled words are short and 162 of the 300 lose one letter, so the later two sample words of seven
or more letters: in truncation 2, 81 lose one letter, 165 two or three, and 54 four or more; in
truncation 3, 88, 155 and 57. Truncation 4 holds only 179: few unused words of seven or more
letters were left. The near-word sets hold correctly spelled words used in at least 20 product
names, each one edit from a word of another stem found in at least ten times as many products
(`wood`, "food"; `heath`, "health"; `kraut`, "kraft"). They measure false alarms where a respelling
is most tempting. A corrector that keeps any word some name uses, as the Norvig corrector does,
respells none of them by construction. Each set leaves out every word of the sets made before it,
so later sets draw from a smaller and rarer vocabulary.

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

The work had six stages. Each version was frozen in a commit before the sets that test it were
generated, and the sets were committed before any model saw them.

1. **Version 1.** The first spelling question offered only trigram neighbors, showed Jev the bare
   spellings, and suggested at 0.6. It ran five times on the three development sets and the absent
   set ([`results/v1/`](results/v1/report.md)) and lost to the Norvig corrector.
2. **Version 2.** We traced the losses (section 4.2), changed the candidates and the evidence, and
   chose the suggestion rule on the development sets with
   [`scripts/spelling-rules.ts`](scripts/spelling-rules.ts) (one run in
   [`results/dev/`](results/dev/report.md)). Frozen in `9eb9f3a`; test sets in `4f8e718`; five
   runs in [`results/v2/`](results/v2/report.md).
3. **Version 2.1.** Version 2's results showed it overriding the prefix step on unfinished words
   (`strawb`). We added a completion test on the development sets (one run in
   [`results/dev21/`](results/dev21/report.md)). Frozen in `5fb118e`; test sets in `b4b0956`. Its
   one run ([`results/v21/`](results/v21/report.md)) failed on the truncation set (section 4.3).
4. **Version 2.2.** We changed the rule using data already seen: the truncation set and version 2's
   test sets, in one run made from the working tree before the freeze
   ([`results/dev22/`](results/dev22/report.md); its file records the commit below it, `bd1c442`).
   Frozen in `602d77d`; test sets synthetic test 3 and truncation 2 in `820f6dc`. The analysis
   plan was committed before any run file was read. It was changed once in that window: a first
   plan pooled the two new sets for the primary tests, and `341a5f2` split them, because the
   corrector and plain full-text search have no rule for unfinished words and truncation 2 would
   tilt two of the four comparisons. Five runs in [`results/v22/`](results/v22/report.md). The
   first records commit `8501272` and the others `341a5f2`; the two differ only in
   `scripts/report.ts`.
5. **Version 2.3.** Version 2.2's runs left two faults on words cut short. A cut word whose stem
   matches other words was answered by the word step (`monke` found monk fruit), and keep or sink
   lost more queries than it won on pages the prefix step answered. We changed the search, the
   candidates and the reorder using the sets already seen: the SQL alone on all of them, and one
   development run with Jev ([`results/dev23/`](results/dev23/report.md)). That run showed the
   first rule dropping three Wikipedia suggestions (`essentail`, `minature`, `imagin`), so the rule
   was narrowed to words whose most common completion has another stem, and checked again without
   Jev. Frozen in `09c2134`, with the analysis plan; test sets synthetic test 4 and truncation 3 in
   `463a46e`. Version 2.2's code then ran once on the two new sets
   ([`results/v22-new/`](results/v22-new/)) for a paired comparison. Five runs in
   [`results/v23/`](results/v23/report.md).
6. **Version 2.4.** Version 2.3's remaining losses to the corrector came from two sources. Some
   misspellings start a rare misspelled product word and were taken for words still being typed
   (`healht`, HEALHTY), and some correct brand spellings were respelled (`salada` to "salad"). We
   tried two changes on the seen sets, made a development set of near-word controls, and
   committed a rule for keeping each before the development run
   ([`results/dev24/`](results/dev24/report.md); version 2.3's run on the near-word set is in
   [`results/v23-near/`](results/v23-near/)). The completion option met its rule and stays. The
   other change named, for the spelling typed, the most popular product whose name uses it
   (SALADA GREEN TEA). It cut false alarms on the near-word set from 20 of 200 to 0, but
   Wikipedia real-word errors fixed fell from 23 to 18 of 32, past its limit of 2: shown
   CARRIBEAN in a marinade's name, Jev kept `carribean`. It was removed. Frozen in `a46e416`,
   with the analysis plan; test sets synthetic test 5, truncation 4 and near words test in
   `f2fff87`. Version 2.3's code ran once on the three new sets
   ([`results/v23-new/`](results/v23-new/)). Five runs in [`results/`](results/report.md).

[`scripts/compare.ts`](scripts/compare.ts) runs every query through every system in sequence, after
one untimed pass so each timed query runs on a warm cache. Five runs per version, model pinned to
`jev-1.13.0` (every answer reported that version), PostgreSQL 16.12 in Docker with default
settings, Node 22.23, an Intel Core i5-10500H with 12 logical CPUs and 8 GB of RAM. The machine was
also running a browser; the load average was between 2.5 and 7.1 during version 2.2's runs. Times
are measured in Node around each call, so they include the round trip to Postgres and, for Jev, to
`api.typesafe.ai`.

Each run writes every query's outcome, Jev scores, probabilities and timings to
[`results/`](results/), and [`scripts/report.ts`](scripts/report.ts) computes every number and
figure here from those files ([`results/report.md`](results/report.md)). Plain Postgres and this
SQL are deterministic. For systems that call Jev, tables give the median of five runs and the range
when runs differ.

### 3.5 Statistics

Proportions carry 95% Wilson (1927) intervals, computed on the median run, so they do not include
run-to-run variation. Paired systems are compared with the exact two-sided McNemar (1947) test,
once per run. For version 2.4, four comparisons on synthetic test 5 are primary and corrected with
Holm's (1979) method, run by run; tables give the range of adjusted p over the five runs and how
many fall under 0.05. Two more, set at the freeze, compare version 2.4 with version 2.3's one run
on the new sets: "Did you mean" on synthetic test 5 and both Jev questions on truncation 4,
corrected with Holm's method across the two. The plan also reports, on truncation 4, how many
searches send a Jev call and the page time, and, on the near words test, how many correct words
each corrector respells. A last test asks whether "Did you mean" loses queries on truncation 4 that
this SQL gets right; it is reported uncorrected. All other tests are exploratory. Earlier versions'
primary tests are in their own folders under [`results/`](results/). Calibration is summarized by
the expected calibration error over ten equal-width bins (Guo et al., 2017) and the Brier (1950)
score.

## 4. Results

### 4.1 Versions at a glance

| version | change | test sets made after its freeze | result on those sets |
|---------|--------|---------------------------------|----------------------|
| 1 | trigram neighbors, bare spellings, a bar of 0.6 | none | lost to the corrector on the development sets, 78% to 85% |
| 2 | one-edit candidates, product counts, edit counts, twice-as-likely rule | synthetic test, Wikipedia | "Did you mean" 78% against the corrector's 75% (Holm p ≤ 0.040) |
| 2.1 | a completion test for unfinished words | synthetic test 2, truncation | failed: 57% against 81% for this SQL on words cut short (one run) |
| 2.2 | no candidates for a word that finds nothing but starts an index word | synthetic test 3, truncation 2 | 83% against 83% on misspellings; 76% against 75% for this SQL on words cut short |
| 2.3 | the word step and the reorder skip words still being typed | synthetic test 4, truncation 3 | words cut short 75% to 81% against version 2.2; misspellings 82% against 84% |
| 2.4 | a completion offered beside a far more common respelling | synthetic test 5, truncation 4, near words test | no change from version 2.3 detected; misspellings 81% against 80%; 8 of 200 tempting correct words respelled |

### 4.2 What the first version got wrong

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

### 4.3 Words cut short, versions 2 to 2.3

Version 2 kept every candidate that finishes the typed word out of the options, so that the prefix
step would handle completions. For a word cut short this left Jev only shorter or nearby words, and
it chose them: `strawb` got "straw". On the 16 synthetic development misspellings that drop the
last letter, this SQL finds the right product for all 16 and version 2's "Did you mean" for 10.

Version 2.1 admitted such a candidate only when the search finds it in more products than the most
common completion of the typed word, and allowed completions one letter longer. On the development
sets it looked fixed, 15 of those 16. On the truncation set, made after it was frozen, it failed:
it suggested a word for 194 of the 300 words cut short, 86 of them the full word, and "Did you
mean" found the right product for 57% of queries in its one run, against 81% for this SQL alone.
Its wrong suggestions were nearby words common enough to pass the test: `yellowf` to "yellow"
(meant yellowfin), `orna` to "orca" (meant ornaments).

Version 2.2 gave no candidates to a word that the search finds in no product but that starts some
word in the index, and on its own new truncation set "Did you mean" took away no more than it
added (5 gained, 2 lost). Two faults remained there. A cut word that shares a stem with other
words was answered by the word step before the prefix step could run: `monke` found MONK FRUIT
sweetener, `hagge` the stuffed grape leaves of Hagg Interests rather than Haggen. On the two
truncation sets these made up 55 of the misses. And the reorder, asked about pages the prefix step
had answered, sank right results more often than it raised them: 7 or 8 losses against 1 or 2 wins
on truncation 2, 7 to 9 against 5 on truncation, and almost none either way on the other sets.

Version 2.3 treats a word as still being typed when no name uses it and the most common word that
starts with it has another stem (section 2.1). The search skips the word step for it, the spelling
question gives it no candidates, and the reorder skips any page the prefix step answered. The
stem condition came from the development run: without it the rule also caught `imagin`, which the
word step already answers with "imagine", and two misspellings that start misspelled product words
of the same stem (`essentail`, `minature`), and dropped their suggestions.

| right product first | version 2 | version 2.1, one run | version 2.2 | version 2.3 | Norvig corrector |
|---------------------|----------:|---------------------:|------------:|------------:|-----------------:|
| synthetic development set, last letter cut, "Did you mean" (16) | 10 | 15 | 16 | 16 | |
| truncation (300), made for 2.1, both questions | | 56% | 82% | 86% | 40% |
| truncation 2 (300), made for 2.2, both questions | | | 74% | 81% | 30% |
| truncation 3 (300), made for 2.3, this SQL | | | 72% | 80% | |
| truncation 3 (300), made for 2.3, both questions | | | 75% | 81% | 33% |

On truncation 3, version 2.2's numbers come from its one run on the set; this SQL is deterministic.
Query by query, version 2.3's SQL gets 24 right that version 2.2's gets wrong and none the other
way, and with both Jev questions 24 against 5 (Holm-adjusted p < 0.0001 and 0.0005 in every run;
[`results/v23/`](results/v23/report.md)). The gain is in cuts of two or more letters, 68% to 76%
with both questions; on one-letter cuts it is 91% to 93%. "Did you mean" now makes no suggestion on
truncation 3, so it can neither add nor take away anything there, and the reorder runs on the few
pages the prefix step did not answer: 3 queries gained, none lost. The corrector, which respells
any word it does not know, finds the right product for 33%; on cuts of two or more letters, 11%.

### 4.4 Version 2.4: a completion beside a common respelling, and an example that was rejected

Version 2.3 lost queries to the corrector in two ways. A misspelling that happens to start a rare
misspelled product word was taken for a word still being typed and got no respelling: `healht`
starts HEALHTY, while "health", one swap away, is in 1,532 products. And Jev respelled some correct
brand or regional spellings one edit from a common word (`salada` to "salad", `smokin` to
"smoking"), 4 of 200 controls on synthetic test 4.

For the first, version 2.4 gives such a word its candidates when one is found in at least 100 times
as many products as the most common word that starts with it, and puts that completion among the
options, counted with the spelling typed (section 2.2). A bare "more products" bar would send about
190 of each 300 words cut short to Jev, as version 2.1 did; at 100 times it sends 18 to 27. For the
second, a development version named, beside the spelling typed, the most popular product whose
name uses it (SALADA GREEN TEA), so that Jev could see a brand. A development set of 200 such
tempting correct words was made for it. Rules for keeping each change were committed before the
development run ([`results/dev24/`](results/dev24/report.md)), against version 2.3's runs:

| change | measure | rule | result |
|--------|---------|------|-------:|
| product example | false alarms on the near-word development set | fall by at least a third | 20 to 0 of 200 |
| product example | Wikipedia real-word errors fixed | fall by at most 2 of 32 | 23 to 18 |
| product example | "Did you mean", synthetic test 4 and Wikipedia | fall by at most a point | 82.4% to 83.6%, 69.6% to 70.6% |
| completion option | both questions on the three truncation sets | fall by at most a point | 86.0% to 86.3%, 81.3% to 81.7%, 81.0% to 80.7% |
| completion option | truncation searches that send a Jev call | rise by at most ten points | 14% to 22%, 13% to 19%, 10% to 19% |

The example failed on real-word errors. Shown CARRIBEAN in a marinade's name, COLLOSAL in a
shrimp's and CANNISTER in a milk powder's, Jev still leaned toward the right word but no longer by
two to one, and three right products were lost. It was removed, and version 2.4 is version 2.3 with
the completion option.

On the sets made after the freeze, the completion option made no measurable difference. Against
version 2.3's run on the same queries ([`results/v23-new/`](results/v23-new/)), "Did you mean" on
synthetic test 5 gained 0 or 1 query and lost 1 or 2, and both questions on truncation 4 gained 0
or 1 and lost 1 (Holm-adjusted p = 1.000 in every run). The case it targets is rare: `healht` in
synthetic test 4 now gets "health" in every run, and `pria`, where Jev chooses the completion
PRIANO, still gets nothing. It sends a Jev call on 23% of truncation 4's searches against 15% for
version 2.3, which moves the median page there from 4 ms to 7 ms and leaves the 90th percentile at
175 ms.

### 4.5 Finding the right product, on the test sets

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/accuracy-dark.svg">
  <img alt="Dot plot of hit@1 with 95% Wilson intervals. Synthetic test 5: plain Postgres 35%, this SQL 63%, Norvig corrector 80%, keep or sink 66%, both Jev questions 82%. Truncation 4: 11%, 76%, 28%, 76%, 75%. Near words test: 94%, 93%, 93%, 94%, 91%." src="docs/figures/accuracy-light.svg" width="860">
</picture>

Right product first (hit@1), median of five runs, 95% Wilson interval of that run. The first
three sets were made after version 2.4 was frozen; the Wikipedia set was made for version 2 and is
rescored here.

| system | synthetic test 5 (500) | truncation 4 (179) | near words test (200) | Wikipedia (473) | Wikipedia, real-word errors (32) |
|--------|-----------------------:|-------------------:|----------------------:|----------------:|---------------------------------:|
| plain Postgres full-text search | 35% [31, 40] | 11% [7, 16] | **94%** [89, 96] | 5% [4, 8] | 28% [16, 45] |
| this SQL | 63% [58, 67] | **76%** [69, 82] | 93% [88, 95] | 43% [38, 47] | 31% [18, 49] |
| + keep or sink | 66% [62, 70] | **76%** [69, 82] | **94%** [90, 97] | 48% [44, 53] | 31% [18, 49] |
| + Did you mean | 81% [78, 84] | 75% [69, 81] | 89% [84, 93] | 70% [66, 74] | **84%** [68, 93] |
| + both | **82%** [79, 85] | 75% [69, 81] | 91% [86, 94] | **71%** [67, 75] | **84%** [68, 93] |
| this SQL + Norvig corrector | 80% [77, 84] | 28% [22, 35] | 93% [88, 95] | 64% [60, 68] | 31% [18, 49] |

On the 300 misspellings of synthetic test 5, this SQL finds the right product first for 48%, keep
or sink for 52%, "Did you mean" for 79% and the corrector for 77%; on its 200 correctly spelled
controls, 85%, 88%, 85% and 85%. Right product in the top 10 (hit@10) on synthetic test 5: plain
40%, this SQL 76%, + keep or sink 76% (it only reorders the top 10), + Did you mean 92%, the
corrector 91%. On truncation 4 this SQL has the right product in the top 10 for 92%. On the
hand-written development queries the full system reaches 96% (this SQL 82%, plain 52%).

On the sets made for earlier versions, rescored, "Did you mean" reaches 78% on version 2's 973 test
queries (the corrector 75%), 83% on synthetic test 4 (the corrector 84%), and with both questions
81% on truncation 3 (the corrector 33%).

### 4.6 Primary comparisons

On synthetic test 5, exact McNemar with Holm's correction across these four, applied run by run:

| comparison | hit@1 | right only in the first | right only in the second | adjusted p, range over runs | runs under 0.05 |
|------------|------:|------------------------:|-------------------------:|----------------------------:|----------------:|
| this SQL vs plain full-text search | 63% vs 35% | 149 | 13 | < 0.0001 | 5 of 5 |
| + keep or sink vs this SQL | 66% vs 63% | 21 to 25 | 4 to 5 | 0.0006 to 0.003 | 5 of 5 |
| + Did you mean vs this SQL | 81% vs 63% | 105 to 107 | 13 | < 0.0001 | 5 of 5 |
| + Did you mean vs Norvig corrector | 81% vs 80% | 10 to 11 | 6 to 8 | 0.332 to 0.648 | 0 of 5 |

Three favor the method in every run; the fourth is not significant in any. Across the five
synthetic test sets, each scored by the version it was made for, "Did you mean" and the corrector
reached 85% and 86%, 83% and 83%, 83% and 83%, 82% and 84%, and 81% and 80%. Of these, only the
corrector's lead on synthetic test 4 reached significance after correction, in 2 of that version's
5 runs.

### 4.7 Spelling correction against classical correctors

A suggestion is "fixed" when it equals the intended word, "wrong" when it is another word, and a
"false alarm" when it respells a correctly spelled control. This is stricter than search accuracy:
"lettuce" for an intended "lettuces" counts as wrong though both searches find lettuce.

| synthetic test 5, median run | Jev | Norvig corrector | frequency rule |
|------------------------------|----:|-----------------:|---------------:|
| misspellings fixed (300) | 245 (82%) | 260 (87%) | 154 (51%) |
| wrong suggestions | 34 | 40 | 131 |
| no suggestion | 20 | 0 | 15 |
| correct words respelled (200) | 0 | 0 | 76 (38.0%) |
| precision | 88% | 87% | 43% |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/spelling-by-edit-dark.svg">
  <img alt="Bar chart of right product first by edit type on synthetic test 5, for this SQL, Did you mean and the Norvig corrector: last letter deleted 100%, 100%, 79%; other deletions 43%, 70%, 69%; insertion 73%, 88%, 89%; substitution 33%, 81%, 81%; transposition 31%, 69%, 68%." src="docs/figures/spelling-by-edit-light.svg" width="860">
</picture>

| synthetic test 5, fixed | n | Jev | Norvig corrector | frequency rule | intended word offered to Jev |
|-------------------------|--:|----:|-----------------:|---------------:|-----------------------------:|
| deletion, last letter | 14 | 0 | 11 (79%) | 0 | 0 |
| deletion, other letter | 61 | 44 (72%) | 45 (74%) | 21 (34%) | 60 (98%) |
| insertion | 75 | 71 (95%) | 74 (99%) | 49 (65%) | 74 (99%) |
| substitution | 75 | 67 (89%) | 66 (88%) | 43 (57%) | 75 (100%) |
| transposition | 75 | 63 (84%) | 64 (85%) | 41 (55%) | 75 (100%) |

| synthetic test 5, right product first | n | this SQL | + Did you mean | this SQL + Norvig corrector |
|---------------------------------------|--:|---------:|---------------:|----------------------------:|
| deletion, last letter | 14 | 14 (100%) | 14 (100%) | 11 (79%) |
| deletion, other letter | 61 | 26 (43%) | 43 (70%) | 42 (69%) |
| insertion | 75 | 55 (73%) | 66 (88%) | 67 (89%) |
| substitution | 75 | 25 (33%) | 61 (81%) | 61 (81%) |
| transposition | 75 | 23 (31%) | 52 (69%) | 51 (68%) |

By exact word the corrector fixes 15 more, 11 of them words missing their last letter, which Jev
leaves to the prefix step; Jev makes fewer wrong suggestions (34 against 40) and here respells no
correct word. By what the user finds, the two are within one query of each other on every other
edit type, and on words missing their last letter the prefix step finds all 14 where the
corrector's respellings find 11.

Over the six sets of misspellings made after a freeze, Jev picked the intended word 1,618 times
out of the 1,798 it was offered (90.0%).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/error-types-dark.svg">
  <img alt="Bar chart of misspellings fixed on the six sets made after a freeze: real-word errors (n = 32), Jev 72%, Norvig 0%, frequency rule 53%, cascade 72%; non-word errors (n = 1,941), Jev 82%, Norvig 88%, frequency rule 48%, cascade 88%." src="docs/figures/error-types-light.svg" width="860">
</picture>

| six sets, median run | Jev | Norvig corrector | frequency rule |
|----------------------|----:|-----------------:|---------------:|
| real-word errors fixed (32) | 23 (72%), 1 wrong | 0, by design | 17 (53%), 9 wrong |
| non-word errors fixed (1,941) | 1,595 (82%), 169 wrong | 1,712 (88%), 225 wrong | 925 (48%), 889 wrong |
| correct words respelled (1,000) | 6 (0.6%) | 0 | 367 (36.7%) |

The real-word errors all come from the Wikipedia set: a misspelling that is itself a word in some
product name (`carribean`, `coctail`), which the corrector keeps by design.

### 4.8 Tempting correct words

The controls of the synthetic sets are sampled from all words that products use, and few of them
sit near a more common word. The near words test holds 200 that do: correctly spelled words used
in at least 20 product names, each one edit from a word of another stem found in at least ten times
as many products. Here a respelling is most tempting and most costly.

| near words test (200), median run | Jev | Norvig corrector | frequency rule |
|-----------------------------------|----:|-----------------:|---------------:|
| words respelled | 8 (7 to 9) | 0, by construction | 198 |
| right product first, + Did you mean | 89% | 93% | 2% |
| right product first, + both questions | 91% | | |

Jev respelled 7 words in every run: `krab` to "crab", `snak` to "snack", `korn` to "corn",
`bacn` to "bacon", `brea` to "bread", `gods` to "goods" and `desert` to "dessert". Most are
stylized or misspelled spellings that products use often enough to pass the set's bar (KRAB is
imitation crab); `desert` in a grocery search is more often a typo for dessert, though the set
counts it as an error. The corrector's 0 is not a measurement of judgment: it keeps any word that
some name uses, which is also why it fixes no real-word error.

### 4.9 Knowing when nothing matches

An empty page, or for Jev the no-match line, counts as saying that nothing matches.

| queries | plain full-text search | this SQL | this SQL + Jev |
|---------|-----------------------:|---------:|---------------:|
| absent (15): says nothing matches | 12 | 2 | 12 |
| answerable (5,052): says nothing matches | 2,975 | 115 | 145 (144 to 149) |
| answerable, says so while a match is in the top 10 | 0 | 0 | 9 (8 to 10) |

Plain full-text search says no to absent queries because it says no to most queries: it returned
nothing for 2,975 of the 5,052 that have an answer. This SQL returns something for almost
everything, including Shamrock Farms sour cream for "shampoo". With Jev the page separates the
two: 12 of 15 absent queries against 145 of 5,052 answerable ones.

### 4.10 Calibration

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/reliability-dark.svg">
  <img alt="Reliability diagram of the spelling choice on the six test sets of misspellings: points run close to the diagonal in every bin; answers at 0.9 to 1.0 were right 97.7% of the time." src="docs/figures/reliability-light.svg" width="520">
</picture>

Over 12,870 spelling answers on the six sets of misspellings made after a freeze (five runs), the
probability of the option Jev ranked first tracks how often it was right: expected calibration
error 0.010, Brier score 0.067. Most answers (9,043) fall between 0.9 and 1.0, where Jev was right
97.7% of the time. Every bin from 0.3 up is within 6 points of its mean probability.

| Jev's probability | answers | right |
|-------------------|--------:|------:|
| 0.3 to 0.4 | 160 | 33.1% |
| 0.4 to 0.5 | 235 | 50.2% |
| 0.5 to 0.6 | 449 | 55.7% |
| 0.6 to 0.7 | 609 | 63.9% |
| 0.7 to 0.8 | 809 | 76.1% |
| 0.8 to 0.9 | 1,547 | 88.3% |
| 0.9 to 1.0 | 9,043 | 97.7% |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/threshold-dark.svg">
  <img alt="Suggestion rates as the floor moves, with the twice-as-likely rule: from 0.2 to 0.3, 82.1% of misspellings fixed and 0.6% of correct words respelled; at 0.9, 64.3% and 0.0%." src="docs/figures/threshold-light.svg" width="860">
</picture>

Moving the rule's floor after the fact shows that the twice-as-likely test does most of the work:
any floor from 0.2 to 0.5 gives 81% to 82% of misspellings fixed and 0.6% of correct words
respelled; a floor of 0.9 would give up a fifth of the fixes to bring false alarms to none.

The keep-or-sink scores separate results that carry the query from results that do not with an
area under the ROC curve of 0.726 over 185,435 scored results. The labels are string matches, which
count a peanut butter cookie as peanut butter, so this is agreement with a noisy label.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/noul-dark.svg">
  <img alt="Histogram of keep-or-sink scores: results that do not match their query cluster below 0.3; results that match spread from 0.2 to 0.9." src="docs/figures/noul-light.svg" width="860">
</picture>

### 4.11 Stability

Jev's answers vary between identical runs. Over five runs, "Did you mean" changed for 73 of the
2,154 queries that got one in any run (3%; 10% in version 1), the no-match line for 113 of 388
(29%), and the first result after keep or sink for 325 of 5,058 (6%). A cache keyed by query would
make repeated searches consistent for a user.

### 4.12 Time

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/latency-dark.svg">
  <img alt="Cumulative distribution of time per query on a log scale: plain full-text search median 1 ms, this SQL median 10 ms, this SQL with Jev median 177 ms." src="docs/figures/latency-light.svg" width="860">
</picture>

Five runs pooled, 25,335 queries per system, milliseconds:

| measure | median | p90 | p99 |
|---------|-------:|----:|----:|
| plain Postgres full-text search | 1 | 6 | 85 |
| this SQL | 10 | 110 | 435 |
| this SQL + Jev, whole page | 177 | 265 | 505 |
| time Jev adds to the page | 158 | 197 | 285 |
| this SQL + Jev, whole page, searches that sent a Jev call | 186 | 279 | 544 |
| time Jev adds, searches that sent a Jev call | 164 | 201 | 301 |
| one keep-or-sink call (10 results judged) | 159 | 194 | 270 |
| one spelling call (median 7 options) | 155 | 189 | 258 |

Plain full-text search is the fastest system by a wide margin, and Jev is the slowest. Each Jev
call returns its whole set of judgments in one round trip, and the two calls run at the same time,
so the page waits for the slower one. The machine was quieter during these runs (load average 1.4
to 4.5) than during version 2.3's (1.8 to 7.3), and every time here is lower, Postgres's most of
all; compare systems within a version's runs, not across versions. Keep or sink was sent on 75% of
searches and the spelling question on 72%; a word still being typed usually sends neither, so the
truncation sets cost \$0.012 to \$0.017 per 1,000 searches against \$0.094 on synthetic test 5. The
close-word lookup takes 2 to 22 ms in psql, and the test for a word still being typed adds about
0.1 to 0.25 ms to the search ([measurements](docs/measurements.md)).

## 5. Failure analysis

Examples that held in all five runs:

| kind | query | this SQL, first result | with Jev |
|------|-------|------------------------|----------|
| reorder fixes | `wheat thins` | RITZ CREAM CHEESE & ONION CRISP & THINS POTATO AND WHEAT CHIPS | WHEAT THINS ORIGINAL SNACKS |
| reorder fixes | `rooihos` | CALIDAD NACHOS ROUND TORTILLA CHIPS | PRIVATE SELECTION ROOIBOS CAFFEINE-FREE RED TEA |
| reorder fixes | `liqyorice` | MENTOS, DROP, CHEWY SWEETS, LICORICE | AUSSIE BLACK LIQUORICE NUGGETS |
| fixes the corrector cannot | `carribean`, `ceasar`, `coctail`, `holliday` | | caribbean, caesar, cocktail, holiday; each misspelling is in some product name, so the corrector keeps it |
| leaves a word being typed alone | `fier`, `tabl` | LAY'S FIERY HABANERO..., THE FATHER'S TABLE... | no suggestion; the corrector offers "fire" and "tail" |
| fixed in version 2.2 | `strawb` | the prefix step finds strawberries | no suggestion; version 2 offered "straw", and the corrector offers "straws" |
| the corrector fixes, Jev does not | `foyster`, `djraft`, `oliveir` | | oyster, kraft, oliver (meant foster, draft, olivier): a common word chosen over a rare brand |
| fixed in version 2.3 | `monke`, `hagge` | BLUE MONKEY coconut water, HAGGEN tomato sauce | the prefix step answers; version 2.2's word step found monk fruit and the grape leaves of Hagg Interests |
| fixed in version 2.3 | `frei` | FREIHOFER'S ORIGINAL HAMBURGER BUNS | kept first; version 2.2's reorder sank it below QUESO PARA FREIR |
| fixed in version 2.4 | `healht` | HEALHTY CHOICE yogurt | suggests "health", offered beside the completion HEALHTY; version 2.3 offered nothing |
| chooses the completion | `pria` | cheese tortellini | Jev picks PRIANO, which finishes what was typed, so nothing is suggested; the corrector offers "prima" |
| respells a correct word | `krab`, `snak`, `desert` | PREMIUM KRAB SALAD, SNAK CLUB pistachios, LILY OF THE DESERT aloe | suggests "crab", "snack" and "dessert"; the corrector keeps a word that some name uses |
| no answer possible | `abotu`, `agian` | | abbott, asian (meant about, again, stop words the search ignores) |
| no-match line, wrongly | `independant` | CULINARY SECRETS FANCY TOMATO KETCHUP | line shown; all ten results match only through the brand owner Independent Marketing Alliance |

On synthetic test 5 the reorder wins 21 to 25 queries and loses 4 or 5; on truncation 4 it wins 0
or 1 and loses none. Jev's wrong spellings are mostly reasonable common words where the intended
word is an uncommon brand; the generator samples brands (koppers, kunzler, sabatino) as often as
common words.

## 6. Discussion

The first version gave Jev less information than a 2007 spelling corrector uses, and lost. Given
the same evidence, edit distance and how often the catalog uses each spelling, it comes within two
points of the corrector on errors made to fit the corrector's assumptions (85% against 86%, 83%
against 83% twice, 82% against 84% and 81% against 80% on the five synthetic test sets; only the
gap on synthetic test 4 reached significance, in 2 of 5 runs) and beats it on errors people made
(71% against 64% on Wikipedia's list). Its advantage concentrates where the decision is a judgment
rather than a lookup: a misspelling that is itself a word in some product name (84% against 31%),
a possessive that only looks misspelled, a word the user has not finished typing (75% against 28%
on truncation 4), a list of results where some are wrong, and a query with no answer at all. Its
probabilities are calibrated well enough to act on.

The lesson for building with a model like this is the one the first version taught, and the later
versions taught it again. The model was not short of judgment; it was short of evidence, or it was
asked the wrong question. Version 1 withheld the counts. Version 2 withheld the completions, so for
`strawb` Jev could only choose among wrong words. Version 2.2 asked Jev to judge products for a
word the user had not finished, where no judgment can tell which completion is meant; version 2.3
stops asking. Evidence is not free of cost, though: version 2.4's product example made Jev more
careful with a spelling that some product uses, which is right for SALADA and wrong for
CARRIBEAN, and the second cost more than the first gained. The classical method's features belong
in the model's input, not beside it: the post hoc cascade, which hands unknown words to the
corrector and the rest to Jev, scores 81% on synthetic test 5, no better than Jev alone at 82%,
and 28% on truncation 4, where it inherits the corrector's habit of respelling unfinished words.

The protocol mattered as much as the model. Version 2.1 passed its development checks (15 of 16
words missing the last letter) and failed on the first set made to test it. Version 2.3's first
rule passed the SQL check on every seen set and failed in the development run, on three Wikipedia
misspellings. Version 2.4's product example looked like the larger of its two gains, and the rule
committed before its development run removed it. Only data a change has not been fitted to, under
a rule written before the data is read, can show that kind of failure.

Three weaknesses remain. Jev respells about 4% of correct words that sit one edit from a far more
common word, most of them stylized product spellings (`krab`, `snak`, `korn`); a dictionary
corrector cannot, and a product name was not enough to separate those from misspellings that
products also carry. A word that no name uses but that matches others through its stem, with
nothing that starts with it (`fleshed`), still reaches Jev with the stem's count as its own;
testing a change there needs controls on that path, such as possessives like `hellmanns`, which
the synthetic generator never produces. And the test sets are running out of words: each new set
leaves out the words of every earlier one, truncation 4 could draw only 179 cases, and a next
version will need a new source of queries, such as real search logs.

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
([TypeSafe models](https://docs.typesafe.ai/models)). A search used 1,937 input tokens on average
on the hand-written queries, \$0.081 per 1,000 searches, and \$0.087 to \$0.096 per 1,000 on the
sets of misspellings. A word still being typed usually makes no call, so the truncation sets cost
\$0.012 to \$0.017 per 1,000. Typeahead runs in Postgres and never calls Jev, so keystrokes cost
nothing, and there is no charge per record.

The database is not free. Search runs on it: this SQL took 10 ms at the median and 110 ms at the
90th percentile in these runs, and a typo of a very common word keeps the page with facets waiting
about 1.25 s ([measurements](docs/measurements.md)). The search objects take 436 MB for 440,302
products. The comparison below leaves out database hosting, which depends on what the database
already costs.

For N records, S searches a month and k billed requests per search:

```math
C_{\text{Algolia Grow}} = 0.40 \cdot \frac{\max(0,\, N - 100{,}000)}{1{,}000} + 0.50 \cdot \frac{\max(0,\, kS - 10{,}000)}{1{,}000}
\qquad
C_{\text{Jev}} = 0.0000814 \cdot S
```

k = 5 is an assumption, standing for a user who types five characters into an instant-search box
before choosing a result.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-dark.svg">
  <img alt="Monthly cost against searches per month, log scales: for 440,302 records Algolia Grow starts at about $136 a month and the Jev step at under $1; at one million searches Algolia costs $631 to $2,631 and the Jev step $81." src="docs/figures/cost-light.svg" width="860">
</picture>

| searches per month | Algolia Grow, 1 request per search | Algolia Grow, 5 requests per search | this SQL + Jev |
|-------------------:|-----------------------------------:|------------------------------------:|---------------:|
| 10,000 | \$136 | \$156 | \$0.81 |
| 100,000 | \$181 | \$381 | \$8.14 |
| 1,000,000 | \$631 | \$2,631 | \$81 |
| 10,000,000 | \$5,131 | \$25,131 | \$814 |

For this demo's 440,302 records, Algolia's record charge alone is \$136 a month before any search.
The author's own Algolia invoices fit the model: close to \$100 a month with 287,000 records and
close to \$200 with about 500,000, the record charge plus requests.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/figures/cost-records-dark.svg">
  <img alt="Algolia's record charge rises from zero at 100,000 records to $200 at 600,000; two invoices sit above the line at about $100 for 287,000 records and $200 for 500,000; the Jev step costs about $8 at 100,000 searches whatever the record count." src="docs/figures/cost-records-light.svg" width="860">
</picture>

### 7.3 What Algolia provides that this does not

None of these was measured here, and each should weigh in a choice between the two:

- **Latency and scaling.** Algolia serves from its own clusters. Here the search load lands on your
  database, and the Jev step adds 164 ms to the page at the median when it calls Jev.
- **Tools around search.** Analytics, A/B tests, merchandising rules, and Query Suggestions built
  from search history.
- **Typo tolerance inside retrieval.** Algolia counts a swap of two letters as one typo while it
  retrieves. Here a swap is fixed only through "Did you mean".
- **Ranking quality.** Algolia's ranking on this data was not measured.
  [`scripts/compare-algolia.ts`](scripts/compare-algolia.ts) reports top-10 overlap for a reader
  who has an index and keys.

## 8. Threats to validity

- **Development and test.** We wrote the hand-written and held-out sets, and the development sets
  shaped version 2: the candidates, the evidence and the suggestion rule. Each version's test sets
  were made after it was frozen and committed before any model saw them, and nothing was changed
  after they were scored. Each version was designed from failures that earlier test sets exposed,
  so for it those sets are development data; only synthetic test 5, truncation 4 and the near words
  test test version 2.4. The weaknesses in section 6, found after scoring, are reported, not fixed.
- **One baseline run.** Each comparison with the previous version on the new sets rests on one run
  of that version's code. Its SQL is deterministic; its Jev answers vary from run to run as the new
  version's do.
- **A shrinking vocabulary.** Every set leaves out the words of the sets before it, so later sets
  draw from rarer words, more of them brands; truncation 4 holds only 179 cases. Numbers from
  different sets are not directly comparable.
- **The near-word sets.** Their controls are words that at least 20 product names use, which
  includes stylized and misspelled product spellings (KRAB, SNAK). A respelling counts as an error
  even where it is arguably right (`desert` to "dessert"), and the Norvig corrector, which keeps any
  word a name uses, scores perfectly by construction.
- **The synthetic error model.** One edit from a word used in at least 20 product names is the
  model a Norvig corrector assumes, which favors that corrector by construction, and the generator
  samples brand names as often as common words. The truncation sets cut words at a length drawn
  uniformly and skip cuts that are words in the index; where real users stop typing was not
  measured.
- **The Wikipedia set.** Its words are general English filtered to words some product uses, not
  grocery queries, and 55 of its 473 cases have a stop word as the correct word. The search ignores
  stop words, so a correct suggestion for those finds nothing; they favor the corrector on the
  exact-word count, which credits it for them.
- **Strict scoring of corrections.** A correction counts only if it equals the intended word.
  Search accuracy is the primary measure.
- **Labels are string matches.** No person judged relevance.
- **One machine, one network.** The laptop was also running a browser, with a load average of 1.4
  to 4.5 during version 2.4's runs, and it reached `api.typesafe.ai` from one location. Postgres
  times depend on the hardware and Jev times on the distance to TypeSafe.
- **Nondeterminism.** Five runs bound the variation reported here.
- **Post hoc analyses.** The floor sweep, the cascade and the stop-word split were computed after
  the results were seen. Splitting deletions by position was chosen after the version 2.2
  development run and before its test runs. The readings of each version's losses to the corrector
  were done after its runs.
- **Scope.** The study covers one English grocery catalog and one model version. It has no
  comparison with Algolia's ranking and none with a general-purpose language model doing the same
  judgments.

## 9. Reproducing the results

```sh
npm install && npm run db && npm run load -- --full                         # 440,302 products
node scripts/make-spelling-set.ts                                            # eval/synthetic.json, seed 20261007
node scripts/make-spelling-set.ts --seed 20261008 --out synthetic-test.json  # eval/synthetic-test.json
node scripts/make-wikipedia-set.ts                                           # eval/wikipedia.json
node scripts/make-spelling-set.ts --seed 20261009 --out synthetic-test-2.json
node scripts/make-spelling-set.ts --seed 20261010 --out truncation.json --truncate
node scripts/make-spelling-set.ts --seed 20261011 --out synthetic-test-3.json
node scripts/make-spelling-set.ts --seed 20261012 --out truncation-2.json --truncate --min-length 7
node scripts/make-spelling-set.ts --seed 20261013 --out synthetic-test-4.json
node scripts/make-spelling-set.ts --seed 20261014 --out truncation-3.json --truncate --min-length 7
node scripts/make-spelling-set.ts --seed 20261015 --out near-words.json --near --min-length 4
node scripts/make-spelling-set.ts --seed 20261016 --out synthetic-test-5.json
node scripts/make-spelling-set.ts --seed 20261017 --out truncation-4.json --truncate --min-length 7
node scripts/make-spelling-set.ts --seed 20261018 --out near-words-test.json --near --min-length 4
JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts                 # one run: about 30 minutes, $0.37
node scripts/report.ts                                                       # results/report.md and docs/figures/*.svg
node scripts/report.ts results/v2                                            # an earlier version's report
```

The generators write the same files again on the same load; the Wikipedia generator reads a fixed
page revision. [`results/`](results/) holds the five runs reported here, one JSON file each, with
every query's outcome, Jev's scores and probabilities, timings, versions and machine load;
`results/v1/` to `results/v23/` hold the earlier versions' runs, `results/v22-new/` and
`results/v23-new/` each previous version's run on the next version's test sets, `results/v23-near/`
version 2.3 on the near-word development set, and the `dev` folders the development runs.
`scripts/report.ts` reads only those files, so every table and figure in this README can be rebuilt
without a database or a key.

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
cutoff. Jev's "Did you mean" covers both, but it respells one word per query, and it respells
about 4% of correct words that sit one edit from a far more common word, most of them stylized
product spellings (`krab` to "crab"). A typo of a very common word is slow: the demo page waits
about 1.25 s for "chocolatte". The materialized views are stale until refreshed.
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
