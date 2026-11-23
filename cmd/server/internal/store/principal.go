package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/memo/cmd/server/internal/domain"
)

// ErrAuthorPrincipalConflict rejects attempts to attach one principal to different authors.
var ErrAuthorPrincipalConflict = httpx.Fail(409, "author_principal_conflict", "The signed principal is already linked to another author")

// RekeyAuthorOnSignIn binds a legacy author to the principal delivered alongside
// its verified bearer subject. Already-keyed authors need one SELECT and no write.
// sql.ErrNoRows means neither identity key resolves an author.
func (s *Store) RekeyAuthorOnSignIn(ctx context.Context, principal, legacySubject string) (domain.Author, error) {
	var author domain.Author
	lookup := func(tx *pgstore.Tx) error {
		var err error
		author, err = (&Tx{Tx: tx}).authorForSignIn(principal, legacySubject)
		return err
	}
	// Keep ordinary reads off the shared writer lock. Only a missing principal
	// requires a write transaction, independent of the requested HTTP method.
	err := s.Store.Do(ctx, false, lookup)
	if !errors.Is(err, sql.ErrNoRows) {
		return author, translate(err)
	}
	err = s.Store.Do(ctx, true, func(raw *pgstore.Tx) error {
		// Another sign-in may have committed while we acquired the writer lock.
		if err := lookup(raw); !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		tx := &Tx{Tx: raw}
		var err error
		author, err = scanAuthor(tx.SQL.QueryRowContext(ctx, `SELECT `+authorColumns+` FROM authors WHERE subject=$1 AND principal IS NULL FOR UPDATE`, legacySubject))
		if err != nil {
			return err
		}
		return tx.Exec(`UPDATE authors SET principal=$1 WHERE id=$2 AND principal IS NULL`, principal, author.ID)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.Author{}, sql.ErrNoRows
		}
		return domain.Author{}, translate(err)
	}
	return author, nil
}

func (t *Tx) authorForSignIn(principal, legacySubject string) (domain.Author, error) {
	var author domain.Author
	var subject sql.NullString
	err := t.SQL.QueryRowContext(t.Context, `SELECT `+authorColumns+`,subject FROM authors WHERE principal=$1`, principal).Scan(&author.ID, &author.DisplayName, &author.Email, &author.DirectoryPersonID, &subject)
	if err != nil {
		return domain.Author{}, err
	}
	if subject.Valid && subject.String != legacySubject {
		return domain.Author{}, ErrAuthorPrincipalConflict
	}
	return author, nil
}

// migrateAuthorPrincipals is an optional offline backfill. The operator must
// establish the historical issuer: the old schema did not save it.
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
