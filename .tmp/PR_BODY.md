## Summary

- Pin `github.com/appthrust/appserver-go v0.8.0`, the published tag at `78866523da5289d828f0ba13d325d31f590c6f68` containing appthrust/appserver-go#10. No temporary `replace` or pseudo-version remains.
- Persist and resolve author identity exclusively through `Identity.Access.Principal`; keep public author ULIDs and article/like/follow references stable.
- Backfill existing authors from their verified historical issuer and stored subject, using exactly the byte-length-prefixed SHA-256/base64url encoding in appthrust/platform#7087. Preserve historical `subject` values for rollback; new authors store only the signed principal.
- Preserve the SDK's diagnostic HTTP 503 for a missing signed principal. Never substitute a subject, unsigned exchange JSON, or a locally derived caller key. Project-role authorization and Directory/OIDC display-name behavior are unchanged.

## Merge/deployment prerequisites

**Both prerequisites are mandatory:**

1. The destination estate's Platform API includes **appthrust/platform#7087**. **Ink: yes. Craftsman: only after its second delivery** (the first `dev-0271704de697` delivery is insufficient).
2. **appserver-go v0.8.0 is tagged and downloadable**. This is now satisfied: the module download resolves the published tag to `78866523da5289d828f0ba13d325d31f590c6f68`.

Memo is recorded as running **only on ink**, at `https://memo.pj-eee7fa8eabbc.appthrust.ink` (`pj-eee7fa8eabbc/memo`). Nexus `features/security/permission/app-authorization.md` section 15.4 (2026-11-13) records it as absent from Craftsman and Cloud. These are deployment records, not a new live observation; current live inventory is **[未確認]**. Ink's platform prerequisite is already satisfied, and the SDK tag prerequisite has now been satisfied too. No cluster was accessed or changed.

This remains a **draft preparation PR**: do not merge, publish Memo, or deploy as part of this task. Platform/SDK upgrades alone must not automatically roll out this app update. Deployment additionally requires the verified historical issuer, a backup, and a maintenance window.

## Migration

1. Stop all old Memo writers; record the old image digest and take a PostgreSQL backup. Do not use a mixed-version rolling rollout.
2. Verify the issuer that originally issued all existing `authors.subject` values. Set `MEMO_LEGACY_OIDC_ISSUER` to that exact value. The old schema did not retain issuer; do not infer it from the current URL or email. Mixed/unknown histories need a reviewed per-author crosswalk before rollout.
3. Start the new binary. `002_author_principal.sql` adds unique `authors.principal` and makes the retained legacy `subject` nullable. Before serving traffic, `store.Open(ctx, dsn, legacyIssuer)` locks the authors table, backfills missing principals atomically, and makes the new column NOT NULL. An absent historical issuer with existing unmigrated rows fails closed and leaves the app unavailable.
4. Verify stable author IDs, names, Directory links, article/like/follow references, and non-null unique principal values before reopening traffic. Verify a known author's draft read/edit and existing owner/admin restrictions.
5. Remove the migration issuer setting after success. Repeated startup does not rekey migrated authors. Keep the old subject column through the rollback window.

Encoding: `"u_" + base64url_no_padding(sha256(decimal_UTF8_byte_length(issuer) + ":" + issuer + subject))`. There is no extra delimiter, trimming, or normalization. The SQL uses built-in PostgreSQL `sha256`, not an extension.

## Rollback

- Before reopening writes: stop the new binary; confirm every author has its historical subject. In one transaction drop `authors.principal`, restore `authors.subject NOT NULL`, and remove only `002_author_principal.sql` from `memo_schema_migrations`. Restart the recorded old image. IDs and relationships remain intact.
- After new authors exist: **do not switch binaries blindly or overwrite new writes with a backup**. New rows contain only a principal, and SHA-256 is not reversible. Obtain a verified issuer/subject crosswalk, match it using the exact hash, stop writers, populate only missing legacy subjects, and verify complete/unique subjects before the same rollback. If a mapping is unknown or two issuers share a subject, the old schema cannot represent the data safely: retain all data and use a forward fix. Do not invent subjects or discard rows.
- No Platform API rollback is required; the old SDK tolerates the new signed facts. This app binary cannot safely recover availability on a pre-#7087 platform.

Full operator instructions: README, “Signed author keys: upgrade and rollback”.

## Verification

All commands were wrapped with `~/.codex/skills/serialize-vm-tests/scripts/serialize-vm-tests --`:

- `go build ./...` — PASS (exit 0).
- `go vet ./cmd/server ./cmd/server/internal/api ./cmd/server/internal/store` — PASS (exit 0).
- `go test ./cmd/server ./cmd/server/internal/api ./cmd/server/internal/store -count=1 -v` — PASS (exit 0), including real PostgreSQL migrations and the real SDK OIDC/exchange/signature path. No integration tests skipped.

For the test command, `BUILTIN_APPSERVER_TEST_DATABASE_URL` pointed only at a task-owned local PostgreSQL server via a Unix socket under `.tmp/pg-socket`; per-test schemas were isolated and cleaned. The local server was stopped and its data directory removed after testing.

Coverage includes old-platform diagnostic 503 before database access, nil-exchange rejection, signed-principal-only new writes, unchanged ownership/admin and social rules, preserved Directory names, repeated migration, unknown issuer rejection, missing-subject atomic rejection, and a different issuer not claiming an existing author.

The migration test computes expected values with the exact Go reference expression (not a hand-written digest), then compares actual PostgreSQL migration output for 10 issuer/subject fixtures, including UTF-8 byte lengths and subject whitespace. One observed fixture:

```text
issuer  = https://id.example.test/realms/team
subject = writer
Go reference = SQL migration = u_X_RRhcpZ0axH8ta69lS7AxBDLU4RjaNJHk9BOEwIpoY
```

The initial pre-fix missing-principal test attempt timed out after 180 seconds waiting for an unrelated exclusive VM-test holder; it did not execute and is not claimed as a red result. The final full focused run executed successfully.
