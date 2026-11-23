package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"fmt"
	"strconv"
	"testing"
	"testing/fstest"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/oklog/ulid/v2"
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
					author, err := tx.authorForSignIn(want, subject)
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

func TestAuthorPrincipalMigrationWithoutHistoricalIssuer(t *testing.T) {
	legacy, dsn := legacyDatabase(t)
	require.NoError(t, legacy.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES('author','subject','Name','email@example.test')`)
	}))
	database, err := Open(t.Context(), dsn, "")
	require.NoError(t, err)
	require.NoError(t, database.Close())
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

func TestRekeyAuthorOnSignInPreservesAuthorAndRelationships(t *testing.T) {
	legacy, dsn := legacyDatabase(t)
	authorID, readerID := ulid.Make().String(), ulid.Make().String()
	require.NoError(t, legacy.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		if err := tx.Exec(`INSERT INTO authors(id,subject,display_name,email,directory_person_id) VALUES
			($1,'writer','Directory Name','writer@example.test','person-1'),
			($2,'reader','Reader','reader@example.test',NULL)`, authorID, readerID); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO articles(id,author_id,title,body,status) VALUES('article',$1,'Draft','Body','draft')`, authorID); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO likes(article_id,author_id) VALUES('article',$1)`, readerID); err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO follows(follower_id,followee_id) VALUES($1,$2),($2,$1)`, readerID, authorID)
	}))
	database, err := Open(t.Context(), dsn, "")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })

	version := func() string {
		t.Helper()
		var version string
		require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
			return tx.SQL.QueryRowContext(t.Context(), `SELECT xmin::text FROM authors WHERE id=$1`, authorID).Scan(&version)
		}))
		return version
	}
	before := version()
	author, err := database.RekeyAuthorOnSignIn(t.Context(), "u_platform-signed-writer", "writer")
	require.NoError(t, err)
	require.Equal(t, authorID, author.ID)
	require.Equal(t, "Directory Name", author.DisplayName)
	require.Equal(t, "writer@example.test", author.Email)
	require.Equal(t, "person-1", *author.DirectoryPersonID)
	after := version()
	require.NotEqual(t, before, after, "first sign-in must update the legacy row")
	again, err := database.RekeyAuthorOnSignIn(t.Context(), "u_platform-signed-writer", "writer")
	require.NoError(t, err)
	require.Equal(t, author, again)
	require.Equal(t, after, version(), "second sign-in must not write the author")
	require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
		var principal, subject string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal,subject FROM authors WHERE id=$1`, authorID).Scan(&principal, &subject))
		require.Equal(t, "u_platform-signed-writer", principal)
		require.Equal(t, "writer", subject)
		var articleAuthor, liker, follower, followee string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT a.author_id,l.author_id,f.follower_id,f.followee_id FROM articles a JOIN likes l ON l.article_id=a.id JOIN follows f ON f.followee_id=a.author_id`).Scan(&articleAuthor, &liker, &follower, &followee))
		require.Equal(t, authorID, articleAuthor)
		require.Equal(t, readerID, liker)
		require.Equal(t, readerID, follower)
		require.Equal(t, authorID, followee)
		counts, err := tx.Counts(authorID)
		require.NoError(t, err)
		require.Equal(t, 1, counts.Followers)
		require.Equal(t, 1, counts.Following)
		var inert bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL FROM authors WHERE id=$1`, readerID).Scan(&inert))
		require.True(t, inert)
		return nil
	}))
}

func TestRekeyAuthorOnSignInUsesPrincipalBeforeUnkeyedSubject(t *testing.T) {
	database, _ := testutil.Database(t, func(ctx context.Context, dsn string) (*Store, error) {
		return Open(ctx, dsn, "")
	})
	require.NoError(t, database.Do(t.Context(), true, func(tx *Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,principal,display_name,email) VALUES
			('signed',NULL,'u_signed','Signed','signed@example.test'),
			('legacy','writer',NULL,'Legacy','legacy@example.test'),
			('rekeyed','other','u_other','Other','other@example.test')`)
	}))
	author, err := database.RekeyAuthorOnSignIn(t.Context(), "u_signed", "writer")
	require.NoError(t, err)
	require.Equal(t, "signed", author.ID)
	author, err = database.RekeyAuthorOnSignIn(t.Context(), "u_different-issuer", "other")
	require.ErrorIs(t, err, sql.ErrNoRows)
	require.Empty(t, author.ID, "a subject cannot select an already-keyed author")
	_, err = database.RekeyAuthorOnSignIn(t.Context(), "u_absent", "absent")
	require.ErrorIs(t, err, sql.ErrNoRows)
	require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
		var unchanged bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL FROM authors WHERE id='legacy'`).Scan(&unchanged))
		require.True(t, unchanged, "principal lookup must not claim a separate legacy row")
		return nil
	}))
}

func TestRekeyAuthorOnSignInRejectsPrincipalConflict(t *testing.T) {
	database, _ := testutil.Database(t, func(ctx context.Context, dsn string) (*Store, error) {
		return Open(ctx, dsn, "")
	})
	require.NoError(t, database.Do(t.Context(), true, func(tx *Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES
			('first','first','First','first@example.test'),
			('second','second','Second','second@example.test')`)
	}))
	_, err := database.RekeyAuthorOnSignIn(t.Context(), "u_shared", "first")
	require.NoError(t, err)
	author, err := database.RekeyAuthorOnSignIn(t.Context(), "u_shared", "second")
	require.ErrorIs(t, err, ErrAuthorPrincipalConflict)
	require.Empty(t, author.ID)
	var response *httpx.Error
	require.ErrorAs(t, err, &response)
	require.Equal(t, 409, response.Status)
	require.Equal(t, "author_principal_conflict", response.Code)
	// Exercise the real unique constraint as well as the principal-first guard.
	err = database.Do(t.Context(), true, func(tx *Tx) error {
		return tx.Exec(`UPDATE authors SET principal='u_shared' WHERE id='second'`)
	})
	require.ErrorIs(t, err, ErrAuthorPrincipalConflict)
	require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
		var unchanged bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL AND subject='second' FROM authors WHERE id='second'`).Scan(&unchanged))
		require.True(t, unchanged)
		return nil
	}))
}

func TestRekeyAuthorOnSignInConcurrentClaims(t *testing.T) {
	for _, sameSubject := range []bool{true, false} {
		t.Run(fmt.Sprintf("same_subject=%t", sameSubject), func(t *testing.T) {
			database, _ := testutil.Database(t, func(ctx context.Context, dsn string) (*Store, error) {
				return Open(ctx, dsn, "")
			})
			require.NoError(t, database.Do(t.Context(), true, func(tx *Tx) error {
				return tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES
					('first','first','First','first@example.test'),
					('second','second','Second','second@example.test')`)
			}))
			start := make(chan struct{})
			results := make(chan error, 2)
			subjects := []string{"first", "second"}
			if sameSubject {
				subjects[1] = "first"
			}
			for _, subject := range subjects {
				go func() {
					<-start
					_, err := database.RekeyAuthorOnSignIn(t.Context(), "u_shared", subject)
					results <- err
				}()
			}
			close(start)
			first, second := <-results, <-results
			if sameSubject {
				require.NoError(t, first)
				require.NoError(t, second)
			} else {
				if first == nil {
					require.ErrorIs(t, second, ErrAuthorPrincipalConflict)
				} else {
					require.ErrorIs(t, first, ErrAuthorPrincipalConflict)
					require.NoError(t, second)
				}
			}
			require.NoError(t, database.Do(t.Context(), false, func(tx *Tx) error {
				var keyed int
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM authors WHERE principal='u_shared'`).Scan(&keyed))
				require.Equal(t, 1, keyed)
				return nil
			}))
		})
	}
}
