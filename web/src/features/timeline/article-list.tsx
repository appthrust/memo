import { useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { timelineQuery, type Feed } from '../../api/queries'
import { useText } from '../../i18n'
import { ActionError, Button } from '../../ui'
import { ArticleCard } from './article-card'

/** Published articles of `feed`, newest first, one more cursor page per もっと読む; `empty` when there are none. */
export function ArticleList({ feed, empty }: { feed: Feed; empty: ReactNode }) {
  const { t } = useText()
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, error } = useSuspenseInfiniteQuery(timelineQuery(feed))
  const articles = data.pages.flatMap((page) => page.items)
  if (articles.length === 0) return <>{empty}</>
  return (
    <div>
      <ul className="grid gap-3">
        {articles.map((article) => (
          <li key={article.id}>
            <ArticleCard article={article} />
          </li>
        ))}
      </ul>
      {isFetchNextPageError ? <ActionError error={error} className="mt-4" /> : null}
      {hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button icon={<ChevronDown />} loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t('memo.common.loadMore')}
          </Button>
        </div>
      ) : data.pages.length > 1 ? (
        <p className="mt-6 text-center text-xs text-stone-500">{t('memo.timeline.end')}</p>
      ) : null}
    </div>
  )
}
