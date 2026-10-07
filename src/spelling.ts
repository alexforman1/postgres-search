import { askJev, type JevRequest, type JevResponse } from './jev.ts'
import { tokens } from './tokens.ts'

// One row of search.similar_words.
export interface SimilarWord {
  pos: number
  word: string
  word_count: number
  alternative: string
  doc_count: number
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
  suggestAt?: number
  maxOptions?: number
  // Describes the catalog to Jev. The demo names groceries; say what your search holds.
  note?: string
  ask?: (request: JevRequest) => Promise<JevResponse>
}

// The query as typed, then the query with one word respelled. Every word's closest alternative
// comes before any word's second, so a long query cannot fill the list from its first word.
export function spellings(query: string, similar: SimilarWord[], max = 16): string[] {
  const words = tokens(query)
  const byPos = new Map<number, string[]>()
  for (const row of similar) {
    // Postgres and JavaScript lower-case some letters differently; a row that does not line up
    // with the query would respell the wrong word.
    if (words[row.pos - 1] !== row.word) continue
    byPos.set(row.pos, [...(byPos.get(row.pos) ?? []), row.alternative])
  }
  const positions = [...byPos.keys()].sort((a, b) => a - b)
  const depth = Math.max(0, ...[...byPos.values()].map(alternatives => alternatives.length))
  const out = [words.join(' ')]
  for (let rank = 0; rank < depth; rank++) {
    for (const pos of positions) {
      const alternative = byPos.get(pos)![rank]
      if (alternative === undefined) continue
      const respelled = words.with(pos - 1, alternative).join(' ')
      if (!out.includes(respelled)) out.push(respelled)
    }
  }
  return out.slice(0, max)
}

// Asks Jev which spelling the user meant: the query as typed or one of the respellings. A
// respelling becomes a suggestion only at suggestAt or above. Every failure suggests nothing.
export async function checkSpelling(
  query: string,
  similar: SimilarWord[],
  options: SpellingOptions = {},
): Promise<SpellingResult> {
  const suggestAt = options.suggestAt ?? 0.6
  const ask = options.ask ?? ((request: JevRequest) => askJev(request))
  const spelled = spellings(query, similar, options.maxOptions)
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
    const response = await ask(buildSpellingRequest(query, spelled, options.note))
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
      suggestion: best > 0 && p >= suggestAt ? spelled[best] : null,
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

function buildSpellingRequest(query: string, spelled: string[], note = 'A user typed `query` into a product search box.'): JevRequest {
  const criteria: Record<string, string> = {}
  spelled.forEach((s, i) => (criteria[`s${i}`] = `"${s}"`))
  return {
    state: { query, note },
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
