// The demo's results page, outside the server, for scripts/eval.ts and scripts/compare.ts.
import type pg from 'pg'
import { rerank, type Candidate, type RerankResult } from '../src/rerank.ts'
import { checkSpelling, type SimilarWord, type SpellingResult } from '../src/spelling.ts'

// The note server.ts sends with the spelling question.
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

export async function search(pool: pg.Pool, q: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT d.id, d.name, d.name_key, d.other_names, d.group_key, d.facets, r.step
       FROM search.query_distinct($1) r JOIN search.documents d ON d.id = r.id
      ORDER BY r.pos`,
    [q],
  )
  return rows
}

export async function similarWords(pool: pg.Pool, q: string): Promise<SimilarWord[]> {
  return (await pool.query<SimilarWord>('SELECT * FROM search.similar_words($1)', [q])).rows
}

// What server.ts does: the search and then the Jev reorder, and alongside them the close-word
// lookup and then the spelling question. Without Jev, only the search runs.
export async function page(pool: pg.Pool, q: string, withJev: boolean): Promise<Page> {
  const started = performance.now()
  let searchMs = 0
  const [first, spelling] = await Promise.all([
    search(pool, q).then(async rows => {
      searchMs = performance.now() - started
      return { rows, reranked: withJev ? await rerank(q, rows) : undefined }
    }),
    withJev ? similarWords(pool, q).then(similar => checkSpelling(q, similar, { note: NOTE })) : undefined,
  ])
  return { ...first, spelling, searchMs, pageMs: performance.now() - started }
}
