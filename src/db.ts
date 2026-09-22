import pg from 'pg'

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/search_demo'

export function connect(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  return new pg.Pool({ connectionString: url })
}
