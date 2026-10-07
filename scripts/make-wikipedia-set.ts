// Writes eval/wikipedia.json: real misspellings from Wikipedia's "Lists of common misspellings/For
// machines", kept where the correct word appears in at least 20 product names. The list is CC BY-SA
// 4.0; the file records the page revision it was read from.
//   node scripts/make-wikipedia-set.ts
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { tokens } from '../src/tokens.ts'

const TITLE = 'Wikipedia:Lists_of_common_misspellings/For_machines'
const MIN_DOCS = 20
const MIN_LENGTH = 4
const headers = { 'User-Agent': 'postgres-search-eval/1.0 (https://github.com/alexforman1/postgres-search)' }

const meta = (await (
  await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${TITLE}&rvprop=ids|timestamp&format=json`, { headers })
).json()) as { query: { pages: Record<string, { revisions: { revid: number; timestamp: string }[] }> } }
const revision = Object.values(meta.query.pages)[0].revisions[0]
const raw = await (await fetch(`https://en.wikipedia.org/w/index.php?title=${TITLE}&action=raw&oldid=${revision.revid}`, { headers })).text()

// Words already in the other eval files stay out, so this set shares nothing with them.
const used = new Set<string>()
for (const file of ['queries.json', 'spelling.json', 'suggest.json', 'absent.json', 'synthetic.json']) {
  const cases: { q: string; expect?: string }[] = JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
  for (const c of cases) for (const w of tokens(`${c.q} ${c.expect ?? ''}`)) used.add(w)
}

const pool = connect()
try {
  const counts = new Map((await pool.query<{ word: string; doc_count: number }>('SELECT word, doc_count FROM search.words')).rows.map(r => [r.word, r.doc_count]))
  const seen = new Set<string>()
  const cases: { q: string; kind: 'typo'; expect: string }[] = []
  let pairs = 0
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([^\s>]+)->(.+?)\s*$/)
    if (!m) continue
    pairs++
    const q = m[1].toLowerCase()
    const expect = m[2].toLowerCase()
    // A comma lists several corrections; the intended word is then unknown.
    if (expect.includes(',') || !/^[a-z]+$/.test(q) || !/^[a-z]+$/.test(expect)) continue
    if (expect.length < MIN_LENGTH || q === expect || seen.has(q)) continue
    if ((counts.get(expect) ?? 0) < MIN_DOCS || used.has(expect) || used.has(q)) continue
    seen.add(q)
    cases.push({ q, kind: 'typo', expect })
  }
  const file = {
    source: `https://en.wikipedia.org/w/index.php?title=${TITLE}&oldid=${revision.revid}`,
    revision: revision.revid,
    revisionDate: revision.timestamp,
    license: 'CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/; adapted: filtered to words used in the USDA catalog',
    cases,
  }
  await writeFile(new URL('../eval/wikipedia.json', import.meta.url), `${JSON.stringify(file, null, 1)}\n`)
  const real = cases.filter(c => counts.has(c.q)).length
  console.log(`revision ${revision.revid}: ${pairs} pairs, wrote ${cases.length} (${new Set(cases.map(c => c.expect)).size} distinct words, ${real} misspellings that are themselves index words)`)
} finally {
  await pool.end()
}
