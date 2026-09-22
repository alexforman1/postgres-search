import pg from 'pg'

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/search_demo'

export function connect(config: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, ...config })
  // An idle client can lose its connection; without a listener that error would crash the process.
  pool.on('error', err => console.error('database connection error:', err.message))
  return pool
}
