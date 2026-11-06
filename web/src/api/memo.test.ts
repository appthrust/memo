import { beforeEach, describe, expect, test } from 'bun:test'
import { memoRoutes } from '../dev/mock-memo'
import { createMemoApi, isMemoError, MemoApiError } from './memo'
import { retryQuery } from './queries'

type Call = { input: string; init: RequestInit }

/** The client wired to the in-repo mock, recording every request it sends. */
function mockApi() {
  const calls: Call[] = []
  const api = createMemoApi(async (input, init) => {
    calls.push({ input, init })
    const url = new URL(input, 'http://memo.test')
    return (await memoRoutes(new Request(url, init), url)) ?? new Response(null, { status: 404 })
  }, () => false)
  return { api, calls }
}

async function rejection(promise: Promise<unknown>): Promise<MemoApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof MemoApiError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

beforeEach(async () => {
  const url = new URL('http://memo.test/api/memo/v1/__mock/reset')
  await memoRoutes(new Request(url, { method: 'POST' }), url)
})

describe('memo API client', () => {
  test('reads go to same-origin /api/memo/v1 without any token, with only the set timeline parameters', async () => {
    const { api, calls } = mockApi()
    const me = await api.me()
    const page = await api.articles.list({ limit: 5, following: true })
    await api.articles.list({ cursor: page.nextCursor, author: me.author.id })
    expect(calls.map((call) => call.input)).toEqual([
      '/api/memo/v1/me',
      '/api/memo/v1/articles?limit=5&following=true',
      `/api/memo/v1/articles?cursor=${encodeURIComponent(page.nextCursor!)}&author=${me.author.id}`,
    ])
    for (const call of calls) {
      expect(call.init.credentials).toBe('same-origin')
      expect(new Headers(call.init.headers).has('Authorization')).toBe(false)
    }
  })

  test('writes send JSON; deletes answer 204 without a body', async () => {
    const { api, calls } = mockApi()
    const article = await api.articles.create({ title: '下書き', body: '本文' })
    expect(calls.at(-1)?.init).toMatchObject({ method: 'POST', body: JSON.stringify({ title: '下書き', body: '本文' }) })
    expect(new Headers(calls.at(-1)?.init.headers).get('Content-Type')).toBe('application/json')
    expect((await api.articles.update(article.id, { status: 'published' })).status).toBe('published')
    expect(await api.articles.like(article.id)).toEqual({ likeCount: 1, likedByMe: true })
    expect(await api.articles.remove(article.id)).toBeUndefined()
    expect(calls.at(-1)?.init.method).toBe('DELETE')
  })

  test('errors keep the server code; unanswered calls are transient and retried, answers are final', async () => {
    const { api } = mockApi()
    const me = await api.me()
    const selfFollow = await rejection(api.authors.follow(me.author.id))
    expect(selfFollow).toMatchObject({ status: 400, code: 'self_follow', transient: false })
    expect(isMemoError(await rejection(api.articles.get('missing')), 'not_found')).toBe(true)
    expect(retryQuery(0, selfFollow)).toBe(false)

    const offline = createMemoApi(() => Promise.reject(new Error('offline')), () => false)
    const unanswered = await rejection(offline.me())
    expect(unanswered).toMatchObject({ status: 0, transient: true })
    expect(retryQuery(0, unanswered)).toBe(true)
    const proxy = createMemoApi(async () => new Response('<html>bad gateway</html>', { status: 502 }), () => false)
    expect(await rejection(proxy.me())).toMatchObject({ status: 502, code: 'unknown', transient: true })
    const store = createMemoApi(async () => Response.json({ error: 'memo_store_unavailable', message: 'database unreachable' }, { status: 503 }), () => false)
    expect(await rejection(store.me())).toMatchObject({ status: 503, code: 'memo_store_unavailable', transient: false })
  })
})
