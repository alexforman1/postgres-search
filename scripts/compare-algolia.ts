// Runs the eval queries against an Algolia index and this database, and prints how much the two
// top-10 lists overlap. Assumes Algolia objectID equals search.documents.id.
//   ALGOLIA_APP_ID=... ALGOLIA_SEARCH_KEY=... ALGOLIA_INDEX=... node scripts/compare-algolia.ts
import { readFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'

const appId = process.env.ALGOLIA_APP_ID
const key = process.env.ALGOLIA_SEARCH_KEY
const index = process.env.ALGOLIA_INDEX
if (!appId || !key || !index) throw new Error('set ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY, and ALGOLIA_INDEX')

async function algolia(q: string): Promise<string[]> {
  const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index!)}/query`, {
    method: 'POST',
    headers: { 'X-Algolia-Application-Id': appId!, 'X-Algolia-API-Key': key!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: new URLSearchParams({ query: q, hitsPerPage: '10' }).toString() }),
  })
  if (!res.ok) throw new Error(`Algolia returned ${res.status}`)
  const body = (await res.json()) as { hits: { objectID: string }[] }
  return body.hits.map(h => h.objectID)
}

const cases: { q: string }[] = JSON.parse(await readFile(new URL('../eval/queries.json', import.meta.url), 'utf8'))
const pool = connect()
try {
  let total = 0
  for (const { q } of cases) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM search.query($1, $2::jsonb, 10) ORDER BY pos', [q, '{}'])
    const ours = new Set(rows.map(r => r.id))
    const theirs = await algolia(q)
    const shared = theirs.filter(id => ours.has(id)).length
    total += shared
    console.log(`${String(shared).padStart(2)}/10  ${q}`)
  }
  console.log(`average overlap: ${(total / cases.length).toFixed(1)} of 10`)
} finally {
  await pool.end()
}
