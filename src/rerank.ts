import { askJev, type JevRequest, type JevResponse } from './jev.ts'

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
  const threshold = options.threshold ?? Number(process.env.JEV_THRESHOLD ?? 0.3)
  const ask = options.ask ?? ((request: JevRequest) => askJev(request))
  const head = results.slice(0, top)
  const tail = results.slice(top)
  const unchanged = (ms: number, error?: string): RerankResult<T> => ({ results, sunk: [], reranked: false, ms, error })

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
