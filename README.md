# Memo

Memo is AppThrust's Markdown publishing application: write drafts, publish articles,
follow authors, and like articles. A Go server serves the React SPA, the authenticated
`/api/memo/v1` API, the shared app launcher, and `/healthz`, `/readyz`, and `/releasez`.
PostgreSQL stores application data. Directory optionally enriches author profiles.
The app is built and released independently of the platform.

## Source and layout

Imported from `appthrust/platform` commit
`27347914ee15817f27a42055160b42506edc73e6`:

- `cmd/memo-server/` → `cmd/server/`, including API, domain, storage, SQL migrations,
  OpenAPI document, and tests. Internal imports use `github.com/appthrust/memo`.
- `dashboard/packages/memo/` → `web/`, including the SPA, development mock, and tests.
- Neither source directory contained a README at the imported revision.

The public Go SDK is `github.com/appthrust/appserver-go v0.8.0` (PR #10, commit
`78866523da5289d828f0ba13d325d31f590c6f68`); no platform checkout, module replacement,
or private Go credential is required. The launcher and i18n
packages use the published `^0.1.0` GitHub Packages versions rather than workspace
packages. Tailwind scans the installed launcher package for its classes.

## Develop

Use Go 1.26 or newer and Bun 1.4.1 (the CI and image version).

```sh
go build ./... && go test ./...
go vet ./...
cd web
# GitHub Packages requires a token with read:packages access.
export NODE_AUTH_TOKEN="$(gh auth token)"
bun install --frozen-lockfile
bun run typecheck
bun run build:image
```

For local UI development, run `bun run mock` and `bun run dev` in separate terminals
in `web/`. The mock defaults to port 5236 and Vite to port 5238. To use a real server,
set `MEMO_API_UPSTREAM` plus `MEMO_DEV_BEARER` or `MEMO_DEV_COOKIE_FILE` as described in
`web/vite.config.ts`.

Run the server with `go run ./cmd/server --static-dir web/dist`. Configure:

- `PLATFORM_API_URL`, `PLATFORM_PROJECT_ID`, and the platform OIDC identity settings.
- `MEMO_DATABASE_URL` (or `DATABASE_URL`) for PostgreSQL. `MEMO_DEV_SEED=1` enables
  development seed data on an empty database.
- `MEMO_PUBLIC_URL` for the HTTPS browser origin.
- `MEMO_DIRECTORY_URL` and `MEMO_DIRECTORY_PUBLIC_URL` for optional Directory links.
- `MEMO_STATIC_DIR` or `--static-dir` to override `/srv/memo`.

The database connection starts asynchronously. While connecting, `/readyz` is 503
and `/healthz` remains 200. Missing database configuration leaves the API returning
`memo_store_unavailable` (503). `/api/memo/v1/openapi.json` exposes the API document
when the API is available. `/releasez` uses `MEMO_RELEASE_VERSION` and
`MEMO_ARTIFACT_DIGEST` supplied by the catalog.

### Signed author keys: upgrade and rollback

This release requires **both** `appserver-go v0.8.0` and a Platform API containing
[appthrust/platform#7087](https://github.com/appthrust/platform/pull/7087).
The SDK tag is published. Ink already includes #7087; Craftsman's first delivery
(`dev-0271704de697`) does not: it requires the second, #7087-containing delivery.
Do not merge or deploy this app update to an estate before both prerequisites hold.
Neither an SDK upgrade nor an estate upgrade alone authorizes a Memo rollout.

Recorded deployment: **ink**, `pj-eee7fa8eabbc/memo`,
`https://memo.pj-eee7fa8eabbc.appthrust.ink`. Nexus's 2026-11-13 inventory
(`features/security/permission/app-authorization.md`, section 15.4) records Memo
as absent from Craftsman and Cloud. Current live state is **[未確認]**; this change
does not inspect or modify any cluster.

Author identity is now `Identity.Access.Principal`, the platform-signed `u_…`
person key. Existing author ULIDs, article ownership references, likes, follows,
Project-role checks, and Directory/OIDC display-name rules are unchanged.
Memo never computes a live caller's key from `sub`. Missing signed facts return
HTTP 503, `access_unavailable`, with a message identifying the missing signed
principal and the #7087 prerequisite. A locally parsed bearer without the
exchange is also rejected, not silently mapped to a subject.

On each authenticated request that resolves an author, Memo first looks up the
signed principal. If it is absent, Memo locks the row matching the SDK's verified
bearer subject **only when its principal is NULL**, then attaches the signed
principal transactionally. It does not derive a principal from a guessed issuer.
The author keeps its ULID, articles, likes, follows, and Directory link. Subsequent
sign-ins resolve by principal without rewriting the identity. Conflicting claims
fail closed with HTTP 409, `author_principal_conflict`; a subject can never select
an author already keyed to a different principal.

Rows whose users never sign in again remain subject-keyed and inert: nobody acts
as those authors until a verified sign-in rekeys them. Their existing published
content and relationships remain visible. New authors store only the signed
principal; retained historical subjects also remain available for rollback.

Migration (a maintenance-window cutover, **not** a mixed-version rolling upgrade):

1. Verify the prerequisites, record the old image digest, and take a PostgreSQL
   backup. Stop every old Memo writer before starting the new version: old binaries
   still write subject-keyed rows. Retain the backup and image through rollback.
2. Roll out the new binary. **No migration environment variable is required.**
   Migration `002_author_principal.sql` adds the unique `authors.principal` column
   and retains `subject` as nullable rollback evidence. With
   `MEMO_LEGACY_OIDC_ISSUER` unset or empty, startup succeeds without backfilling;
   legacy principals stay NULL until their users sign in.
3. Verify a known author's sign-in, draft read/edit, stable ULID, Directory link,
   article/like/follow references, and the existing owner/admin restrictions.
   Unvisited authors may still have NULL principals; this does not block readiness.

Optional offline backfill: operators who can prove the exact issuer of **all**
stored legacy subjects may set `MEMO_LEGACY_OIDC_ISSUER` before startup. The old
schema did not save the issuer; do not infer it from the current URL, name, or email.
For unknown or mixed histories, leave it unset and use sign-in rekeying instead.
When set, `store.Open` locks the authors table, backfills missing principals
transactionally, and makes the principal column NOT NULL, as before. The exact
hash input is decimal **UTF-8 byte length** of issuer, `:`, issuer, subject (no
other separator, trimming, or normalization), followed by SHA-256, unpadded
base64url, and the `u_` prefix. PostgreSQL's built-in `sha256` is used; no extension
or extra database privilege is needed. Check the resulting keys and remove the
setting after completion; repeated startup leaves existing principals unchanged.

Rollback:

- **Before reopening writes:** stop the new binary, confirm every author's old
  subject is still present, drop the new `principal` column, restore `subject
  NOT NULL`, and delete only the `002_author_principal.sql` row from
  `memo_schema_migrations`, in one transaction. Then start the recorded old image.
  The previous author IDs and all relationships remain unchanged.
- **After new authors have been created:** do not blindly switch binaries or
  restore the backup over new writes. SHA-256 is not reversible. First obtain a
  verified issuer/subject crosswalk for every `subject IS NULL` author and match
  it to the stored principal using the exact hash above. Stop writers, populate
  only those missing subjects, check completeness and the old subject uniqueness
  constraint, then perform the same transactional rollback. If two issuers share
  a subject or any mapping cannot be verified, the old schema cannot safely
  represent the data: keep traffic closed and use a forward fix. Preserve a
  backup/export of all post-upgrade data; do not invent subjects or discard rows.
- The Platform API need not be rolled back: the old SDK ignores the added signed
  facts. Never deploy this binary against a pre-#7087 estate to recover availability.

The integration tests cover lazy rekeying, repeat sign-ins without identity
writes, conflicting claims, preserved relationships, and startup without an
issuer. Optional backfill output is compared with the exact Go reference
expression from platform `bfeb156136f5`, including multibyte issuers, subject
whitespace, delimiters, and repeated startup.

PostgreSQL integration tests are opt-in: they skip when both
`BUILTIN_APPSERVER_TEST_DATABASE_URL` and `BUILDER_CONSOLE_TEST_DATABASE_URL` are unset.
An explicitly configured test database must permit isolated schema creation.
Publisher renderer and mocked catalog API tests need no live services:

```sh
bun test hack/
```

Build the production image locally:

```sh
NODE_AUTH_TOKEN="$(gh auth token)" docker build --platform linux/amd64 \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t memo-local .
```

The image builds the SPA natively, cross-compiles the Go binary, and uses a
non-root distroless final stage. The executable is `/memo-server`, static files are
in `/srv/memo`, and port 8080 is exposed. Npm credentials enter the build only through
a required BuildKit secret, never through build arguments or committed files.

## Catalog and release

`catalog/entry.yaml` preserves the complete spec read from
`ApplicationStackDefinition/memo` in `appthrust-ink-pmc001` on 2026-11-06, excluding
cluster-owned metadata. The served compatibility floor is `0.1.0`, stream `0.1`,
with its original immutable `ghcr.io/appthrust/platform/memo` image. The next release
is **`0.2.0`**, stream **`0.2`**. No speculative new-version image is committed.

After the release prerequisites are available, push a SemVer tag such as `v0.2.0`.
The tag workflow:

1. Performs one multi-platform build on `ubuntu-24.04` for Linux amd64 and arm64,
   pushing `ghcr.io/appthrust/memo:<version>`.
2. Resolves and signs the image index digest with Cosign keyless signing.
3. Reads Cloud's persisted entry, merges its history with the committed floor,
   and appends the new version using `ghcr.io/appthrust/memo@sha256:<index-digest>`.
   The new version alone is default; earlier versions remain served. Reusing a
   version with different immutable images is rejected.
4. PUTs `/api/v1/catalog/entries/memo`, then POSTs `/api/v1/catalog/publish`.
   HTTP 202 with state `queued` means Cloud dispatched publication; HTTP 200 with
   state `snapshot` requires the workflow to dispatch the Cloud repository event
   using a short-lived GitHub App installation token.
5. Waits up to ten minutes for the signed catalog artifact to contain the exact
   Memo version and image digest. Dispatch alone is not publication success.

Publication commands used by the workflow:

```sh
bun hack/publish-entry.ts submit --version 0.2.0 --digest sha256:<image-index-digest>
bun hack/publish-entry.ts await --version 0.2.0 --digest sha256:<image-index-digest>
```

Writers are serialized by `memo-catalog-publish`; the workflow is guarded to
`appthrust/memo`. Required settings are repository secret `CLOUD_CATALOG_ADMIN_TOKEN`,
optional variable `CLOUD_API_URL` (default `https://api.appthrust.com`), and organization
secrets `APPTHRUST_GITHUB_ACTIONS_APP_ID` and `APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`.
The App must be installed on `appthrust/cloud` with Contents write permission.
GitHub Packages must grant this repository's `GITHUB_TOKEN` read access to
`@appthrust/app-launcher` and `@appthrust/platform-dashboard-i18n`. Make the GHCR image
public after its first publication.

`await` uses ORAS to verify the catalog index digest and Cosign to verify its signer:
`https://github.com/appthrust/cloud/.github/workflows/catalog-publish.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. It does not require the Cloud
admin token.

An existing installation moving from `ghcr.io/appthrust/platform/memo` requires an
explicit version update with `replaceRepository: true`. Subsequent `follow` updates
track the selected stream; `pinned` installations require explicit updates.

Migration authority:
[First-party app repositories](https://github.com/appthrust/platform/blob/main/design/platform/marketplace-apps/first-party-app-repositories.md).

## Authz Probe (ink-only test fixture)

`cmd/authz-probe` is a dependency-free app that exercises platform app roles
and bindings (platform ADR-0082) on `appthrust.ink`. It is not part of Memo and
is never published to the shared catalog.

- API: `GET /api/probe/whoami` returns the caller's resolved permissions and
  whether the installation's access model is declared and accepted;
  `GET /api/probe/read`, `POST /api/probe/write` and `POST /api/probe/admin`
  answer 403 without `probe:read`, `probe:write` and `probe:admin`.
- Roles: `viewer`, `editor`, `admin` (`catalog/authz-probe.yaml`). Project
  managers get `admin` and every signed-in user gets `viewer` by default.
- Publication: the manual workflow `authz-probe.yml` (main only) pushes the
  image as `ghcr.io/appthrust/memo:authz-probe-<version>` and a signed one-entry
  catalog as `ghcr.io/appthrust/memo:authz-test-catalog`. Updates are pinned
  only, because Memo's version tags share the repository.
- An estate reads it only through the task-owned `AppCatalogSource` in
  `hack/authz-test/appcatalogsource.yaml`, which trusts that workflow alone.
  It requires platform main `791a7f4d4c` or later.
