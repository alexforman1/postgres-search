import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JevRequest, JevResponse } from '../src/jev.ts'
import { checkSpelling, spellings, type SimilarWord } from '../src/spelling.ts'
import { tokens } from '../src/tokens.ts'

function similar(pos: number, word: string, ...alternatives: string[]): SimilarWord[] {
  return alternatives.map((alternative, i) => ({ pos, word, word_matches: 1, alternative, alternative_matches: 3000 - i }))
}

// A stand-in for Jev that gives each spelling option the given probability.
function answering(probabilities: Record<string, number> | undefined) {
  const calls: JevRequest[] = []
  const ask = async (request: JevRequest): Promise<JevResponse> => {
    calls.push(request)
    return {
      model: 'jev-test',
      answers: probabilities ? { meant: { type: 'choice', probabilities } } : {},
      usage: { input_tokens: 450, output_tokens: 10 },
    }
  }
  return { ask, calls }
}

const tortila = [...similar(1, 'tortila', 'tortilla', 'tortilas'), ...similar(2, 'chips', 'chip')]

test('tokens splits like search.tokens', () => {
  assert.deepEqual(tokens('  Häagen-Dazs S.Pellegrino, 2.5OZ!! '), ['häagen', 'dazs', 's', 'pellegrino', '2', '5oz'])
  assert.deepEqual(tokens('!!! ...'), [])
})

test('spellings lists the query as typed, then each word respelled, closest alternatives first', () => {
  assert.deepEqual(spellings('Tortila Chips', tortila), [
    'tortila chips',
    'tortilla chips',
    'tortila chip',
    'tortilas chips',
  ])
})

test('spellings keeps at most max options', () => {
  assert.deepEqual(spellings('tortila chips', tortila, 2), ['tortila chips', 'tortilla chips'])
})

test('spellings skips a row whose word is not the query word at that position', () => {
  assert.deepEqual(spellings('tortila chips', similar(2, 'tortila', 'tortilla')), ['tortila chips'])
})

test('suggests the respelling Jev picks at or above the bar', async () => {
  const { ask, calls } = answering({ s0: 0.25, s1: 0.7, s2: 0.03, s3: 0.02 })
  const out = await checkSpelling('tortila chips', tortila, { ask })
  assert.equal(out.suggestion, 'tortilla chips')
  assert.equal(out.p, 0.7)
  assert.equal(out.ran, true)
  assert.equal(calls.length, 1)
  const question = calls[0].questions.meant
  assert.equal(question.type, 'choice')
  assert.deepEqual(question.type === 'choice' && question.criteria, {
    s0: '"tortila chips", exactly as typed. The search finds tortila in 1 product and chips in 1 product.',
    s1: '"tortilla chips", 1 edit from what was typed. The search finds tortilla in 3,000 products.',
    s2: '"tortila chip", 1 edit from what was typed. The search finds chip in 3,000 products.',
    s3: '"tortilas chips", 1 edit from what was typed. The search finds tortilas in 2,999 products.',
  })
  assert.equal((calls[0].state as { query: string }).query, 'tortila chips')
})

test('returns the probability of every option in option order', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 0.25, s1: 0.7, s2: 0.03 }))
  assert.deepEqual(out.probabilities, [0.25, 0.7, 0.03, 0])
})

test('suggests nothing when the spelling as typed wins', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 0.86, s1: 0.14, s2: 0, s3: 0 }))
  assert.equal(out.suggestion, null)
  assert.equal(out.ran, true)
})

test('suggests nothing unless the respelling is twice as likely as the spelling typed', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 0.45, s1: 0.55, s2: 0, s3: 0 }))
  assert.equal(out.suggestion, null)
  assert.equal(out.p, 0.55)
})

test('suggests a respelling the probability splits with others, when it is twice the typed one', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 0.15, s1: 0.4, s2: 0.3, s3: 0.15 }))
  assert.equal(out.suggestion, 'tortilla chips')
})

test('suggests nothing under the floor, however small the typed spelling', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 0.1, s1: 0.28, s2: 0.27, s3: 0.35 }))
  assert.equal(out.suggestion, 'tortilas chips')
  const low = await checkSpelling('tortila chips', tortila, answering({ s0: 0.1, s1: 0.29, s2: 0.29, s3: 0.29 }))
  assert.equal(low.suggestion, null)
})

test('ratio and suggestAt set the rule', async () => {
  const out = await checkSpelling('tortila chips', tortila, {
    ...answering({ s0: 0.45, s1: 0.55, s2: 0, s3: 0 }),
    ratio: 1,
    suggestAt: 0.5,
  })
  assert.equal(out.suggestion, 'tortilla chips')
})

test('skips the call when no word has a close spelling', async () => {
  const { ask, calls } = answering({})
  const out = await checkSpelling('oreo', [], { ask })
  assert.equal(calls.length, 0)
  assert.equal(out.ran, false)
  assert.equal(out.suggestion, null)
})

test('counts a swap of two neighboring letters as one edit', async () => {
  const { ask, calls } = answering({ s0: 1 })
  await checkSpelling('dortios', [...similar(1, 'dortios', 'doritos'), ...similar(1, 'dortios', 'dorados')], { ask })
  const question = calls[0].questions.meant
  const criteria = question.type === 'choice' ? question.criteria : {}
  assert.match(criteria.s1, /"doritos", 1 edit from/)
  assert.match(criteria.s2, /"dorados", 2 edits from/)
})

test('tells Jev what the counts mean', async () => {
  const { ask, calls } = answering({ s0: 1 })
  await checkSpelling('tortila chips', tortila, { ask })
  assert.match((calls[0].state as { evidence: string }).evidence, /how many of the catalog's products the search finds/)
})

test('sends the note that describes the catalog', async () => {
  const { ask, calls } = answering({ s0: 1 })
  await checkSpelling('tortila chips', tortila, { ask, note: 'A user typed `query` into a grocery search box.' })
  assert.equal((calls[0].state as { note: string }).note, 'A user typed `query` into a grocery search box.')
})

test('suggests nothing when Jev fails', async () => {
  const ask = async (): Promise<JevResponse> => {
    throw new Error('connection refused')
  }
  const out = await checkSpelling('tortila chips', tortila, { ask })
  assert.equal(out.suggestion, null)
  assert.equal(out.ran, false)
  assert.equal(out.error, 'connection refused')
})

test('suggests nothing when the answer has no probabilities', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering(undefined))
  assert.equal(out.suggestion, null)
  assert.equal(out.ran, false)
  assert.equal(out.error, 'incomplete answer')
})

test('reports the model that answered and the input tokens it billed', async () => {
  const out = await checkSpelling('tortila chips', tortila, answering({ s0: 1 }))
  assert.equal(out.model, 'jev-test')
  assert.equal(out.inputTokens, 450)
})

const healht: SimilarWord[] = [
  { pos: 1, word: 'healht', word_matches: 0, word_example: null, alternative: 'healhty', alternative_matches: 1, completes: true },
  { pos: 1, word: 'healht', word_matches: 0, word_example: null, alternative: 'health', alternative_matches: 1532 },
]

test('an option that finishes the typed word counts with the spelling typed', async () => {
  // health is likelier than either alone, but not twice as likely as the two together.
  const kept = await checkSpelling('healht', healht, answering({ s0: 0.05, s1: 0.4, s2: 0.55 }))
  assert.equal(kept.suggestion, null)
  const fixed = await checkSpelling('healht', healht, answering({ s0: 0.01, s1: 0.04, s2: 0.95 }))
  assert.equal(fixed.suggestion, 'health')
  // Choosing the completion suggests nothing: the prefix step already shows it.
  assert.equal((await checkSpelling('healht', healht, answering({ s0: 0.01, s1: 0.98, s2: 0.01 }))).suggestion, null)
})

test('tells Jev which option finishes the typed word, and names a product that uses the word typed', async () => {
  const { ask, calls } = answering({ s0: 0.9, s1: 0.1 })
  await checkSpelling('healht', healht, { ask })
  const healhtQuestion = calls[0].questions.meant
  assert.equal(healhtQuestion.type === 'choice' && healhtQuestion.criteria.s1, '"healhty", what was typed, finished. The search finds healhty in 1 product.')
  const salada: SimilarWord[] = [
    { pos: 1, word: 'salada', word_matches: 87, word_example: 'SALADA GREEN TEA', alternative: 'salad', alternative_matches: 9000 },
  ]
  await checkSpelling('salada', salada, { ask })
  const saladaQuestion = calls[1].questions.meant
  assert.equal(
    saladaQuestion.type === 'choice' && saladaQuestion.criteria.s0,
    '"salada", exactly as typed. The search finds salada in 87 products, such as SALADA GREEN TEA.',
  )
})
