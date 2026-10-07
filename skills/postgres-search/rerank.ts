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
