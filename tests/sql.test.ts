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

async function query(q: string, filters: object = {}, lim: number | null = 50) {
  const { rows } = await pool.query<{ id: string; step: string; pos: number }>(
    'SELECT id, step, pos FROM search.query($1, $2::jsonb, $3) ORDER BY pos',
    [q, JSON.stringify(filters), lim],
  )
  return rows
}

const ids = (rows: { id: string }[]) => rows.map(r => r.id)
const steps = (rows: { step: string }[]) => [...new Set(rows.map(r => r.step))]

describe('search.query', () => {
  test('word step puts an exact name first, then orders by rank', async () => {
    const rows = await query('cheerios')
    assert.deepEqual(ids(rows), ['3', '1', '2'])
    assert.deepEqual(steps(rows), ['word'])
  })

  test('a later step never adds rows to an earlier one', async () => {
    // "Cheerioz Oat Rings" is close enough for the typo step, so it would show up if steps mixed.
    const { rows } = await pool.query(
      "SELECT word_similarity('cheerios', name) >= 0.5 AS close FROM search.documents WHERE id = '10'",
    )
    assert.equal(rows[0].close, true)
    assert.ok(!ids(await query('cheerios')).includes('10'))
  })

  test('prefix step runs when no whole word matches', async () => {
    const rows = await query('straw')
    assert.deepEqual(ids(rows), ['5', '4'])
    assert.deepEqual(steps(rows), ['prefix'])
  })

  test('prefix step matches unstemmed words and skips stop words', async () => {
    // "chocolate" is stored stemmed as "chocol", so this partial word only matches unstemmed.
    assert.deepEqual(ids(await query('chocolat')), ['8', '6'])
    assert.deepEqual(ids(await query('the straw')), ['5', '4'])
  })

  test('typo step runs when nothing else matches', async () => {
    const rows = await query('cheerois')
    assert.deepEqual(steps(rows), ['typo'])
    assert.deepEqual(ids(rows).sort(), ['1', '10', '2', '3'])
    assert.deepEqual(ids(await query('stawberry jam')), ['4'])
  })

  test('code step ignores leading zeros on both sides', async () => {
    const rows = await query('016000275287')
    assert.deepEqual(ids(rows), ['1'])
    assert.deepEqual(steps(rows), ['code'])
    assert.deepEqual(ids(await query('0016000')), ['2', '1', '3'])
  })

  test('digits that match no code fall through to the text steps', async () => {
    assert.ok(!steps(await query('9999')).includes('code'))
  })

  test('filters apply in every step', async () => {
    assert.deepEqual(ids(await query('milk', { category: 'Dairy' })), ['7', '6', '12'])
    assert.deepEqual(ids(await query('cheerois', { brand: 'Store Brand' })), ['10'])
  })

  test('an exact name beats a higher rank', async () => {
    assert.deepEqual(ids(await query('Häagen-Dazs Vanilla')), ['9', '11'])
  })

  test('lim is clamped, and NULL returns every match', async () => {
    assert.equal((await query('milk', {}, null)).length, 4)
    assert.equal((await query('milk', {}, 0)).length, 1)
    assert.equal((await query('milk', {}, 2)).length, 2)
  })

  test('empty, punctuation-only, and stop-word queries return nothing', async () => {
    for (const q of ['', '   ', '!!!', 'the']) assert.deepEqual(await query(q), [])
  })
})
