import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Heart } from 'lucide-react'
import { memoApi, type Article } from '../../api/memo'
import { articleQuery, invalidateMemo } from '../../api/queries'
import { useText } from '../../i18n'
import { ActionError, cn } from '../../ui'

/**
 * スキ toggle for a published article. The count moves at the click
 * (optimistic) and settles to the server's answer; a failure restores the
 * previous state and explains itself under the button.
 */
export function LikeButton({ article }: { article: Article }) {
  const { t } = useText()
  const client = useQueryClient()
  const key = articleQuery(article.id).queryKey
  const mutation = useMutation({
    mutationFn: (like: boolean) => (like ? memoApi.articles.like(article.id) : memoApi.articles.unlike(article.id)),
    onMutate: async (like) => {
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData(key)
      client.setQueryData(key, (current) => current && current.likedByMe !== like ? { ...current, likedByMe: like, likeCount: Math.max(0, current.likeCount + (like ? 1 : -1)) } : current)
      return { previous }
    },
    onError: (_error, _like, context) => {
      if (context?.previous) client.setQueryData(key, context.previous)
    },
    onSuccess: (state) => client.setQueryData(key, (current) => current && { ...current, ...state }),
    // Timelines and author pages show the count too.
    onSettled: () => invalidateMemo(client),
  })
  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        aria-pressed={article.likedByMe}
        onClick={() => mutation.mutate(!article.likedByMe)}
        className={cn(
          'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors select-none',
          article.likedByMe ? 'border-like/30 bg-like-soft text-like' : 'border-stone-300 bg-white text-stone-700 hover:border-like/40 hover:text-like'
        )}
      >
        <Heart aria-hidden className={cn('size-4 transition-transform', article.likedByMe ? 'scale-110 fill-current' : undefined)} />
        {t('memo.article.like')}
        <span className="tabular-nums" aria-live="polite">
          {article.likeCount}
        </span>
      </button>
      {mutation.isError ? <ActionError error={mutation.error} /> : null}
    </div>
  )
}
