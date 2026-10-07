// Scores eval/queries.json (the results page) and eval/suggest.json (typeahead) against the loaded
// data. Reports Jev columns only when TYPESAFE_API_KEY is set.
import { readFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { rerank, type Candidate } from '../src/rerank.ts'

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

const read = async (file: string) => JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
const cases: Case[] = await read('queries.json')
const suggestCases: SuggestCase[] = await read('suggest.json')
const withJev = Boolean(process.env.TYPESAFE_API_KEY)
const scores = new Map<string, { plain: Score; jev: Score }>()
const misses: string[] = []
const jev = { reranked: 0, skipped: 0, failed: 0 }
const searchMs: number[] = []
const jevMs: number[] = []
const jevTokens: number[] = []
const models = new Set<string>()
const typed = new Map<string, { cases: number; hit1: number; hit8: number }>()
const suggestMisses: string[] = []

const matches = (row: Row, pattern: RegExp) => pattern.test(`${row.name} ${row.other_names ?? ''}`)

function add(score: Score, rows: Row[], pattern: RegExp) {
  score.cases += 1
  CUTOFFS.forEach((k, i) => {
    if (rows.slice(0, k).some(r => matches(r, pattern))) score.hits[i] += 1
  })
}

const blank = (): Score => ({ cases: 0, hits: CUTOFFS.map(() => 0) })
const pool = connect()
try {
  for (const c of cases) {
    const started = performance.now()
    const { rows } = await pool.query<Row>(
      `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
         FROM search.query_distinct($1) r JOIN search.documents d ON d.id = r.id
        ORDER BY r.pos`,
      [c.q],
    )
    searchMs.push(performance.now() - started)
    const pattern = new RegExp(c.expect, 'i')
    const reranked = withJev ? await rerank(c.q, rows) : undefined
    if (reranked) {
      if (reranked.error) jev.failed += 1
      else if (reranked.reranked) jev.reranked += 1
      else jev.skipped += 1
      if (reranked.reranked) {
        jevMs.push(reranked.ms)
        jevTokens.push(reranked.inputTokens ?? 0)
        if (reranked.model) models.add(reranked.model)
      }
    }
    for (const kind of [c.kind, 'all']) {
      if (!scores.has(kind)) scores.set(kind, { plain: blank(), jev: blank() })
      const entry = scores.get(kind)!
      add(entry.plain, rows, pattern)
      if (reranked) add(entry.jev, reranked.results, pattern)
    }
    if (!rows.slice(0, 10).some(r => matches(r, pattern))) {
      misses.push(`${c.kind}: "${c.q}" -> ${rows[0]?.name ?? 'no results'}`)
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
const dollars = (tokens: number) => `$${((tokens * PRICE_PER_MTOK) / 1e6).toFixed(6)}`
const header = ['kind', 'cases', ...CUTOFFS.map(k => `hit@${k}`)]
if (withJev) header.push(...JEV_CUTOFFS.map(k => `jev hit@${k}`))
console.log(header.join('\t'))
const kinds = [...scores.keys()].filter(k => k !== 'all').concat('all')
for (const kind of kinds) {
  const { plain, jev: withRerank } = scores.get(kind)!
  const cols = [kind, String(plain.cases), ...plain.hits.map(h => pct(h, plain.cases))]
  if (withJev) cols.push(...JEV_CUTOFFS.map(k => pct(withRerank.hits[CUTOFFS.indexOf(k)], withRerank.cases)))
  console.log(cols.join('\t'))
}
if (withJev) {
  // A failed call leaves the search order, so failures would otherwise look like "Jev changed nothing".
  console.log(`\njev: ${jev.reranked} reranked, ${jev.skipped} skipped, ${jev.failed} failed`)
  if (jevMs.length) {
    const total = jevTokens.reduce((a, b) => a + b, 0)
    console.log(`jev model: ${[...models].join(', ')}`)
    console.log(`jev ms per call: p50 ${Math.round(at(jevMs, 0.5))}, p90 ${Math.round(at(jevMs, 0.9))}`)
    console.log(`jev input tokens per call: p50 ${at(jevTokens, 0.5)}, p90 ${at(jevTokens, 0.9)}`)
    console.log(`jev cost: ${dollars(total / jevMs.length)} per call, ${dollars(total / cases.length)} per search, ${dollars(total)} for the run`)
  }
}
console.log(`search ms per query: p50 ${Math.round(at(searchMs, 0.5))}, p90 ${Math.round(at(searchMs, 0.9))}`)
if (misses.length) console.log(`\nnot in the top 10:\n${misses.join('\n')}`)

console.log('\nsuggest\tcases\thit@1\thit@8')
for (const [kind, score] of typed) {
  console.log([kind, score.cases, pct(score.hit1, score.cases), pct(score.hit8, score.cases)].join('\t'))
}
if (suggestMisses.length) console.log(`\nnot in the top 8 suggestions:\n${suggestMisses.join('\n')}`)
