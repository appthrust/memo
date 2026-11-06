import { useSuspenseQuery } from '@tanstack/react-query'
import { ExternalLink, FileText, Newspaper, PenLine } from 'lucide-react'
import { useState } from 'react'
import { authorQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { useSession } from '../../shell/use-session'
import { Avatar, Badge, EmptyState, LinkButton, PageHeader, Section, useDocumentTitle } from '../../ui'
import { ArticleList } from '../timeline/article-list'
import { FollowButton } from './follow-button'
import { FollowListDialog } from './follow-list'

/**
 * `/authors/<id>`: name, the Directory profile link (when the author is linked
 * and Directory's browser origin is known), counts, フォロー (not on one's own
 * page) and their published articles.
 */
export function AuthorPage({ authorId }: { authorId: string }) {
  const { t } = useText()
  const { me } = useSession()
  const { data: profile } = useSuspenseQuery(authorQuery(authorId))
  const [list, setList] = useState<'followers' | 'following' | null>(null)
  useDocumentTitle(profile.author.displayName)
  const { author } = profile
  const directoryUrl =
    author.directoryPersonId && me.directory.publicUrl ? `${me.directory.publicUrl.replace(/\/+$/, '')}/people/${encodeURIComponent(author.directoryPersonId)}` : undefined
  const stats = [
    { label: t('memo.author.articles'), value: profile.articleCount, open: undefined },
    { label: t('memo.author.followers'), value: profile.followerCount, open: 'followers' as const },
    { label: t('memo.author.following'), value: profile.followingCount, open: 'following' as const },
  ]
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        media={<Avatar name={author.displayName} size="lg" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {author.displayName}
            {profile.isMe ? <Badge tone="accent">{t('memo.nav.you')}</Badge> : null}
          </span>
        }
        lead={
          directoryUrl ? (
            <a href={directoryUrl} className="inline-flex min-h-10 items-center gap-1 text-accent-strong hover:underline md:min-h-0">
              {t('memo.author.directoryProfile')}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          ) : undefined
        }
        actions={profile.isMe ? undefined : <FollowButton profile={profile} />}
      >
        <ul aria-label={t('memo.author.stats')} className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {stats.map((stat) => {
            const content = (
              <>
                <span className="text-base font-semibold text-stone-900 tabular-nums">{stat.value}</span>
                <span className="text-stone-500">{stat.label}</span>
              </>
            )
            return (
              <li key={stat.label}>
                {stat.open ? (
                  <button
                    type="button"
                    onClick={() => setList(stat.open)}
                    aria-haspopup="dialog"
                    className="-mx-1.5 flex min-h-10 items-baseline gap-1.5 rounded-md px-1.5 hover:bg-stone-100 md:min-h-8 md:items-center"
                  >
                    {content}
                  </button>
                ) : (
                  <span className="flex min-h-10 items-baseline gap-1.5 md:min-h-8 md:items-center">{content}</span>
                )}
              </li>
            )
          })}
        </ul>
        {profile.isMe && me.counts.drafts > 0 ? (
          <LinkButton href={paths.drafts} size="sm" icon={<FileText />} className="mt-3">
            {t('memo.author.drafts', { count: me.counts.drafts })}
          </LinkButton>
        ) : null}
      </PageHeader>
      <Section title={t('memo.author.published')}>
        <ArticleList
          feed={{ kind: 'author', authorId }}
          empty={
            <EmptyState
              icon={<Newspaper />}
              title={t('memo.author.emptyTitle')}
              body={profile.isMe ? t('memo.author.emptyMine') : undefined}
              action={
                profile.isMe ? (
                  <LinkButton href={paths.newArticle} tone="primary" icon={<PenLine />}>
                    {t('memo.nav.write')}
                  </LinkButton>
                ) : undefined
              }
            />
          }
        />
      </Section>
      <FollowListDialog
        author={author}
        direction={list}
        onOpenChange={(open) => {
          if (!open) setList(null)
        }}
      />
    </div>
  )
}
