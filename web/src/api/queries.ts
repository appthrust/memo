// Read-model loading (React Query). Every query is a `queryOptions()` /
// `infiniteQueryOptions()` factory so route loaders (`ensureQueryData`) and
// components share one key and fetcher.
import { infiniteQueryOptions, QueryClient, queryOptions } from '@tanstack/react-query'
import { memoApi, MemoApiError } from './memo'

/** Retries for a call nothing answered (rollout gap, network blip). */
const TRANSIENT_RETRIES = 3

/** Any answer with a status (4xx, coded 5xx) is final; unanswered calls are retried with backoff. */
export const retryQuery = (failureCount: number, error: unknown) =>
  error instanceof MemoApiError && !error.transient ? false : failureCount < TRANSIENT_RETRIES

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: retryQuery, retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000), staleTime: 10_000 },
  },
})

/** Every memo key starts with this, so one invalidation refreshes everything after a write. */
export const MEMO_KEY = ['memo'] as const

/** A write (publish, like, follow, delete) changes timelines, counts and profiles; everything lives under MEMO_KEY. */
export const invalidateMemo = (client: QueryClient) => client.invalidateQueries({ queryKey: MEMO_KEY })

export const meQuery = queryOptions({ queryKey: [...MEMO_KEY, 'me'], queryFn: () => memoApi.me(), staleTime: 60_000 })

/** Timeline page size (the server's default). */
export const PAGE_SIZE = 20

/** Which published articles a list shows: everyone's, the followed authors', or one author's. */
export type Feed = { kind: 'all' } | { kind: 'following' } | { kind: 'author'; authorId: string }

/** Published articles, newest first, one cursor page per "もっと読む". */
export const timelineQuery = (feed: Feed) =>
  infiniteQueryOptions({
    queryKey: [...MEMO_KEY, 'timeline', feed.kind, feed.kind === 'author' ? feed.authorId : ''],
    queryFn: ({ pageParam }) =>
      memoApi.articles.list({
        limit: PAGE_SIZE,
        cursor: pageParam,
        following: feed.kind === 'following',
        author: feed.kind === 'author' ? feed.authorId : undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })

export const articleQuery = (articleId: string) =>
  queryOptions({ queryKey: [...MEMO_KEY, 'articles', articleId], queryFn: () => memoApi.articles.get(articleId) })

export const draftsQuery = queryOptions({ queryKey: [...MEMO_KEY, 'drafts'], queryFn: () => memoApi.drafts() })

export const authorQuery = (authorId: string) =>
  queryOptions({ queryKey: [...MEMO_KEY, 'authors', authorId], queryFn: () => memoApi.authors.get(authorId) })

/** Who follows the author (`followers`) or whom they follow (`following`); loaded when the list opens. */
export const followListQuery = (authorId: string, direction: 'followers' | 'following') =>
  queryOptions({ queryKey: [...MEMO_KEY, 'authors', authorId, direction], queryFn: () => memoApi.authors[direction](authorId) })
