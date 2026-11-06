// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the memo contract (`/api/memo/v1/*`, ./mock-memo) and the app switcher's
// `GET /launcher` on one port; Vite proxies both here (vite.config.ts).
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { memoRoutes } from './mock-memo'

const port = Number(process.env.MEMO_MOCK_PORT ?? 5236)
const launcher = createMockLauncherHandler(mockLauncherEntries('memo'))

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    return launcher(request) ?? (await memoRoutes(request, url)) ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
  },
})

console.log(`memo mock API on http://${server.hostname}:${server.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'})`)
