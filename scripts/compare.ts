// Runs three searches on the same queries and writes one JSON file of per-query results to
// results/, which scripts/report.ts turns into tables and figures:
//   plain    Postgres full-text search as its manual shows it: to_tsvector and plainto_tsquery over
//            the name and other names, a GIN index, ordered by ts_rank, one row per name
//   sql      this repo's search.query_distinct
//   sql+jev  the same with the Jev step, as the page shows it, and after one click on its "Did you
//            mean" link
// For every query it also records two spelling correctors that use no model, for comparison: the
// frequency rule (the most common close word, if used ten times as often) and a Norvig-style
// corrector (the most common known word within two edits; a known word is kept).
// The queries are eval/queries.json, eval/spelling.json, eval/synthetic.json, eval/absent.json and,
// when present, the test sets eval/synthetic-test.json and eval/wikipedia.json.
// The first run builds the table baseline.documents from search.source, which takes about half a
// minute on the full load.
//   JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/compare.ts
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { connect } from '../src/db.ts'
import { page, search, similarWords, type Row } from '../src/page.ts'
import type { SimilarWord } from '../src/spelling.ts'
import { carries, tokens } from '../src/tokens.ts'

if (!process.env.TYPESAFE_API_KEY) throw new Error('set TYPESAFE_API_KEY; the third search needs Jev')

type QuerySet = 'hand-written' | 'held-out' | 'synthetic' | 'synthetic-test' | 'wikipedia' | 'absent'

interface Case {
  q: string
  set: QuerySet
  kind: string
  edit?: string
  expect?: string
  // Null for the absent set, where nothing should match.
  hit: ((row: { name: string; other_names: string | null }) => boolean) | null
}

const read = async (file: string) => JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
const text = (r: { name: string; other_names: string | null }) => `${r.name} ${r.other_names ?? ''}`

const cases: Case[] = [
  ...(await read('queries.json')).map((c: { q: string; kind: string; expect: string }) => {
    const pattern = new RegExp(c.expect, 'i')
    return { q: c.q, set: 'hand-written', kind: c.kind, hit: (r: Row) => pattern.test(text(r)) }
  }),
]
const exists = async (file: string) => readFile(new URL(`../eval/${file}`, import.meta.url)).then(() => true, () => false)
for (const [file, set] of [
  ['spelling.json', 'held-out'],
  ['synthetic.json', 'synthetic'],
  ['synthetic-test.json', 'synthetic-test'],
  ['wikipedia.json', 'wikipedia'],
] as const) {
  if (!(await exists(file))) continue
  const data = await read(file)
  // eval/wikipedia.json wraps its cases with their source and license.
  const list = (Array.isArray(data) ? data : data.cases) as { q: string; kind: string; edit?: string; expect?: string }[]
  for (const c of list) {
    const want = c.expect ?? c.q
    cases.push({ q: c.q, set, kind: c.kind, edit: c.edit, expect: c.expect, hit: r => carries(text(r), want) })
  }
}
for (const c of (await read('absent.json')) as { q: string }[]) cases.push({ q: c.q, set: 'absent', kind: 'absent', hit: null })
// COMPARE_LIMIT=n runs only every nth query, for a quick check of the script.
if (process.env.COMPARE_LIMIT) {
  const every = Math.max(1, Math.floor(cases.length / Number(process.env.COMPARE_LIMIT)))
  cases.splice(0, cases.length, ...cases.filter((_, i) => i % every === 0))
}

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

// The vocabulary the correctors work from: search.words, the same list search.similar_words reads.
const vocabulary = new Map<string, number>()
const stopWords = new Set<string>()

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
function edits1(w: string): string[] {
  const out: string[] = []
  for (let i = 0; i <= w.length; i++) {
    const left = w.slice(0, i)
    const right = w.slice(i)
    if (right) out.push(left + right.slice(1))
    if (right.length > 1) out.push(left + right[1] + right[0] + right.slice(2))
    for (const c of LETTERS) {
      if (right) out.push(left + c + right.slice(1))
      out.push(left + c + right)
    }
  }
  return out
}

// The words search.similar_words would look at: four letters or more, no digits, not a stop word.
const eligible = (w: string) => w.length >= 4 && !/[0-9]/.test(w) && !stopWords.has(w)

// Known words within one edit, else within two, more common than the typed word, nearest first and
// then most common first.
const editCache = new Map<string, { word: string; distance: number; count: number }[]>()
function editCandidates(w: string) {
  const cached = editCache.get(w)
  if (cached) return cached
  const own = vocabulary.get(w) ?? 0
  const found = new Map<string, number>()
  const one = edits1(w)
  for (const e of one) if ((vocabulary.get(e) ?? 0) > own && !found.has(e)) found.set(e, 1)
  if (found.size === 0) {
    for (const e of one) for (const e2 of edits1(e)) if (e2 !== w && (vocabulary.get(e2) ?? 0) > own && !found.has(e2)) found.set(e2, 2)
  }
  const list = [...found]
    .map(([word, distance]) => ({ word, distance, count: vocabulary.get(word)! }))
    .sort((a, b) => a.distance - b.distance || b.count - a.count || (a.word < b.word ? -1 : 1))
  editCache.set(w, list)
  return list
}

// Norvig's corrector: a known word stays; otherwise the most common known word one edit away, else
// two edits away.
function norvig(q: string): string | null {
  const words = tokens(q)
  const fixed = words.map(w => {
    if (!eligible(w) || vocabulary.has(w)) return w
    const near = editCandidates(w)
    if (near.length === 0) return w
    const d = near[0].distance
    return near.filter(c => c.distance === d).sort((a, b) => b.count - a.count)[0].word
  })
  return fixed.join(' ') === words.join(' ') ? null : fixed.join(' ')
}

// The rule from scripts/eval.ts: respell a word to its most common close word from
// search.similar_words when that word is used at least ten times as often.
function frequencyRule(q: string, similar: SimilarWord[]): string | null {
  const words = tokens(q)
  const best = similar
    .filter(r => words[r.pos - 1] === r.word && r.alternative_matches >= 10 * Math.max(r.word_matches, 1))
    .sort((a, b) => b.alternative_matches - a.alternative_matches)[0]
  return best ? words.with(best.pos - 1, best.alternative).join(' ') : null
}

interface Scored {
  n: number
  hit1: boolean
  hit10: boolean
  top: string | null
}

function score(rows: Row[], hit: Case['hit']): Scored {
  return {
    n: rows.length,
    hit1: hit ? rows.slice(0, 1).some(hit) : false,
    hit10: hit ? rows.slice(0, 10).some(hit) : false,
    top: rows[0]?.name ?? null,
  }
}

const git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
const startedAt = new Date().toISOString()
const loadBefore = os.loadavg()
const records: unknown[] = []
const models = new Set<string>()

try {
  await buildBaseline()
  for (const r of (await pool.query<{ word: string; doc_count: number; stop: boolean }>(
    `SELECT word, doc_count, ts_lexize('english_stem', word) = '{}' AS stop FROM search.words`,
  )).rows) {
    vocabulary.set(r.word, r.doc_count)
    if (r.stop) stopWords.add(r.word)
  }
  const postgres = (await pool.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0].v

  // One untimed pass, so every timed query runs on a warm cache.
  for (const c of cases) {
    await plain(c.q)
    await search(pool, c.q)
  }

  const searchCache = new Map<string, Row[]>()
  const searchOnce = async (q: string) => {
    if (!searchCache.has(q)) searchCache.set(q, await search(pool, q))
    return searchCache.get(q)!
  }

  for (const [i, c] of cases.entries()) {
    let started = performance.now()
    const plainRows = await plain(c.q)
    const plainMs = performance.now() - started
    started = performance.now()
    const sqlRows = await search(pool, c.q)
    const sqlMs = performance.now() - started
    const p = await page(pool, c.q, { withJev: true })
    const r = p.reranked!
    const sp = p.spelling!
    for (const m of [r.model, sp.model]) if (m) models.add(m)

    const similar = await similarWords(pool, c.q)
    const suggestions = {
      jev: sp.suggestion,
      norvig: norvig(c.q),
      frequency: frequencyRule(c.q, similar),
    }
    const followed: Record<string, Scored | null> = {}
    for (const [name, s] of Object.entries(suggestions)) followed[name] = s ? score(await searchOnce(s), c.hit) : null

    const head = p.rows.slice(0, 10)
    records.push({
      q: c.q,
      set: c.set,
      kind: c.kind,
      edit: c.edit,
      expect: c.expect,
      step: sqlRows[0]?.step ?? null,
      plain: { ms: plainMs, ...score(plainRows, c.hit) },
      sql: { ms: sqlMs, ...score(sqlRows, c.hit) },
      jev: {
        pageMs: p.pageMs,
        searchMs: p.searchMs,
        ...score(r.results, c.hit),
        rerank: {
          ran: r.reranked,
          ms: r.ms,
          tokens: r.inputTokens ?? 0,
          error: r.error ?? null,
          noMatch: r.noMatch,
          scores: r.scores,
          labels: c.hit ? head.map(c.hit) : [],
        },
        spelling: {
          ran: sp.ran,
          ms: sp.ms,
          tokens: sp.inputTokens ?? 0,
          error: sp.error ?? null,
          options: sp.options,
          probabilities: sp.probabilities,
          suggestion: sp.suggestion,
          p: sp.p,
        },
      },
      suggestions,
      followed,
    })
    if ((i + 1) % 50 === 0) console.error(`${i + 1} of ${cases.length}`)
  }

  const meta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    git,
    models: [...models],
    postgres,
    node: process.version,
    cpu: os.cpus()[0]?.model ?? null,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    loadBefore,
    loadAfter: os.loadavg(),
    products: (await pool.query('SELECT count(*)::int AS n FROM search.documents')).rows[0].n,
    pricePerMillionInputTokens: 0.042,
    // The rule that turned spelling probabilities into suggestions (src/spelling.ts defaults).
    spellingRule: { ratio: 2, suggestAt: 0.3 },
  }
  await mkdir(new URL('../results/', import.meta.url), { recursive: true })
  const file = new URL(`../results/compare-${startedAt.replace(/[:.]/g, '-')}.json`, import.meta.url)
  await writeFile(file, `${JSON.stringify({ meta, records })}\n`)
  console.log(`wrote ${file.pathname}`)
} finally {
  await pool.end()
}
