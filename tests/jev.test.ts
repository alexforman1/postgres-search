import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askJev, type JevRequest } from '../src/jev.ts'

const request: JevRequest = { state: { query: 'oreo' }, questions: { c0: { type: 'noul', instructions: 'Is it?' } } }

test('sends the key, model, state, and questions', async () => {
  let url = ''
  let init: RequestInit = {}
  const fake: typeof fetch = async (input, options) => {
    url = String(input)
    init = options ?? {}
    return Response.json({ model: 'jev-test', answers: { c0: { type: 'noul', noul: 0.9 } } })
  }
  const response = await askJev(request, { apiKey: 'key', model: 'jev-latest', fetch: fake })
  assert.equal(response.answers.c0.noul, 0.9)
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer key')
  assert.deepEqual(JSON.parse(String(init.body)), { model: 'jev-latest', ...request })
})

test('throws without a key', async () => {
  await assert.rejects(askJev(request, { apiKey: '' }), /TYPESAFE_API_KEY/)
})

test('throws on a network error', async () => {
  const fake: typeof fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(askJev(request, { apiKey: 'key', fetch: fake }), /fetch failed/)
})

test('throws on an error status', async () => {
  const fake: typeof fetch = async () => new Response('slow down', { status: 429 })
  await assert.rejects(askJev(request, { apiKey: 'key', fetch: fake }), /429/)
})

test('throws when the request outlasts the timeout', async () => {
  const fake: typeof fetch = (_input, options) =>
    new Promise((_resolve, reject) => {
      // AbortSignal.timeout does not keep the process alive by itself; this timer does.
      const alive = setTimeout(() => {}, 1000)
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(alive)
        reject(options.signal?.reason)
      })
    })
  await assert.rejects(askJev(request, { apiKey: 'key', timeoutMs: 20, fetch: fake }), { name: 'TimeoutError' })
})
