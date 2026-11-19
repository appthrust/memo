package store

import (
	"context"
	"errors"
	"strings"
)

// migrateAuthorPrincipals is an offline cutover, not an authentication fallback.
// The operator must establish the historical issuer: the old schema did not save it.
func (s *Store) migrateAuthorPrincipals(ctx context.Context, issuer string) error {
	return s.Do(ctx, true, func(tx *Tx) error {
		// Block old writers for the whole backfill and NOT NULL transition. Operators
		// must stop the old binary first; a rolling mixed-version rollout is unsafe.
		if err := tx.Exec(`LOCK TABLE authors IN ACCESS EXCLUSIVE MODE`); err != nil {
			return err
		}
		var pending bool
		if err := tx.SQL.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM authors WHERE principal IS NULL)`).Scan(&pending); err != nil {
			return err
		}
		if pending {
			if strings.TrimSpace(issuer) == "" {
				return errors.New("MEMO_LEGACY_OIDC_ISSUER is required to migrate existing authors; verify the historical issuer before starting Memo")
			}
			var invalid bool
			if err := tx.SQL.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM authors WHERE principal IS NULL AND (subject IS NULL OR btrim(subject) = ''))`).Scan(&invalid); err != nil {
				return err
			}
			if invalid {
				return errors.New("cannot migrate authors with a missing legacy subject")
			}
			// appthrust/platform bfeb156136f5, principal.go:43-50:
			// sha256(strconv.Itoa(len(issuer)) + ":" + issuer + subject), raw base64url.
			// len is the UTF-8 BYTE length; neither issuer nor subject is normalized.
			if err := tx.Exec(`UPDATE authors SET principal = 'u_' || rtrim(translate(encode(sha256(
				convert_to(octet_length(convert_to($1::text, 'UTF8'))::text || ':' || $1::text || subject, 'UTF8')
			), 'base64'), '+/', '-_'), '=') WHERE principal IS NULL`, issuer); err != nil {
				return err
			}
		}
		return tx.Exec(`ALTER TABLE authors ALTER COLUMN principal SET NOT NULL`)
	})
}
