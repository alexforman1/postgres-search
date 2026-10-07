// Asks the spelling question once for every case of the development sets, eval/spelling.json and
// eval/synthetic.json, and scores four suggestion rules on the same answers. The page's rule, a
// respelling twice as likely as the spelling typed and at least 0.3 likely, was chosen from this
// output before the test sets existed.
//   JEV_MODEL=jev-1.13.0 node --env-file=.env scripts/spelling-rules.ts
import { readFileSync } from 'node:fs'
import { connect } from '../src/db.ts'
import { NOTE, similarWords } from '../src/page.ts'
import { checkSpelling } from '../src/spelling.ts'
const read = (f: string) => JSON.parse(readFileSync(new URL(`../eval/${f}`, import.meta.url), 'utf8'))
const cases = [...read('spelling.json'), ...read('synthetic.json')] as { q: string; kind: string; expect?: string }[]
const pool = connect()
// ratio 0 and a floor of 0 record Jev's answer for every case; the rules below decide from it.
const out: { kind: string; expect?: string; options: string[]; probs: number[] }[] = []
let tokens = 0
for (const c of cases) {
  const r = await checkSpelling(c.q, await similarWords(pool, c.q), { note: NOTE, ratio: 0, suggestAt: 0 })
  tokens += r.inputTokens ?? 0
  out.push({ kind: c.kind, expect: c.expect, options: r.options, probs: r.probabilities })
}
await pool.end()
const best = (x: (typeof out)[0]) => { let b = 0, p = 0; x.probs.forEach((v, i) => { if (i > 0 && v > p) { b = i; p = v } }); return { o: x.options[b], p, typed: x.probs[0] ?? 0, b } }
const score = (name: string, rule: (b: ReturnType<typeof best>) => boolean) => {
  let fixed = 0, wrong = 0, alarms = 0
  for (const x of out) { const b = best(x); if (!(b.b > 0 && rule(b))) continue; if (x.kind === 'control') alarms++; else if (b.o === x.expect) fixed++; else wrong++ }
  console.log(name.padEnd(28), `fixed ${fixed}/330 wrong ${wrong} alarms ${alarms}/220 precision ${(100 * fixed / Math.max(1, fixed + wrong + alarms)).toFixed(1)}%`)
}
score('bar 0.6', b => b.p >= 0.6)
score('bar 0.5', b => b.p >= 0.5)
score('beats typed, at least 0.4', b => b.p > b.typed && b.p >= 0.4)
score('2x typed, at least 0.3', b => b.p >= 2 * b.typed && b.p >= 0.3)
console.log('input tokens per spelling call', Math.round(tokens / out.filter(x => x.probs.length).length))
