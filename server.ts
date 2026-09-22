import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { connect } from './src/db.ts'
import { rerank, type Candidate } from './src/rerank.ts'

const pool = connect()
const port = Number(process.env.PORT ?? 3000)

const files: Record<string, { path: string; type: string }> = {
  '/': { path: 'public/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { path: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { path: 'public/style.css', type: 'text/css; charset=utf-8' },
}

class BadRequest extends Error {}

interface Row extends Candidate {
  step: string
}

// Filters arrive as a JSON object of facet name to value.
function parseFilters(raw: string | null): Record<string, string> {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new BadRequest('filters is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !Object.values(value).every(v => typeof v === 'string')) {
    throw new BadRequest('filters must be an object of strings')
  }
  return value as Record<string, string>
}

async function search(q: string, filters: Record<string, string>) {
  const { rows } = await pool.query<Row>(
    `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
       FROM search.query_distinct($1, $2::jsonb) r
       JOIN search.documents d ON d.id = r.id
      ORDER BY r.pos`,
    [q, JSON.stringify(filters)],
  )
  if (!process.env.TYPESAFE_API_KEY) {
    return { jev: { ran: false, ms: 0, error: 'no TYPESAFE_API_KEY' }, results: rows.map(r => ({ ...r, sunk: false })) }
  }
  const out = await rerank(q, rows)
  const sunk = new Set(out.sunk.map(r => r.id))
  return {
    jev: { ran: out.reranked, ms: out.ms, error: out.error },
    results: out.results.map(r => ({ ...r, sunk: sunk.has(r.id) })),
  }
}

async function suggest(q: string) {
  const { rows } = await pool.query('SELECT name, id, doc_count FROM search.suggest($1)', [q])
  return { suggestions: rows }
}

async function facets(q: string, filters: Record<string, string>) {
  const { rows } = await pool.query<{ facet: string; value: string; doc_count: number }>(
    'SELECT facet, value, doc_count::int AS doc_count FROM search.facets($1, $2::jsonb)',
    [q, JSON.stringify(filters)],
  )
  const grouped: Record<string, { value: string; count: number }[]> = {}
  for (const r of rows) (grouped[r.facet] ??= []).push({ value: r.value, count: r.doc_count })
  return { facets: grouped }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    const file = files[url.pathname]
    if (file) {
      res.writeHead(200, { 'Content-Type': file.type })
      res.end(await readFile(new URL(file.path, import.meta.url)))
      return
    }
    const q = url.searchParams.get('q') ?? ''
    let body: unknown
    if (url.pathname === '/search') body = await search(q, parseFilters(url.searchParams.get('filters')))
    else if (url.pathname === '/suggest') body = await suggest(q)
    else if (url.pathname === '/facets') body = await facets(q, parseFilters(url.searchParams.get('filters')))
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  } catch (err) {
    const status = err instanceof BadRequest ? 400 : 500
    if (status === 500) console.error(err)
    res.writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: err instanceof BadRequest ? err.message : 'search failed' }))
  }
})

server.listen(port, () => console.log(`http://localhost:${port}`))
