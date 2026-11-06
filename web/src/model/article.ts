// Article write rules (design/platform/builtin-app-memo/README.md "Validation"),
// shared by the editor and the dev mock so both refuse the same input the
// server refuses.

export const MAX_TITLE_LENGTH = 120
export const MAX_BODY_BYTES = 100 * 1024

/** Characters as the server counts them (Unicode code points, not UTF-16 units). */
export function textLength(text: string): number {
  return Array.from(text).length
}

export type ArticleProblem = 'titleRequired' | 'titleTooLong' | 'bodyRequired' | 'bodyTooLarge'

/**
 * What the title and the body break (an empty object when the write is valid).
 * `publish`: the article is published after this write, so it needs a body.
 */
export function articleProblems(title: string, body: string, publish: boolean): { title?: ArticleProblem; body?: ArticleProblem } {
  const trimmed = title.trim()
  const problems: { title?: ArticleProblem; body?: ArticleProblem } = {}
  if (!trimmed) problems.title = 'titleRequired'
  else if (textLength(trimmed) > MAX_TITLE_LENGTH) problems.title = 'titleTooLong'
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) problems.body = 'bodyTooLarge'
  else if (publish && !body.trim()) problems.body = 'bodyRequired'
  return problems
}

/**
 * The plain-text preview the server stores as `excerpt` (domain.Excerpt):
 * link and image syntax reduced to their text, the markers `# * _ \` > -`
 * removed, whitespace collapsed, at most 160 characters.
 */
export function excerptOf(body: string): string {
  const text = body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>-]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
  return Array.from(text).slice(0, 160).join('')
}
