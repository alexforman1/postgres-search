// Loads the demo data and builds the search objects.
//   node scripts/load.ts          load data/sample.csv.gz
//   node scripts/load.ts --full   download and load the full USDA release
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import type pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { connect } from '../src/db.ts'

const RELEASE = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_csv_2025-12-18.zip'
const PRODUCT_COLUMNS = 'gtin_upc, description, brand_name, brand_owner, category, modified_date'

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const sql = (name: string) => readFile(root(`sql/${name}`), 'utf8')

async function copyInto(client: pg.PoolClient, statement: string, source: Readable): Promise<void> {
  await pipeline(source, client.query(copyFrom(statement)))
}

async function loadSample(client: pg.PoolClient): Promise<void> {
  await copyInto(
    client,
    `COPY products (${PRODUCT_COLUMNS}) FROM STDIN WITH (FORMAT csv, HEADER true)`,
    createReadStream(root('data/sample.csv.gz')).pipe(createGunzip()),
  )
}

async function loadRelease(client: pg.PoolClient): Promise<void> {
  const dir = root('data/usda')
  const zip = `${dir}/branded.zip`
  await mkdir(dir, { recursive: true })
  if (!existsSync(zip)) {
    console.log(`downloading ${RELEASE}`)
    const res = await fetch(RELEASE)
    if (!res.ok || !res.body) throw new Error(`download failed with status ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip))
  }
  execFileSync('unzip', ['-j', '-o', zip, '*/branded_food.csv', '*/food.csv', '-d', dir], { stdio: 'inherit' })

  await client.query(await sql('demo/usda-staging.sql'))
  for (const [table, file] of [['usda_branded_food', 'branded_food.csv'], ['usda_food', 'food.csv']]) {
    console.log(`copying ${file}`)
    await copyInto(client, `COPY ${table} FROM STDIN WITH (FORMAT csv, HEADER true)`, createReadStream(`${dir}/${file}`))
  }
  console.log('keeping the newest record for each barcode')
  await client.query(await sql('demo/usda-import.sql'))
}

const pool = connect()
const client = await pool.connect()
try {
  await client.query('DROP SCHEMA IF EXISTS search CASCADE')
  await client.query('DROP TABLE IF EXISTS products')
  await client.query(await sql('demo/usda.sql'))
  if (process.argv.includes('--full')) await loadRelease(client)
  else await loadSample(client)
  console.log('building search objects')
  await client.query(await sql('schema.sql'))
  await client.query(await sql('functions.sql'))
  const { rows } = await client.query('SELECT count(*)::int AS n FROM search.documents')
  console.log(`${rows[0].n} products searchable`)
} finally {
  client.release()
  await pool.end()
}
