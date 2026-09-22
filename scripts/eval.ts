// Scores eval/queries.json against the loaded data. Reports Jev columns only when
// TYPESAFE_API_KEY is set.
import { readFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { rerank, type Candidate } from '../src/rerank.ts'

interface Case {
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

const cases: Case[] = JSON.parse(await readFile(new URL('../eval/queries.json', import.meta.url), 'utf8'))
const withJev = Boolean(process.env.TYPESAFE_API_KEY)
const scores = new Map<string, { plain: Score; jev: Score }>()
const misses: string[] = []
const jev = { reranked: 0, skipped: 0, failed: 0 }

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
    const { rows } = await pool.query<Row>(
      `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
         FROM search.query_distinct($1) r JOIN search.documents d ON d.id = r.id
        ORDER BY r.pos`,
      [c.q],
    )
    const pattern = new RegExp(c.expect, 'i')
    const reranked = withJev ? await rerank(c.q, rows) : undefined
    if (reranked) {
      if (reranked.error) jev.failed += 1
      else if (reranked.reranked) jev.reranked += 1
      else jev.skipped += 1
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
} finally {
  await pool.end()
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`
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
}
if (misses.length) console.log(`\nnot in the top 10:\n${misses.join('\n')}`)
