// The same split as search.tokens in sql/schema.sql.
export function tokens(q: string): string[] {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}
