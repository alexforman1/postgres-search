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

describe('search.tokens', () => {
  test('lower-cases and splits on anything that is not a letter or digit', async () => {
    const tokens = async (q: string | null) => (await pool.query('SELECT search.tokens($1) AS t', [q])).rows[0].t
    assert.deepEqual(await tokens('  Häagen-Dazs S.Pellegrino, 2.5OZ!! '), ['häagen', 'dazs', 's', 'pellegrino', '2', '5oz'])
    assert.deepEqual(await tokens('Lemon/Lime'), ['lemon', 'lime'])
    for (const q of [null, '', '   ', '!!! ...']) assert.deepEqual(await tokens(q), [])
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

  test('word and prefix steps find words joined by a slash or a dot', async () => {
    // Postgres's parser reads "Lemon/Lime" as a file path and "Cran.Apple" as a host name.
    for (const [q, id] of [['lime', '17'], ['lemon', '17'], ['apple', '18']]) {
      const rows = await query(q)
      assert.deepEqual(ids(rows), [id])
      assert.deepEqual(steps(rows), ['word'])
    }
    const rows = await query('lim')
    assert.deepEqual(ids(rows), ['17'])
    assert.deepEqual(steps(rows), ['prefix'])
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

  test('prefix step accepts short words next to a longer one, but not alone', async () => {
    assert.deepEqual(ids(await query('straw j')), ['4'])
    assert.deepEqual(ids(await query('whole mi')), ['7', '12'])
    assert.ok(!steps(await query('ch')).includes('prefix'))
  })

  test('typo step runs when nothing else matches', async () => {
    const rows = await query('cheerois')
    assert.deepEqual(steps(rows), ['typo'])
    assert.deepEqual(ids(rows).sort(), ['1', '10', '2', '3'])
    assert.deepEqual(ids(await query('stawberry jam')), ['4'])
    assert.deepEqual(ids(await query('the cheerois')).sort(), ['1', '10', '2', '3'])
  })

  test('code step ignores leading zeros on both sides', async () => {
    const rows = await query('016000275287')
    assert.deepEqual(ids(rows), ['1'])
    assert.deepEqual(steps(rows), ['code'])
    assert.deepEqual(ids(await query('0016000')), ['2', '1', '3'])
  })

  test('code step does not fall through when it matches', async () => {
    // Row 13 has "16000" in its name, so the word step would add it if steps mixed.
    const rows = await query('16000')
    assert.deepEqual(ids(rows), ['2', '1', '3'])
    assert.deepEqual(steps(rows), ['code'])
  })

  test('digits that match no code fall through to the text steps', async () => {
    assert.ok(!steps(await query('9999')).includes('code'))
  })

  test('filters apply in every step', async () => {
    assert.deepEqual(await query('0016000', { category: 'Spreads' }), [])
    assert.deepEqual(ids(await query('milk', { category: 'Dairy' })), ['7', '6', '12'])
    assert.deepEqual(ids(await query('straw', { category: 'Produce' })), ['5'])
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
    for (const q of ['', '   ', '!!!', 'the', 'and', 'the and']) assert.deepEqual(await query(q), [])
  })

  test('long input is cut to 256 characters and 32 words', async () => {
    assert.deepEqual(await query('milk '.repeat(32) + 'chocolate'), await query('milk'))
    assert.deepEqual(await query('milk' + ' '.repeat(260) + 'chocolate'), await query('milk'))
  })

  test('plans are made for each call, not cached', async () => {
    // A cached generic plan scans the whole facets index when filters is empty.
    const { rows } = await pool.query(
      "SELECT proconfig FROM pg_proc WHERE oid = 'search.query(text, jsonb, int)'::regprocedure",
    )
    assert.ok(rows[0].proconfig.includes('plan_cache_mode=force_custom_plan'))
  })
})

describe('search.query_distinct', () => {
  test('returns one row per group, at the position of its best row', async () => {
    const byPos = async (q: string) =>
      (await pool.query('SELECT id FROM search.query_distinct($1) ORDER BY pos', [q])).rows.map(r => r.id)
    // Row 12 has the same name as row 7, so it folds into it.
    assert.deepEqual(await byPos('milk'), ['8', '7', '6'])
    // The fixture gives every Cheerios row the same group_key.
    assert.deepEqual(await byPos('cheerios'), ['3'])
  })
})

async function suggest(q: string) {
  const { rows } = await pool.query<{ name: string; id: string; doc_count: number }>(
    'SELECT name, id, doc_count FROM search.suggest($1)',
    [q],
  )
  return rows
}

describe('search.suggest', () => {
  test('names that start with the input come first, most common first', async () => {
    assert.deepEqual(await suggest('wh'), [
      { name: 'Whole Milk', id: '7', doc_count: 2 },
      { name: 'Wheat Thins', id: '14', doc_count: 1 },
    ])
    assert.deepEqual(
      (await suggest('chee')).slice(0, 3).map(s => s.name),
      ['Cheerios', 'Cheerios Cereal', 'Cheerioz Oat Rings'],
    )
  })

  test('under four characters, only names that start with the input are listed', async () => {
    assert.deepEqual(
      (await suggest('ch')).map(s => s.name),
      ['Cheerios', 'Cheerios Cereal', 'Cheerioz Oat Rings', 'Chocolate Milk'],
    )
  })

  test('three letters is still under the boundary', async () => {
    // With a fill, "che" would also offer Honey Nut Cheerios Cereal.
    assert.deepEqual(
      (await suggest('che')).map(s => s.name),
      ['Cheerios', 'Cheerios Cereal', 'Cheerioz Oat Rings'],
    )
  })

  test('several short words are under the boundary too', async () => {
    // The boundary counts the longest word, not the spaces between words.
    assert.deepEqual(await suggest('nd s'), [])
    assert.deepEqual(await suggest('ch s'), [])
  })

  test('search.query fills the rest in its own order, listing each name once', async () => {
    assert.deepEqual(
      (await suggest('chee')).map(s => s.name),
      ['Cheerios', 'Cheerios Cereal', 'Cheerioz Oat Rings', 'Honey Nut Cheerios Cereal'],
    )
    assert.deepEqual((await suggest('milk')).map(s => s.name), ['Milk Chocolate Bar', 'Whole Milk', 'Chocolate Milk'])
  })

  test('the fill stops at lim', async () => {
    const { rows } = await pool.query("SELECT name FROM search.suggest('milk', 2)")
    assert.deepEqual(rows.map(r => r.name), ['Milk Chocolate Bar', 'Whole Milk'])
  })

  test('a name that starts with the input beats a rare whole-word match', async () => {
    // "Peans" stems to "pean", so the word step alone would offer only the pie.
    assert.deepEqual(
      (await suggest('pean')).map(s => s.name),
      ['Peanut Butter', 'Sweet Potato Pie with Peans'],
    )
  })

  test('empty input returns nothing', async () => {
    assert.deepEqual(await suggest('  '), [])
  })

  test('plans are made for each call, not cached', async () => {
    // A cached generic plan cannot use the prefix range on search.names and scans all of it.
    const { rows } = await pool.query(
      "SELECT proconfig FROM pg_proc WHERE oid = 'search.suggest(text, int)'::regprocedure",
    )
    assert.ok(rows[0].proconfig.includes('plan_cache_mode=force_custom_plan'))
  })
})

describe('search.words', () => {
  test('counts each word once per product, and the products the word step finds for it', async () => {
    const { rows } = await pool.query(
      "SELECT word, doc_count, stem, match_count FROM search.words WHERE word IN ('cheerios', 'cheerioz', 'hershey', 'mills') ORDER BY word",
    )
    assert.deepEqual(rows, [
      { word: 'cheerios', doc_count: 3, stem: 'cheerio', match_count: 3 },
      { word: 'cheerioz', doc_count: 1, stem: 'cheerioz', match_count: 1 },
      { word: 'hershey', doc_count: 1, stem: 'hershey', match_count: 1 },
      { word: 'mills', doc_count: 3, stem: 'mill', match_count: 3 },
    ])
  })
})

interface Similar {
  pos: number
  word: string
  word_matches: number
  alternative: string
  alternative_matches: number
}

async function similarWords(q: string, perWord?: number) {
  const { rows } = await pool.query<Similar>(
    perWord === undefined
      ? 'SELECT pos, word, word_matches, alternative, alternative_matches FROM search.similar_words($1)'
      : 'SELECT pos, word, word_matches, alternative, alternative_matches FROM search.similar_words($1, $2)',
    perWord === undefined ? [q] : [q, perWord],
  )
  return rows
}

describe('search.similar_words', () => {
  test('lists words that products use and that are spelled close to a query word', async () => {
    assert.deepEqual(await similarWords('cheerois'), [
      { pos: 1, word: 'cheerois', word_matches: 0, alternative: 'cheerios', alternative_matches: 3 },
      { pos: 1, word: 'cheerois', word_matches: 0, alternative: 'cheerioz', alternative_matches: 1 },
    ])
  })

  test('finds words one edit away that share too few trigrams, such as a swap', async () => {
    assert.equal((await similarWords('mlik'))[0]?.alternative, 'milk')
  })

  test('counts what the search finds for the typed word, so a possessive is not a misspelling', async () => {
    assert.ok(!(await similarWords('hersheys')).some(r => r.alternative === 'hershey'))
    assert.equal(
      (await pool.query("SELECT word_matches FROM search.similar_words('cheerioz')")).rows[0].word_matches,
      1,
    )
  })

  test('never lists the typed word, and counts the products that use it', async () => {
    assert.deepEqual(await similarWords('cheerioz'), [
      { pos: 1, word: 'cheerioz', word_matches: 1, alternative: 'cheerios', alternative_matches: 3 },
    ])
  })

  test('gives each word of a longer query its own alternatives', async () => {
    const rows = await similarWords('whole milc')
    assert.deepEqual([...new Set(rows.map(r => r.pos))], [2])
    assert.equal(rows[0].alternative, 'milk')
  })

  test('skips words under four letters and words with digits', async () => {
    assert.deepEqual(await similarWords('oat'), [])
    assert.deepEqual(await similarWords('16001'), [])
    assert.deepEqual([...new Set((await similarWords('milc 16001 oat')).map(r => r.word))], ['milc'])
  })

  test('per_word keeps the closest alternatives, words one edit away first', async () => {
    assert.deepEqual((await similarWords('cheerois', 1)).map(r => r.alternative), ['cheerios'])
  })

  test('leaves out stop words, which search.query ignores', async () => {
    assert.deepEqual(await similarWords('with'), [])
  })

  test('offers only words the search finds in more products than the typed word', async () => {
    assert.deepEqual(await similarWords('cheerios'), [])
    assert.deepEqual((await similarWords('cheerioz')).map(r => r.alternative), ['cheerios'])
  })

  test('leaves out words that only finish the typed word, which the prefix step finds', async () => {
    assert.ok(!(await similarWords('cheeri')).some(r => r.alternative.startsWith('cheeri')))
  })

  test('leaves out words that share too few letters', async () => {
    assert.ok(!(await similarWords('cheerois')).some(r => r.alternative === 'cereal'))
    assert.deepEqual(await similarWords('zzzz'), [])
  })
})

describe('search.facets', () => {
  test('counts come from the rows search.query matched', async () => {
    const { rows } = await pool.query("SELECT facet, value, doc_count::int FROM search.facets('milk')")
    assert.deepEqual(rows, [
      { facet: 'brand', value: 'Horizon', doc_count: 2 },
      { facet: 'brand', value: 'Hershey', doc_count: 1 },
      { facet: 'brand', value: 'Organic Valley', doc_count: 1 },
      { facet: 'category', value: 'Dairy', doc_count: 3 },
      { facet: 'category', value: 'Candy', doc_count: 1 },
    ])
  })

  test('counts follow whichever step matched', async () => {
    const { rows } = await pool.query("SELECT facet, value, doc_count::int FROM search.facets('cheerois')")
    assert.deepEqual(rows, [
      { facet: 'brand', value: 'General Mills', doc_count: 3 },
      { facet: 'brand', value: 'Store Brand', doc_count: 1 },
      { facet: 'category', value: 'Cereal', doc_count: 4 },
    ])
  })

  test('filters narrow the counts', async () => {
    const { rows } = await pool.query(
      `SELECT facet, value, doc_count::int FROM search.facets('milk', '{"category": "Dairy"}')`,
    )
    assert.deepEqual(rows, [
      { facet: 'brand', value: 'Horizon', doc_count: 2 },
      { facet: 'brand', value: 'Organic Valley', doc_count: 1 },
      { facet: 'category', value: 'Dairy', doc_count: 3 },
    ])
  })

  test('per_facet keeps the top values of each facet', async () => {
    const top = [
      { facet: 'brand', value: 'Horizon' },
      { facet: 'category', value: 'Dairy' },
    ]
    assert.deepEqual((await pool.query("SELECT facet, value FROM search.facets('milk', '{}', 1)")).rows, top)
    assert.deepEqual((await pool.query("SELECT facet, value FROM search.facets('milk', '{}', 0)")).rows, top)
  })
})

describe('search.refresh', () => {
  test('makes new rows searchable in every view', async () => {
    await pool.query(
      "INSERT INTO fixture_items VALUES (15, 'Granola Clusters', 'Nature Valley', '016000123456', 'Cereal', 25)",
    )
    assert.deepEqual(await query('granola'), [])
    assert.deepEqual(await similarWords('granloa'), [])
    await pool.query('SELECT search.refresh()')
    assert.deepEqual(ids(await query('granola')), ['15'])
    assert.ok((await suggest('gr')).some(s => s.name === 'Granola Clusters'))
    assert.ok((await similarWords('granloa')).some(r => r.alternative === 'granola'))
  })

  test('facets skip JSON null values', async () => {
    await pool.query("INSERT INTO fixture_items VALUES (16, 'Plain Oats', NULL, '0123456789', 'Cereal', 1)")
    await pool.query('SELECT search.refresh()')
    const { rows } = await pool.query("SELECT facet, value, doc_count::int FROM search.facets('plain oats')")
    assert.deepEqual(rows, [{ facet: 'category', value: 'Cereal', doc_count: 1 }])
  })
})
