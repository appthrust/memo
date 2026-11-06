import { useSuspenseQuery } from '@tanstack/react-query'
import { FileText, PenLine } from 'lucide-react'
import { draftsQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { paths } from '../../routes/paths'
import { EmptyState, LinkButton, PageHeader, useDocumentTitle } from '../../ui'
import { ArticleCard } from '../timeline/article-card'

/** `/drafts`: the caller's unpublished articles, last saved first; each opens in the editor. */
export function DraftsPage() {
  const { t } = useText()
  useDocumentTitle(t('memo.nav.drafts'))
  const { data: drafts } = useSuspenseQuery(draftsQuery)
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t('memo.nav.drafts')} lead={t('memo.drafts.lead')} />
      {drafts.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title={t('memo.drafts.emptyTitle')}
          body={t('memo.drafts.emptyBody')}
          action={
            <LinkButton href={paths.newArticle} tone="primary" icon={<PenLine />}>
              {t('memo.nav.write')}
            </LinkButton>
          }
        />
      ) : (
        <ul className="grid gap-3">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <ArticleCard article={draft} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
