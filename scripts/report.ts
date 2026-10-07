// Reads every compare-*.json that scripts/compare.ts wrote to a directory and produces the numbers
// the README reports: report.md in that directory (tables and tests) and, for results/, the
// figures in docs/figures/ (each in a light and a dark version). It calls neither Jev nor, once
// known.json exists in the directory, Postgres, so it can be rerun at no cost.
//   node scripts/report.ts              # results/, the current version
//   node scripts/report.ts results/v1   # the first version, kept for comparison
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tokens } from '../src/tokens.ts'

// ---------------------------------------------------------------- data

interface Scored {
  n: number
  hit1: boolean
  hit10: boolean
  top: string | null
}

interface Rec {
  q: string
  set: 'hand-written' | 'held-out' | 'synthetic' | 'synthetic-test' | 'wikipedia' | 'absent'
  kind: string
  edit?: string
  expect?: string
  step: string | null
  plain: Scored & { ms: number }
  sql: Scored & { ms: number }
  jev: Scored & {
    pageMs: number
    searchMs: number
    rerank: { ran: boolean; ms: number; tokens: number; error: string | null; noMatch: boolean; scores: number[]; labels: boolean[] }
    spelling: {
      ran: boolean
      ms: number
      tokens: number
      error: string | null
      options: string[]
      probabilities: number[]
      suggestion: string | null
      p: number
    }
  }
  // Only in results/v1, which also asked the spelling question over a wider option list.
  wide?: { ran: boolean; tokens: number; options: string[]; probabilities: number[]; suggestion: string | null }
  suggestions: { jev: string | null; norvig: string | null; frequency: string | null; wide?: string | null }
  followed: { jev: Scored | null; norvig: Scored | null; frequency: Scored | null; wide?: Scored | null }
}

interface Run {
  meta: {
    startedAt: string
    git: string
    models: string[]
    postgres: string
    node: string
    cpu: string
    cpus: number
    memoryGB: number
    loadBefore: number[]
    loadAfter: number[]
    products: number
    pricePerMillionInputTokens: number
    // Missing in the runs made before the twice-as-likely rule, which used a bar of 0.6.
    spellingRule?: { ratio: number; suggestAt: number }
  }
  records: Rec[]
}

const dirName = (process.argv[2] ?? 'results').replace(/\/+$/, '')
const dir = new URL(`../${dirName}/`, import.meta.url)
const drawFigures = process.argv[2] === undefined
async function loadRuns(from: URL): Promise<Run[]> {
  const files = (await readdir(from)).filter(f => /^compare-.*\.json$/.test(f)).sort()
  return Promise.all(files.map(async f => JSON.parse(await readFile(new URL(f, from), 'utf8'))))
}
const runs = await loadRuns(dir)
if (runs.length === 0) throw new Error(`no ${dirName}/compare-*.json; run scripts/compare.ts first`)
const PRICE = runs[0].meta.pricePerMillionInputTokens
const hasWide = runs.every(run => run.records.every(r => r.wide !== undefined))

// Which misspelled words are in search.words, read once from the database and kept in known.json
// beside the runs, so the report rebuilds from the directory alone. A real-word error is a
// misspelling that some product name also carries.
// It also records which intended words are stop words, which the search ignores, so no system can
// find a product for them.
const known = new Set<string>()
const stopTargets = new Set<string>()
{
  const typos = runs.flatMap(run => run.records).filter(r => r.kind === 'typo' && r.expect)
  const words = [...new Set(typos.flatMap(r => tokens(r.q)))].sort()
  const targets = [...new Set(typos.flatMap(r => tokens(r.expect!)))].sort()
  const cache = new URL('known.json', dir)
  let saved: { checked: string[]; known: string[]; targets?: string[]; stop?: string[] } | null = null
  try {
    saved = JSON.parse(await readFile(cache, 'utf8'))
  } catch {}
  if (saved?.targets && words.every(w => saved!.checked.includes(w)) && targets.every(w => saved!.targets!.includes(w))) {
    for (const w of saved.known) known.add(w)
    for (const w of saved.stop ?? []) stopTargets.add(w)
  } else {
    const { connect } = await import('../src/db.ts')
    const pool = connect()
    try {
      for (const row of (await pool.query<{ word: string }>('SELECT word FROM search.words WHERE word = ANY($1)', [words])).rows) known.add(row.word)
      const stop = await pool.query<{ w: string }>(`SELECT w FROM unnest($1::text[]) AS w WHERE ts_lexize('english_stem', w) = '{}'`, [targets])
      for (const row of stop.rows) stopTargets.add(row.w)
    } finally {
      await pool.end()
    }
    await writeFile(cache, `${JSON.stringify({ checked: words, known: [...known].sort(), targets, stop: [...stopTargets].sort() })}\n`)
  }
}
const searchable = (r: Rec) => !tokens(r.expect ?? '').some(w => stopTargets.has(w))
const misspelled = (r: Rec) => tokens(r.q).filter(w => !tokens(r.expect ?? '').includes(w))
const realWord = (r: Rec) => misspelled(r).length > 0 && misspelled(r).every(w => known.has(w))

// ---------------------------------------------------------------- statistics

const Z = 1.959964
// Wilson score interval for k successes in n trials, 95%.
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const p = k / n
  const d = 1 + (Z * Z) / n
  const c = (p + (Z * Z) / (2 * n)) / d
  const h = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)]
}

function logChoose(n: number, k: number): number {
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i)
  return s
}

// Exact two-sided McNemar test on paired outcomes: b counts pairs where only a is right, c where
// only b is right. The p-value is the two-sided binomial probability of a split this uneven.
function mcnemar(a: boolean[], b: boolean[]): { onlyA: number; onlyB: number; p: number } {
  let onlyA = 0
  let onlyB = 0
  a.forEach((x, i) => {
    if (x && !b[i]) onlyA++
    if (!x && b[i]) onlyB++
  })
  const n = onlyA + onlyB
  if (n === 0) return { onlyA, onlyB, p: 1 }
  let tail = 0
  for (let k = 0; k <= Math.min(onlyA, onlyB); k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2)
  return { onlyA, onlyB, p: Math.min(1, 2 * tail) }
}

const sorted = (v: number[]) => [...v].sort((x, y) => x - y)
const quantile = (v: number[], q: number) => {
  const s = sorted(v)
  return s.length ? s[Math.floor(q * (s.length - 1))] : NaN
}
const median = (v: number[]) => quantile(v, 0.5)
const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length
const norm = (s: string | null | undefined) => (s ? tokens(s).join(' ') : null)

// Area under the ROC curve by the Mann-Whitney statistic, ties counted as half.
function auroc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i])
  const neg = scores.filter((_, i) => !labels[i])
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

// ---------------------------------------------------------------- systems

type SystemId = 'plain' | 'sql' | 'rerank' | 'spellingOnly' | 'jev' | 'norvig' | 'frequency' | 'wide' | 'cascade'
const SYSTEM_LABEL: Record<SystemId, string> = {
  plain: 'plain Postgres full-text search',
  sql: 'this SQL',
  rerank: 'this SQL + Jev keep or sink, as shown',
  spellingOnly: 'this SQL + Jev "Did you mean", one click',
  jev: 'this SQL + Jev, both questions, one click',
  norvig: 'this SQL + Norvig corrector, one click',
  frequency: 'this SQL + frequency rule, one click',
  wide: 'this SQL + Jev over wider options, one click',
  cascade: 'this SQL + Jev, Norvig first for unknown words (post hoc), one click',
}
const outcome = (r: Rec, s: SystemId): Scored => {
  switch (s) {
    case 'plain':
      return r.plain
    case 'sql':
      return r.sql
    case 'rerank':
      return r.jev
    case 'spellingOnly':
      return r.followed.jev ?? r.sql
    case 'jev':
      return r.followed.jev ?? r.jev
    case 'norvig':
      return r.followed.norvig ?? r.sql
    case 'frequency':
      return r.followed.frequency ?? r.sql
    case 'wide':
      return r.followed.wide ?? r.sql
    case 'cascade':
      return r.followed.norvig ?? r.followed.jev ?? r.jev
  }
}
const DETERMINISTIC: SystemId[] = ['plain', 'sql', 'norvig', 'frequency']

type Group = { name: string; take: (r: Rec) => boolean }
const isTest = (r: Rec) => r.set === 'synthetic-test' || r.set === 'wikipedia'
const ALL_GROUPS: Group[] = [
  { name: 'hand-written', take: r => r.set === 'hand-written' },
  { name: 'hand-written, misspelled', take: r => r.set === 'hand-written' && r.kind === 'typo' },
  { name: 'held-out', take: r => r.set === 'held-out' },
  { name: 'held-out, misspelled', take: r => r.set === 'held-out' && r.kind === 'typo' },
  { name: 'held-out, correctly spelled', take: r => r.set === 'held-out' && r.kind === 'control' },
  { name: 'synthetic', take: r => r.set === 'synthetic' },
  { name: 'synthetic, misspelled', take: r => r.set === 'synthetic' && r.kind === 'typo' },
  { name: 'synthetic, correctly spelled', take: r => r.set === 'synthetic' && r.kind === 'control' },
  { name: 'out-of-sample (held-out and synthetic)', take: r => r.set === 'held-out' || r.set === 'synthetic' },
  { name: 'synthetic-test', take: r => r.set === 'synthetic-test' },
  { name: 'synthetic-test, misspelled', take: r => r.set === 'synthetic-test' && r.kind === 'typo' },
  { name: 'synthetic-test, correctly spelled', take: r => r.set === 'synthetic-test' && r.kind === 'control' },
  { name: 'wikipedia', take: r => r.set === 'wikipedia' },
  { name: 'wikipedia, real-word errors', take: r => r.set === 'wikipedia' && realWord(r) },
  { name: 'wikipedia, non-word errors', take: r => r.set === 'wikipedia' && !realWord(r) },
  { name: 'wikipedia, searchable words (post hoc)', take: r => r.set === 'wikipedia' && searchable(r) },
  { name: 'test (synthetic-test and wikipedia)', take: isTest },
]
const GROUPS = ALL_GROUPS.filter(g => runs[0].records.some(g.take))
const hasTest = runs[0].records.some(isTest)

interface Cell {
  n: number
  // The median run's hit count, and the lowest and highest over runs.
  k: number
  lo: number
  hi: number
  ci: [number, number]
}

function cell(group: Group, s: SystemId, metric: 'hit1' | 'hit10', from: Run[] = runs): Cell {
  const counts = from.map(run => run.records.filter(group.take).filter(r => outcome(r, s)[metric]).length)
  const n = from[0].records.filter(group.take).length
  const k = median(counts)
  return { n, k, lo: Math.min(...counts), hi: Math.max(...counts), ci: wilson(k, n) }
}

const pct = (x: number, digits = 0) => `${(100 * x).toFixed(digits)}%`
const showCell = (c: Cell) => {
  const range = pct(c.lo / c.n) === pct(c.hi / c.n) ? '' : ` (${pct(c.lo / c.n)} to ${pct(c.hi / c.n)})`
  return `${pct(c.k / c.n)}${range} [${pct(c.ci[0])}, ${pct(c.ci[1])}]`
}
const fmtP = (p: number) => (p < 0.0001 ? '< 0.0001' : p < 0.001 ? p.toFixed(4) : p.toFixed(3))

// ---------------------------------------------------------------- report

const out: string[] = []
const line = (s = '') => out.push(s)
const table = (header: string[], rows: (string | number)[][], align: ('l' | 'r')[] = []) => {
  line(`| ${header.join(' | ')} |`)
  line(`|${header.map((_, i) => (align[i] === 'l' || (align[i] === undefined && i === 0) ? ':---' : '---:')).join('|')}|`)
  for (const r of rows) line(`| ${r.join(' | ')} |`)
  line()
}

const all = runs.flatMap(r => r.records)
const metas = runs.map(r => r.meta)
line(`# Comparison report`)
line()
line(`Generated by \`scripts/report.ts\` from ${runs.length} runs of \`scripts/compare.ts\`.`)
line()
table(
  ['run', 'started (UTC)', 'commit', 'model', 'Postgres', 'Node', 'load before / after'],
  metas.map((m, i) => [
    i + 1,
    m.startedAt.replace('T', ' ').slice(0, 19),
    m.git,
    m.models.join(', '),
    m.postgres.split(' ')[0],
    m.node,
    `${m.loadBefore[0].toFixed(1)} / ${m.loadAfter[0].toFixed(1)}`,
  ]),
)
line(`Machine: ${metas[0].cpu}, ${metas[0].cpus} logical CPUs, ${metas[0].memoryGB} GB. Products: ${metas[0].products.toLocaleString('en-US')}.`)
line()

line('## Accuracy (hit@1)')
line()
line('Median run, with the lowest and highest run in parentheses when they differ, and the Wilson')
line('95% interval of the median run in brackets.')
line()
const MAIN: SystemId[] = ['plain', 'sql', 'rerank', 'spellingOnly', 'jev', 'norvig', 'frequency', 'wide', 'cascade'].filter(
  s => s !== 'wide' || hasWide,
) as SystemId[]
for (const metric of ['hit1', 'hit10'] as const) {
  line(`### ${metric === 'hit1' ? 'hit@1' : 'hit@10'}`)
  line()
  table(
    ['group', 'n', ...MAIN.map(s => SYSTEM_LABEL[s])],
    GROUPS.map(g => [g.name, cell(g, 'plain', metric).n, ...MAIN.map(s => showCell(cell(g, s, metric)))]),
  )
}

// The four comparisons the README treats as primary, on the queries nothing was tuned on, with
// Holm's correction across the four, run by run.
const PRIMARY: [SystemId, SystemId][] = [
  ['sql', 'plain'],
  ['rerank', 'sql'],
  ['spellingOnly', 'sql'],
  ['spellingOnly', 'norvig'],
]
// The test sets when present; in results/v1, which has none, the held-out and synthetic sets.
const outOfSample = GROUPS.find(g => g.name.startsWith(hasTest ? 'test' : 'out-of-sample'))!
const holmByRun = runs.map(run => {
  const rs = run.records.filter(outOfSample.take)
  const tests = PRIMARY.map(([a, b]) => mcnemar(rs.map(r => outcome(r, a).hit1), rs.map(r => outcome(r, b).hit1)))
  const order = tests.map((t, i) => i).sort((i, j) => tests[i].p - tests[j].p)
  const adjusted = new Array<number>(tests.length)
  let running = 0
  order.forEach((i, rank) => {
    running = Math.max(running, Math.min(1, (tests.length - rank) * tests[i].p))
    adjusted[i] = running
  })
  return tests.map((t, i) => ({ ...t, adjusted: adjusted[i] }))
})
line('## Primary comparisons')
line()
line(`On the ${runs[0].records.filter(outOfSample.take).length} queries of the group "${outOfSample.name}", hit@1, exact McNemar with Holm's correction across these four, the largest adjusted p over the ${runs.length} runs.`)
line()
table(
  ['A', 'B', 'A hit@1', 'B hit@1', 'only A', 'only B', 'Holm-adjusted p, worst run'],
  PRIMARY.map(([a, b], i) => {
    const ca = cell(outOfSample, a, 'hit1')
    const cb = cell(outOfSample, b, 'hit1')
    const onlyA = holmByRun.map(r => r[i].onlyA)
    const onlyB = holmByRun.map(r => r[i].onlyB)
    const sp = (v: number[]) => (Math.min(...v) === Math.max(...v) ? `${v[0]}` : `${Math.min(...v)} to ${Math.max(...v)}`)
    return [SYSTEM_LABEL[a], SYSTEM_LABEL[b], pct(ca.k / ca.n), pct(cb.k / cb.n), sp(onlyA), sp(onlyB), fmtP(Math.max(...holmByRun.map(r => r[i].adjusted)))]
  }),
  ['l', 'l'],
)
line('## Paired tests (exact McNemar, hit@1, exploratory)')
line()
line('"only A" counts queries the first system gets right and the second gets wrong. For systems')
line('that call Jev, each run gives its own test; the table shows the range over runs.')
line()
const PAIRS: [SystemId, SystemId][] = [
  ['sql', 'plain'],
  ['rerank', 'sql'],
  ['spellingOnly', 'sql'],
  ['jev', 'sql'],
  ['jev', 'plain'],
  ['spellingOnly', 'norvig'],
  ['spellingOnly', 'frequency'],
  ['wide', 'spellingOnly'],
  ['cascade', 'norvig'],
  ['cascade', 'jev'],
].filter(([a, b]) => hasWide || (a !== 'wide' && b !== 'wide')) as [SystemId, SystemId][]
const pairRows: (string | number)[][] = []
for (const g of GROUPS.filter(g => !g.name.includes('correctly'))) {
  for (const [a, b] of PAIRS) {
    const tests = runs.map(run => {
      const rs = run.records.filter(g.take)
      return mcnemar(rs.map(r => outcome(r, a).hit1), rs.map(r => outcome(r, b).hit1))
    })
    const ps = tests.map(t => t.p)
    const onlyA = tests.map(t => t.onlyA)
    const onlyB = tests.map(t => t.onlyB)
    const span = (v: number[]) => (Math.min(...v) === Math.max(...v) ? `${v[0]}` : `${Math.min(...v)} to ${Math.max(...v)}`)
    pairRows.push([
      g.name,
      `${SYSTEM_LABEL[a]} vs ${SYSTEM_LABEL[b]}`,
      span(onlyA),
      span(onlyB),
      Math.min(...ps) === Math.max(...ps) ? fmtP(ps[0]) : `${fmtP(Math.min(...ps))} to ${fmtP(Math.max(...ps))}`,
    ])
  }
}
table(['group', 'A vs B', 'only A', 'only B', 'p'], pairRows, ['l', 'l'])

// ------------------------------------------------ spelling correction

type Corrector = 'jev' | 'wide' | 'norvig' | 'frequency' | 'cascade'
const CORRECTOR_LABEL: Record<Corrector, string> = {
  jev: 'Jev (shipped options)',
  wide: 'Jev (wider options, research only)',
  norvig: 'Norvig corrector',
  frequency: 'frequency rule',
  cascade: 'Norvig for unknown words, else Jev (post hoc)',
}
const CORRECTORS: Corrector[] = (['jev', 'norvig', 'frequency', 'wide'] as Corrector[]).filter(c => c !== 'wide' || hasWide)
const suggestionOf = (r: Rec, c: Corrector) => (c === 'cascade' ? (r.suggestions.norvig ?? r.suggestions.jev) : (r.suggestions[c] ?? null))
const spellingSets = (['held-out', 'synthetic', 'synthetic-test', 'wikipedia'] as const).filter(set => runs[0].records.some(r => r.set === set))
// Analyses of the spelling question use the test sets when present.
const spellingScope = (r: Rec) => (hasTest ? isTest(r) : r.set === 'held-out' || r.set === 'synthetic')
const scopeName = hasTest ? 'synthetic-test and wikipedia' : 'held-out and synthetic'

interface Correction {
  typos: number
  fixed: number
  wrong: number
  missed: number
  controls: number
  falseAlarms: number
  offered: number
}

function correction(rs: Rec[], c: Corrector): Correction {
  const typos = rs.filter(r => r.kind === 'typo')
  const controls = rs.filter(r => r.kind === 'control')
  const sug = (r: Rec) => norm(suggestionOf(r, c))
  const fixed = typos.filter(r => sug(r) === norm(r.expect)).length
  const wrong = typos.filter(r => sug(r) !== null && sug(r) !== norm(r.expect)).length
  const options = (r: Rec) => (c === 'wide' ? r.wide!.options : r.jev.spelling.options)
  const offered = c === 'jev' || c === 'wide' ? typos.filter(r => options(r).map(o => norm(o)).includes(norm(r.expect))).length : NaN
  return {
    typos: typos.length,
    fixed,
    wrong,
    missed: typos.length - fixed - wrong,
    controls: controls.length,
    falseAlarms: controls.filter(r => sug(r) !== null).length,
    offered,
  }
}

const span = (v: number[]) => (Math.min(...v) === Math.max(...v) ? `${v[0]}` : `${median(v)} (${Math.min(...v)} to ${Math.max(...v)})`)

// The first version against this one, on the development sets both were run on.
const v1 = drawFigures ? await loadRuns(new URL('../results/v1/', import.meta.url)).catch(() => [] as Run[]) : []
if (v1.length) {
  line('## Version 1 and version 2 on the development sets')
  line()
  line(`Version 1 (${v1.length} runs in results/v1) used trigram candidates only, no counts or edits in the options, and a bar of 0.6. Hit@1, median run.`)
  line()
  const dev = ['hand-written', 'held-out', 'synthetic', 'out-of-sample (held-out and synthetic)'].map(name => ALL_GROUPS.find(g => g.name === name)!)
  table(
    ['group', 'n', 'v1 "Did you mean"', 'v2 "Did you mean"', 'v1 both questions', 'v2 both questions', 'Norvig corrector'],
    dev.map(g => {
      const c = (s: SystemId, from: Run[]) => pct(cell(g, s, 'hit1', from).k / cell(g, s, 'hit1', from).n)
      return [g.name, cell(g, 'sql', 'hit1').n, c('spellingOnly', v1), c('spellingOnly', runs), c('jev', v1), c('jev', runs), c('norvig', runs)]
    }),
  )
  const corr = (from: Run[]) => {
    const per = from.map(run => correction(run.records.filter(r => r.set === 'synthetic'), 'jev'))
    return [median(per.map(x => x.fixed)), median(per.map(x => x.wrong)), median(per.map(x => x.missed)), median(per.map(x => x.falseAlarms)), median(per.map(x => x.offered))]
  }
  table(
    ['synthetic development set (300 misspellings, 200 controls)', 'fixed', 'wrong', 'missed', 'false alarms', 'intended word offered'],
    [
      ['version 1', ...corr(v1)],
      ['version 2', ...corr(runs)],
    ],
  )
}

line('## Spelling correction')
line()
line('"fixed" is a suggestion equal to the intended word, "wrong" a different suggestion, "false')
line('alarms" a suggestion on a correctly spelled control. "offered" is how often the intended word')
line('was among the options Jev chose from. Medians over runs, range in parentheses.')
line()
for (const set of spellingSets) {
  line(`### ${set}`)
  line()
  const rows = CORRECTORS.map(c => {
    const per = runs.map(run => correction(run.records.filter(r => r.set === set), c))
    const precision = per.map(x => x.fixed / Math.max(1, x.fixed + x.wrong + x.falseAlarms))
    return [
      CORRECTOR_LABEL[c],
      span(per.map(x => x.fixed)),
      span(per.map(x => x.wrong)),
      span(per.map(x => x.missed)),
      span(per.map(x => x.falseAlarms)),
      pct(median(precision)),
      c === 'jev' || c === 'wide' ? span(per.map(x => x.offered)) : 'n/a',
    ]
  })
  const n = correction(runs[0].records.filter(r => r.set === set), 'jev')
  line(`${n.typos} misspellings and ${n.controls} controls.`)
  line()
  table(['corrector', 'fixed', 'wrong', 'missed', 'false alarms', 'precision', 'offered'], rows)
}

const editSet = runs[0].records.some(r => r.set === 'synthetic-test') ? 'synthetic-test' : 'synthetic'
line(`### ${editSet} misspellings by edit type (fixed, median run)`)
line()
const EDIT_TYPES = ['deletion', 'insertion', 'substitution', 'transposition']
const byEdit = EDIT_TYPES.map(e => {
  const counts = CORRECTORS.map(c => runs.map(run => correction(run.records.filter(r => r.set === editSet && (r.edit === e || r.kind === 'control')), c).fixed))
  const n = runs[0].records.filter(r => r.set === editSet && r.edit === e).length
  const offered = runs.map(run => correction(run.records.filter(r => r.set === editSet && (r.edit === e || r.kind === 'control')), 'jev').offered)
  return { e, n, fixed: counts.map(median), offered: median(offered) }
})
table(
  ['edit', 'n', ...CORRECTORS.map(c => CORRECTOR_LABEL[c]), 'offered (shipped options)'],
  byEdit.map(x => [x.e, x.n, ...x.fixed.map(f => `${f} (${pct(f / x.n)})`), `${x.offered} (${pct(x.offered / x.n)})`]),
)

// Choice accuracy when the intended word was offered.
line('### When the intended word was offered')
line()
{
  line(`Misspellings in ${scopeName}.`)
  line()
  const rows = ((hasWide ? ['jev', 'wide'] : ['jev']) as ('jev' | 'wide')[]).map(c => {
    const per = runs.map(run => {
      const typos = run.records.filter(r => spellingScope(r) && r.kind === 'typo' && !!r.expect)
      const options = (r: Rec) => (c === 'wide' ? r.wide!.options : r.jev.spelling.options).map(o => norm(o))
      const offered = typos.filter(r => options(r).includes(norm(r.expect)))
      return { offered: offered.length, picked: offered.filter(r => norm(r.suggestions[c]) === norm(r.expect)).length }
    })
    return [CORRECTOR_LABEL[c], span(per.map(x => x.offered)), span(per.map(x => x.picked)), pct(median(per.map(x => x.picked / x.offered)), 1)]
  })
  table(['options', 'typos with the word offered', 'Jev picked it', 'rate'], rows)
}

const ERROR_TYPES = [
  { name: 'real-word errors', take: (r: Rec) => r.kind === 'typo' && !!r.expect && realWord(r) },
  { name: 'non-word errors', take: (r: Rec) => r.kind === 'typo' && !!r.expect && !realWord(r) },
]
const SPLIT_CORRECTORS: Corrector[] = ['jev', 'norvig', 'cascade', 'frequency']
const errorSplit = ERROR_TYPES.map(et => {
  const n = runs[0].records.filter(r => spellingScope(r) && et.take(r)).length
  const fixed = SPLIT_CORRECTORS.map(c =>
    median(runs.map(run => run.records.filter(r => spellingScope(r) && et.take(r) && norm(suggestionOf(r, c)) === norm(r.expect)).length)),
  )
  const wrong = SPLIT_CORRECTORS.map(c =>
    median(
      runs.map(
        run =>
          run.records.filter(
            r => spellingScope(r) && et.take(r) && suggestionOf(r, c) !== null && norm(suggestionOf(r, c)) !== norm(r.expect),
          ).length,
      ),
    ),
  )
  return { name: et.name, n, fixed, wrong }
})
const controlAlarms = SPLIT_CORRECTORS.map(c =>
  median(runs.map(run => run.records.filter(r => spellingScope(r) && r.kind === 'control' && suggestionOf(r, c) !== null).length)),
)
const controlCount = runs[0].records.filter(r => spellingScope(r) && r.kind === 'control').length
line(`### Real-word and non-word errors (${scopeName}, median run)`)
line()
line('A real-word error is a misspelling that some product name also carries, so it is a word in the index.')
line()
table(
  ['errors', 'n', ...SPLIT_CORRECTORS.map(c => `${CORRECTOR_LABEL[c]}: fixed / wrong`)],
  [
    ...errorSplit.map(e => [e.name, e.n, ...e.fixed.map((f, i) => `${f} (${pct(f / e.n)}) / ${e.wrong[i]}`)]),
    ['controls respelled', controlCount, ...controlAlarms.map(a => `${a} (${pct(a / controlCount, 1)})`)],
  ],
)
const cascadeCalls = all.filter(r => r.jev.spelling.ran && r.suggestions.norvig === null).length / all.filter(r => r.jev.spelling.ran).length
line(`The cascade would still send the spelling question on ${pct(cascadeCalls)} of the searches that send it now.`)
line()

// ------------------------------------------------ threshold, calibration, stability

const spellingRecs = all.filter(r => spellingScope(r) && r.kind !== 'absent' && (r.kind === 'control' || !!r.expect))
const RULE = runs[0].meta.spellingRule ?? { ratio: 0, suggestAt: 0.6 }
// The run's own rule with its floor moved to t.
function suggestAt(r: Rec, t: number): string | null {
  const s = r.jev.spelling
  let best = 0
  let p = 0
  s.probabilities.forEach((pi, i) => {
    if (i > 0 && pi > p) {
      best = i
      p = pi
    }
  })
  return best > 0 && p >= t && p >= RULE.ratio * (s.probabilities[0] ?? 0) ? norm(s.options[best]) : null
}
const thresholds = Array.from({ length: 16 }, (_, i) => +(0.2 + 0.05 * i).toFixed(2))
const sweep = thresholds.map(t => {
  const typos = spellingRecs.filter(r => r.kind === 'typo')
  const controls = spellingRecs.filter(r => r.kind === 'control')
  const fixed = typos.filter(r => suggestAt(r, t) === norm(r.expect)).length
  const wrong = typos.filter(r => suggestAt(r, t) !== null && suggestAt(r, t) !== norm(r.expect)).length
  const alarms = controls.filter(r => suggestAt(r, t) !== null).length
  return { t, recall: fixed / typos.length, falseRate: alarms / controls.length, precision: fixed / Math.max(1, fixed + wrong + alarms) }
})
line('## Spelling bar sensitivity (post hoc)')
line()
line(
  `The ${scopeName} sets pooled over all runs (${spellingRecs.filter(r => r.kind === 'typo').length} misspelling and ${spellingRecs.filter(r => r.kind === 'control').length} control answers). The rule is the one these runs used${RULE.ratio ? `, a respelling at least ${RULE.ratio} times as likely as the spelling typed,` : ''} with its floor moved; the runs used ${RULE.suggestAt}.`,
)
line()
table(
  ['bar', 'misspellings fixed', 'controls respelled', 'precision'],
  sweep.map(s => [s.t.toFixed(2), pct(s.recall, 1), pct(s.falseRate, 1), pct(s.precision, 1)]),
)

// Reliability of the spelling choice: confidence is the probability of the option Jev ranked first.
const reliabilityItems = spellingRecs
  .filter(r => r.jev.spelling.ran)
  .map(r => {
    const s = r.jev.spelling
    let top = 0
    s.probabilities.forEach((p, i) => {
      if (p > s.probabilities[top]) top = i
    })
    const right = r.kind === 'typo' ? norm(s.options[top]) === norm(r.expect) : top === 0
    return { conf: s.probabilities[top], right }
  })
const BINS = 10
const reliability = Array.from({ length: BINS }, (_, b) => {
  const lo = b / BINS
  const hi = (b + 1) / BINS
  const items = reliabilityItems.filter(x => x.conf >= lo && (x.conf < hi || (b === BINS - 1 && x.conf <= hi)))
  return { lo, hi, n: items.length, conf: items.length ? mean(items.map(x => x.conf)) : NaN, acc: items.length ? items.filter(x => x.right).length / items.length : NaN }
})
const ece = reliability.reduce((s, b) => s + (b.n ? (b.n / reliabilityItems.length) * Math.abs(b.acc - b.conf) : 0), 0)
const brier = mean(reliabilityItems.map(x => (x.conf - (x.right ? 1 : 0)) ** 2))
line('## Reliability of the spelling choice')
line()
line(`${reliabilityItems.length} answers where the spelling question ran (${scopeName}, all runs). Expected calibration error ${ece.toFixed(3)}; Brier score ${brier.toFixed(3)}.`)
line()
table(
  ['confidence', 'answers', 'mean confidence', 'right'],
  reliability.filter(b => b.n).map(b => [`${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}`, b.n, b.conf.toFixed(2), pct(b.acc, 1)]),
)

// Keep or sink scores against the eval's own match labels (a noisy label, not ground truth).
const nouls: { score: number; label: boolean }[] = []
for (const r of all) {
  if (r.set === 'absent' || !r.jev.rerank.ran) continue
  r.jev.rerank.scores.forEach((score, i) => nouls.push({ score, label: r.jev.rerank.labels[i] }))
}
const nounAuc = auroc(nouls.map(x => x.score), nouls.map(x => x.label))
const noulBins = Array.from({ length: BINS }, (_, b) => {
  const inBin = (x: { score: number }) => x.score >= b / BINS && (x.score < (b + 1) / BINS || (b === BINS - 1 && x.score <= 1))
  const pos = nouls.filter(x => x.label)
  const neg = nouls.filter(x => !x.label)
  return { b, pos: pos.filter(inBin).length / pos.length, neg: neg.filter(inBin).length / neg.length }
})
line('## Keep or sink scores against the eval match labels')
line()
line(
  `${nouls.length} scored candidates (all runs, all sets but absent), ${nouls.filter(x => x.label).length} of them matching their query's pattern or intended word. Area under the ROC curve ${nounAuc.toFixed(3)}. The labels are the eval's string matches, which count a peanut butter cookie as peanut butter, so this measures agreement with a noisy label.`,
)
line()

// Run-to-run stability.
const byQuery = new Map<string, Rec[]>()
for (const run of runs) for (const r of run.records) byQuery.set(`${r.set}|${r.q}`, [...(byQuery.get(`${r.set}|${r.q}`) ?? []), r])
const groupsOfRuns = [...byQuery.values()]
const everSuggested = groupsOfRuns.filter(rs => rs.some(r => r.suggestions.jev !== null))
const unstable = everSuggested.filter(rs => new Set(rs.map(r => r.suggestions.jev)).size > 1)
const everNoMatch = groupsOfRuns.filter(rs => rs.some(r => r.jev.rerank.noMatch))
const unstableNoMatch = everNoMatch.filter(rs => new Set(rs.map(r => r.jev.rerank.noMatch)).size > 1)
const orderChanged = groupsOfRuns.filter(rs => new Set(rs.map(r => r.jev.top)).size > 1)
line('## Run-to-run stability')
line()
table(
  ['what', 'queries', 'changed between runs'],
  [
    ['"Did you mean" shown in at least one run', everSuggested.length, `${unstable.length} (${pct(unstable.length / Math.max(1, everSuggested.length))})`],
    ['no-match flag raised in at least one run', everNoMatch.length, `${unstableNoMatch.length} (${pct(unstableNoMatch.length / Math.max(1, everNoMatch.length))})`],
    ['first result after keep or sink', groupsOfRuns.length, `${orderChanged.length} (${pct(orderChanged.length / groupsOfRuns.length)})`],
  ],
)
const unstableList = unstable.slice(0, 12).map(rs => `\`${rs[0].q}\`: ${rs.map(r => r.suggestions.jev ?? 'none').join(', ')}`)
if (unstableList.length) {
  line('Suggestions that changed: ' + unstableList.join('; ') + '.')
  line()
}

// ------------------------------------------------ no match

line('## No-match line')
line()
{
  const absentRows = runs.map(run => {
    const rs = run.records.filter(r => r.set === 'absent')
    return {
      n: rs.length,
      plainEmpty: rs.filter(r => r.plain.n === 0).length,
      sqlEmpty: rs.filter(r => r.sql.n === 0).length,
      jevTold: rs.filter(r => r.jev.n === 0 || (r.jev.rerank.noMatch && !r.suggestions.jev)).length,
    }
  })
  const falseLines = runs.map(run => run.records.filter(r => r.set !== 'absent' && r.jev.rerank.noMatch && !r.suggestions.jev && r.jev.hit10).length)
  const answerable = runs[0].records.filter(r => r.set !== 'absent').length
  // "Shown as having no match": an empty page, or for Jev, the no-match line.
  const told = (run: Run, f: (r: Rec) => boolean) => run.records.filter(r => r.set !== 'absent' && f(r)).length
  const plainAnswerable = runs.map(run => told(run, r => r.plain.n === 0))
  const sqlAnswerable = runs.map(run => told(run, r => r.sql.n === 0))
  const jevAnswerable = runs.map(run => told(run, r => r.jev.n === 0 || (r.jev.rerank.noMatch && !r.suggestions.jev)))
  line('An empty page, or for Jev the no-match line, counts as saying that nothing matches.')
  line()
  table(
    ['queries', 'plain', 'this SQL', 'this SQL + Jev'],
    [
      [`absent (${absentRows[0].n}): says nothing matches`, span(absentRows.map(x => x.plainEmpty)), span(absentRows.map(x => x.sqlEmpty)), span(absentRows.map(x => x.jevTold))],
      [`answerable (${answerable}): says nothing matches`, span(plainAnswerable), span(sqlAnswerable), span(jevAnswerable)],
      ['answerable, says nothing matches while a match is in the top 10', '0', '0', span(falseLines)],
    ],
  )
}

// ------------------------------------------------ time and cost

const pooled = (f: (r: Rec) => number | null) => all.map(f).filter((x): x is number => x !== null && Number.isFinite(x))
const lat = {
  plain: pooled(r => r.plain.ms),
  sql: pooled(r => r.sql.ms),
  page: pooled(r => r.jev.pageMs),
  added: pooled(r => r.jev.pageMs - r.jev.searchMs),
  rerank: pooled(r => (r.jev.rerank.ran ? r.jev.rerank.ms : null)),
  spelling: pooled(r => (r.jev.spelling.ran ? r.jev.spelling.ms : null)),
  search: pooled(r => r.jev.searchMs),
}
line('## Time')
line()
line(`Pooled over all ${runs.length} runs and ${runs[0].records.length} queries per run. Milliseconds.`)
line()
const perRunMedian = (f: (r: Rec) => number | null) =>
  runs.map(run => median(run.records.map(f).filter((x): x is number => x !== null && Number.isFinite(x))))
table(
  ['measure', 'p50', 'p90', 'p99', 'median of each run'],
  (
    [
      ['plain Postgres full-text search', lat.plain, (r: Rec) => r.plain.ms],
      ['this SQL', lat.sql, (r: Rec) => r.sql.ms],
      ['this SQL + Jev, whole page', lat.page, (r: Rec) => r.jev.pageMs],
      ['time Jev adds to the page', lat.added, (r: Rec) => r.jev.pageMs - r.jev.searchMs],
      ['Jev keep or sink call', lat.rerank, (r: Rec) => (r.jev.rerank.ran ? r.jev.rerank.ms : null)],
      ['Jev spelling call', lat.spelling, (r: Rec) => (r.jev.spelling.ran ? r.jev.spelling.ms : null)],
    ] as [string, number[], (r: Rec) => number | null][]
  ).map(([name, v, f]) => [name, quantile(v, 0.5).toFixed(0), quantile(v, 0.9).toFixed(0), quantile(v, 0.99).toFixed(0), perRunMedian(f).map(x => x.toFixed(0)).join(', ')]),
)
const judgments = all.filter(r => r.jev.rerank.ran).map(r => r.jev.rerank.scores.length)
const optionCounts = all.filter(r => r.jev.spelling.ran).map(r => r.jev.spelling.options.length)
line(
  `Each keep or sink call judged a median of ${median(judgments)} results; each spelling call chose among a median of ${median(optionCounts)} options. Calls made: keep or sink on ${pct(all.filter(r => r.jev.rerank.ran).length / all.length)} of searches, spelling on ${pct(all.filter(r => r.jev.spelling.ran).length / all.length)}.`,
)
line()

line('## Cost')
line()
const costRows = GROUPS.filter(g => !g.name.includes(',')).concat([{ name: 'absent', take: r => r.set === 'absent' }]).map(g => {
  const rs = all.filter(g.take)
  const tokensPer = mean(rs.map(r => r.jev.rerank.tokens + r.jev.spelling.tokens))
  return [g.name, rs.length / runs.length, tokensPer.toFixed(0), `$${((tokensPer * PRICE) / 1e6).toFixed(6)}`, `$${((tokensPer * PRICE) / 1e3).toFixed(4)}`]
})
const allTokens = mean(all.map(r => r.jev.rerank.tokens + r.jev.spelling.tokens))
costRows.push(['every query', all.length / runs.length, allTokens.toFixed(0), `$${((allTokens * PRICE) / 1e6).toFixed(6)}`, `$${((allTokens * PRICE) / 1e3).toFixed(4)}`])
table(['queries', 'per run', 'input tokens per search', 'cost per search', 'cost per 1,000 searches'], costRows)
const runTokens = runs.map(run => run.records.reduce((s, r) => s + r.jev.rerank.tokens + r.jev.spelling.tokens + (r.wide?.tokens ?? 0), 0))
line(`Each run sent ${median(runTokens).toLocaleString('en-US')} input tokens in all${hasWide ? ', including the research-only spelling variant' : ''}: $${((median(runTokens) * PRICE) / 1e6).toFixed(3)} per run at $${PRICE} per million.`)
line()

await writeFile(new URL('report.md', dir), `${out.join('\n')}\n`)

// ---------------------------------------------------------------- figures

type Theme = 'light' | 'dark'
const THEME = {
  light: {
    surface: '#fcfcfb',
    text: '#0b0b0b',
    muted: '#52514e',
    grid: '#e4e3df',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],
  },
  dark: {
    surface: '#1a1a19',
    text: '#ffffff',
    muted: '#c3c2b7',
    grid: '#383835',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500'],
  },
}
const FONT = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function svg(width: number, height: number, theme: Theme, title: string, body: string): string {
  const t = THEME[theme]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${FONT}">
<title>${esc(title)}</title>
<rect width="${width}" height="${height}" fill="${t.surface}"/>
${body}
</svg>
`
}
const text = (x: number, y: number, s: string, o: { size?: number; fill: string; anchor?: string; weight?: number } ) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${o.size ?? 12}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}>${esc(s)}</text>`
const lineEl = (x1: number, y1: number, x2: number, y2: number, stroke: string, w = 1) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"/>`
const dot = (x: number, y: number, fill: string, surface: string, r = 5) =>
  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${surface}" stroke-width="2"/>`
const path = (pts: [number, number][], stroke: string) =>
  `<path d="${pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
// A bar from the baseline up to y, rounded 4px at the data end only.
function column(x: number, w: number, base: number, top: number, fill: string): string {
  const h = base - top
  if (h <= 0.5) return ''
  const r = Math.min(4, h, w / 2)
  return `<path d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z" fill="${fill}"/>`
}
function hbar(x0: number, x1: number, y: number, h: number, fill: string): string {
  const w = x1 - x0
  if (w <= 0.5) return ''
  const r = Math.min(4, w, h / 2)
  return `<path d="M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z" fill="${fill}"/>`
}
function legend(items: { label: string; color: string }[], x: number, y: number, t: (typeof THEME)['light']): string {
  let cx = x
  return items
    .map(it => {
      const s = `<rect x="${cx}" y="${y - 9}" width="12" height="12" rx="3" fill="${it.color}"/>${text(cx + 18, y + 1, it.label, { fill: t.muted, size: 12 })}`
      cx += 30 + it.label.length * 6.6
      return s
    })
    .join('')
}

const figures: Record<string, (theme: Theme) => string> = {}

// Figure 1: hit@1 by system, three query sets, with Wilson intervals.
figures['accuracy'] = theme => {
  const t = THEME[theme]
  const sets = [
    ...(hasTest
      ? [
          { g: GROUPS.find(g => g.name === 'hand-written')!, title: 'Hand-written queries (n = 50, development)' },
          { g: GROUPS.find(g => g.name === 'synthetic-test')!, title: 'Test: synthetic one-edit misspellings and controls (n = 500)' },
          { g: GROUPS.find(g => g.name === 'wikipedia')!, title: `Test: real misspellings from Wikipedia (n = ${runs[0].records.filter(r => r.set === 'wikipedia').length})` },
        ]
      : [
          { g: GROUPS.find(g => g.name === 'hand-written')!, title: 'Hand-written queries (n = 50, partly in-sample for Jev)' },
          { g: GROUPS.find(g => g.name === 'held-out')!, title: 'Held-out words (n = 50)' },
          { g: GROUPS.find(g => g.name === 'synthetic')!, title: 'Synthetic one-edit misspellings and controls (n = 500)' },
        ]),
  ]
  const systems: { s: SystemId; jev: boolean }[] = [
    { s: 'plain', jev: false },
    { s: 'sql', jev: false },
    { s: 'norvig', jev: false },
    { s: 'rerank', jev: true },
    { s: 'jev', jev: true },
  ]
  const W = 860
  const left = 300
  const right = 70
  const rowH = 26
  const panelH = 30 + systems.length * rowH + 10
  const top = 60
  const H = top + sets.length * panelH + 50
  const x = (v: number) => left + v * (W - left - right)
  let body = text(24, 30, 'Right product first (hit@1), with 95% Wilson intervals', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, 'Blue rows call Jev. Dots are the median of five runs; whiskers are the interval of that run.', { fill: t.muted, size: 12 })
  sets.forEach((set, si) => {
    const y0 = top + si * panelH
    body += text(24, y0 + 22, set.title, { fill: t.text, size: 13, weight: 600 })
    const yTop = y0 + 32
    const yBottom = y0 + 32 + systems.length * rowH
    for (const v of [0, 0.25, 0.5, 0.75, 1]) body += lineEl(x(v), yTop - 4, x(v), yBottom - 6, t.grid)
    systems.forEach((sys, i) => {
      const c = cell(set.g, sys.s, 'hit1')
      const y = yTop + i * rowH + rowH / 2 - 4
      const color = sys.jev ? t.series[0] : t.muted
      body += text(left - 12, y + 4, SYSTEM_LABEL[sys.s], { fill: sys.jev ? t.text : t.muted, size: 12, anchor: 'end' })
      body += lineEl(x(c.ci[0]), y, x(c.ci[1]), y, color, 2)
      body += dot(x(c.k / c.n), y, color, t.surface)
      body += text(x(c.ci[1]) + 8, y + 4, pct(c.k / c.n), { fill: t.text, size: 12 })
    })
  })
  const axisY = top + sets.length * panelH + 4
  for (const v of [0, 0.25, 0.5, 0.75, 1]) body += text(x(v), axisY + 10, pct(v), { fill: t.muted, size: 11, anchor: 'middle' })
  return svg(W, H, theme, 'Right product first by system and query set', body)
}

// Figure 2: misspellings fixed by edit type, four correctors.
figures['spelling-by-edit'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 380
  const left = 56
  const right = 20
  const top = 86
  const bottom = 300
  const groups = [...byEdit.map(b => ({ name: b.e, n: b.n, fixed: b.fixed }))]
  const gw = (W - left - right) / groups.length
  const bw = 22
  const y = (v: number) => bottom - v * (bottom - top)
  let body = text(24, 30, `${editSet === 'synthetic-test' ? 'Synthetic test set' : 'Synthetic set'}: misspellings fixed, by edit type`, { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, 'Share of 75 misspellings per type where the suggestion is the intended word (median of five runs). Labels: Jev.', { fill: t.muted, size: 12 })
  body += legend(CORRECTORS.map((c, i) => ({ label: CORRECTOR_LABEL[c], color: t.series[i] })), left, 72, t)
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, pct(v), { fill: t.muted, size: 11, anchor: 'end' })
  }
  groups.forEach((g, gi) => {
    const cx = left + gi * gw + gw / 2
    const x0 = cx - (CORRECTORS.length * bw + (CORRECTORS.length - 1) * 2) / 2
    g.fixed.forEach((f, i) => {
      const v = f / g.n
      const bx = x0 + i * (bw + 2)
      body += column(bx, bw, bottom, y(v), t.series[i])
      if (i === 0) body += text(bx + bw / 2, y(v) - 6, pct(v), { fill: t.text, size: 11, anchor: 'middle' })
    })
    body += text(cx, bottom + 20, g.name, { fill: t.text, size: 12, anchor: 'middle' })
  })
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Synthetic misspellings fixed by edit type and corrector', body)
}

// Figure 3: the spelling bar, post hoc.
figures['threshold'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 360
  const left = 56
  const right = 170
  const top = 70
  const bottom = 300
  const x = (v: number) => left + ((v - 0.2) / (0.95 - 0.2)) * (W - left - right)
  const y = (v: number) => bottom - v * (bottom - top)
  let body = text(24, 30, 'Where the suggestion floor sits (post hoc)', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, `The ${scopeName} sets, all runs pooled${RULE.ratio ? `, with the respelling at least ${RULE.ratio} times as likely as the spelling typed` : ''}. The page uses ${RULE.suggestAt}.`, { fill: t.muted, size: 12 })
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, pct(v), { fill: t.muted, size: 11, anchor: 'end' })
  }
  for (const v of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) body += text(x(v), bottom + 18, v.toFixed(1), { fill: t.muted, size: 11, anchor: 'middle' })
  body += text((left + W - right) / 2, bottom + 40, 'probability a respelling needs before it is suggested', { fill: t.muted, size: 12, anchor: 'middle' })
  body += lineEl(x(RULE.suggestAt), top - 6, x(RULE.suggestAt), bottom, t.muted)
  body += text(x(RULE.suggestAt) + 6, top + 4, 'floor used', { fill: t.muted, size: 11 })
  const series = [
    { label: 'misspellings fixed', v: sweep.map(s => s.recall), color: t.series[0] },
    { label: 'correct words respelled', v: sweep.map(s => s.falseRate), color: t.series[1] },
    { label: 'precision', v: sweep.map(s => s.precision), color: t.series[2] },
  ]
  for (const s of series) {
    const pts = sweep.map((p, i) => [x(p.t), y(s.v[i])] as [number, number])
    body += path(pts, s.color)
    const last = pts[pts.length - 1]
    body += dot(last[0], last[1], s.color, t.surface, 4)
    body += text(last[0] + 10, last[1] + 4, `${s.label} ${pct(s.v[s.v.length - 1])}`, { fill: t.text, size: 12 })
    const used = sweep.findIndex(p => p.t === RULE.suggestAt)
    if (used >= 0) body += dot(pts[used][0], pts[used][1], s.color, t.surface, 4)
  }
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Spelling suggestion rates by bar', body)
}

// Figure 4: reliability of the spelling choice.
figures['reliability'] = theme => {
  const t = THEME[theme]
  const W = 520
  const H = 470
  const left = 64
  const right = 24
  const top = 76
  const bottom = 400
  const x = (v: number) => left + v * (W - left - right)
  const y = (v: number) => bottom - v * (bottom - top)
  let body = text(24, 30, 'Reliability of the spelling choice', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, `${reliabilityItems.length.toLocaleString('en-US')} answers. ECE ${ece.toFixed(3)}, Brier ${brier.toFixed(3)}. Diagonal: perfect calibration.`, { fill: t.muted, size: 12 })
  for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += lineEl(x(v), top, x(v), bottom, t.grid)
    body += text(left - 8, y(v) + 4, v.toFixed(1), { fill: t.muted, size: 11, anchor: 'end' })
    body += text(x(v), bottom + 18, v.toFixed(1), { fill: t.muted, size: 11, anchor: 'middle' })
  }
  body += lineEl(x(0), y(0), x(1), y(1), t.muted)
  body += text((left + W - right) / 2, bottom + 40, 'Jev probability of the option it ranked first', { fill: t.muted, size: 12, anchor: 'middle' })
  body += `<text transform="translate(18 ${(top + bottom) / 2}) rotate(-90)" font-size="12" fill="${t.muted}" text-anchor="middle">share of those answers that were right</text>`
  const pts = reliability.filter(b => b.n >= 5).map(b => [x(b.conf), y(b.acc)] as [number, number])
  body += path(pts, t.series[0])
  for (const b of reliability.filter(b => b.n >= 5)) {
    body += dot(x(b.conf), y(b.acc), t.series[0], t.surface, 4 + Math.min(4, Math.log10(b.n)))
  }
  return svg(W, H, theme, 'Reliability diagram for the spelling choice', body)
}

// Figure 5: keep or sink scores by label.
figures['noul'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 360
  const left = 56
  const right = 20
  const top = 86
  const bottom = 290
  const gw = (W - left - right) / BINS
  const bw = 20
  const maxV = Math.max(...noulBins.flatMap(b => [b.pos, b.neg]))
  const ceil = Math.ceil(maxV * 10) / 10
  const tickStep = ceil > 0.4 ? 0.2 : 0.1
  const y = (v: number) => bottom - (v / ceil) * (bottom - top)
  let body = text(24, 30, `Keep or sink scores, by whether the result matches its query (AUROC ${nounAuc.toFixed(3)})`, { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, `${nouls.length.toLocaleString('en-US')} scored results. Matching uses the eval's string match, a noisy label. The page sinks results under 0.3.`, { fill: t.muted, size: 12 })
  body += legend(
    [
      { label: 'result matches the query', color: t.series[0] },
      { label: 'result does not match', color: t.series[1] },
    ],
    left,
    72,
    t,
  )
  for (let v = 0; v <= ceil + 1e-9; v += tickStep) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, pct(v), { fill: t.muted, size: 11, anchor: 'end' })
  }
  noulBins.forEach((b, i) => {
    const cx = left + i * gw + gw / 2
    body += column(cx - bw - 1, bw, bottom, y(b.pos), t.series[0])
    body += column(cx + 1, bw, bottom, y(b.neg), t.series[1])
    body += text(cx, bottom + 18, `${(i / BINS).toFixed(1)} to ${((i + 1) / BINS).toFixed(1)}`, { fill: t.muted, size: 10, anchor: 'middle' })
  })
  body += lineEl(left + 3 * gw, top - 6, left + 3 * gw, bottom, t.muted)
  body += text(left + 3 * gw + 6, top + 4, 'sink below 0.3', { fill: t.muted, size: 11 })
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  body += text((left + W - right) / 2, bottom + 40, 'Jev score: is this result what the user meant?', { fill: t.muted, size: 12, anchor: 'middle' })
  return svg(W, H, theme, 'Distribution of keep or sink scores by label', body)
}

// Figure 6: latency distributions.
figures['latency'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 380
  const left = 56
  const right = 190
  const top = 70
  const bottom = 310
  const lo = 1
  const hi = 3000
  const x = (v: number) => left + ((Math.log10(Math.max(lo, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - left - right)
  const y = (v: number) => bottom - v * (bottom - top)
  let body = text(24, 30, 'Time per query, cumulative', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, `${runs.length} runs pooled, ${lat.plain.length.toLocaleString('en-US')} queries per system, warm cache, log scale. Dots mark the medians.`, { fill: t.muted, size: 12 })
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, pct(v), { fill: t.muted, size: 11, anchor: 'end' })
  }
  for (const v of [1, 3, 10, 30, 100, 300, 1000, 3000]) {
    body += lineEl(x(v), top, x(v), bottom, t.grid)
    body += text(x(v), bottom + 18, `${v.toLocaleString('en-US')} ms`, { fill: t.muted, size: 11, anchor: 'middle' })
  }
  const series = [
    { label: 'this SQL + Jev, whole page', v: lat.page, color: t.series[0] },
    { label: 'this SQL', v: lat.sql, color: t.series[1] },
    { label: 'plain full-text search', v: lat.plain, color: t.series[2] },
  ]
  const ends: number[] = []
  for (const s of series) {
    const sv = sorted(s.v)
    const pts: [number, number][] = []
    const step = Math.max(1, Math.floor(sv.length / 400))
    for (let i = 0; i < sv.length; i += step) pts.push([x(sv[i]), y((i + 1) / sv.length)])
    pts.push([x(sv[sv.length - 1]), y(1)])
    body += path(pts, s.color)
    const m = median(sv)
    body += dot(x(m), y(0.5), s.color, t.surface, 4)
    ends.push(m)
  }
  series.forEach((s, i) => {
    const ly = top + 20 + i * 40
    body += `<rect x="${W - right + 14}" y="${ly - 9}" width="12" height="12" rx="3" fill="${s.color}"/>`
    body += text(W - right + 32, ly + 1, `${s.label}`, { fill: t.text, size: 12 })
    body += text(W - right + 32, ly + 15, `median ${ends[i].toFixed(0)} ms`, { fill: t.muted, size: 11 })
  })
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Cumulative distribution of time per query', body)
}

// Figure 7: what the page waits for, at the medians.
figures['timeline'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 262
  const left = 230
  const right = 40
  const s = median(lat.search)
  const r = median(lat.rerank)
  const sp = median(lat.spelling)
  const pageEnd = median(lat.page)
  const end = Math.ceil((Math.max(pageEnd, s + r, sp) * 1.1) / 50) * 50
  const x = (v: number) => left + (v / end) * (W - left - right)
  let body = text(24, 30, 'What one search waits for (medians)', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, 'Both paths start when the query arrives. Orange is Postgres, blue is a Jev call; the page waits for the slower path.', { fill: t.muted, size: 12 })
  for (let v = 0; v <= end; v += 50) {
    body += lineEl(x(v), 80, x(v), 206, t.grid)
    body += text(x(v), 224, `${v} ms`, { fill: t.muted, size: 11, anchor: 'middle' })
  }
  const rows = [
    { label: 'search, then keep or sink', pg: s, pgLabel: `search ${s.toFixed(0)} ms`, jev: r, jevLabel: `judge ${median(judgments)} results: ${r.toFixed(0)} ms` },
    { label: 'close words, then spelling', pg: 0, pgLabel: 'close-word lookup (6 to 20 ms in psql)', jev: sp, jevLabel: `choose among ${median(optionCounts)} spellings: ${sp.toFixed(0)} ms` },
  ]
  rows.forEach((row, i) => {
    const y = 96 + i * 58
    body += text(left - 14, y + 16, row.label, { fill: t.text, size: 12, anchor: 'end' })
    if (row.pg > 0) body += hbar(x(0), x(row.pg), y, 22, t.series[1])
    else body += hbar(x(0), x(0) + 3, y, 22, t.series[1])
    const j0 = row.pg > 0 ? x(row.pg) + 2 : x(0) + 5
    body += hbar(j0, j0 + (x(row.jev) - x(0)), y, 22, t.series[0])
    body += text(j0 + 10, y + 15, row.jevLabel, { fill: '#ffffff', size: 12, weight: 600 })
    body += text(x(0), y + 38, row.pgLabel, { fill: t.muted, size: 11 })
  })
  body += lineEl(x(pageEnd), 76, x(pageEnd), 210, t.text, 1.5)
  body += text(x(pageEnd) + 6, 86, `page median ${pageEnd.toFixed(0)} ms`, { fill: t.text, size: 11 })
  return svg(W, H, theme, 'Timeline of one search', body)
}

// Figure: real-word and non-word errors.
figures['error-types'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 360
  const left = 56
  const right = 20
  const top = 90
  const bottom = 290
  const shown: Corrector[] = ['jev', 'norvig', 'frequency', 'cascade']
  const y = (v: number) => bottom - v * (bottom - top)
  const realSource = hasTest ? 'from Wikipedia\'s list of common misspellings' : 'from the hand-written held-out set'
  let body = text(24, 30, `Misspellings fixed, by kind of error (${scopeName} sets)`, { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, `A real-word error also appears in some product name, so Norvig's corrector keeps it by design. The ${errorSplit[0].n} come ${realSource}.`, { fill: t.muted, size: 12 })
  body += legend(shown.map((c, i) => ({ label: CORRECTOR_LABEL[c], color: t.series[i] })), left, 74, t)
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, pct(v), { fill: t.muted, size: 11, anchor: 'end' })
  }
  const gw = (W - left - right) / errorSplit.length
  const bw = 22
  errorSplit.forEach((e, gi) => {
    const cx = left + gi * gw + gw / 2
    const x0 = cx - (shown.length * bw + (shown.length - 1) * 2) / 2
    shown.forEach((c, i) => {
      const v = e.fixed[SPLIT_CORRECTORS.indexOf(c)] / e.n
      const bx = x0 + i * (bw + 2)
      body += column(bx, bw, bottom, y(v), t.series[i])
      body += text(bx + bw / 2, y(v) - 6, pct(v), { fill: t.text, size: 11, anchor: 'middle' })
    })
    body += text(cx, bottom + 20, `${e.name} (n = ${e.n})`, { fill: t.text, size: 12, anchor: 'middle' })
  })
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Misspellings fixed by kind of error', body)
}

// Figure: Algolia's record charge, with the author's invoices.
figures['cost-records'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 380
  const left = 70
  const right = 250
  const top = 70
  const bottom = 310
  const xmax = 600_000
  const ymax = 250
  const x = (v: number) => left + (v / xmax) * (W - left - right)
  const y = (v: number) => bottom - (v / ymax) * (bottom - top)
  let body = text(24, 30, 'Algolia bills by the record; this search does not', { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, 'Grow plan record charge at list price, and two monthly invoices the author paid, which also include search requests.', { fill: t.muted, size: 12 })
  for (const v of [0, 50, 100, 150, 200, 250]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, `$${v}`, { fill: t.muted, size: 11, anchor: 'end' })
  }
  for (const v of [0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000]) {
    body += lineEl(x(v), top, x(v), bottom, t.grid)
    body += text(x(v), bottom + 18, `${v / 1000}K`, { fill: t.muted, size: 11, anchor: 'middle' })
  }
  body += text((left + W - right) / 2, bottom + 40, 'records in the index', { fill: t.muted, size: 12, anchor: 'middle' })
  const recordCharge = (n: number) => (Math.max(0, n - ALGOLIA.includedRecords) / 1000) * ALGOLIA.perThousandRecords
  const pts = Array.from({ length: 61 }, (_, i) => [x(i * 10_000), y(recordCharge(i * 10_000))] as [number, number])
  body += path(pts, t.series[1])
  body += text(pts[60][0] + 10, pts[60][1] + 4, 'Algolia record charge alone', { fill: t.text, size: 12 })
  const jevAt100k = 100_000 * jevPerSearch
  body += path([[x(0), y(jevAt100k)], [x(xmax), y(jevAt100k)]], t.series[0])
  body += text(x(xmax) + 10, y(jevAt100k) + 4, `this SQL + Jev at 100K searches: $${jevAt100k.toFixed(2)}`, { fill: t.text, size: 12 })
  for (const inv of [
    { n: 287_000, v: 100 },
    { n: 500_000, v: 200 },
  ]) {
    body += dot(x(inv.n), y(inv.v), t.series[2], t.surface, 6)
    body += text(x(inv.n) - 10, y(inv.v) - 12, `invoice, ${inv.n / 1000}K records: about $${inv.v}`, { fill: t.text, size: 12, anchor: 'end' })
  }
  const demo = runs[0].meta.products
  body += lineEl(x(demo), top, x(demo), bottom, t.muted)
  body += text(x(demo) + 6, top + 12, `this demo: ${demo.toLocaleString('en-US')}`, { fill: t.muted, size: 11 })
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Algolia record charge and invoices against record count', body)
}

// Figure 8: monthly cost against Algolia's published Grow rates.
const ALGOLIA = { includedRecords: 100_000, includedRequests: 10_000, perThousandRecords: 0.4, perThousandRequests: 0.5 }
const algoliaMonthly = (records: number, searches: number, requestsPerSearch: number) =>
  (Math.max(0, records - ALGOLIA.includedRecords) / 1000) * ALGOLIA.perThousandRecords +
  (Math.max(0, searches * requestsPerSearch - ALGOLIA.includedRequests) / 1000) * ALGOLIA.perThousandRequests
const jevPerSearch = (mean(all.filter(r => r.set === 'hand-written').map(r => r.jev.rerank.tokens + r.jev.spelling.tokens)) * PRICE) / 1e6
figures['cost'] = theme => {
  const t = THEME[theme]
  const W = 860
  const H = 400
  const left = 70
  const right = 230
  const top = 70
  const bottom = 330
  const sx = [1e4, 1e7]
  const sy = [0.1, 1e5]
  const x = (v: number) => left + ((Math.log10(v) - Math.log10(sx[0])) / (Math.log10(sx[1]) - Math.log10(sx[0]))) * (W - left - right)
  const y = (v: number) => bottom - ((Math.log10(Math.max(sy[0], v)) - Math.log10(sy[0])) / (Math.log10(sy[1]) - Math.log10(sy[0]))) * (bottom - top)
  const records = runs[0].meta.products
  let body = text(24, 30, `Monthly search bill for ${records.toLocaleString('en-US')} records`, { fill: t.text, size: 16, weight: 600 })
  body += text(24, 50, 'Algolia Grow list prices read 2026-10-07; Jev at the measured tokens per search. Postgres hosting is not included.', { fill: t.muted, size: 12 })
  for (const v of [0.1, 1, 10, 100, 1000, 10000, 100000]) {
    body += lineEl(left, y(v), W - right, y(v), t.grid)
    body += text(left - 8, y(v) + 4, `$${v.toLocaleString('en-US')}`, { fill: t.muted, size: 11, anchor: 'end' })
  }
  for (const v of [1e4, 1e5, 1e6, 1e7]) {
    body += lineEl(x(v), top, x(v), bottom, t.grid)
    body += text(x(v), bottom + 18, v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}K`, { fill: t.muted, size: 11, anchor: 'middle' })
  }
  body += text((left + W - right) / 2, bottom + 40, 'searches per month', { fill: t.muted, size: 12, anchor: 'middle' })
  const xs = Array.from({ length: 61 }, (_, i) => 10 ** (4 + (3 * i) / 60))
  const series = [
    { label: 'Algolia Grow, 5 requests', sub: 'per search (typeahead)', f: (s: number) => algoliaMonthly(records, s, 5), color: t.series[1] },
    { label: 'Algolia Grow, 1 request', sub: 'per search', f: (s: number) => algoliaMonthly(records, s, 1), color: t.series[2] },
    { label: 'this SQL + Jev', sub: `$${(jevPerSearch * 1000).toFixed(3)} per 1,000 searches`, f: (s: number) => s * jevPerSearch, color: t.series[0] },
  ]
  for (const s of series) {
    const pts = xs.map(v => [x(v), y(s.f(v))] as [number, number])
    body += path(pts, s.color)
    const last = pts[pts.length - 1]
    body += dot(last[0], last[1], s.color, t.surface, 4)
    body += text(last[0] + 10, last[1] - 2, s.label, { fill: t.text, size: 12 })
    body += text(last[0] + 10, last[1] + 12, s.sub, { fill: t.muted, size: 11 })
  }
  body += lineEl(left, bottom, W - right, bottom, t.muted)
  return svg(W, H, theme, 'Monthly cost against search volume', body)
}

if (drawFigures) {
  await mkdir(new URL('../docs/figures/', import.meta.url), { recursive: true })
  for (const [name, draw] of Object.entries(figures)) {
    for (const theme of ['light', 'dark'] as const) {
      await writeFile(new URL(`../docs/figures/${name}-${theme}.svg`, import.meta.url), draw(theme))
    }
  }
}

// The cost table for the README, at a few volumes.
const costModel = [1e4, 1e5, 1e6, 1e7].map(s => [
  s.toLocaleString('en-US'),
  `$${algoliaMonthly(runs[0].meta.products, s, 1).toFixed(0)}`,
  `$${algoliaMonthly(runs[0].meta.products, s, 5).toFixed(0)}`,
  `$${(s * jevPerSearch).toFixed(2)}`,
])
const tail: string[] = []
tail.push('## Cost model')
tail.push('')
tail.push(`Algolia Grow list prices (read 2026-10-07): ${ALGOLIA.includedRecords.toLocaleString('en-US')} records and ${ALGOLIA.includedRequests.toLocaleString('en-US')} requests included, then $${ALGOLIA.perThousandRecords} per 1,000 records a month and $${ALGOLIA.perThousandRequests} per 1,000 requests. Jev at $${(jevPerSearch * 1000).toFixed(4)} per 1,000 searches, the hand-written mean.`)
tail.push('')
tail.push('| searches per month | Algolia, 1 request per search | Algolia, 5 requests per search | this SQL + Jev |')
tail.push('|---:|---:|---:|---:|')
for (const r of costModel) tail.push(`| ${r.join(' | ')} |`)
tail.push('')
await writeFile(new URL('report.md', dir), `${out.join('\n')}\n${tail.join('\n')}\n`)
console.log(`read ${runs.length} runs; wrote ${dirName}/report.md${drawFigures ? ` and ${Object.keys(figures).length * 2} figures` : ''}`)
