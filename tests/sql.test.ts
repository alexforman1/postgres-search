import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type pg from 'pg'
import { resetDatabase } from './helpers.ts'

let pool: pg.Pool

before(async () => {
  pool = await resetDatabase()
})

after(async () => {
  await pool.end()
})

describe('search.documents', () => {
  test('stores a normalized name key and codes without leading zeros', async () => {
    const { rows } = await pool.query(
      "SELECT id, name_key, code FROM search.documents WHERE id IN ('3', '9') ORDER BY id",
    )
    assert.deepEqual(rows, [
      { id: '3', name_key: 'cheerios', code: '16000503687' },
      { id: '9', name_key: 'häagen dazs vanilla', code: '74570000014' },
    ])
  })
})
