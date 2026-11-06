// Dev-only in-memory implementation of the memo contract (`/api/memo/v1/*`,
// cmd/server; design/platform/builtin-app-memo/README.md "API"). Fixtures: five
// authors (four linked to a Directory person, 鈴木 not), 26 published articles
// (more than one timeline page) and three drafts (two by the caller, one by 佐藤,
// which is 404 for everyone else), likes and follows in both directions.
// The caller is 山田 (memo admin) unless MOCK_ROLE is set to anything but
// Admin (Member), which makes them a plain member;
// `POST /api/memo/v1/__mock/caller {authorId, admin?}` switches the signed-in
// author (default not admin). `POST /api/memo/v1/__mock/reset` returns
// {reset: true} and reseeds all state.
// The timeline cursor is base64url(`publishedAt|id`), opaque to the SPA.
import type { ApiError, Article, ArticleStatus, ArticleSummary, Author, AuthorProfile, Me } from '../api/memo'
import { articleProblems, excerptOf } from '../model/article'

type StoredAuthor = Author & { subject: string }
type StoredArticle = {
  id: string
  authorId: string
  title: string
  body: string
  status: ArticleStatus
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}
type Like = { articleId: string; authorId: string; createdAt: string }
type Follow = { followerId: string; followeeId: string; createdAt: string }

const BASE = '/api/memo/v1'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_FOLLOW_LIST = 200
const DIRECTORY_PUBLIC_URL = process.env.MEMO_MOCK_DIRECTORY_PUBLIC_URL ?? 'https://directory.pj-mock.appthrust.ink'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID-shaped id: 48-bit time and an 80-bit tail derived from `seq`, both Crockford base32. */
function ulid(time: number, seq: number): string {
  let head = ''
  for (let value = time, i = 0; i < 10; i++, value = Math.floor(value / 32)) head = CROCKFORD[value % 32] + head
  let tail = ''
  for (let value = seq * 2654435761, i = 0; i < 16; i++, value = Math.floor(value / 32) + i * 7919) tail = CROCKFORD[value % 32] + tail
  return head + tail
}

const T0 = Date.parse('2026-09-01T09:00:00Z')
const HOUR = 3_600_000

/** Fixed author ids, so tests and links can name them. */
export const MOCK_AUTHOR_IDS = {
  yamada: ulid(T0, 1),
  sato: ulid(T0, 2),
  suzuki: ulid(T0, 3),
  tanaka: ulid(T0, 4),
  kato: ulid(T0, 5),
} as const

const SAMPLE_BODY = `## 背景

チームで使っている手順を共有します。**まずは小さく試す**のが基本です。

- 目的をひとことで書く
- 期限と担当を決める
- 終わったら振り返る

> うまくいかなかったことも、書いておくと次の人の役に立ちます。

\`\`\`sh
make check
\`\`\`

詳しくは [社内ガイド](https://example.com/guide) を見てください。`

/** [author, title, first line of the body, hours after T0]. */
const PUBLISHED: readonly [keyof typeof MOCK_AUTHOR_IDS, string, string, number][] = [
  ['sato', '新しい見積テンプレートを作りました', '営業部で使う見積テンプレートを刷新しました。', 2],
  ['tanaka', 'Kubernetes の監視を見直した話', 'アラートが多すぎて誰も見なくなっていた問題を整理しました。', 20],
  ['suzuki', '東日本エリアの訪問ルートを最適化', '移動時間を 2 割減らせたので、やり方をまとめます。', 30],
  ['kato', '社内ツールのリリース手順', 'リリースの前日と当日にやることを一覧にしました。', 44],
  ['yamada', '四半期の振り返り', '今期よかったこと、改善したいことを書き出します。', 60],
  ['sato', '提案資料の構成を 3 枚にした理由', 'お客さまが最後まで読める資料の長さを考えました。', 80],
  ['tanaka', 'オンコールの引き継ぎメモの書き方', '夜間に起きたことを朝のチームに伝えるための型です。', 100],
  ['kato', 'TypeScript の型で設定ミスを防ぐ', '設定ファイルの読み込みに型をつけたら、本番の事故が減りました。', 120],
  ['suzuki', 'はじめての展示会出展レポート', 'ブースの準備から当日の動きまで、学んだことをまとめます。', 150],
  ['yamada', '1on1 で聞いている 5 つの質問', '毎週の 1on1 で使っている質問を紹介します。', 170],
  ['sato', '営業日報をやめて週報にした結果', '書く時間が減り、読む人が増えました。', 200],
  ['tanaka', 'PostgreSQL のバックアップを検証した', '復元できることを毎月確かめる仕組みを作りました。', 230],
  ['kato', 'デザインレビューのチェックリスト', '画面を見るときに確かめていることを一覧にしました。', 260],
  ['suzuki', 'お客さまの声を社内に届ける方法', '商談で聞いた話を、開発チームに届ける流れを作りました。', 300],
  ['yamada', '新しく入った人へのオンボーディング', '最初の 2 週間で何をするかをまとめています。', 340],
  ['tanaka', '障害対応のふりかえりテンプレート', '責める場ではなく、仕組みを直す場にするための型です。', 380],
  ['sato', '西日本チームとの合同勉強会', '月に一度、オンラインで事例を共有しています。', 420],
  ['kato', 'CI を 10 分短くした工夫', 'キャッシュとテストの並べ替えで待ち時間を減らしました。', 460],
  ['suzuki', '電話の前に準備していること', '初回の電話で聞くことをメモにしています。', 500],
  ['tanaka', '権限設計で迷ったら読むメモ', 'ロールを増やしすぎないための考え方です。', 540],
  ['yamada', 'チームの目標を 1 枚にまとめる', '全員が同じ方向を向くための書き方を試しました。', 580],
  ['kato', 'アクセシビリティの最初の一歩', 'キーボードだけで操作できるかを確かめるところから始めました。', 620],
  ['sato', '契約更新の連絡を自動にした', '更新日の 30 日前にお知らせが届くようにしました。', 660],
  ['suzuki', '社内報の取材をしてみて', '他の部署の人の話を聞く機会は、思った以上に新鮮でした。', 700],
  ['tanaka', 'ステージング環境の片付け', '使われていない環境を見つけて、費用を減らしました。', 740],
  ['kato', 'ドキュメントを書く時間の作り方', '金曜の午後を書く時間にしています。', 780],
]

/** [author, title, body, hours after T0] — drafts never reach the timeline. */
const DRAFTS: readonly [keyof typeof MOCK_AUTHOR_IDS, string, string, number][] = [
  ['yamada', '来期の採用計画（メモ）', '## 方針\n\n- エンジニア 2 名\n- 営業 1 名\n', 790],
  ['yamada', '読んだ本のまとめ', '', 795],
  ['sato', '値上げのお知らせ文面（下書き）', 'お客さまへの文面を検討中です。', 792],
]

function seedMemo() {
  const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString()
  const authors: StoredAuthor[] = [
    { id: MOCK_AUTHOR_IDS.yamada, subject: 'sub-yamada', displayName: '山田 太郎', email: 'yamada@example.com', directoryPersonId: 'p-yamada' },
    { id: MOCK_AUTHOR_IDS.sato, subject: 'sub-sato', displayName: '佐藤 花子', email: 'sato@example.com', directoryPersonId: 'p-sato' },
    { id: MOCK_AUTHOR_IDS.suzuki, subject: 'sub-suzuki', displayName: '鈴木 一郎', email: 'suzuki@example.com', directoryPersonId: null },
    { id: MOCK_AUTHOR_IDS.tanaka, subject: 'sub-tanaka', displayName: '田中 美咲', email: 'tanaka@example.com', directoryPersonId: 'p-tanaka' },
    { id: MOCK_AUTHOR_IDS.kato, subject: 'sub-kato', displayName: '加藤 大輔', email: 'kato@example.com', directoryPersonId: 'p-kato' },
  ]
  let seq = 100
  const articles: StoredArticle[] = []
  for (const [author, title, lead, hours] of PUBLISHED) {
    const time = at(hours)
    articles.push({
      id: ulid(T0 + hours * HOUR, seq++),
      authorId: MOCK_AUTHOR_IDS[author],
      title,
      body: `${lead}\n\n${SAMPLE_BODY}`,
      status: 'published',
      publishedAt: time,
      createdAt: at(hours - 1),
      updatedAt: time,
    })
  }
  for (const [author, title, body, hours] of DRAFTS) {
    articles.push({ id: ulid(T0 + hours * HOUR, seq++), authorId: MOCK_AUTHOR_IDS[author], title, body, status: 'draft', publishedAt: null, createdAt: at(hours - 2), updatedAt: at(hours) })
  }
  const likes: Like[] = []
  const ids = Object.values(MOCK_AUTHOR_IDS)
  articles.forEach((article, index) => {
    if (article.status !== 'published') return
    // A deterministic spread: each article liked by 0–3 people other than its author.
    for (const [offset, liker] of ids.entries()) {
      if (liker !== article.authorId && (index + offset) % 3 === 0) likes.push({ articleId: article.id, authorId: liker, createdAt: article.publishedAt! })
    }
  })
  const follow = (follower: keyof typeof MOCK_AUTHOR_IDS, followee: keyof typeof MOCK_AUTHOR_IDS, hours: number): Follow => ({
    followerId: MOCK_AUTHOR_IDS[follower],
    followeeId: MOCK_AUTHOR_IDS[followee],
    createdAt: at(hours),
  })
  const follows: Follow[] = [follow('yamada', 'sato', 10), follow('yamada', 'tanaka', 12), follow('tanaka', 'yamada', 14), follow('sato', 'yamada', 16), follow('kato', 'yamada', 18), follow('kato', 'tanaka', 20)]
  return {
    authors,
    articles,
    likes,
    follows,
    callerId: MOCK_AUTHOR_IDS.yamada as string,
    admin: (process.env.MOCK_ROLE ?? 'Admin') === 'Admin',
    clock: T0 + 800 * HOUR,
    seq,
  }
}

let state = seedMemo()

/** Strictly increasing wall-clock time, so two writes in one millisecond still order. */
function now(): string {
  state.clock = Math.max(Date.now(), state.clock + 1)
  return new Date(state.clock).toISOString()
}

function author(authorId: string): Author {
  const stored = state.authors.find((candidate) => candidate.id === authorId)
  if (!stored) throw new Error(`mock: unknown author ${authorId}`)
  return { id: stored.id, displayName: stored.displayName, email: stored.email, directoryPersonId: stored.directoryPersonId }
}

function summary(article: StoredArticle): ArticleSummary {
  const likes = state.likes.filter((like) => like.articleId === article.id)
  return {
    id: article.id,
    title: article.title,
    excerpt: excerptOf(article.body),
    status: article.status,
    author: author(article.authorId),
    publishedAt: article.publishedAt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    likeCount: likes.length,
    likedByMe: likes.some((like) => like.authorId === state.callerId),
  }
}

function profile(authorId: string): AuthorProfile {
  return {
    author: author(authorId),
    articleCount: state.articles.filter((article) => article.authorId === authorId && article.status === 'published').length,
    followerCount: state.follows.filter((follow) => follow.followeeId === authorId).length,
    followingCount: state.follows.filter((follow) => follow.followerId === authorId).length,
    followedByMe: state.follows.some((follow) => follow.followerId === state.callerId && follow.followeeId === authorId),
    isMe: authorId === state.callerId,
  }
}

/** Newest publication first; equal times order by id, both descending (the server's index order). */
const timelineOrder = (a: StoredArticle, b: StoredArticle) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || b.id.localeCompare(a.id)

function decodeCursor(cursor: string): { publishedAt: string; id: string } | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined
  const [publishedAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (rest.length > 0 || !publishedAt || !id || Number.isNaN(Date.parse(publishedAt))) return undefined
  return { publishedAt: new Date(publishedAt).toISOString(), id }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, error: string, message: string) => json({ error, message } satisfies ApiError, status)
const notFound = () => fail(404, 'not_found', 'The requested resource was not found')
const forbidden = () => fail(403, 'forbidden', 'You do not have permission for this action')
const invalid = (message: string) => fail(400, 'invalid_request', message)

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await request.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const PROBLEM_MESSAGES = {
  titleRequired: 'title is required',
  titleTooLong: 'title must be at most 120 characters',
  bodyRequired: 'body must not be empty to publish',
  bodyTooLarge: 'body must be at most 100 KiB',
} as const

/** The validation failure for the article as it would be stored, else undefined. */
function validate(title: string, articleBody: string, publish: boolean): Response | undefined {
  const problems = articleProblems(title, articleBody, publish)
  const problem = problems.title ?? problems.body
  return problem ? invalid(PROBLEM_MESSAGES[problem]) : undefined
}

function timeline(url: URL): Response {
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid(`limit must be between 1 and ${MAX_LIMIT}`)
  const cursorParam = url.searchParams.get('cursor')
  const cursor = cursorParam ? decodeCursor(cursorParam) : undefined
  if (cursorParam && !cursor) return invalid('cursor is not valid')
  const authorId = url.searchParams.get('author')
  const followees = url.searchParams.get('following') === 'true' ? new Set(state.follows.filter((f) => f.followerId === state.callerId).map((f) => f.followeeId)) : undefined
  const matching = state.articles
    .filter(
      (article) =>
        article.status === 'published' &&
        (!authorId || article.authorId === authorId) &&
        (!followees || followees.has(article.authorId)) &&
        (!cursor || article.publishedAt! < cursor.publishedAt || (article.publishedAt === cursor.publishedAt && article.id < cursor.id))
    )
    .sort(timelineOrder)
  const page = matching.slice(0, limit)
  const last = page.at(-1)
  // The cursor is base64url(`publishedAt|id`) of the page's last article.
  return json({ items: page.map(summary), nextCursor: matching.length > limit && last ? Buffer.from(`${last.publishedAt}|${last.id}`, 'utf8').toString('base64url') : null })
}

/** Handles `/api/memo/v1/*`; undefined for any other path. */
export async function memoRoutes(request: Request, url: URL): Promise<Response | undefined> {
  if (!url.pathname.startsWith(`${BASE}/`)) return undefined
  const route = `${request.method} ${url.pathname.slice(BASE.length)}`
  let match: RegExpMatchArray | null

  if (route === 'POST /__mock/reset') {
    state = seedMemo()
    return json({ reset: true })
  }
  if (route === 'POST /__mock/caller') {
    const input = await body(request)
    if (typeof input?.authorId !== 'string' || !state.authors.some((a) => a.id === input.authorId)) return invalid('authorId must name a seeded author')
    state.callerId = input.authorId
    state.admin = input.admin === true
    return json({ callerId: state.callerId, admin: state.admin })
  }

  const caller = state.callerId

  if (route === 'GET /me') {
    const mine = state.articles.filter((article) => article.authorId === caller)
    const me: Me = {
      author: author(caller),
      roles: { memoAdmin: state.admin },
      directory: { linked: author(caller).directoryPersonId !== null, publicUrl: DIRECTORY_PUBLIC_URL || null },
      counts: {
        published: mine.filter((article) => article.status === 'published').length,
        drafts: mine.filter((article) => article.status === 'draft').length,
        followers: state.follows.filter((follow) => follow.followeeId === caller).length,
        following: state.follows.filter((follow) => follow.followerId === caller).length,
      },
    }
    return json(me)
  }
  if (route === 'GET /articles') return timeline(url)
  if (route === 'GET /drafts') {
    return json({
      items: state.articles
        .filter((article) => article.authorId === caller && article.status === 'draft')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .map(summary),
    })
  }
  if (route === 'POST /articles') {
    const input = await body(request)
    if (!input || typeof input.title !== 'string' || typeof input.body !== 'string') return invalid('title and body are required')
    if (input.publish !== undefined && typeof input.publish !== 'boolean') return invalid('publish must be a boolean')
    const publish = input.publish === true
    const problem = validate(input.title, input.body, publish)
    if (problem) return problem
    const time = now()
    const created: StoredArticle = {
      id: ulid(state.clock, state.seq++),
      authorId: caller,
      title: input.title.trim(),
      body: input.body,
      status: publish ? 'published' : 'draft',
      publishedAt: publish ? time : null,
      createdAt: time,
      updatedAt: time,
    }
    state.articles.push(created)
    return json({ ...summary(created), body: created.body } satisfies Article, 201)
  }

  if ((match = route.match(/^(GET|PATCH|DELETE) \/articles\/([^/]+)$/))) {
    const [, method, id] = match
    const article = state.articles.find((candidate) => candidate.id === decodeURIComponent(id!))
    // A draft does not exist for anyone but its author.
    if (!article || (article.status === 'draft' && article.authorId !== caller)) return notFound()
    if (method === 'GET') return json({ ...summary(article), body: article.body } satisfies Article)
    if (method === 'DELETE') {
      if (article.authorId !== caller && !state.admin) return forbidden()
      state.articles = state.articles.filter((candidate) => candidate !== article)
      state.likes = state.likes.filter((like) => like.articleId !== article.id)
      return new Response(null, { status: 204 })
    }
    if (article.authorId !== caller) return forbidden()
    const input = await body(request)
    if (!input) return invalid('A JSON object is required')
    if (input.title !== undefined && typeof input.title !== 'string') return invalid('title must be a string')
    if (input.body !== undefined && typeof input.body !== 'string') return invalid('body must be a string')
    if (input.status !== undefined && input.status !== 'draft' && input.status !== 'published') return invalid('status must be draft or published')
    const title = typeof input.title === 'string' ? input.title : article.title
    const nextBody = typeof input.body === 'string' ? input.body : article.body
    const status = (input.status as ArticleStatus | undefined) ?? article.status
    const problem = validate(title, nextBody, status === 'published')
    if (problem) return problem
    const time = now()
    Object.assign(article, {
      title: title.trim(),
      body: nextBody,
      status,
      publishedAt: status === 'draft' ? null : (article.publishedAt ?? time),
      updatedAt: time,
    })
    return json({ ...summary(article), body: article.body } satisfies Article)
  }

  if ((match = route.match(/^(PUT|DELETE) \/articles\/([^/]+)\/like$/))) {
    const [, method, id] = match
    const article = state.articles.find((candidate) => candidate.id === decodeURIComponent(id!))
    if (!article || article.status !== 'published') return notFound()
    const liked = state.likes.some((like) => like.articleId === article.id && like.authorId === caller)
    if (method === 'PUT' && !liked) state.likes.push({ articleId: article.id, authorId: caller, createdAt: now() })
    if (method === 'DELETE') state.likes = state.likes.filter((like) => !(like.articleId === article.id && like.authorId === caller))
    return json({ likeCount: state.likes.filter((like) => like.articleId === article.id).length, likedByMe: method === 'PUT' })
  }

  if ((match = route.match(/^(GET|PUT|DELETE) \/authors\/([^/]+)(?:\/(followers|following|follow))?$/))) {
    const [, method, rawId, sub] = match
    const authorId = decodeURIComponent(rawId!)
    if (!state.authors.some((candidate) => candidate.id === authorId)) return notFound()
    if (method === 'GET' && sub === undefined) return json(profile(authorId))
    if (method === 'GET') {
      // followers: who follows `authorId`; following: whom `authorId` follows. Newest first.
      const ids = state.follows
        .filter((f) => (sub === 'followers' ? f.followeeId : f.followerId) === authorId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((f) => (sub === 'followers' ? f.followerId : f.followeeId))
      if (sub === 'followers' || sub === 'following') return json({ items: ids.slice(0, MAX_FOLLOW_LIST).map(author) })
    }
    if (method !== 'GET' && sub === 'follow') {
      if (authorId === caller) return fail(400, 'self_follow', 'You cannot follow yourself')
      const following = state.follows.some((f) => f.followerId === caller && f.followeeId === authorId)
      if (method === 'PUT' && !following) state.follows.push({ followerId: caller, followeeId: authorId, createdAt: now() })
      if (method === 'DELETE') state.follows = state.follows.filter((f) => !(f.followerId === caller && f.followeeId === authorId))
      return json({ followerCount: state.follows.filter((f) => f.followeeId === authorId).length, followedByMe: method === 'PUT' })
    }
  }

  return notFound()
}
