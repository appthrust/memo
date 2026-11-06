// Page routes. `/articles/new` is declared next to `/articles/$articleId`;
// TanStack ranks the static segment first, so "new" is never looked up as an id.
import { useSuspenseQuery } from '@tanstack/react-query'
import { createRoute, redirect } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { articleQuery, authorQuery, draftsQuery, meQuery, timelineQuery } from '../api/queries'
import { ArticlePage } from '../features/articles/article-page'
import { EditorPage } from '../features/articles/editor-page'
import { AuthorPage } from '../features/authors/author-page'
import { DraftsPage } from '../features/drafts/drafts-page'
import { TimelinePage } from '../features/timeline/timeline-page'
import { useText } from '../i18n'
import { useSession } from '../shell/use-session'
import { EmptyState, LinkButton, useDocumentTitle } from '../ui'
import { paths, type TimelineTab } from './paths'
import { notFoundOn404, rootRoute } from './root'

type TimelineSearch = { feed?: 'following' }

export const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // `?feed=following` is the フォロー中 tab; anything else is すべて.
  validateSearch: (search: Record<string, unknown>): TimelineSearch => (search.feed === 'following' ? { feed: 'following' } : {}),
  loaderDeps: ({ search }) => ({ tab: (search.feed ?? 'all') as TimelineTab }),
  loader: ({ context, deps }) => context.queryClient.ensureInfiniteQueryData(timelineQuery({ kind: deps.tab })),
  component: function TimelineRoute() {
    const { feed } = timelineRoute.useSearch()
    return <TimelinePage tab={feed ?? 'all'} />
  },
})

export const newArticleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles/new',
  component: () => <EditorPage />,
})

export const articleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles/$articleId',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(articleQuery(params.articleId)).catch(notFoundOn404),
  component: function ArticleRoute() {
    const { articleId } = articleRoute.useParams()
    return <ArticlePage key={articleId} articleId={articleId} />
  },
})

/** Someone else's (published) article: only its author edits it, an admin included. */
function NotOwner({ articleId }: { articleId: string }) {
  const { t } = useText()
  useDocumentTitle(t('memo.editor.notOwnerTitle'))
  return (
    <div className="mx-auto max-w-md py-12">
      <EmptyState
        icon={<Lock />}
        heading="h1"
        title={t('memo.editor.notOwnerTitle')}
        body={t('memo.editor.notOwnerBody')}
        action={<LinkButton href={paths.article(articleId)}>{t('memo.editor.backToArticle')}</LinkButton>}
      />
    </div>
  )
}

export const editArticleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles/$articleId/edit',
  loader: ({ context, params }) => context.queryClient.ensureQueryData(articleQuery(params.articleId)).catch(notFoundOn404),
  component: function EditArticleRoute() {
    const { articleId } = editArticleRoute.useParams()
    const { me } = useSession()
    const { data: article } = useSuspenseQuery(articleQuery(articleId))
    if (article.author.id !== me.author.id) return <NotOwner articleId={articleId} />
    return <EditorPage key={article.id} article={article} />
  },
})

export const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drafts',
  loader: ({ context }) => context.queryClient.ensureQueryData(draftsQuery),
  component: DraftsPage,
})

export const authorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/authors/$authorId',
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(authorQuery(params.authorId)).catch(notFoundOn404),
      context.queryClient.ensureInfiniteQueryData(timelineQuery({ kind: 'author', authorId: params.authorId })),
    ])
  },
  component: function AuthorRoute() {
    const { authorId } = authorRoute.useParams()
    return <AuthorPage key={authorId} authorId={authorId} />
  },
})

export const meRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me',
  // The root already loaded `GET /me`; this only forwards to the caller's author page.
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    throw redirect({ to: '/authors/$authorId', params: { authorId: me.author.id }, replace: true })
  },
})

export const routeTree = rootRoute.addChildren([timelineRoute, newArticleRoute, articleRoute, editArticleRoute, draftsRoute, authorRoute, meRoute])
