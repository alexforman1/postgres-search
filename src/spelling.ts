import { askJev, type JevRequest, type JevResponse } from './jev.ts'
import { tokens } from './tokens.ts'

// One row of search.similar_words. The counts are how many products the search finds for a word.
export interface SimilarWord {
  pos: number
  word: string
  word_matches: number
  alternative: string
  alternative_matches: number
}

// A spelling to offer Jev, with what the search finds for the words that differ between options
// and, for a respelling, how many edits separate it from what was typed.
interface Option {
  text: string
  found: { word: string; matches: number }[]
  edits?: number
}

// Edit distance counting a letter added, removed or replaced, or two neighbors swapped, as one
// edit each (the optimal string alignment distance).
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

export interface SpellingResult {
  // A respelled query to offer as a "Did you mean" link, or null. Never search it without asking.
  suggestion: string | null
  // Jev's probability for the likeliest respelling, whether or not it cleared the bar.
  p: number
  ran: boolean
  ms: number
  // What Jev chose from: the query as typed, then the respellings.
  options: string[]
  // Jev's probability for each option, in option order; empty when it did not run.
  probabilities: number[]
  error?: string
  model?: string
  inputTokens?: number
}

export interface SpellingOptions {
  // A respelling is suggested when Jev gives it at least ratio times the probability of the
  // spelling typed, and at least suggestAt. Defaults 2 and 0.3.
  ratio?: number
  suggestAt?: number
  maxOptions?: number
  // Describes the catalog to Jev. The demo names groceries; say what your search holds.
  note?: string
  ask?: (request: JevRequest) => Promise<JevResponse>
}

// The query as typed, then the query with one word respelled. Every word's closest alternative
// comes before any word's second, so a long query cannot fill the list from its first word.
function options(query: string, similar: SimilarWord[], max = 16): Option[] {
  const words = tokens(query)
  const byPos = new Map<number, SimilarWord[]>()
  for (const row of similar) {
    // Postgres and JavaScript lower-case some letters differently; a row that does not line up
    // with the query would respell the wrong word.
    if (words[row.pos - 1] !== row.word) continue
    byPos.set(row.pos, [...(byPos.get(row.pos) ?? []), row])
  }
  const positions = [...byPos.keys()].sort((a, b) => a - b)
  const depth = Math.max(0, ...[...byPos.values()].map(rows => rows.length))
  const typed = positions.map(pos => ({ word: words[pos - 1], matches: byPos.get(pos)![0].word_matches }))
  const out: Option[] = [{ text: words.join(' '), found: typed }]
  for (let rank = 0; rank < depth; rank++) {
    for (const pos of positions) {
      const row = byPos.get(pos)![rank]
      if (row === undefined) continue
      const text = words.with(pos - 1, row.alternative).join(' ')
      if (!out.some(o => o.text === text)) {
        out.push({ text, found: [{ word: row.alternative, matches: row.alternative_matches }], edits: editDistance(row.word, row.alternative) })
      }
    }
  }
  return out.slice(0, max)
}

export function spellings(query: string, similar: SimilarWord[], max = 16): string[] {
  return options(query, similar, max).map(o => o.text)
}

// Asks Jev which spelling the user meant: the query as typed or one of the respellings. The likeliest
// respelling becomes a suggestion when it is at least twice as likely as the spelling typed and
// at least 0.3 likely; comparing it with the typed spelling, not with a fixed bar, keeps a
// suggestion when Jev splits the rest among several close words. Every failure suggests nothing.
export async function checkSpelling(
  query: string,
  similar: SimilarWord[],
  settings: SpellingOptions = {},
): Promise<SpellingResult> {
  const suggestAt = settings.suggestAt ?? 0.3
  const ratio = settings.ratio ?? 2
  const ask = settings.ask ?? ((request: JevRequest) => askJev(request))
  const offered = options(query, similar, settings.maxOptions)
  const spelled = offered.map(o => o.text)
  const nothing = (ms: number, error?: string): SpellingResult => ({
    suggestion: null,
    p: 0,
    ran: false,
    ms,
    options: spelled,
    probabilities: [],
    error,
  })
  if (spelled.length < 2) return nothing(0)

  const started = Date.now()
  try {
    const response = await ask(buildSpellingRequest(query, offered, settings.note))
    const probabilities = response.answers.meant?.probabilities
    if (!probabilities) return nothing(Date.now() - started, 'incomplete answer')
    let best = 0
    let p = 0
    spelled.forEach((_, i) => {
      const pi = probabilities[`s${i}`]
      if (i > 0 && typeof pi === 'number' && pi > p) {
        best = i
        p = pi
      }
    })
    return {
      suggestion: best > 0 && p >= suggestAt && p >= ratio * (probabilities.s0 ?? 0) ? spelled[best] : null,
      p,
      ran: true,
      ms: Date.now() - started,
      options: spelled,
      probabilities: spelled.map((_, i) => (typeof probabilities[`s${i}`] === 'number' ? probabilities[`s${i}`] : 0)),
      model: response.model,
      inputTokens: response.usage?.input_tokens,
    }
  } catch (err) {
    return nothing(Date.now() - started, err instanceof Error ? err.message : String(err))
  }
}

const products = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'product' : 'products'}`

function buildSpellingRequest(query: string, offered: Option[], note = 'A user typed `query` into a product search box.'): JevRequest {
  const criteria: Record<string, string> = {}
  offered.forEach((o, i) => {
    const found = o.found.map(f => `${f.word} in ${products(f.matches)}`).join(' and ')
    const how = i === 0 ? 'exactly as typed' : `${o.edits} ${o.edits === 1 ? 'edit' : 'edits'} from what was typed`
    criteria[`s${i}`] = `"${o.text}", ${how}. The search finds ${found}.`
  })
  return {
    state: {
      query,
      note,
      evidence:
        "Each option says how many edits separate it from what was typed, where an edit is one letter added, removed or replaced or two neighboring letters swapped, and how many of the catalog's products the search finds for the words it changes. A word the search finds in no product is not a word this catalog uses, so searching it shows nothing.",
    },
    questions: {
      meant: {
        type: 'choice',
        instructions:
          'Which of these searches did the user mean to type? Pick the one that is spelled the way the user intended. The first option is exactly what they typed.',
        criteria,
      },
    },
  }
}
