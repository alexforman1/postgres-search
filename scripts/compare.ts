// Runs three searches on the same queries and reports how often each finds the right product and
// how long each takes:
//   plain    Postgres full-text search as its manual shows it: to_tsvector and plainto_tsquery over
//            the name and other names, a GIN index, ordered by ts_rank, one row per name
//   sql      this repo's search.query_distinct
//   sql+jev  the same with the Jev step, scored as the page shows it and after one click on its
//            "Did you mean" link
// The queries are eval/queries.json, eval/spelling.json and eval/absent.json. The first run builds
// the table baseline.documents from search.source, which takes about half a minute on the full load.
//   JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts
import { readFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { tokens } from '../src/tokens.ts'
import { page, search, type Row } from './page.ts'

if (!process.env.TYPESAFE_API_KEY) throw new Error('set TYPESAFE_API_KEY; the third search needs Jev')

interface Case {
  q: string
  set: 'hand-written' | 'held-out' | 'absent'
  kind: string
  // Null for the absent set, where nothing should match.
  hit: ((row: { name: string; other_names: string | null }) => boolean) | null
}

const read = async (file: string) => JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

// The phrase's words, with spaces and punctuation ignored, starting at the start of a word: "almond
// milk" finds ALMONDMILK, "hellmanns" finds HELLMANN'S, and "jalapeno" finds JALAPEÑO.
function carries(text: string, phrase: string): boolean {
  const words = tokens(fold(text))
  const target = tokens(fold(phrase)).join('')
  return words.some((_, i) => words.slice(i).join('').startsWith(target))
}

const cases: Case[] = [
  ...(await read('queries.json')).map((c: { q: string; kind: string; expect: string }) => {
    const pattern = new RegExp(c.expect, 'i')
    return { q: c.q, set: 'hand-written', kind: c.kind, hit: (r: Row) => pattern.test(`${r.name} ${r.other_names ?? ''}`) }
  }),
  ...(await read('spelling.json')).map((c: { q: string; kind: string; expect?: string }) => ({
    q: c.q,
    set: 'held-out',
    kind: c.kind,
    hit: (r: Row) => carries(`${r.name} ${r.other_names ?? ''}`, c.expect ?? c.q),
  })),
  ...(await read('absent.json')).map((c: { q: string }) => ({ q: c.q, set: 'absent', kind: 'absent', hit: null })),
]

const pool = connect()

async function buildBaseline() {
  await pool.query('CREATE SCHEMA IF NOT EXISTS baseline')
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM search.documents)::int AS want,
            (SELECT count(*) FROM pg_tables WHERE schemaname = 'baseline' AND tablename = 'documents')::int AS exists`,
  )
  if (rows[0].exists) {
    const have = (await pool.query('SELECT count(*)::int AS n FROM baseline.documents')).rows[0].n
    if (have === rows[0].want) return
    await pool.query('DROP TABLE baseline.documents')
  }
  console.error('building baseline.documents')
  await pool.query(
    `CREATE TABLE baseline.documents AS
     SELECT id::text AS id, name::text AS name, other_names::text AS other_names,
            to_tsvector('english', coalesce(name::text, '') || ' ' || coalesce(other_names::text, '')) AS v
     FROM search.source`,
  )
  await pool.query('CREATE INDEX ON baseline.documents USING gin (v)')
  await pool.query('ANALYZE baseline.documents')
}

async function plain(q: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, name, other_names FROM (
       SELECT DISTINCT ON (lower(name)) id, name, other_names, ts_rank(v, tq) AS r
       FROM baseline.documents, plainto_tsquery('english', $1) tq
       WHERE v @@ tq
       ORDER BY lower(name), r DESC, id
     ) x
     ORDER BY r DESC, name, id
     LIMIT 50`,
    [q],
  )
  return rows
}

const SYSTEMS = ['plain', 'sql', 'sql+jev', 'sql+jev, one click'] as const
type System = (typeof SYSTEMS)[number]

interface Score {
  cases: number
  hit1: number
  hit10: number
  empty: number
}

const blank = (): Score => ({ cases: 0, hit1: 0, hit10: 0, empty: 0 })
const scores = new Map<string, Map<System, Score>>()
const absent = new Map<System, number>(SYSTEMS.map(s => [s, 0]))
const ms = { plain: [] as number[], sql: [] as number[], jev: [] as number[] }
const decisions = { rerank: [] as number[], rerankMs: [] as number[], spelling: [] as number[], spellingMs: [] as number[] }

function add(group: string, system: System, rows: { name: string; other_names: string | null }[], hit: NonNullable<Case['hit']>) {
  if (!scores.has(group)) scores.set(group, new Map(SYSTEMS.map(s => [s, blank()])))
  const s = scores.get(group)!.get(system)!
  s.cases += 1
  if (rows.length === 0) s.empty += 1
  if (rows.slice(0, 1).some(hit)) s.hit1 += 1
  if (rows.slice(0, 10).some(hit)) s.hit10 += 1
}

try {
  await buildBaseline()
  // One untimed pass, so every timed query runs on a warm cache.
  for (const c of cases) {
    await plain(c.q)
    await search(pool, c.q)
  }

  for (const c of cases) {
    let started = performance.now()
    const plainRows = await plain(c.q)
    ms.plain.push(performance.now() - started)
    started = performance.now()
    const sqlRows = await search(pool, c.q)
    ms.sql.push(performance.now() - started)
    const p = await page(pool, c.q, true)
    ms.jev.push(p.pageMs)
    const r = p.reranked!
    const sp = p.spelling!
    if (r.reranked) {
      decisions.rerank.push(Math.min(p.rows.length, 10))
      decisions.rerankMs.push(r.ms)
    }
    if (sp.ran) {
      decisions.spelling.push(sp.options.length)
      decisions.spellingMs.push(sp.ms)
    }
    const jevRows = r.results
    const clickRows = sp.suggestion ? await search(pool, sp.suggestion) : jevRows

    if (c.hit === null) {
      if (plainRows.length === 0) absent.set('plain', absent.get('plain')! + 1)
      if (sqlRows.length === 0) absent.set('sql', absent.get('sql')! + 1)
      const told = jevRows.length === 0 || (r.noMatch && !sp.suggestion)
      if (told) absent.set('sql+jev', absent.get('sql+jev')! + 1)
      if (told) absent.set('sql+jev, one click', absent.get('sql+jev, one click')! + 1)
      continue
    }
    for (const group of [`${c.set}: ${c.kind}`, `${c.set}: all`]) {
      add(group, 'plain', plainRows, c.hit)
      add(group, 'sql', sqlRows, c.hit)
      add(group, 'sql+jev', jevRows, c.hit)
      add(group, 'sql+jev, one click', clickRows, c.hit)
    }
  }
} finally {
  await pool.end()
}

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`
const at = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))]
const p50p90 = (values: number[]) => `${Math.round(at(values, 0.5))} / ${Math.round(at(values, 0.9))}`

console.log(['group', 'cases', ...SYSTEMS.map(s => `${s} hit@1`), ...SYSTEMS.map(s => `${s} hit@10`)].join('\t'))
for (const [group, bySystem] of scores) {
  const n = bySystem.get('plain')!.cases
  console.log(
    [
      group,
      n,
      ...SYSTEMS.map(s => pct(bySystem.get(s)!.hit1, n)),
      ...SYSTEMS.map(s => pct(bySystem.get(s)!.hit10, n)),
    ].join('\t'),
  )
}
console.log('\nno results at all:')
for (const [group, bySystem] of scores) {
  if (group.endsWith(': all')) console.log(`${group}\t${SYSTEMS.slice(0, 2).map(s => `${s} ${bySystem.get(s)!.empty}`).join('\t')}`)
}
const absentCount = cases.filter(c => c.hit === null).length
console.log(
  `\nabsent, ${absentCount} queries, page shows nothing or says nothing matches: ` +
    SYSTEMS.slice(0, 3).map(s => `${s} ${absent.get(s)}`).join(', '),
)
console.log(`\nms per query, median / p90, over ${cases.length} queries:`)
console.log(`plain ${p50p90(ms.plain)}; sql ${p50p90(ms.sql)}; sql+jev page ${p50p90(ms.jev)}`)
console.log(
  `jev keep or sink: ${decisions.rerank.length} calls, median ${at(decisions.rerank, 0.5)} judgments each, ms ${p50p90(decisions.rerankMs)}`,
)
console.log(
  `jev spelling: ${decisions.spelling.length} calls, median ${at(decisions.spelling, 0.5)} options each, ms ${p50p90(decisions.spellingMs)}`,
)
