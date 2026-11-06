// All memo wording, as dashboard-i18n catalogs: the English source is the
// `defaultMessage`, Japanese (the audience's default) is `translations.ja`.
// Screens read it through `useText().t(id, values)` (src/i18n.tsx); no screen
// hardcodes user-facing text.
import type { DashboardMessageCatalog } from '@appthrust/platform-dashboard-i18n'
import { articleMessages } from './articles'
import { authorMessages } from './authors'
import { commonMessages } from './common'

export const catalogs: readonly DashboardMessageCatalog[] = [commonMessages, articleMessages, authorMessages]

export type MessageId = keyof typeof commonMessages | keyof typeof articleMessages | keyof typeof authorMessages
