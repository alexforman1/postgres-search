// Writes eval/synthetic.json: misspellings made by one Damerau edit of words that product names
// use, and correctly spelled controls, both sampled with a fixed seed. Rerunning it on the same
// load writes the same file. Words in any eval file made before it are left out, so each set
// shares no word with the earlier ones. With --truncate it writes words cut short instead, as a
// user types them, each kept to at least four letters and at least one letter short. With --near
// it writes correctly spelled words that sit one edit from a word of another stem found in at least
// ten times as many products, the controls a respelling is most likely to get wrong:
//   node scripts/make-spelling-set.ts                                               # development
//   node scripts/make-spelling-set.ts --seed 20261008 --out synthetic-test.json     # test, version 2
//   node scripts/make-spelling-set.ts --seed 20261009 --out synthetic-test-2.json   # test, version 2.1
//   node scripts/make-spelling-set.ts --seed 20261010 --out truncation.json --truncate
//   node scripts/make-spelling-set.ts --seed 20261011 --out synthetic-test-3.json   # test, version 2.2
//   node scripts/make-spelling-set.ts --seed 20261012 --out truncation-2.json --truncate --min-length 7
//   node scripts/make-spelling-set.ts --seed 20261013 --out synthetic-test-4.json   # test, version 2.3
//   node scripts/make-spelling-set.ts --seed 20261014 --out truncation-3.json --truncate --min-length 7
//   node scripts/make-spelling-set.ts --seed 20261015 --out near-words.json --near --min-length 4   # development
//   node scripts/make-spelling-set.ts --seed 20261016 --out synthetic-test-5.json   # test, version 2.4
//   node scripts/make-spelling-set.ts --seed 20261017 --out truncation-4.json --truncate --min-length 7
//   node scripts/make-spelling-set.ts --seed 20261018 --out near-words-test.json --near --min-length 4
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { tokens } from '../src/tokens.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const SEED = Number(arg('--seed', '20261007'))
const OUT = arg('--out', 'synthetic.json')
const TRUNCATE = process.argv.includes('--truncate')
const NEAR = process.argv.includes('--near')
const TYPOS = 300
const CONTROLS = 200
// A word must appear in this many product names, so the sample holds words, not stray tokens.
const MIN_DOCS = 20
const MIN_LENGTH = Number(arg('--min-length', '5'))
const EDITS = ['deletion', 'insertion', 'substitution', 'transposition'] as const
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

// mulberry32: a small seeded generator, so the sample does not depend on Math.random.
function generator(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = generator(SEED)
const pick = (n: number) => Math.floor(random() * n)

// One edit at a position other than the first letter, which typists rarely get wrong and which
// every candidate generator here would then miss for a reason unrelated to the method.
function misspell(word: string, edit: (typeof EDITS)[number]): string {
  const i = 1 + pick(word.length - 1)
  switch (edit) {
    case 'deletion':
      return word.slice(0, i) + word.slice(i + 1)
    case 'insertion':
      return word.slice(0, i) + LETTERS[pick(26)] + word.slice(i)
    case 'substitution': {
      const others = LETTERS.replace(word[i], '')
      return word.slice(0, i) + others[pick(others.length)] + word.slice(i + 1)
    }
    case 'transposition': {
      const j = Math.min(i, word.length - 2)
      return word.slice(0, j) + word[j + 1] + word[j] + word.slice(j + 2)
    }
  }
}

// The eval files in the order they were made. A set excludes the words of every file before it,
// so each one still regenerates the same after later files are added.
const ORDER = [
  'queries.json',
  'spelling.json',
  'suggest.json',
  'absent.json',
  'synthetic.json',
  'wikipedia.json',
  'synthetic-test.json',
  'synthetic-test-2.json',
  'truncation.json',
  'synthetic-test-3.json',
  'truncation-2.json',
  'synthetic-test-4.json',
  'truncation-3.json',
  'near-words.json',
  'synthetic-test-5.json',
  'truncation-4.json',
  'near-words-test.json',
]
const EXCLUDE = ORDER.includes(OUT) ? ORDER.slice(0, ORDER.indexOf(OUT)) : ORDER
const used = new Set<string>()
for (const file of EXCLUDE) {
  let data: unknown
  try {
    data = JSON.parse(await readFile(new URL(`../eval/${file}`, import.meta.url), 'utf8'))
  } catch {
    continue
  }
  const cases = (Array.isArray(data) ? data : (data as { cases: unknown[] }).cases) as { q: string; expect?: string }[]
  for (const c of cases) for (const w of tokens(`${c.q} ${c.expect ?? ''}`)) used.add(w)
}

const pool = connect()
try {
  const { rows } = await pool.query<{ word: string }>(
    `SELECT w AS word
       FROM search.documents d
      CROSS JOIN LATERAL unnest(search.tokens(d.name)) AS w
      WHERE w ~ '^[a-z]+$' AND length(w) >= $1 AND ts_lexize('english_stem', w) <> '{}'
      GROUP BY w
     HAVING count(DISTINCT d.id) >= $2
      ORDER BY w`,
    [MIN_LENGTH, MIN_DOCS],
  )
  const vocabulary = new Set((await pool.query<{ word: string }>('SELECT word FROM search.words')).rows.map(r => r.word))
  const words = rows.map(r => r.word).filter(w => !used.has(w))
  // Fisher-Yates with the seeded generator.
  for (let i = words.length - 1; i > 0; i--) {
    const j = pick(i + 1)
    ;[words[i], words[j]] = [words[j], words[i]]
  }

  if (NEAR) {
    const index = new Map(
      (await pool.query<{ word: string; stem: string; match_count: number }>('SELECT word, stem, match_count FROM search.words')).rows.map(r => [r.word, r]),
    )
    const edits = (w: string) => {
      const out = new Set<string>()
      for (let i = 0; i <= w.length; i++) {
        if (i < w.length) out.add(w.slice(0, i) + w.slice(i + 1))
        if (i + 1 < w.length) out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2))
        for (const c of LETTERS) {
          out.add(w.slice(0, i) + c + w.slice(i))
          if (i < w.length) out.add(w.slice(0, i) + c + w.slice(i + 1))
        }
      }
      out.delete(w)
      return [...out]
    }
    const cases: { q: string; kind: 'control'; near: string }[] = []
    for (const word of words) {
      if (cases.length === CONTROLS) break
      const own = index.get(word)
      if (!own) continue
      const near = edits(word)
        .map(e => index.get(e))
        .filter(e => e !== undefined && e.stem !== own.stem && e.match_count >= 10 * own.match_count)
        .sort((a, b) => b!.match_count - a!.match_count || a!.word.localeCompare(b!.word))[0]
      if (near) cases.push({ q: word, kind: 'control', near: near.word })
    }
    await writeFile(new URL(`../eval/${OUT}`, import.meta.url), `${JSON.stringify(cases, null, 1)}\n`)
    console.log(`${words.length} eligible words; wrote ${cases.length} near-word controls`)
    process.exit(0)
  }

  if (TRUNCATE) {
    const cases: { q: string; kind: 'truncation'; expect: string }[] = []
    for (const word of words) {
      if (cases.length === TYPOS) break
      if (word.length < 5) continue
      // A length from 4 to one short of the word; a cut that is itself a word is skipped, since the
      // intended meaning is then unclear.
      const q = word.slice(0, 4 + pick(word.length - 4))
      if (vocabulary.has(q)) continue
      cases.push({ q, kind: 'truncation', expect: word })
    }
    await writeFile(new URL(`../eval/${OUT}`, import.meta.url), `${JSON.stringify(cases, null, 1)}\n`)
    console.log(`${words.length} eligible words; wrote ${cases.length} truncations`)
    process.exit(0)
  }
  const typos: { q: string; kind: 'typo'; edit: string; expect: string }[] = []
  let next = 0
  while (typos.length < TYPOS) {
    const word = words[next++]
    const edit = EDITS[typos.length % EDITS.length]
    // A misspelling that is itself a word in the index is a real-word error, which this set leaves
    // to the hand-written queries; draw again, then move to the next word.
    let q = ''
    for (let tries = 0; tries < 10 && (q === '' || q === word || vocabulary.has(q)); tries++) q = misspell(word, edit)
    if (q !== word && !vocabulary.has(q)) typos.push({ q, kind: 'typo', edit, expect: word })
  }
  const controls = words.slice(next, next + CONTROLS).map(q => ({ q, kind: 'control' as const }))
  await writeFile(new URL(`../eval/${OUT}`, import.meta.url), `${JSON.stringify([...typos, ...controls], null, 1)}\n`)
  console.log(`${rows.length} eligible words, ${words.length} after removing eval words; wrote ${typos.length} typos and ${controls.length} controls`)
} finally {
  await pool.end()
}
