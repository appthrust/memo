package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/memo/cmd/server/internal/domain"
	"github.com/appthrust/memo/cmd/server/internal/store"
	"github.com/go-jose/go-jose/v4"
	"github.com/oklog/ulid/v2"
	"github.com/stretchr/testify/require"
)

// This fixture uses the real SDK's OIDC verification, exchange and assertion
// verification. Its person keys deliberately differ from a local subject hash.
type accessFixture struct {
	t       *testing.T
	server  *httptest.Server
	key     *ecdsa.PrivateKey
	legacy  atomic.Bool
	bearers map[string]string
}

func newAccessFixture(t *testing.T) *accessFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	f := &accessFixture{t: t, key: key, bearers: make(map[string]string)}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oidc/.well-known/openid-configuration":
			httpx.WriteJSON(w, 200, map[string]any{"issuer": f.server.URL + "/oidc", "jwks_uri": f.server.URL + "/oidc/keys", "id_token_signing_alg_values_supported": []string{"ES256"}})
		case "/oidc/keys", "/access/jwks.json":
			httpx.WriteJSON(w, 200, accesskey.NewES256Signer("test-key", key).JWKS())
		case "/api/v1/access/user-token":
			require.Equal(t, http.MethodPost, r.Method)
			subject := bearerSubject(t, r.Header.Get("Authorization"))
			now := time.Now().Truncate(time.Second)
			claims := map[string]any{
				"iss": f.server.URL + "/access", "sub": "user:" + subject, "aud": []string{"memo-client"},
				"scope": "", "iat": now.Unix(), "exp": now.Add(time.Minute).Unix(),
				"appthrust.io/credential": "session", "appthrust.io/subject_kind": "user",
				"appthrust.io/subject_issuer": f.server.URL + "/oidc",
				"appthrust.io/project": "pj-test", "appthrust.io/installation": "memo", "appthrust.io/installation_uid": "memo-uid",
				"appthrust.io/principal": signedPrincipal(subject), "appthrust.io/group_grants": []any{},
			}
			if f.legacy.Load() {
				delete(claims, "appthrust.io/principal")
				delete(claims, "appthrust.io/group_grants")
			}
			httpx.WriteJSON(w, 200, map[string]any{
				"token": f.sign(accesskey.AssertionType, claims), "expiresAt": now.Add(time.Minute),
				"audience": "memo-client", "project": "pj-test", "installation": "memo", "installationUID": "memo-uid",
				"access": map[string]bool{"declared": false, "accepted": false},
				"principal": "unsigned-principal-must-not-be-used",
			})
		default:
			t.Errorf("unexpected identity fixture route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func signedPrincipal(subject string) string {
	digest := sha256.Sum256([]byte("signed-fixture:" + subject))
	return "u_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func bearerSubject(t *testing.T, bearer string) string {
	t.Helper()
	parts := strings.Split(strings.TrimPrefix(bearer, "Bearer "), ".")
	require.Len(t, parts, 3)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)
	var claims struct {
		Subject string `json:"sub"`
	}
	require.NoError(t, json.Unmarshal(payload, &claims))
	return claims.Subject
}

func (f *accessFixture) sign(typ string, claims any) string {
	f.t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: f.key}, (&jose.SignerOptions{}).WithType(jose.ContentType(typ)).WithHeader("kid", "test-key"))
	require.NoError(f.t, err)
	payload, err := json.Marshal(claims)
	require.NoError(f.t, err)
	signed, err := signer.Sign(payload)
	require.NoError(f.t, err)
	raw, err := signed.CompactSerialize()
	require.NoError(f.t, err)
	return raw
}

func (f *accessFixture) bearer(subject string) string {
	if value, ok := f.bearers[subject]; ok {
		return value
	}
	value := "Bearer " + f.sign("JWT", map[string]any{
		"iss": f.server.URL + "/oidc", "sub": subject, "aud": []string{"appthrust-platform-api"}, "azp": "memo-client",
		"exp": time.Now().Add(time.Hour).Unix(), "email": subject + "@example.test", "name": subject,
	})
	f.bearers[subject] = value
	return value
}

func (f *accessFixture) auth() *identity.Authenticator {
	auth, err := identity.New(identity.Trust{
		OIDCIssuer: f.server.URL + "/oidc", OIDCAudiences: []string{"appthrust-platform-api"}, AccessIssuer: f.server.URL + "/access",
		AppAccess: &identity.AppAccessConfig{PlatformOrigin: f.server.URL, Project: "pj-test", Installation: "memo"},
	})
	require.NoError(f.t, err)
	return auth
}

func TestMissingSignedPrincipalReturns503(t *testing.T) {
	f := newAccessFixture(t)
	f.legacy.Store(true)
	// No database or platform client: the failure must stop before either is used.
	handler := New(nil, f.auth(), nil, nil, "")
	for _, path := range []string{"/api/memo/v1/me", "/api/memo/v1/articles", "/api/memo/v1/openapi.json"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", f.bearer("writer"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, 503, w.Code, w.Body.String())
		var body httpx.Error
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		require.Equal(t, "access_unavailable", body.Code)
		require.Contains(t, body.Message, "missing signed principal")
		require.Contains(t, body.Message, "#7087")
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	}
}

func TestIdentityWithoutExchangeCannotUseSubject(t *testing.T) {
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	handler := New(nil, auth, nil, nil, "")
	r := httptest.NewRequest(http.MethodGet, "/api/memo/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+token("writer"))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), "signed principal")
}

func TestSignedPrincipalOwnsNewWrites(t *testing.T) {
	h := newHarness(t)
	first := call[domain.Article](h, "writer", "POST", "/articles", map[string]string{"title": "First", "body": "Body"}, 201)
	second := call[domain.Article](h, "writer", "POST", "/articles", map[string]string{"title": "Second", "body": "Body"}, 201)
	require.Equal(t, first.Author.ID, second.Author.ID)
	require.Equal(t, "writer", first.Author.DisplayName)
	require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
		var principal string
		var noSubject bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT u.principal,u.subject IS NULL FROM authors u JOIN articles a ON a.author_id=u.id WHERE a.id=$1`, first.ID).Scan(&principal, &noSubject))
		require.Equal(t, signedPrincipal("writer"), principal)
		require.True(t, noSubject)
		return nil
	}))
	// A missing principal for another user must not create a subject-owned row.
	h.identity.legacy.Store(true)
	call[httpx.Error](h, "legacy-writer", "POST", "/articles", map[string]string{"title": "Denied", "body": "Body"}, 503)
	require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
		var authors, articles int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT (SELECT count(*) FROM authors), (SELECT count(*) FROM articles)`).Scan(&authors, &articles))
		require.Equal(t, 1, authors)
		require.Equal(t, 2, articles)
		return nil
	}))
}

func TestLegacyAuthorResolvesOnReadAndMutationPaths(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
		body   any
		status int
	}{
		{"GET", "/me", nil, 200},
		{"GET", "/drafts", nil, 200},
		{"GET", "/articles/draft", nil, 200},
		{"GET", "/articles/published", nil, 200},
		{"GET", "/articles?following=true", nil, 200},
		{"GET", "/authors/peer", nil, 200},
		{"POST", "/articles", map[string]string{"title": "New", "body": "Body"}, 201},
		{"PATCH", "/articles/draft", map[string]string{"title": "Updated"}, 200},
		{"PUT", "/articles/published/like", nil, 200},
		{"PUT", "/authors/peer/follow", nil, 200},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			h := newHarness(t)
			authorID := ulid.Make().String()
			require.NoError(t, h.database.Do(t.Context(), true, func(tx *store.Tx) error {
				if err := tx.Exec(`INSERT INTO authors(id,subject,display_name,email) VALUES
					($1,'writer','writer','writer@example.test'),
					('peer','peer','Peer','peer@example.test')`, authorID); err != nil {
					return err
				}
				if err := tx.Exec(`INSERT INTO articles(id,author_id,title,body,status,published_at) VALUES
					('draft',$1,'Draft','Body','draft',NULL),
					('published','peer','Published','Body','published',now())`, authorID); err != nil {
					return err
				}
				if err := tx.Exec(`INSERT INTO likes(article_id,author_id) VALUES('published',$1)`, authorID); err != nil {
					return err
				}
				return tx.Exec(`INSERT INTO follows(follower_id,followee_id) VALUES($1,'peer')`, authorID)
			}))
			call[any](h, "writer", tc.method, tc.path, tc.body, tc.status)
			var version string
			require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
				var principal string
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal,xmin::text FROM authors WHERE id=$1`, authorID).Scan(&principal, &version))
				require.Equal(t, signedPrincipal("writer"), principal)
				return nil
			}))
			me := call[meResponse](h, "writer", "GET", "/me", nil, 200)
			require.Equal(t, authorID, me.Author.ID)
			draft := call[domain.Article](h, "writer", "GET", "/articles/draft", nil, 200)
			require.Equal(t, authorID, draft.Author.ID)
			published := call[domain.Article](h, "writer", "GET", "/articles/published", nil, 200)
			require.True(t, published.LikedByMe)
			require.Equal(t, 1, published.LikeCount)
			peer := call[domain.AuthorProfile](h, "writer", "GET", "/authors/peer", nil, 200)
			require.True(t, peer.FollowedByMe)
			require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
				var current string
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT xmin::text FROM authors WHERE id=$1`, authorID).Scan(&current))
				require.Equal(t, version, current, "repeat sign-in and reads must not rewrite the author")
				var inert bool
				require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL FROM authors WHERE id='peer'`).Scan(&inert))
				require.True(t, inert, "target lookups must not rekey another user")
				return nil
			}))
		})
	}
}

func TestSubjectCannotActAsRekeyedAuthor(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.database.Do(t.Context(), true, func(tx *store.Tx) error {
		if err := tx.Exec(`INSERT INTO authors(id,subject,principal,display_name,email) VALUES
			('owner','writer',$1,'Owner','owner@example.test'),
			('peer',NULL,$2,'Peer','peer@example.test')`, signedPrincipal("other-issuer"), signedPrincipal("peer")); err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO articles(id,author_id,title,body,status,published_at) VALUES
			('draft','owner','Draft','Body','draft',NULL),
			('published','owner','Published','Body','published',now());
			INSERT INTO likes(article_id,author_id) VALUES('published','owner');
			INSERT INTO follows(follower_id,followee_id) VALUES('owner','peer')`)
	}))
	call[httpx.Error](h, "writer", "GET", "/articles/draft", nil, 404)
	call[httpx.Error](h, "writer", "PATCH", "/articles/published", map[string]string{"title": "Stolen"}, 403)
	call[httpx.Error](h, "writer", "DELETE", "/articles/published", nil, 403)
	published := call[domain.Article](h, "writer", "GET", "/articles/published", nil, 200)
	require.False(t, published.LikedByMe)
	owner := call[domain.AuthorProfile](h, "writer", "GET", "/authors/owner", nil, 200)
	require.False(t, owner.IsMe)
	peer := call[domain.AuthorProfile](h, "writer", "GET", "/authors/peer", nil, 200)
	require.False(t, peer.FollowedByMe)
	me := call[meResponse](h, "writer", "GET", "/me", nil, 200)
	require.NotEqual(t, "owner", me.Author.ID)
	call[any](h, "writer", "DELETE", "/articles/published/like", nil, 200)
	call[any](h, "writer", "DELETE", "/authors/peer/follow", nil, 200)
	require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
		var principal string
		var likes, follows int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal,(SELECT count(*) FROM likes WHERE author_id='owner'),(SELECT count(*) FROM follows WHERE follower_id='owner') FROM authors WHERE id='owner'`).Scan(&principal, &likes, &follows))
		require.Equal(t, signedPrincipal("other-issuer"), principal)
		require.Equal(t, 1, likes)
		require.Equal(t, 1, follows)
		return nil
	}))
	// Project admins retain moderation authority, but cannot edit as the owner.
	call[httpx.Error](h, "admin", "PATCH", "/articles/published", map[string]string{"title": "Stolen"}, 403)
	call[any](h, "admin", "DELETE", "/articles/published", nil, 204)
}

func TestPrincipalConflictFailsBeforeAuthorAction(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.database.Do(t.Context(), true, func(tx *store.Tx) error {
		return tx.Exec(`INSERT INTO authors(id,subject,principal,display_name,email) VALUES
			('owner','other',$1,'Owner','owner@example.test'),
			('claimant','writer',NULL,'Writer','writer@example.test')`, signedPrincipal("writer"))
	}))
	for _, path := range []string{"/me", "/drafts"} {
		response := call[httpx.Error](h, "writer", "GET", path, nil, 409)
		require.Equal(t, "author_principal_conflict", response.Code)
	}
	require.NoError(t, h.database.Do(t.Context(), false, func(tx *store.Tx) error {
		var inert bool
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT principal IS NULL FROM authors WHERE id='claimant'`).Scan(&inert))
		require.True(t, inert)
		return nil
	}))
}
