import { useSuspenseQuery } from '@tanstack/react-query'
import { PenLine } from 'lucide-react'
import { articleQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { Badge, formatDate, LinkButton, Markdown, Notice, useDocumentTitle } from '../../ui'
import { AuthorLink } from '../authors/author-link'
import { DeleteArticle } from './delete-article'
import { LikeButton } from './like-button'

/** `/articles/<id>`: the rendered article, its author, スキ, and the owner's (or an admin's) actions. */
export function ArticlePage({ articleId }: { articleId: string }) {
  const { t, locale } = useText()
  const { me } = useSession()
  const { data: article } = useSuspenseQuery(articleQuery(articleId))
  useDocumentTitle(article.title)
  const mine = article.author.id === me.author.id
  const draft = article.status === 'draft'
  return (
    <article className="mx-auto max-w-2xl">
      {draft ? (
        <Notice
          className="mb-6"
          actions={
            <LinkButton href={paths.editArticle(article.id)} size="sm" icon={<PenLine />}>
              {t('memo.article.edit')}
            </LinkButton>
          }
        >
          {t('memo.article.draftNotice')}
        </Notice>
      ) : null}
      <header>
        {draft ? (
          <div className="mb-2">
            <Badge>{t('memo.article.draft')}</Badge>
          </div>
        ) : null}
        <h1 className="text-2xl leading-snug font-bold tracking-tight break-words text-stone-900 sm:text-3xl">{article.title}</h1>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2 text-sm text-stone-500">
            <AuthorLink author={article.author} size="md" />
            {article.publishedAt ? (
              <>
                <span aria-hidden>·</span>
                <time dateTime={article.publishedAt} className="shrink-0">
                  {t('memo.article.publishedOn', { date: formatDate(article.publishedAt, locale) })}
                </time>
              </>
            ) : null}
          </div>
          {mine || me.roles.memoAdmin ? (
            <div role="group" aria-label={t('memo.article.actions')} className="flex items-center gap-1">
              {mine ? (
                <LinkButton href={paths.editArticle(article.id)} tone="ghost" icon={<PenLine />}>
                  {t('memo.article.edit')}
                </LinkButton>
              ) : null}
              <DeleteArticle article={article} asAdmin={!mine} />
            </div>
          ) : null}
        </div>
      </header>
      {article.body.trim() ? <Markdown source={article.body} className="mt-8" /> : <p className="mt-8 text-stone-500">{t('memo.article.noBody')}</p>}
      {draft ? null : (
        <footer className="mt-12 border-t border-line pt-6">
          <LikeButton article={article} />
        </footer>
      )}
    </article>
  )
}
