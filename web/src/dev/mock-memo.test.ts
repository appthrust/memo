import { beforeEach, describe, expect, test } from 'bun:test'
import type { Article, ArticlePage, ArticleSummary } from '../api/memo'
import { MOCK_AUTHOR_IDS, memoRoutes } from './mock-memo'

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`/api/memo/v1${path}`, 'http://mock.test')
  const response = await memoRoutes(
    new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    url
  )
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
}

const as = (author: keyof typeof MOCK_AUTHOR_IDS, admin = false) => call('POST', '/__mock/caller', { authorId: MOCK_AUTHOR_IDS[author], admin })
const ids = (items: ArticleSummary[]) => items.map((item) => item.id)

beforeEach(async () => {
  expect(await call('POST', '/__mock/reset')).toEqual({ status: 200, body: { reset: true } })
})

describe('memo mock contract', () => {
  test('GET /me carries the author, admin role, Directory link and counts', async () => {
    const { status, body } = await call('GET', '/me')
    expect(status).toBe(200)
    expect(body.author).toMatchObject({ id: MOCK_AUTHOR_IDS.yamada, displayName: '山田 太郎', directoryPersonId: 'p-yamada' })
    expect(body.directory).toEqual({ linked: true, publicUrl: 'https://directory.pj-mock.appthrust.ink' })
    expect(body.counts).toEqual({ published: 4, drafts: 2, followers: 3, following: 2 })
    await as('suzuki')
    const member = (await call('GET', '/me')).body
    expect(member.roles.memoAdmin).toBe(false)
    expect(member.directory.linked).toBe(false)
  })

  test('a draft stays out of the timeline and is 404 for others until published', async () => {
    const created = await call('POST', '/articles', { title: '  新しい記事  ', body: '# こんにちは\n\n本文です。' })
    expect(created.status).toBe(201)
    const draft: Article = created.body
    expect(draft).toMatchObject({ title: '新しい記事', status: 'draft', publishedAt: null, excerpt: 'こんにちは 本文です。', likeCount: 0 })
    expect(ids((await call('GET', '/drafts')).body.items)[0]).toBe(draft.id)
    expect(ids((await call('GET', '/articles')).body.items)).not.toContain(draft.id)

    await as('sato')
    expect((await call('GET', `/articles/${draft.id}`)).status).toBe(404)
    expect((await call('PUT', `/articles/${draft.id}/like`)).status).toBe(404)

    await as('yamada', true)
    const published = await call('PATCH', `/articles/${draft.id}`, { status: 'published' })
    expect(published.status).toBe(200)
    expect(published.body.publishedAt).not.toBeNull()
    const timeline: ArticlePage = (await call('GET', '/articles')).body
    expect(timeline.items[0]?.id).toBe(draft.id)

    // Back to draft clears publishedAt; publishing again sets a new one.
    const reverted = await call('PATCH', `/articles/${draft.id}`, { status: 'draft' })
    expect(reverted.body).toMatchObject({ status: 'draft', publishedAt: null })
    expect(ids((await call('GET', '/articles')).body.items)).not.toContain(draft.id)
  })

  test('validation: title 1–120 after trimming, a body to publish, a known status', async () => {
    expect((await call('POST', '/articles', { title: '   ', body: 'x' })).body).toMatchObject({ error: 'invalid_request' })
    expect((await call('POST', '/articles', { title: 'あ'.repeat(121), body: '' })).status).toBe(400)
    expect((await call('POST', '/articles', { title: 'あ'.repeat(120), body: '' })).status).toBe(201)
    expect((await call('POST', '/articles', { title: '空', body: '  ', publish: true })).status).toBe(400)
    const { body: draft } = await call('POST', '/articles', { title: '空の下書き', body: '' })
    expect((await call('PATCH', `/articles/${draft.id}`, { status: 'published' })).status).toBe(400)
    expect((await call('PATCH', `/articles/${draft.id}`, { status: 'archived' })).status).toBe(400)
  })

  test('only the owner edits; the owner or an admin deletes', async () => {
    const { body: mine } = await call('POST', '/articles', { title: '山田の記事', body: '本文', publish: true })
    await as('sato')
    expect((await call('PATCH', `/articles/${mine.id}`, { title: '乗っ取り' })).body).toMatchObject({ error: 'forbidden' })
    expect((await call('DELETE', `/articles/${mine.id}`)).status).toBe(403)
    await as('tanaka', true)
    expect((await call('PATCH', `/articles/${mine.id}`, { title: '管理者' })).status).toBe(403)
    expect((await call('DELETE', `/articles/${mine.id}`)).status).toBe(204)
    expect((await call('GET', `/articles/${mine.id}`)).status).toBe(404)
  })

  test('likes are idempotent per person and counted on the article', async () => {
    const { body: article } = await call('POST', '/articles', { title: 'スキの記事', body: '本文', publish: true })
    await as('sato')
    expect((await call('PUT', `/articles/${article.id}/like`)).body).toEqual({ likeCount: 1, likedByMe: true })
    expect((await call('PUT', `/articles/${article.id}/like`)).body).toEqual({ likeCount: 1, likedByMe: true })
    await as('tanaka')
    expect((await call('PUT', `/articles/${article.id}/like`)).body).toEqual({ likeCount: 2, likedByMe: true })
    expect((await call('GET', `/articles/${article.id}`)).body).toMatchObject({ likeCount: 2, likedByMe: true })
    expect((await call('DELETE', `/articles/${article.id}/like`)).body).toEqual({ likeCount: 1, likedByMe: false })
    expect((await call('DELETE', `/articles/${article.id}/like`)).body).toEqual({ likeCount: 1, likedByMe: false })
    await as('yamada')
    expect((await call('GET', `/articles/${article.id}`)).body).toMatchObject({ likeCount: 1, likedByMe: false })
  })

  test('follows are idempotent, refuse self and drive the following timeline', async () => {
    expect((await call('PUT', `/authors/${MOCK_AUTHOR_IDS.yamada}/follow`)).body).toMatchObject({ error: 'self_follow' })
    const following = async () => new Set(((await call('GET', '/articles?following=true&limit=50')).body as ArticlePage).items.map((item) => item.author.id))
    expect(await following()).toEqual(new Set([MOCK_AUTHOR_IDS.sato, MOCK_AUTHOR_IDS.tanaka]))

    const before = (await call('GET', `/authors/${MOCK_AUTHOR_IDS.suzuki}`)).body
    expect(before).toMatchObject({ followedByMe: false, isMe: false })
    expect((await call('PUT', `/authors/${MOCK_AUTHOR_IDS.suzuki}/follow`)).body).toEqual({ followerCount: before.followerCount + 1, followedByMe: true })
    expect((await call('PUT', `/authors/${MOCK_AUTHOR_IDS.suzuki}/follow`)).body).toEqual({ followerCount: before.followerCount + 1, followedByMe: true })
    expect(await following()).toContain(MOCK_AUTHOR_IDS.suzuki)
    expect((await call('GET', `/authors/${MOCK_AUTHOR_IDS.suzuki}/followers`)).body.items[0].id).toBe(MOCK_AUTHOR_IDS.yamada)
    expect((await call('GET', `/authors/${MOCK_AUTHOR_IDS.yamada}/following`)).body.items[0].id).toBe(MOCK_AUTHOR_IDS.suzuki)

    expect((await call('DELETE', `/authors/${MOCK_AUTHOR_IDS.suzuki}/follow`)).body).toEqual({ followerCount: before.followerCount, followedByMe: false })
    expect(await following()).not.toContain(MOCK_AUTHOR_IDS.suzuki)
    expect((await call('GET', `/authors/${MOCK_AUTHOR_IDS.yamada}`)).body).toMatchObject({ isMe: true, articleCount: 4, followerCount: 3 })
    expect((await call('GET', '/authors/nobody')).status).toBe(404)
  })

  test('cursor paging walks the whole timeline newest first, without repeats', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const response: { status: number; body: ArticlePage } = await call('GET', `/articles?limit=10${cursor ? `&cursor=${cursor}` : ''}`)
      expect(response.status).toBe(200)
      seen.push(...ids(response.body.items))
      cursor = response.body.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(26)
    expect(new Set(seen).size).toBe(26)
    const all: ArticlePage = (await call('GET', '/articles?limit=50')).body
    expect(ids(all.items)).toEqual(seen)
    expect(all.nextCursor).toBeNull()
    const times = all.items.map((item) => item.publishedAt!)
    expect([...times].sort().reverse()).toEqual(times)

    const firstPage: ArticlePage = (await call('GET', '/articles')).body
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.nextCursor).not.toBeNull()
    const byAuthor: ArticlePage = (await call('GET', `/articles?author=${MOCK_AUTHOR_IDS.kato}&limit=50`)).body
    expect(byAuthor.items.every((item) => item.author.id === MOCK_AUTHOR_IDS.kato)).toBe(true)
  })

  test('a bad cursor or limit is 400 invalid_request', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'cursor=%25%25', `cursor=${Buffer.from('not-a-cursor').toString('base64url')}`]) {
      const { status, body } = await call('GET', `/articles?${query}`)
      expect(status, query).toBe(400)
      expect(body.error).toBe('invalid_request')
    }
  })
})
