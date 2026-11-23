package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"testing"
	"testing/fstest"

	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/stretchr/testify/require"
)

// This is the Go reference expression in appthrust/platform#7087,
// bfeb156136f5:platform-api/internal/handler/principal.go:49-50, not a hand-coded digest.
func platformPrincipal(issuer, subject string) string {
	digest := sha256.Sum256([]byte(strconv.Itoa(len(issuer)) + ":" + issuer + subject))
	return "u_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func legacyDatabase(t *testing.T) (*pgstore.Store, string) {
	t.Helper()
	source, err := migrations.ReadFile("migrations/001_memo.sql")
	require.NoError(t, err)
	return testutil.Database(t, func(ctx context.Context, dsn string) (*pgstore.Store, error) {
		return pgstore.Open(ctx, dsn, fstest.MapFS{"migrations/001_memo.sql": {Data: source}}, "memo_schema_migrations")
	})
}

func TestAuthorPrincipalMigrationMatchesPlatform(t *testing.T) {
	for _, issuer := range []string{"https://id.example.test/realms/team", "https://例え.test/realm/é"} {
		t.Run(issuer, func(t *testing.T) {
			legacy, dsn := legacyDatabase(t)
			subjects := []string{"writer", "利用者:é", "subject:with:separators", "a/b+c_", " subject "}
			require.NoError(t, legacy.Do(t.Context(), true, func(tx *pgstore.Tx) error {
				for i, subject := range subjects {
					if err := tx.Exec(`INSERT INTO authors(id,subject,display_name,email,directory_person_id) VALUES($1,$2,'Directory Name','writer@example.test','person-1')`, fmt.Sprint(i), subject); err != nil {
						return err
					}
				}
				return tx.Exec(`INSERT INTO articles(id,author_id,title,body,status) VALUES('article','0','Draft','Body','draft');
					INSERT INTO likes(article_id,author_id) VALUES('article','1');
					INSERT INTO follows(follower_id,followee_id) VALUES('1','0')`)
			}))
			database, err := Open(t.Context(), dsn, issuer)
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, database.Close()) })
			require.NoError(t, database.migrateAuthorPrincipals(t.Context(), "https://must-not-rekey.example.test"))
			require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
				for i, subject := range subjects {
					var got, oldSubject string
					require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal,subject FROM authors WHERE id=$1`, fmt.Sprint(i)).Scan(&got, &oldSubject))
					want := platformPrincipal(issuer, subject)
					require.Equal(t, want, got)
					require.Equal(t, subject, oldSubject)
					t.Logf("Go reference issuer=%q subject=%q principal=%s", issuer, subject, want)
					author, err := tx.AuthorByPrincipal(want)
					require.NoError(t, err)
					require.Equal(t, fmt.Sprint(i), author.ID)
					require.Equal(t, "Directory Name", author.DisplayName)
					require.Equal(t, "person-1", *author.DirectoryPersonID)
				}
				var authorID, likerID, followerID string
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT a.author_id,l.author_id,f.follower_id FROM articles a JOIN likes l ON l.article_id=a.id JOIN follows f ON f.followee_id=a.author_id`).Scan(&authorID, &likerID, &followerID))
				require.Equal(t, "0", authorID)
				require.Equal(t, "1", likerID)
				require.Equal(t, "1", followerID)
				return nil
			}))
			require.NoError(t, database.Do(t.Context(), true, func(tx *Tx) error {
				author, err := tx.UpsertAuthor(platformPrincipal(issuer, subjects[0]), "OIDC Name", "updated@example.test")
				require.NoError(t, err)
				require.Equal(t, "0", author.ID)
				require.Equal(t, "Directory Name", author.DisplayName)
				// Same subject at another issuer must not claim the migrated author.
				other, err := tx.UpsertAuthor(platformPrincipal(issuer+"/other", subjects[0]), "Other", "other@example.test")
				require.NoError(t, err)
				require.NotEqual(t, author.ID, other.ID)
				var subjectIsNull bool
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT subject IS NULL FROM authors WHERE id=$1`, other.ID).Scan(&subjectIsNull))
				require.True(t, subjectIsNull, "new authors store the signed principal only")
				return nil
			}))
		})
	}
}

func TestAuthorPrincipalMigrationRequiresHistoricalIssuer(t *testing.T) {
	legacy, dsn := legacyDatabase(t)
	require.NoError(t, legacy.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES('author','subject','Name','email@example.test')`)
	}))
	database, err := Open(t.Context(), dsn, "")
	require.Nil(t, database)
	require.ErrorContains(t, err, "MEMO_LEGACY_OIDC_ISSUER is required")
	require.NoError(t, legacy.Do(t.Context(), false, func(tx *pgstore.Tx) error {
		var unchanged bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL AND subject='subject' FROM authors WHERE id='author'`).Scan(&unchanged))
		require.True(t, unchanged)
		return nil
	}))
	database, err = Open(t.Context(), dsn, "https://id.example.test")
	require.NoError(t, err)
	require.NoError(t, database.Close())
}

func TestAuthorPrincipalMigrationRejectsMissingSubjectAtomically(t *testing.T) {
	legacy, dsn := legacyDatabase(t)
	require.NoError(t, legacy.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES
			('valid','writer','Writer','writer@example.test'),
			('invalid','','Unknown','unknown@example.test')`)
	}))
	database, err := Open(t.Context(), dsn, "https://id.example.test")
	require.Nil(t, database)
	require.ErrorContains(t, err, "missing legacy subject")
	require.NoError(t, legacy.Do(t.Context(), false, func(tx *pgstore.Tx) error {
		var migrated int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM authors WHERE principal IS NOT NULL`).Scan(&migrated))
		require.Zero(t, migrated)
		return nil
	}))
}
