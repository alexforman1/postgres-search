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
