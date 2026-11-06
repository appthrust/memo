import { useQuery } from '@tanstack/react-query'
import type { Author } from '../../api/memo'
import { followListQuery } from '../../api/queries'
import { useText } from '../../i18n'
import { Dialog, Loading, LoadFailed } from '../../ui'
import { AuthorLink } from './author-link'

/** Who follows `author` (`followers`) or whom they follow (`following`), loaded when the dialog opens. */
export function FollowListDialog({
  author,
  direction,
  onOpenChange,
}: {
  author: Author
  direction: 'followers' | 'following' | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useText()
  const query = useQuery({ ...followListQuery(author.id, direction ?? 'followers'), enabled: direction !== null })
  return (
    <Dialog
      open={direction !== null}
      onOpenChange={onOpenChange}
      title={t(direction === 'following' ? 'memo.author.followingOf' : 'memo.author.followersOf', { name: author.displayName })}
    >
      {query.isPending ? (
        <Loading className="py-2" />
      ) : query.isError ? (
        <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <p className="text-stone-500">{t('memo.author.nobody')}</p>
      ) : (
        <ul className="-my-1 divide-y divide-stone-100">
          {query.data.map((person) => (
            <li key={person.id} className="py-1">
              <AuthorLink author={person} size="md" />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
