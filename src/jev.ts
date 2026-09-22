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
