// Scores eval/queries.json (the results page) and eval/suggest.json (typeahead) against the loaded
// data. With TYPESAFE_API_KEY set it also scores the Jev step: its columns on the results page,
// eval/spelling.json (the spelling question), and eval/absent.json (the no-match line).
import { readFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { rerank, type Candidate, type RerankResult } from '../src/rerank.ts'
import { checkSpelling, type SimilarWord, type SpellingResult } from '../src/spelling.ts'
import { tokens } from '../src/tokens.ts'

interface Case {
  q: string
  kind: string
  expect: string
}

// What is typed into the search box (the first 4 or 5 letters of a word, or a whole short word),
// and a pattern the intended suggestion matches.
interface SuggestCase {
  q: string
  kind: string
  expect: string
}

// A misspelling and the spelling meant, or a correctly spelled control with no expect.
interface SpellingCase {
  q: string
  kind: 'typo' | 'control'
  expect?: string
}

interface Row extends Candidate {
  step: string
}

interface Score {
  cases: number
  // hits[i] counts the cases with a match in the top CUTOFFS[i] results.
  hits: number[]
}

const CUTOFFS = [1, 3, 10]
// Jev only reorders the top 10, so its hit@10 always equals the plain one.
const JEV_CUTOFFS = [1, 3]
// Dollars per million input tokens for jev-1.13.0 (https://docs.typesafe.ai/models). Output tokens
// are free.
const PRICE_PER_MTOK = 0.042
// The note server.ts sends with the spelling question.
const NOTE = 'A user typed `query` into the search box of a grocery and packaged food product search.'
// The rule Jev is compared with: respell a word to its most common close word when that word is
// used at least this many times as often as the word typed.
const FREQUENCY_RATIO = 10

const read = async (file: string) => JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
const cases: Case[] = await read('queries.json')
const suggestCases: SuggestCase[] = await read('suggest.json')
const spellingCases: SpellingCase[] = await read('spelling.json')
const absentCases: { q: string }[] = await read('absent.json')
const withJev = Boolean(process.env.TYPESAFE_API_KEY)

const pool = connect()

async function search(q: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
       FROM search.query_distinct($1) r JOIN search.documents d ON d.id = r.id
      ORDER BY r.pos`,
    [q],
  )
  return rows
}

async function similarWords(q: string): Promise<SimilarWord[]> {
  return (await pool.query<SimilarWord>('SELECT * FROM search.similar_words($1)', [q])).rows
}

interface Page {
  rows: Row[]
  searchMs: number
  pageMs: number
  reranked?: RerankResult<Row>
  spelling?: SpellingResult
}

// What the demo page does: the search and then the Jev reorder, and alongside them the close-word
// lookup and then the spelling question.
async function page(q: string): Promise<Page> {
  const started = performance.now()
  let searchMs = 0
  const [first, second] = await Promise.all([
    search(q).then(async rows => {
      searchMs = performance.now() - started
      return { rows, reranked: withJev ? await rerank(q, rows) : undefined }
    }),
    withJev ? similarWords(q).then(similar => checkSpelling(q, similar, { note: NOTE })) : undefined,
  ])
  return { ...first, spelling: second, searchMs, pageMs: performance.now() - started }
}

// Respells a word to its most common close word, when that word is used FREQUENCY_RATIO times as
// often as the word typed.
function frequencyRule(q: string, similar: SimilarWord[]): string | null {
  const words = tokens(q)
  const best = similar
    .filter(r => words[r.pos - 1] === r.word && r.doc_count >= FREQUENCY_RATIO * Math.max(r.word_count, 1))
    .sort((a, b) => b.doc_count - a.doc_count)[0]
  return best ? words.with(best.pos - 1, best.alternative).join(' ') : null
}

const matches = (row: Row, pattern: RegExp) => pattern.test(`${row.name} ${row.other_names ?? ''}`)

function add(score: Score, rows: Row[], pattern: RegExp) {
  score.cases += 1
  CUTOFFS.forEach((k, i) => {
    if (rows.slice(0, k).some(r => matches(r, pattern))) score.hits[i] += 1
  })
}

const blank = (): Score => ({ cases: 0, hits: CUTOFFS.map(() => 0) })
const scores = new Map<string, { plain: Score; jev: Score; followed: Score }>()
const misses: string[] = []
const suggested: string[] = []
const noMatches: string[] = []
const calls = { rerank: { ran: 0, skipped: 0, failed: 0 }, spelling: { ran: 0, skipped: 0, failed: 0 } }
const ms = { search: [] as number[], page: [] as number[], rerank: [] as number[], spelling: [] as number[] }
const pageTokens = { rerank: [] as number[], spelling: [] as number[] }
const models = new Set<string>()
let runTokens = 0

interface Call {
  error?: string
  ms: number
  inputTokens?: number
  model?: string
}

// Every call adds to the cost of the run; only results-page calls count toward cost and time per
// search.
function record(kind: 'rerank' | 'spelling', ran: boolean, out: Call, forPage: boolean) {
  if (ran) runTokens += out.inputTokens ?? 0
  if (!forPage) return
  if (out.error) calls[kind].failed += 1
  else if (ran) calls[kind].ran += 1
  else calls[kind].skipped += 1
  if (ran) {
    ms[kind].push(out.ms)
    pageTokens[kind].push(out.inputTokens ?? 0)
    if (out.model) models.add(out.model)
  }
}

const spellingScores = new Map<string, { cases: number; offered: number; jev: number; rule: number }>()
const spellingMisses: string[] = []
let absentNoMatch = 0
let absentEmpty = 0
const absentLines: string[] = []
const typed = new Map<string, { cases: number; hit1: number; hit8: number }>()
const suggestMisses: string[] = []

try {
  for (const c of cases) {
    const pattern = new RegExp(c.expect, 'i')
    const p = await page(c.q)
    ms.search.push(p.searchMs)
    ms.page.push(p.pageMs)
    if (p.reranked) record('rerank', p.reranked.reranked, p.reranked, true)
    if (p.spelling) record('spelling', p.spelling.ran, p.spelling, true)
    const jevRows = p.reranked?.results ?? p.rows
    // Following the suggestion runs a new search; score its plain Postgres results.
    const suggestion = p.spelling?.suggestion
    const followedRows = suggestion ? await search(suggestion) : jevRows
    if (suggestion) suggested.push(`${c.kind}: "${c.q}" -> "${suggestion}" (${p.spelling!.p.toFixed(2)})`)
    // The page shows the no-match line only when it has no suggestion to show.
    if (p.reranked?.noMatch && !suggestion) {
      const hit = p.rows.slice(0, 10).some(r => matches(r, pattern))
      noMatches.push(`${c.kind}: "${c.q}"${hit ? ', with a match in the top 10' : ''}`)
    }
    for (const kind of [c.kind, 'all']) {
      if (!scores.has(kind)) scores.set(kind, { plain: blank(), jev: blank(), followed: blank() })
      const entry = scores.get(kind)!
      add(entry.plain, p.rows, pattern)
      add(entry.jev, jevRows, pattern)
      add(entry.followed, followedRows, pattern)
    }
    if (!p.rows.slice(0, 10).some(r => matches(r, pattern))) {
      misses.push(`${c.kind}: "${c.q}" -> ${p.rows[0]?.name ?? 'no results'}`)
    }
  }

  if (withJev) {
    for (const c of spellingCases) {
      const similar = await similarWords(c.q)
      const out = await checkSpelling(c.q, similar, { note: NOTE })
      record('spelling', out.ran, out, false)
      const want = c.expect ? tokens(c.expect).join(' ') : null
      const rule = frequencyRule(c.q, similar)
      if (!spellingScores.has(c.kind)) spellingScores.set(c.kind, { cases: 0, offered: 0, jev: 0, rule: 0 })
      const score = spellingScores.get(c.kind)!
      score.cases += 1
      if (want === null || out.options.includes(want)) score.offered += 1
      if (out.suggestion === want) score.jev += 1
      if (rule === want) score.rule += 1
      if (out.suggestion !== want || rule !== want) {
        spellingMisses.push(
          `${c.kind}: "${c.q}" -> jev ${out.suggestion ? `"${out.suggestion}" (${out.p.toFixed(2)})` : `none (${out.p.toFixed(2)})`}` +
            `, rule ${rule ? `"${rule}"` : 'none'}${want && !out.options.includes(want) ? `, "${want}" not offered` : ''}` +
            `${out.error ? `, error: ${out.error}` : ''}`,
        )
      }
    }

    for (const c of absentCases) {
      const p = await page(c.q)
      if (p.reranked) record('rerank', p.reranked.reranked, p.reranked, false)
      if (p.spelling) record('spelling', p.spelling.ran, p.spelling, false)
      if (p.rows.length === 0) absentEmpty += 1
      if (p.reranked?.noMatch && !p.spelling?.suggestion) absentNoMatch += 1
      absentLines.push(
        `"${c.q}": ${p.rows.length} results, ${p.reranked?.noMatch ? 'no match' : p.reranked?.reranked ? 'not flagged' : 'not reranked'}` +
          `${p.spelling?.suggestion ? `, suggests "${p.spelling.suggestion}"` : ''}${p.rows[0] ? `, first ${p.rows[0].name}` : ''}`,
      )
    }
  }

  for (const c of suggestCases) {
    const pattern = new RegExp(c.expect, 'i')
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM search.suggest($1, 8)', [c.q])
    if (!typed.has(c.kind)) typed.set(c.kind, { cases: 0, hit1: 0, hit8: 0 })
    const score = typed.get(c.kind)!
    score.cases += 1
    if (rows.slice(0, 1).some(r => pattern.test(r.name))) score.hit1 += 1
    if (rows.some(r => pattern.test(r.name))) score.hit8 += 1
    else suggestMisses.push(`${c.kind}: "${c.q}" -> ${rows[0]?.name ?? 'no suggestions'}`)
  }
} finally {
  await pool.end()
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`
// The value at fraction p of the sorted list, such as the median at 0.5.
const at = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))]
const p50p90 = (values: number[]) => `p50 ${Math.round(at(values, 0.5))}, p90 ${Math.round(at(values, 0.9))}`
const dollars = (tokens: number, digits = 6) => `$${((tokens * PRICE_PER_MTOK) / 1e6).toFixed(digits)}`
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

const header = ['kind', 'cases', ...CUTOFFS.map(k => `hit@${k}`)]
if (withJev) header.push(...JEV_CUTOFFS.map(k => `jev hit@${k}`), ...CUTOFFS.map(k => `followed hit@${k}`))
console.log(header.join('\t'))
const kinds = [...scores.keys()].filter(k => k !== 'all').concat('all')
for (const kind of kinds) {
  const { plain, jev, followed } = scores.get(kind)!
  const cols = [kind, String(plain.cases), ...plain.hits.map(h => pct(h, plain.cases))]
  if (withJev) {
    cols.push(...JEV_CUTOFFS.map(k => pct(jev.hits[CUTOFFS.indexOf(k)], jev.cases)))
    cols.push(...followed.hits.map(h => pct(h, followed.cases)))
  }
  console.log(cols.join('\t'))
}
console.log(`\nsearch ms per query: ${p50p90(ms.search)}`)
if (withJev) {
  // A failed call keeps the search order, so failures would otherwise look like "Jev changed nothing".
  for (const kind of ['rerank', 'spelling'] as const) {
    const c = calls[kind]
    const timing = ms[kind].length ? `; ms ${p50p90(ms[kind])}; input tokens p50 ${at(pageTokens[kind], 0.5)}` : ''
    console.log(`jev ${kind}: ${c.ran} ran, ${c.skipped} skipped, ${c.failed} failed${timing}`)
  }
  console.log(`page ms with jev: ${p50p90(ms.page)}; added ${p50p90(ms.page.map((t, i) => t - ms.search[i]))}`)
  const perSearch = (sum(pageTokens.rerank) + sum(pageTokens.spelling)) / cases.length
  console.log(`jev cost per search: ${dollars(perSearch)}, per 1,000 searches ${dollars(perSearch * 1000, 4)}`)
  console.log(`jev model: ${[...models].join(', ')}; this run cost ${dollars(runTokens, 4)}`)
  if (suggested.length) console.log(`\ndid you mean:\n${suggested.join('\n')}`)
  console.log(`\nno match: ${noMatches.length ? `\n${noMatches.join('\n')}` : 'none'}`)
}
if (misses.length) console.log(`\nnot in the top 10:\n${misses.join('\n')}`)

if (withJev) {
  console.log('\nspelling\tcases\toffered\tjev\tfrequency rule')
  for (const [kind, s] of spellingScores) {
    console.log([kind, s.cases, pct(s.offered, s.cases), pct(s.jev, s.cases), pct(s.rule, s.cases)].join('\t'))
  }
  if (spellingMisses.length) console.log(`\nspelling cases either one got wrong:\n${spellingMisses.join('\n')}`)
  console.log(`\nabsent: ${absentNoMatch} of ${absentCases.length} flagged no match, ${absentEmpty} had no results`)
  console.log(absentLines.join('\n'))
}

console.log('\nsuggest\tcases\thit@1\thit@8')
for (const [kind, score] of typed) {
  console.log([kind, score.cases, pct(score.hit1, score.cases), pct(score.hit8, score.cases)].join('\t'))
}
if (suggestMisses.length) console.log(`\nnot in the top 8 suggestions:\n${suggestMisses.join('\n')}`)
