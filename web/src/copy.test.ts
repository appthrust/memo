import { createDashboardTranslator } from '@appthrust/platform-dashboard-i18n'
import { describe, expect, test } from 'bun:test'
import { catalogs } from './copy'

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort()

describe('memo copy catalogs', () => {
  const messages = catalogs.flatMap((catalog) => Object.entries(catalog))

  test('every message is namespaced, translated to Japanese and keeps its placeholders', () => {
    for (const [id, message] of messages) {
      expect(id.startsWith('memo.')).toBe(true)
      const ja = message.translations.ja
      expect(ja, id).toBeTruthy()
      expect(placeholders(ja ?? ''), id).toEqual(placeholders(message.defaultMessage))
    }
  })

  test('ids are unique, so both languages build a translator', () => {
    expect(new Set(messages.map(([id]) => id)).size).toBe(messages.length)
    const ja = createDashboardTranslator('ja', catalogs)
    const en = createDashboardTranslator('en', catalogs)
    expect(ja.t('memo.nav.home')).toBe('ホーム')
    expect(en.t('memo.nav.home')).toBe('Home')
    expect(ja.t('memo.nav.write')).toBe('書く')
    expect(ja.t('memo.article.likeCount', { count: 3 })).toBe('スキ 3')
    expect(en.t('memo.editor.titleCount', { count: 12, max: 120 })).toBe('12 / 120 characters')
  })
})
