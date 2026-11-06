import type { Author } from '../../api/memo'
import { paths } from '../../routes/paths'
import { Avatar, cn, HrefLink } from '../../ui'

/** Initials avatar and name, linking to the author page. */
export function AuthorLink({ author, size = 'sm', className }: { author: Author; size?: 'sm' | 'md'; className?: string }) {
  return (
    <HrefLink
      href={paths.author(author.id)}
      className={cn('inline-flex min-h-10 max-w-full items-center gap-2 rounded-md font-medium text-stone-700 hover:text-stone-950 hover:underline md:min-h-0', className)}
    >
      <Avatar name={author.displayName} size={size} />
      <span className="truncate">{author.displayName}</span>
    </HrefLink>
  )
}
