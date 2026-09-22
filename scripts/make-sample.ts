// Writes a fixed subset of the loaded products to data/sample.csv.gz.
//   node scripts/make-sample.ts [rows]
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { to as copyTo } from 'pg-copy-streams'
import { connect } from '../src/db.ts'

const rows = Number(process.argv[2] ?? 100000)
if (!Number.isInteger(rows) || rows <= 0) throw new Error('rows must be a positive integer')

const pool = connect()
const client = await pool.connect()
try {
  // Ordering by a hash of the barcode picks the same subset on every run.
  const statement = `COPY (
      SELECT gtin_upc, description, brand_name, brand_owner, category, modified_date
      FROM products
      ORDER BY md5(gtin_upc)
      LIMIT ${rows}
    ) TO STDOUT WITH (FORMAT csv, HEADER true)`
  await pipeline(
    client.query(copyTo(statement)),
    createGzip({ level: 9 }),
    createWriteStream(fileURLToPath(new URL('../data/sample.csv.gz', import.meta.url))),
  )
} finally {
  client.release()
  await pool.end()
}
