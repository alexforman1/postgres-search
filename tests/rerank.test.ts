import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JevRequest, JevResponse } from '../src/jev.ts'
import { rerank, type Candidate } from '../src/rerank.ts'

function candidate(id: string, name: string, group_key: string | null = null): Candidate {
  return { id, name, name_key: name.toLowerCase(), other_names: null, group_key, facets: {} }
}

// A stand-in for Jev that returns the given scores and records each request.
function answering(scores: (number | undefined)[]) {
  const calls: JevRequest[] = []
  const ask = async (request: JevRequest): Promise<JevResponse> => {
    calls.push(request)
    const answers: JevResponse['answers'] = {}
    scores.forEach((noul, i) => {
      if (noul !== undefined) answers[`c${i}`] = { type: 'noul', noul }
    })
    return { model: 'jev-test', answers }
  }
  return { ask, calls }
}

const four = [
  candidate('a', 'Oreo Cookies'),
  candidate('b', 'Oregano'),
  candidate('c', 'Oreo Thins'),
  candidate('d', 'Ore-Ida Fries'),
]

test('moves candidates below the threshold to the bottom and keeps the rest in order', async () => {
  const { ask } = answering([0.9, 0.1, 0.8, 0.2])
  const out = await rerank('oreo', four, { ask, threshold: 0.3 })
  assert.deepEqual(out.results.map(r => r.id), ['a', 'c', 'b', 'd'])
  assert.deepEqual(out.sunk.map(r => r.id), ['b', 'd'])
  assert.equal(out.reranked, true)
})

test('asks one question per candidate in a single call', async () => {
  const { ask, calls } = answering([0.9, 0.9, 0.9, 0.9])
  await rerank('oreo', four, { ask })
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0].questions), ['c0', 'c1', 'c2', 'c3'])
  assert.equal((calls[0].state as { query: string }).query, 'oreo')
})

test('leaves results past the top untouched', async () => {
  const { ask } = answering([0.1, 0.9])
  const out = await rerank('oreo', four.slice(0, 3), { ask, top: 2, threshold: 0.3 })
  assert.deepEqual(out.results.map(r => r.id), ['b', 'a', 'c'])
})

test('skips the call when every candidate is the same thing', async () => {
  const { ask, calls } = answering([])
  const milk = [candidate('a', 'Whole Milk'), candidate('b', 'Whole Milk'), candidate('c', 'Whole Milk')]
  const out = await rerank('whole milk', milk, { ask })
  assert.equal(calls.length, 0)
  assert.equal(out.reranked, false)
})

test('uses group_key to decide sameness when it is set', async () => {
  const { ask, calls } = answering([])
  await rerank('oreo', [candidate('a', 'Oreo Cookies', 'oreo'), candidate('b', 'Oreo Thins', 'oreo')], { ask })
  assert.equal(calls.length, 0)
})

test('skips the call with fewer than two results', async () => {
  const { ask, calls } = answering([])
  await rerank('oreo', four.slice(0, 1), { ask })
  assert.equal(calls.length, 0)
})

test('keeps the original order when Jev fails', async () => {
  const ask = async (): Promise<JevResponse> => {
    throw new Error('connection refused')
  }
  const out = await rerank('oreo', four, { ask })
  assert.deepEqual(out.results, four)
  assert.equal(out.reranked, false)
  assert.equal(out.error, 'connection refused')
})

test('keeps the original order when an answer is missing', async () => {
  const { ask } = answering([0.9, undefined, 0.1, 0.9])
  const out = await rerank('oreo', four, { ask })
  assert.deepEqual(out.results, four)
  assert.equal(out.reranked, false)
})
