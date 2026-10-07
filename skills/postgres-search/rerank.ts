const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

// Picks one option. criteria maps each option id to its description.
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export interface JevRequest {
  state: unknown
  questions: Record<string, NoulQuestion | ChoiceQuestion>
}

export interface JevAnswer {
  type: string
  noul?: number
  choice?: string
  probabilities?: Record<string, number>
}

export interface JevResponse {
  // The versioned model that answered, even when the request named an alias such as jev-latest.
  model: string
  answers: Record<string, JevAnswer>
  // TypeSafe bills input tokens only.
  usage?: { input_tokens: number; output_tokens: number }
}

export interface JevOptions {
  apiKey?: string
  model?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

// One request and no retries: a results page cannot wait for a retry. Every failure throws, and
// the caller keeps its own order.
export async function askJev(request: JevRequest, options: JevOptions = {}): Promise<JevResponse> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set')
  const send = options.fetch ?? fetch
  const res = await send(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? process.env.JEV_MODEL ?? 'jev-latest', ...request }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
  })
  if (!res.ok) throw new Error(`Jev returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as JevResponse
}

// The same split as search.tokens in sql/schema.sql.
export function tokens(q: string): string[] {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}

// The phrase's words in order, from the start of a word of text, ignoring accents and the spaces
// and punctuation between words: "almond milk" is in ALMONDMILK, "hellmanns" in HELLMANN'S,
// "jalapeno" in JALAPEÑO and "strawb" in STRAWBERRY.
export function carries(text: string, phrase: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')
  const target = tokens(fold(phrase)).join('')
  const words = tokens(fold(text))
  return target !== '' && words.some((_, i) => words.slice(i).join('').startsWith(target))
}

export interface Candidate {
  id: string
  name: string
  name_key: string
  other_names: string | null
  group_key: string | null
  facets: Record<string, string>
}

export interface RerankResult<T> {
  results: T[]
  sunk: T[]
  reranked: boolean
  // Jev scored every candidate below the threshold and none carries the typed words. The results
  // stay; the page can say that none of them matches.
  noMatch: boolean
  // Jev's score for each of the top candidates, in their original order; empty when it did not run.
  scores: number[]
  ms: number
  error?: string
  model?: string
  inputTokens?: number
}

export interface RerankOptions {
  top?: number
  threshold?: number
  ask?: (request: JevRequest) => Promise<JevResponse>
}

// Asks Jev whether each of the top results is what the user meant, then moves the ones it rejects
// to the bottom of the top. It never sorts by score: a real match scores near 1 whether it is the
// best match or a close variant, so sorting would reshuffle good results on noise.
export async function rerank<T extends Candidate>(
  query: string,
  results: T[],
  options: RerankOptions = {},
): Promise<RerankResult<T>> {
  const top = options.top ?? 10
  const threshold = options.threshold ?? thresholdFromEnv()
  const ask = options.ask ?? ((request: JevRequest) => askJev(request))
  const head = results.slice(0, top)
  const tail = results.slice(top)
  const unchanged = (ms: number, error?: string): RerankResult<T> => ({
    results,
    sunk: [],
    reranked: false,
    noMatch: false,
    scores: [],
    ms,
    error,
  })

  // Every comparison with NaN is false, which would drop every candidate from both lists.
  if (!Number.isFinite(threshold)) return unchanged(0, 'threshold is not a number')

  // Jev helps choose between different things. When every candidate is the same thing, its scores
  // differ only by noise, so the call is skipped.
  const groups = new Set(head.map(r => r.group_key ?? r.name_key))
  if (head.length < 2 || groups.size < 2) return unchanged(0)

  const started = Date.now()
  try {
    const response = await ask(buildRerankRequest(query, head))
    const scores = head.map((_, i) => response.answers[`c${i}`]?.noul)
    if (scores.some(s => typeof s !== 'number')) return unchanged(Date.now() - started, 'incomplete answer')
    const keep = head.filter((_, i) => (scores[i] as number) >= threshold)
    const sunk = head.filter((_, i) => (scores[i] as number) < threshold)
    return {
      results: [...keep, ...sunk, ...tail],
      sunk,
      reranked: true,
      noMatch: keep.length === 0 && !head.some(c => carriesQuery(c, query)),
      scores: scores as number[],
      ms: Date.now() - started,
      model: response.model,
      inputTokens: response.usage?.input_tokens,
    }
  } catch (err) {
    return unchanged(Date.now() - started, err instanceof Error ? err.message : String(err))
  }
}

// Jev judges products, so it scores low every product of a brand typed alone ("general mills") and
// of an unfinished word ("strawb"); results that carry the typed words still match what was typed.
function carriesQuery(c: Candidate, query: string): boolean {
  return carries(c.name, query) || carries(c.other_names ?? '', query)
}

function thresholdFromEnv(): number {
  const raw = process.env.JEV_THRESHOLD
  return raw === undefined || raw.trim() === '' ? 0.3 : Number(raw)
}

function buildRerankRequest(query: string, candidates: Candidate[]): JevRequest {
  const questions: JevRequest['questions'] = {}
  candidates.forEach((_, i) => {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Is candidate ${i} what the user was looking for?`,
      criteria: {
        true: `Candidate ${i} is the product the query names or describes, allowing for typos and abbreviations.`,
        false: `Candidate ${i} only shares letters or a word with the query, or is a different product.`,
      },
    }
  })
  return {
    state: {
      query,
      note: 'A user typed the query into a product search box. Each candidate is a record the search returned.',
      candidates: candidates.map((c, i) => ({ index: i, name: c.name, other_names: c.other_names, facets: c.facets })),
    },
    questions,
  }
}

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
