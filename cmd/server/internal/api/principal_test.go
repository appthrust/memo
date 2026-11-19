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
