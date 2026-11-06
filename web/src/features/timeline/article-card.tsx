import { Heart } from 'lucide-react'
import type { ArticleSummary } from '../../api/memo'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { Badge, cn, formatDate, HrefLink } from '../../ui'
import { AuthorLink } from '../authors/author-link'

/**
 * One article in a list. A published card links to the article and shows its
 * author, publication date and スキ; a draft card (the drafts page) links to
 * the editor and shows when it was last saved. The title link covers the card;
 * the author link sits above it.
 */
export function ArticleCard({ article }: { article: ArticleSummary }) {
  const { t, locale } = useText()
  const draft = article.status === 'draft'
  return (
    <article className="group relative rounded-lg border border-line bg-white px-4 py-4 transition-colors hover:border-stone-300 sm:px-5">
      {draft ? null : (
        <div className="relative z-[1] mb-2 flex min-w-0 items-center gap-2 text-xs text-stone-500">
          <AuthorLink author={article.author} />
          {article.publishedAt ? (
            <>
              <span aria-hidden>·</span>
              <time dateTime={article.publishedAt} className="shrink-0">
                {formatDate(article.publishedAt, locale)}
              </time>
            </>
          ) : null}
        </div>
      )}
      <h2 className="text-base leading-snug font-semibold break-words text-stone-900 sm:text-lg">
        <HrefLink
          href={draft ? paths.editArticle(article.id) : paths.article(article.id)}
          className="rounded-sm group-hover:text-accent-strong after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
        >
          {article.title}
        </HrefLink>
      </h2>
      {article.excerpt ? <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-stone-600">{article.excerpt}</p> : null}
      <div className={cn('mt-3 flex items-center gap-3 text-xs text-stone-500', draft ? undefined : 'justify-end')}>
        {draft ? (
          <>
            <Badge>{t('memo.article.draft')}</Badge>
            <time dateTime={article.updatedAt}>{t('memo.drafts.saved', { date: formatDate(article.updatedAt, locale) })}</time>
          </>
        ) : (
          <span className={cn('inline-flex items-center gap-1', article.likedByMe ? 'text-like' : undefined)}>
            <Heart aria-hidden className={cn('size-3.5', article.likedByMe ? 'fill-current' : undefined)} />
            <span className="sr-only">{t('memo.article.likeCount', { count: article.likeCount })}</span>
            <span aria-hidden className="tabular-nums">
              {article.likeCount}
            </span>
          </span>
        )}
      </div>
    </article>
  )
}
