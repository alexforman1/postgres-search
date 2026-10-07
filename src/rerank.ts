import { askJev, type JevRequest, type JevResponse } from './jev.ts'
import { carries } from './tokens.ts'

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
