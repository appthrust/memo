// Shell, navigation, feedback and error wording shared by every screen.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const commonMessages = defineDashboardMessages({
  'memo.product': { defaultMessage: 'memo', translations: { ja: 'memo' } },
  'memo.productMark': { defaultMessage: 'M', translations: { ja: 'M' } },
  'memo.language.ja': { defaultMessage: '日本語', translations: { ja: '日本語' } },
  'memo.language.en': { defaultMessage: 'English', translations: { ja: 'English' } },
  'memo.nav.label': { defaultMessage: 'Memo sections', translations: { ja: 'memo のメニュー' } },
  'memo.nav.home': { defaultMessage: 'Home', translations: { ja: 'ホーム' } },
  'memo.nav.drafts': { defaultMessage: 'Drafts', translations: { ja: '下書き' } },
  'memo.nav.write': { defaultMessage: 'Write', translations: { ja: '書く' } },
  'memo.nav.you': { defaultMessage: 'You', translations: { ja: 'あなた' } },
  'memo.nav.language': { defaultMessage: 'Display language', translations: { ja: '表示言語' } },
  'memo.nav.skipToMain': { defaultMessage: 'Skip to main content', translations: { ja: '本文へ移動' } },
  'memo.common.loading': { defaultMessage: 'Loading…', translations: { ja: '読み込んでいます…' } },
  'memo.common.loadFailed': { defaultMessage: "Couldn't load this page", translations: { ja: '読み込めませんでした' } },
  'memo.common.retry': { defaultMessage: 'Try again', translations: { ja: 'もう一度読み込む' } },
  'memo.common.loadMore': { defaultMessage: 'Load more', translations: { ja: 'もっと読む' } },
  'memo.common.accessDenied': {
    defaultMessage: 'This account cannot use memo. Sign in again or ask an administrator.',
    translations: { ja: 'このアカウントでは memo を使えません。サインインし直すか、管理者に確認してください。' },
  },
  'memo.common.actionFailed': { defaultMessage: "Couldn't complete the action", translations: { ja: '操作を完了できませんでした' } },
  'memo.common.close': { defaultMessage: 'Close', translations: { ja: '閉じる' } },
  'memo.common.cancel': { defaultMessage: 'Cancel', translations: { ja: 'キャンセル' } },
  'memo.common.required': { defaultMessage: 'Required', translations: { ja: '必須' } },
  'memo.common.breadcrumbs': { defaultMessage: 'Breadcrumbs', translations: { ja: 'パンくずリスト' } },
  'memo.errors.transient': {
    defaultMessage: 'memo is temporarily unavailable. Try again in a moment.',
    translations: { ja: 'memo に一時的につながりません。少し待ってからもう一度お試しください。' },
  },
  'memo.errors.storeUnavailable': {
    defaultMessage: "memo's database is temporarily unavailable. Try again in a moment.",
    translations: { ja: 'memo のデータベースに一時的につながりません。少し待ってからもう一度お試しください。' },
  },
  'memo.errors.identityUnavailable': {
    defaultMessage: 'Sign-in could not be checked right now. Try again in a moment.',
    translations: { ja: 'サインインを確認できませんでした。少し待ってからもう一度お試しください。' },
  },
  'memo.errors.forbidden': { defaultMessage: "You don't have permission for this action.", translations: { ja: 'この操作をする権限がありません。' } },
  'memo.errors.notFound': {
    defaultMessage: 'This article no longer exists. It may have been deleted.',
    translations: { ja: 'この記事はもうありません。削除された可能性があります。' },
  },
  'memo.errors.invalid': { defaultMessage: 'Check the entered values.', translations: { ja: '入力内容を確認してください。' } },
  'memo.errors.selfFollow': { defaultMessage: "You can't follow yourself.", translations: { ja: '自分自身はフォローできません。' } },
  'memo.notFound.title': { defaultMessage: 'Page not found', translations: { ja: 'ページが見つかりません' } },
  'memo.notFound.body': {
    defaultMessage: 'The article or author may have been removed, or the address may be wrong.',
    translations: { ja: 'この記事や著者は削除されたか、アドレスが間違っている可能性があります。' },
  },
  'memo.notFound.home': { defaultMessage: 'Back to home', translations: { ja: 'ホームへ戻る' } },
})
