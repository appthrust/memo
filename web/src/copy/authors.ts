// Author page, follow and follower lists.
import { defineDashboardMessages } from '@appthrust/platform-dashboard-i18n'

export const authorMessages = defineDashboardMessages({
  'memo.author.stats': { defaultMessage: 'Activity', translations: { ja: '活動' } },
  'memo.author.articles': { defaultMessage: 'articles', translations: { ja: '記事' } },
  'memo.author.followers': { defaultMessage: 'followers', translations: { ja: 'フォロワー' } },
  'memo.author.following': { defaultMessage: 'following', translations: { ja: 'フォロー中' } },
  'memo.author.follow': { defaultMessage: 'Follow', translations: { ja: 'フォロー' } },
  'memo.author.followed': { defaultMessage: 'Followed', translations: { ja: 'フォロー中' } },
  'memo.author.directoryProfile': { defaultMessage: 'Directory profile', translations: { ja: 'ディレクトリのプロフィール' } },
  'memo.author.drafts': { defaultMessage: '{count} drafts', translations: { ja: '下書き {count} 件' } },
  'memo.author.published': { defaultMessage: 'Published articles', translations: { ja: '公開した記事' } },
  'memo.author.emptyTitle': { defaultMessage: 'No published articles yet', translations: { ja: 'まだ公開した記事はありません' } },
  'memo.author.emptyMine': { defaultMessage: 'Articles you publish appear here.', translations: { ja: '記事を公開すると、ここに並びます。' } },
  'memo.author.followersOf': { defaultMessage: "{name}'s followers", translations: { ja: '{name} のフォロワー' } },
  'memo.author.followingOf': { defaultMessage: 'People {name} follows', translations: { ja: '{name} がフォロー中の人' } },
  'memo.author.nobody': { defaultMessage: 'No one yet.', translations: { ja: 'まだいません。' } },
})
