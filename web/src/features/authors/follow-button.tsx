import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserCheck, UserPlus } from 'lucide-react'
import { memoApi, type AuthorProfile } from '../../api/memo'
import { authorQuery, invalidateMemo } from '../../api/queries'
import { useText } from '../../i18n'
import { ActionError, Button } from '../../ui'

/**
 * フォロー toggle on someone else's author page. The follower count moves at
 * the click and settles to the server's answer; a failure restores it.
 */
export function FollowButton({ profile }: { profile: AuthorProfile }) {
  const { t } = useText()
  const client = useQueryClient()
  const key = authorQuery(profile.author.id).queryKey
  const mutation = useMutation({
    mutationFn: (follow: boolean) => (follow ? memoApi.authors.follow(profile.author.id) : memoApi.authors.unfollow(profile.author.id)),
    onMutate: async (follow) => {
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData(key)
      client.setQueryData(key, (current) =>
        current && current.followedByMe !== follow ? { ...current, followedByMe: follow, followerCount: Math.max(0, current.followerCount + (follow ? 1 : -1)) } : current
      )
      return { previous }
    },
    onError: (_error, _follow, context) => {
      if (context?.previous) client.setQueryData(key, context.previous)
    },
    onSuccess: (state) => client.setQueryData(key, (current) => current && { ...current, ...state }),
    // The フォロー中 timeline, the caller's counts and the follower lists change too.
    onSettled: () => invalidateMemo(client),
  })
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        tone={profile.followedByMe ? 'secondary' : 'primary'}
        icon={profile.followedByMe ? <UserCheck /> : <UserPlus />}
        aria-pressed={profile.followedByMe}
        onClick={() => mutation.mutate(!profile.followedByMe)}
      >
        {t(profile.followedByMe ? 'memo.author.followed' : 'memo.author.follow')}
      </Button>
      {mutation.isError ? <ActionError error={mutation.error} /> : null}
    </div>
  )
}
