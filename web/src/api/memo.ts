// Memo API (`/api/memo/v1/*`, served by cmd/server from the SPA's own
// origin). The OIDC edge (Envoy) in front of the server attaches the caller's
// bearer token; the SPA never sees or requests one. `GET /me` upserts the
// caller as an author and links them to Directory when it can. Lists are
// `{items: [...]}` (the timeline adds `nextCursor`), single resources are
// direct objects, errors are `{error, message}`.

/** `directoryPersonId` is set once `GET /me` linked the author to their Directory person. */
export type Author = { id: string; displayName: string; email: string; directoryPersonId: string | null }
export type ArticleStatus = 'draft' | 'published'
/** `excerpt`: the server's plain-text preview (first 160 characters, Markdown markers stripped). */
export type ArticleSummary = {
  id: string
  title: string
  excerpt: string
  status: ArticleStatus
  author: Author
  /** Null while a draft. */
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  likeCount: number
  likedByMe: boolean
}
/** `body` is the Markdown as written; the SPA renders and sanitizes it. */
export type Article = ArticleSummary & { body: string }
export type AuthorProfile = { author: Author; articleCount: number; followerCount: number; followingCount: number; followedByMe: boolean; isMe: boolean }
/**
 * `directory.linked`: Directory answered and the author carries its person id. `publicUrl` is the Directory
 * browser origin (`MEMO_DIRECTORY_PUBLIC_URL`), null when unset.
 */
export type Me = {
  author: Author
  roles: { memoAdmin: boolean }
  directory: { linked: boolean; publicUrl: string | null }
  counts: { published: number; drafts: number; followers: number; following: number }
}
/** One timeline page; `nextCursor` is opaque and null on the last page. */
export type ArticlePage = { items: ArticleSummary[]; nextCursor: string | null }
export type LikeState = { likeCount: number; likedByMe: boolean }
export type FollowState = { followerCount: number; followedByMe: boolean }
export type ApiError = { error: string; message: string }

/** `publish: true` creates the article published (`publishedAt` = now). */
export type CreateArticleInput = { title: string; body: string; publish?: boolean }
/** The first switch to `published` sets `publishedAt`; `draft` clears it. */
export type UpdateArticleInput = { title?: string; body?: string; status?: ArticleStatus }
/** `limit` 1–50 (server default 20); `author` narrows to one author; `following` to the authors the caller follows. */
export type TimelineParams = { limit?: number; cursor?: string | null; author?: string; following?: boolean }

/**
 * Non-2xx memo response. `code` is the server's stable snake_case error.
 * `transient` = no error envelope came back: a 5xx from a proxy in front of the
 * server (e.g. during a rollout), or no response at all (status 0).
 */
export class MemoApiError extends Error {
  readonly status: number
  readonly code: string
  readonly transient: boolean

  constructor(status: number, body: Partial<ApiError> | undefined) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    super(body?.message || `memo api ${status}`)
    this.name = 'MemoApiError'
    this.status = status
    this.code = code ?? (status === 404 ? 'not_found' : 'unknown')
    this.transient = code === undefined && (status === 0 || status >= 500)
  }
}

export function isMemoError(error: unknown, code?: string): error is MemoApiError {
  return error instanceof MemoApiError && (code === undefined || error.code === code)
}

export const BASE = '/api/memo/v1'
const READ_TIMEOUT_MS = 8_000
// A 401 first sends the browser to `/` so the edge re-runs sign-in. Another 401
// within this window means the edge forwards a token the server rejects;
// redirecting again would loop, so that 401 reaches the screens instead.
const REAUTH_WINDOW_MS = 60_000
const REAUTH_AT_KEY = 'memo:reauth-at'

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

export interface MemoApi {
  /** The caller (upserted), their roles, the Directory link and their counts. */
  me(): Promise<Me>
  articles: {
    /** Published articles, newest publication first. 400 `invalid_request` for a bad cursor or limit. */
    list(params?: TimelineParams): Promise<ArticlePage>
    /** A draft is 404 `not_found` for anyone but its author. */
    get(articleId: string): Promise<Article>
    /** 400 `invalid_request`: title 1–120 characters (trimmed), body ≤ 100 KiB and non-empty to publish. */
    create(input: CreateArticleInput): Promise<Article>
    /** Owner only (403 `forbidden`). */
    update(articleId: string, input: UpdateArticleInput): Promise<Article>
    /** Owner or memo admin. */
    remove(articleId: string): Promise<void>
    /** Idempotent; a draft is 404. */
    like(articleId: string): Promise<LikeState>
    unlike(articleId: string): Promise<LikeState>
  }
  /** The caller's drafts, last edited first. */
  drafts(): Promise<ArticleSummary[]>
  authors: {
    get(authorId: string): Promise<AuthorProfile>
    /** Newest first, at most 200. */
    followers(authorId: string): Promise<Author[]>
    following(authorId: string): Promise<Author[]>
    /** Idempotent; 400 `self_follow` for the caller. */
    follow(authorId: string): Promise<FollowState>
    unfollow(authorId: string): Promise<FollowState>
  }
}

/** `?limit=&cursor=&author=&following=true` with only the set parameters. */
export function timelineSearch({ limit, cursor, author, following }: TimelineParams = {}): string {
  const search = new URLSearchParams()
  if (limit !== undefined) search.set('limit', String(limit))
  if (cursor) search.set('cursor', cursor)
  if (author) search.set('author', author)
  if (following) search.set('following', 'true')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function createMemoApi(fetcher: Fetcher = (input, init) => fetch(input, init), reauth = browserReauth): MemoApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const read = method === 'GET'
    let response: Response
    try {
      response = await fetcher(`${BASE}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: read ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
      })
    } catch {
      // Network failure or read timeout: nothing answered.
      throw new MemoApiError(0, undefined)
    }
    if (response.status === 401 && reauth()) return new Promise<T>(() => {})
    if (!response.ok) {
      let parsed: Partial<ApiError> | undefined
      try {
        parsed = (await response.json()) as Partial<ApiError>
      } catch {
        parsed = undefined
      }
      throw new MemoApiError(response.status, parsed)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
  const list = async <T>(path: string) => (await call<{ items: T[] }>('GET', path)).items
  const id = encodeURIComponent

  return {
    me: () => call<Me>('GET', '/me'),
    articles: {
      list: (params) => call<ArticlePage>('GET', `/articles${timelineSearch(params)}`),
      get: (articleId) => call<Article>('GET', `/articles/${id(articleId)}`),
      create: (input) => call<Article>('POST', '/articles', input),
      update: (articleId, input) => call<Article>('PATCH', `/articles/${id(articleId)}`, input),
      remove: (articleId) => call<void>('DELETE', `/articles/${id(articleId)}`),
      like: (articleId) => call<LikeState>('PUT', `/articles/${id(articleId)}/like`),
      unlike: (articleId) => call<LikeState>('DELETE', `/articles/${id(articleId)}/like`),
    },
    drafts: () => list<ArticleSummary>('/drafts'),
    authors: {
      get: (authorId) => call<AuthorProfile>('GET', `/authors/${id(authorId)}`),
      followers: (authorId) => list<Author>(`/authors/${id(authorId)}/followers`),
      following: (authorId) => list<Author>(`/authors/${id(authorId)}/following`),
      follow: (authorId) => call<FollowState>('PUT', `/authors/${id(authorId)}/follow`),
      unfollow: (authorId) => call<FollowState>('DELETE', `/authors/${id(authorId)}/follow`),
    },
  }
}

function browserReauth(): boolean {
  const lastReauthAt = Number(sessionStorage.getItem(REAUTH_AT_KEY))
  if (Date.now() - lastReauthAt < REAUTH_WINDOW_MS) return false
  sessionStorage.setItem(REAUTH_AT_KEY, String(Date.now()))
  window.location.assign('/')
  return true
}

export const memoApi = createMemoApi()
