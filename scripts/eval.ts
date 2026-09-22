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
  hit1: number
  hit10: number
}

const cases: Case[] = JSON.parse(await readFile(new URL('../eval/queries.json', import.meta.url), 'utf8'))
const withJev = Boolean(process.env.TYPESAFE_API_KEY)
const scores = new Map<string, { plain: Score; jev: Score }>()
const misses: string[] = []

const matches = (row: Row, pattern: RegExp) => pattern.test(`${row.name} ${row.other_names ?? ''}`)

function add(score: Score, rows: Row[], pattern: RegExp) {
  score.cases += 1
  if (rows.slice(0, 1).some(r => matches(r, pattern))) score.hit1 += 1
  if (rows.slice(0, 10).some(r => matches(r, pattern))) score.hit10 += 1
}

const blank = (): Score => ({ cases: 0, hit1: 0, hit10: 0 })
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
    for (const kind of [c.kind, 'all']) {
      if (!scores.has(kind)) scores.set(kind, { plain: blank(), jev: blank() })
      const entry = scores.get(kind)!
      add(entry.plain, rows, pattern)
      if (withJev && kind === c.kind) add(entry.jev, (await rerank(c.q, rows)).results, pattern)
    }
    if (!rows.slice(0, 10).some(r => matches(r, pattern))) {
      misses.push(`${c.kind}: "${c.q}" -> ${rows[0]?.name ?? 'no results'}`)
    }
  }
} finally {
  await pool.end()
}

if (withJev) {
  const all = scores.get('all')!
  all.jev = blank()
  for (const [kind, entry] of scores) {
    if (kind === 'all') continue
    all.jev.cases += entry.jev.cases
    all.jev.hit1 += entry.jev.hit1
    all.jev.hit10 += entry.jev.hit10
  }
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`
const header = ['kind', 'cases', 'hit@1', 'hit@10']
if (withJev) header.push('jev hit@1', 'jev hit@10')
console.log(header.join('\t'))
for (const [kind, { plain, jev }] of scores) {
  const cols = [kind, String(plain.cases), pct(plain.hit1, plain.cases), pct(plain.hit10, plain.cases)]
  if (withJev) cols.push(pct(jev.hit1, jev.cases), pct(jev.hit10, jev.cases))
  console.log(cols.join('\t'))
}
if (misses.length) console.log(`\nnot in the top 10:\n${misses.join('\n')}`)
