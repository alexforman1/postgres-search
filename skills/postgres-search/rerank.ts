const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}

export interface JevRequest {
  state: unknown
  questions: Record<string, NoulQuestion>
}

export interface JevResponse {
  model: string
  answers: Record<string, { type: string; noul?: number }>
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
  ms: number
  error?: string
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
  const unchanged = (ms: number, error?: string): RerankResult<T> => ({ results, sunk: [], reranked: false, ms, error })

  // Every comparison with NaN is false, which would drop every candidate from both lists.
  if (!Number.isFinite(threshold)) return unchanged(0, 'threshold is not a number')

  // Jev helps choose between different things. When every candidate is the same thing, its scores
  // differ only by noise, so the call is skipped.
  const groups = new Set(head.map(r => r.group_key ?? r.name_key))
  if (head.length < 2 || groups.size < 2) return unchanged(0)

  const started = Date.now()
  try {
    const response = await ask(buildRequest(query, head))
    const scores = head.map((_, i) => response.answers[`c${i}`]?.noul)
    if (scores.some(s => typeof s !== 'number')) return unchanged(Date.now() - started, 'incomplete answer')
    const keep = head.filter((_, i) => (scores[i] as number) >= threshold)
    const sunk = head.filter((_, i) => (scores[i] as number) < threshold)
    return { results: [...keep, ...sunk, ...tail], sunk, reranked: true, ms: Date.now() - started }
  } catch (err) {
    return unchanged(Date.now() - started, err instanceof Error ? err.message : String(err))
  }
}

function thresholdFromEnv(): number {
  const raw = process.env.JEV_THRESHOLD
  return raw === undefined || raw.trim() === '' ? 0.3 : Number(raw)
}

function buildRequest(query: string, candidates: Candidate[]): JevRequest {
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
