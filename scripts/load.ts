// Loads the demo data and builds the search objects in the search_demo database.
//   node scripts/load.ts                  load data/sample.csv.gz
//   node scripts/load.ts --full           download and load the full USDA release
//   node scripts/load.ts --any-database   allow a database other than search_demo
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import type pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { connect } from '../src/db.ts'

// sql/demo/usda-staging.sql lists this release's CSV columns in order. COPY does not check
// column names, so recheck that file whenever this changes.
const RELEASE = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_csv_2025-12-18.zip'
const PRODUCT_COLUMNS = 'gtin_upc, description, brand_name, brand_owner, category, modified_date'

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const sql = (name: string) => readFile(root(`sql/${name}`), 'utf8')

// Downloads the release once and extracts the two files the demo uses. Returns their folder.
async function fetchRelease(): Promise<string> {
  const dir = root('data/usda')
  const zip = `${dir}/branded.zip`
  await mkdir(dir, { recursive: true })
  if (!existsSync(zip)) {
    console.log(`downloading ${RELEASE}`)
    const res = await fetch(RELEASE)
    if (!res.ok || !res.body) throw new Error(`download failed with status ${res.status}`)
    // Write to a temporary name so an interrupted download is never mistaken for a finished one.
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${zip}.part`))
    await rename(`${zip}.part`, zip)
  }
  execFileSync('unzip', ['-j', '-o', zip, '*/branded_food.csv', '*/food.csv', '-d', dir], { stdio: 'inherit' })
  return dir
}

async function loadSample(client: pg.PoolClient): Promise<void> {
  await pipeline(
    createReadStream(root('data/sample.csv.gz')),
    createGunzip(),
    client.query(copyFrom(`COPY products (${PRODUCT_COLUMNS}) FROM STDIN WITH (FORMAT csv, HEADER true)`)),
  )
}

async function loadRelease(client: pg.PoolClient, dir: string): Promise<void> {
  await client.query(await sql('demo/usda-staging.sql'))
  for (const [table, file] of [['usda_branded_food', 'branded_food.csv'], ['usda_food', 'food.csv']]) {
    console.log(`copying ${file}`)
    await pipeline(
      createReadStream(`${dir}/${file}`),
      client.query(copyFrom(`COPY ${table} FROM STDIN WITH (FORMAT csv, HEADER true)`)),
    )
  }
  console.log('keeping the newest record for each barcode')
  await client.query(await sql('demo/usda-import.sql'))
}

// A container started a moment ago may not accept connections yet.
async function connectWithRetry(pool: pg.Pool, attempts = 10): Promise<pg.PoolClient> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect()
    } catch (err) {
      if (attempt >= attempts) throw err
      await sleep(1000)
    }
  }
}

const full = process.argv.includes('--full')
const releaseDir = full ? await fetchRelease() : null

const pool = connect()
const client = await connectWithRetry(pool)
try {
  // The load drops tables, so refuse to run against some other project's database by accident.
  const { rows: [db] } = await client.query('SELECT current_database() AS name')
  if (db.name !== 'search_demo' && !process.argv.includes('--any-database')) {
    throw new Error(`refusing to replace tables in "${db.name}"; pass --any-database to allow it`)
  }
  // One transaction, so a failed load leaves the previous data in place.
  await client.query('BEGIN')
  await client.query('DROP SCHEMA IF EXISTS search CASCADE')
  await client.query('DROP TABLE IF EXISTS products')
  await client.query(await sql('demo/usda.sql'))
  if (releaseDir) await loadRelease(client, releaseDir)
  else await loadSample(client)
  console.log('building search objects')
  await client.query(await sql('schema.sql'))
  await client.query(await sql('functions.sql'))
  const { rows } = await client.query('SELECT count(*)::int AS n FROM search.documents')
  await client.query('COMMIT')
  console.log(`${rows[0].n} products searchable`)
} catch (err) {
  await client.query('ROLLBACK')
  throw err
} finally {
  client.release()
  await pool.end()
}
