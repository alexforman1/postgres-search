import { readFile } from 'node:fs/promises'
import pg from 'pg'

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/search_test'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

// Creates the test database if needed, then rebuilds the fixture and the search schema.
export async function resetDatabase(): Promise<pg.Pool> {
  await createDatabaseIfMissing(TEST_DATABASE_URL)
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  await pool.query('DROP SCHEMA IF EXISTS search CASCADE')
  await pool.query('DROP TABLE IF EXISTS fixture_items')
  await pool.query(await read('fixture.sql'))
  await pool.query(await read('../sql/schema.sql'))
  await pool.query(await read('../sql/functions.sql'))
  return pool
}

async function createDatabaseIfMissing(url: string): Promise<void> {
  const target = new URL(url)
  const name = decodeURIComponent(target.pathname.slice(1))
  target.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: target.toString() })
  await admin.connect()
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`)
  } finally {
    await admin.end()
  }
}
