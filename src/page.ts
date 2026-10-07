// The demo's results page: the search, then the Jev reorder, and at the same time the close-word
// lookup, then the spelling question. server.ts serves it; scripts/eval.ts and scripts/compare.ts
// measure the same code.
import type pg from 'pg'
import { rerank, type Candidate, type RerankResult } from './rerank.ts'
import { checkSpelling, type SimilarWord, type SpellingResult } from './spelling.ts'

// Tells the spelling question what the demo searches.
export const NOTE = 'A user typed `query` into the search box of a grocery and packaged food product search.'

export interface Row extends Candidate {
  step: string
}

export interface Page {
  rows: Row[]
  searchMs: number
  pageMs: number
  reranked?: RerankResult<Row>
  spelling?: SpellingResult
}

export async function search(pool: pg.Pool, q: string, filters: Record<string, string> = {}): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
       FROM search.query_distinct($1, $2::jsonb) r
       JOIN search.documents d ON d.id = r.id
      ORDER BY r.pos`,
    [q, JSON.stringify(filters)],
  )
  return rows
}

// A failed lookup means no suggestion, not a failed page.
export async function similarWords(pool: pg.Pool, q: string): Promise<SimilarWord[]> {
  try {
    return (await pool.query<SimilarWord>('SELECT * FROM search.similar_words($1)', [q])).rows
  } catch (err) {
    console.error('similar_words failed:', err instanceof Error ? err.message : err)
    return []
  }
}

// The spelling question depends only on the words, so a filter click, which repeats the search
// with the same words, does not ask it again.
export async function page(
  pool: pg.Pool,
  q: string,
  { filters = {}, withJev }: { filters?: Record<string, string>; withJev: boolean },
): Promise<Page> {
  const started = performance.now()
  let searchMs = 0
  const [first, spelling] = await Promise.all([
    search(pool, q, filters).then(async rows => {
      searchMs = performance.now() - started
      return { rows, reranked: withJev ? await rerank(q, rows) : undefined }
    }),
    withJev && Object.keys(filters).length === 0
      ? similarWords(pool, q).then(similar => checkSpelling(q, similar, { note: NOTE }))
      : undefined,
  ])
  return { ...first, spelling, searchMs, pageMs: performance.now() - started }
}
