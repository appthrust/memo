import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { memoApi, type ArticleSummary } from '../../api/memo'
import { articleQuery, invalidateMemo } from '../../api/queries'
import { useText } from '../../i18n'
import { Button, ConfirmDialog } from '../../ui'

/**
 * Delete with a confirmation (the owner, or a memo admin on someone else's
 * article: `asAdmin` names that). Afterwards a draft returns to the drafts page, a published article to home.
 */
export function DeleteArticle({ article, asAdmin = false, onDeleting }: { article: ArticleSummary; asAdmin?: boolean; onDeleting?: () => void }) {
  const { t } = useText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const mutation = useMutation({
    mutationFn: () => memoApi.articles.remove(article.id),
    onSuccess: async () => {
      onDeleting?.()
      // Leave the page first: refetching the open article now would answer 404.
      await navigate({ to: article.status === 'draft' ? '/drafts' : '/', replace: true })
      client.removeQueries({ queryKey: articleQuery(article.id).queryKey })
      await invalidateMemo(client)
    },
  })
  return (
    <>
      <Button tone="ghost" icon={<Trash2 />} className="text-bad-ink hover:bg-bad-soft hover:text-bad-ink" onClick={() => setOpen(true)}>
        {t(asAdmin ? 'memo.article.adminDelete' : 'memo.article.delete')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) mutation.reset()
        }}
        title={t('memo.article.deleteTitle')}
        body={t('memo.article.deleteBody', { title: article.title })}
        confirmLabel={t('memo.article.deleteConfirm')}
        tone="danger"
        onConfirm={() => mutation.mutate()}
        pending={mutation.isPending}
        error={mutation.error}
      />
    </>
  )
}
