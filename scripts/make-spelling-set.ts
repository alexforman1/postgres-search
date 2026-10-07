// Writes eval/synthetic.json: misspellings made by one Damerau edit of words that product names
// use, and correctly spelled controls, both sampled with a fixed seed. Rerunning it on the same
// load writes the same file. Words in any other eval file are left out, so a second set made with
// another seed shares no word with the first:
//   node scripts/make-spelling-set.ts                                          # the development set
//   node scripts/make-spelling-set.ts --seed 20261008 --out synthetic-test.json   # the test set
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from '../src/db.ts'
import { tokens } from '../src/tokens.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const SEED = Number(arg('--seed', '20261007'))
const OUT = arg('--out', 'synthetic.json')
const TYPOS = 300
const CONTROLS = 200
// A word must appear in this many product names, so the sample holds words, not stray tokens.
const MIN_DOCS = 20
const MIN_LENGTH = 5
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

// The development set excludes the files that existed when it was made, so it still regenerates
// the same; any later set also excludes the development and Wikipedia sets.
const EXCLUDE = ['queries.json', 'spelling.json', 'suggest.json', 'absent.json']
if (OUT !== 'synthetic.json') EXCLUDE.push('synthetic.json', 'wikipedia.json')
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
