import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useNavigate } from '@tanstack/react-router'
import { Eye, PenLine, Send } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { memoApi, type Article } from '../../api/memo'
import { articleQuery, invalidateMemo } from '../../api/queries'
import type { MessageId } from '../../copy'
import { useText } from '../../i18n'
import { articleProblems, MAX_TITLE_LENGTH, textLength, type ArticleProblem } from '../../model/article'
import { paths } from '../../routes/paths'
import { ActionError, Badge, Button, cn, Field, Markdown, Notice, PageHeader, TextArea, TextInput, useDocumentTitle } from '../../ui'
import { DeleteArticle } from './delete-article'

/** What a button does: a draft is saved or published; a published article is updated or reverted to a draft. */
type EditorAction = 'saveDraft' | 'publish' | 'update' | 'unpublish'

const PROBLEM_TEXT: Record<ArticleProblem, MessageId> = {
  titleRequired: 'memo.editor.titleRequired',
  titleTooLong: 'memo.editor.titleTooLong',
  bodyRequired: 'memo.editor.bodyRequired',
  bodyTooLarge: 'memo.editor.bodyTooLarge',
}

const PANE = 'min-h-[24rem] md:h-[calc(100dvh-16rem)] md:min-h-[28rem]'

/**
 * `/articles/new` (no `article`) and `/articles/<id>/edit`: title, Markdown
 * text and its live preview — side by side from `md`, switched by a toggle
 * below. Leaving with unsaved changes asks first.
 */
export function EditorPage({ article }: { article?: Article }) {
  const { t, locale } = useText()
  const client = useQueryClient()
  const navigate = useNavigate()
  const id = useId()
  const [title, setTitle] = useState(article?.title ?? '')
  const [body, setBody] = useState(article?.body ?? '')
  const [saved, setSaved] = useState({ title: article?.title ?? '', body: article?.body ?? '' })
  const [view, setView] = useState<'source' | 'preview'>('source')
  // Validation shows after the first attempt, for that attempt's target status.
  const [attempt, setAttempt] = useState<{ publish: boolean } | null>(null)
  const [flash, setFlash] = useState<'saved' | 'unpublished' | null>(null)
  // Set right before an intended navigation (after a save or delete), which must not ask.
  const leaving = useRef(false)
  const published = article?.status === 'published'
  const dirty = title !== saved.title || body !== saved.body
  useDocumentTitle(t(article ? 'memo.editor.editTitle' : 'memo.editor.newTitle'))
  useBlocker({
    shouldBlockFn: () => dirty && !leaving.current && !window.confirm(t('memo.editor.leave')),
    enableBeforeUnload: () => dirty && !leaving.current,
  })

  const mutation = useMutation({
    mutationFn: (action: EditorAction) => {
      if (!article) return memoApi.articles.create({ title, body, publish: action === 'publish' })
      const status = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : undefined
      return memoApi.articles.update(article.id, { title, body, ...(status ? { status } : {}) })
    },
    onSuccess: async (result, action) => {
      client.setQueryData(articleQuery(result.id).queryKey, result)
      if (action === 'publish' || action === 'update') {
        leaving.current = true
        await navigate({ to: '/articles/$articleId', params: { articleId: result.id } })
      } else if (!article) {
        // A new draft continues in its own editor URL, which shows when it was saved.
        leaving.current = true
        await navigate({ to: '/articles/$articleId/edit', params: { articleId: result.id }, replace: true })
      } else {
        setTitle(result.title)
        setSaved({ title: result.title, body: result.body })
        setAttempt(null)
        setFlash(action === 'unpublish' ? 'unpublished' : 'saved')
      }
      await invalidateMemo(client)
    },
  })

  const run = (action: EditorAction) => {
    const publish = action === 'publish' || action === 'update'
    setAttempt({ publish })
    setFlash(null)
    const problems = articleProblems(title, body, publish)
    if (problems.title || problems.body) return
    mutation.mutate(action)
  }
  const problems = attempt ? articleProblems(title, body, attempt.publish) : {}
  const titleError = problems.title ? t(PROBLEM_TEXT[problems.title], { max: MAX_TITLE_LENGTH }) : undefined
  const bodyError = problems.body ? t(PROBLEM_TEXT[problems.body]) : undefined
  const pending = mutation.isPending ? mutation.variables : undefined

  const actions = published ? (
    <>
      <Button onClick={() => run('unpublish')} loading={pending === 'unpublish'} disabled={mutation.isPending}>
        {t('memo.editor.unpublish')}
      </Button>
      <Button tone="primary" icon={<Send />} onClick={() => run('update')} loading={pending === 'update'} disabled={mutation.isPending}>
        {t('memo.editor.update')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => run('saveDraft')} loading={pending === 'saveDraft'} disabled={mutation.isPending}>
        {t('memo.editor.saveDraft')}
      </Button>
      <Button tone="primary" icon={<Send />} onClick={() => run('publish')} loading={pending === 'publish'} disabled={mutation.isPending}>
        {t('memo.editor.publish')}
      </Button>
    </>
  )

  return (
    <div>
      <PageHeader
        title={t(article ? 'memo.editor.editTitle' : 'memo.editor.newTitle')}
        breadcrumbs={article && published ? [{ label: t('memo.editor.backToArticle'), href: paths.article(article.id) }] : undefined}
        lead={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={published ? 'accent' : 'neutral'}>{t(published ? 'memo.editor.statusPublished' : 'memo.editor.statusDraft')}</Badge>
            {dirty ? (
              <span>{t('memo.editor.unsaved')}</span>
            ) : article ? (
              <time dateTime={article.updatedAt}>
                {t('memo.editor.lastSaved', { time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(article.updatedAt)) })}
              </time>
            ) : null}
          </span>
        }
        actions={actions}
      />
      <div className="space-y-4">
        {flash ? <Notice tone="success">{t(flash === 'saved' ? 'memo.editor.saved' : 'memo.editor.unpublished')}</Notice> : null}
        {mutation.isError ? <ActionError error={mutation.error} /> : null}
        <Field
          id={`${id}-title`}
          label={t('memo.editor.titleLabel')}
          required
          error={titleError}
          aside={t('memo.editor.titleCount', { count: textLength(title.trim()), max: MAX_TITLE_LENGTH })}
        >
          <TextInput
            id={`${id}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('memo.editor.titlePlaceholder')}
            invalid={Boolean(titleError)}
            autoFocus={!article}
            className="h-11 text-base font-semibold md:h-11"
          />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label htmlFor={`${id}-body`} className="text-sm font-medium text-stone-800">
              {t('memo.editor.bodyLabel')}
            </label>
            {/* Below `md` one pane shows at a time. */}
            <div role="group" aria-label={t('memo.editor.mode')} className="flex rounded-md border border-stone-300 bg-white p-0.5 md:hidden">
              {(['source', 'preview'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => setView(option)}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded px-3 text-xs font-medium [&_svg]:size-3.5',
                    view === option ? 'bg-accent-soft text-accent-strong' : 'text-stone-600 hover:text-stone-900'
                  )}
                >
                  {option === 'source' ? <PenLine aria-hidden /> : <Eye aria-hidden />}
                  {t(option === 'source' ? 'memo.editor.source' : 'memo.editor.preview')}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className={cn(view === 'preview' ? 'max-md:hidden' : undefined)}>
              <TextArea
                id={`${id}-body`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={t('memo.editor.bodyPlaceholder')}
                invalid={Boolean(bodyError)}
                spellCheck={false}
                className={cn(PANE, 'resize-none font-mono text-[13px] md:resize-none')}
              />
              {bodyError ? (
                <p id={`${id}-body-error`} className="mt-1.5 text-xs text-bad-ink">
                  {bodyError}
                </p>
              ) : null}
            </div>
            <section aria-label={t('memo.editor.preview')} className={cn(PANE, 'overflow-y-auto rounded-md border border-line bg-white px-5 py-4', view === 'source' ? 'max-md:hidden' : undefined)}>
              <p aria-hidden className="mb-3 text-[11px] font-medium tracking-wide text-stone-400 uppercase max-md:hidden">
                {t('memo.editor.preview')}
              </p>
              {title.trim() ? <h1 className="mb-5 text-2xl leading-snug font-bold break-words text-stone-900">{title.trim()}</h1> : null}
              {body.trim() ? <Markdown source={body} /> : <p className="text-sm text-stone-400">{t('memo.editor.previewEmpty')}</p>}
            </section>
          </div>
        </div>
        {article ? (
          <div className="flex justify-end border-t border-line pt-4">
            <DeleteArticle article={article} onDeleting={() => (leaving.current = true)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
