import { Newspaper, PenLine, UserPlus } from 'lucide-react'
import { useText } from '../../i18n'
import { paths, type TimelineTab } from '../../routes/paths'
import { cn, EmptyState, HrefLink, LinkButton, useDocumentTitle } from '../../ui'
import { ArticleList } from './article-list'

const TAB = 'relative flex min-h-10 items-center px-3 text-sm font-medium text-stone-500 hover:text-stone-900'
const TAB_ACTIVE = 'text-stone-900 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'

/** `/`: the published timeline, everyone's (すべて) or the followed authors' (フォロー中). */
export function TimelinePage({ tab }: { tab: TimelineTab }) {
  const { t } = useText()
  useDocumentTitle(t('memo.nav.home'))
  const tabs: { tab: TimelineTab; label: string }[] = [
    { tab: 'all', label: t('memo.timeline.all') },
    { tab: 'following', label: t('memo.timeline.following') },
  ]
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="sr-only">{t('memo.nav.home')}</h1>
      <nav aria-label={t('memo.timeline.tabs')} className="mb-5 flex border-b border-line">
        {tabs.map((item) => (
          <HrefLink key={item.tab} href={paths.timeline(item.tab)} className={TAB} activeProps={{ className: cn(TAB, TAB_ACTIVE) }}>
            {item.label}
          </HrefLink>
        ))}
      </nav>
      {/* Each tab keeps its own pages; switching back shows what was already loaded. */}
      <ArticleList
        key={tab}
        feed={{ kind: tab }}
        empty={
          tab === 'following' ? (
            <EmptyState
              icon={<UserPlus />}
              title={t('memo.timeline.emptyFollowing.title')}
              body={t('memo.timeline.emptyFollowing.body')}
              action={<LinkButton href={paths.timeline('all')}>{t('memo.timeline.showAll')}</LinkButton>}
            />
          ) : (
            <EmptyState
              icon={<Newspaper />}
              title={t('memo.timeline.emptyAll.title')}
              body={t('memo.timeline.emptyAll.body')}
              action={
                <LinkButton href={paths.newArticle} tone="primary" icon={<PenLine />}>
                  {t('memo.nav.write')}
                </LinkButton>
              }
            />
          )
        }
      />
    </div>
  )
}
