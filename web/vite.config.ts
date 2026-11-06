import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type ProxyOptions } from 'vite'

// Dev transport mirrors production: cmd/server serves the SPA,
// `/api/memo/v1/*` and the app switcher's `/launcher` from one origin, and
// the OIDC edge (Envoy) in front of it attaches Authorization. In dev `/api`
// and `/launcher` go to the in-repo mock (`bun run mock`,
// src/dev/mock-server.ts), which needs no token. To exercise a real memo server
// instead, point MEMO_API_UPSTREAM at it and either set MEMO_DEV_BEARER to the
// token the edge would attach (a local Go server) or MEMO_DEV_COOKIE_FILE to a
// file holding the `Cookie` header of an authenticated browser session
// (re-read per request so a refresher can rotate it). The proxy drops the
// browser Origin so upstreams treat calls as first-party.
// The mock port sits below Linux's ephemeral range (32768+), where outbound connections could already hold it.
const upstream = process.env.MEMO_API_UPSTREAM ?? `http://127.0.0.1:${process.env.MEMO_MOCK_PORT ?? 5236}`
const devBearer = process.env.MEMO_DEV_BEARER
const devCookieFile = process.env.MEMO_DEV_COOKIE_FILE
const proxy: ProxyOptions = {
  target: upstream,
  changeOrigin: true,
  configure(server) {
    server.on('proxyReq', (request) => {
      request.removeHeader('origin')
      if (devBearer) request.setHeader('authorization', `Bearer ${devBearer}`)
      if (devCookieFile) request.setHeader('cookie', readFileSync(devCookieFile, 'utf8').trim())
    })
  },
}

export default defineConfig({
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic' },
  server: {
    port: Number(process.env.MEMO_PORT ?? 5238),
    strictPort: true,
    proxy: { '/api': proxy, '/launcher': proxy },
  },
})
