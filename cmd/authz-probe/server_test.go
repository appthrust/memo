package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/stretchr/testify/require"
)

type authenticateFunc func(context.Context, string) (identity.Identity, string, error)

func (f authenticateFunc) Authenticate(ctx context.Context, header string) (identity.Identity, string, error) {
	return f(ctx, header)
}

var guardedEndpoints = []struct {
	method, path, permission string
}{
	{http.MethodGet, "/api/probe/read", "probe:read"},
	{http.MethodPost, "/api/probe/write", "probe:write"},
	{http.MethodPost, "/api/probe/admin", "probe:admin"},
}

func TestPermissions(t *testing.T) {
	for _, endpoint := range guardedEndpoints {
		t.Run(endpoint.permission, func(t *testing.T) {
			for _, scenario := range []struct {
				name   string
				scopes []string
				status int
			}{
				{"present", []string{endpoint.permission}, http.StatusOK},
				{"absent", nil, http.StatusForbidden},
				{"other", []string{"unrelated:read"}, http.StatusForbidden},
				{"wildcard", []string{"probe:*"}, http.StatusForbidden},
			} {
				t.Run(scenario.name, func(t *testing.T) {
					auth := authenticateFunc(func(ctx context.Context, header string) (identity.Identity, string, error) {
						require.Equal(t, "Bearer request-token", header)
						return identity.Identity{
							Principal: accesskey.Principal{Kind: "user", Subject: "user-1", Project: "pj-test", Scopes: scenario.scopes, Groups: []string{"admin", "project.manage"}},
							Access:    &identity.AppAccess{Declared: true, Accepted: true},
						}, "Bearer private-token", nil
					})
					handler := newHandler(auth, "authz-probe", "dev")
					request := httptest.NewRequest(endpoint.method, endpoint.path, nil)
					request.Header.Set("Authorization", "Bearer request-token")
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, request)
					require.Equal(t, scenario.status, response.Code)
					require.Equal(t, "application/json", response.Header().Get("Content-Type"))
					require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
					if scenario.status == http.StatusOK {
						require.JSONEq(t, `{"ok":true,"permission":"`+endpoint.permission+`"}`, response.Body.String())
					} else {
						require.JSONEq(t, `{"code":"forbidden","permission":"`+endpoint.permission+`"}`, response.Body.String())
					}
				})
			}
		})
	}
}

func TestWhoami(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		scopes []string
		access *identity.AppAccess
		want   string
	}{
		{"pending", nil, &identity.AppAccess{Declared: true, Accepted: false}, `{"declared":true,"accepted":false}`},
		{"accepted without grant", []string{}, &identity.AppAccess{Declared: true, Accepted: true}, `{"declared":true,"accepted":true}`},
		{"undeclared", nil, &identity.AppAccess{}, `{"declared":false,"accepted":false}`},
		{"no exchange", nil, nil, `{"declared":false,"accepted":false}`},
		{"granted", []string{"probe:read", "probe:write"}, &identity.AppAccess{Declared: true, Accepted: true}, `{"declared":true,"accepted":true}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			auth := authenticateFunc(func(context.Context, string) (identity.Identity, string, error) {
				return identity.Identity{
					Principal: accesskey.Principal{Kind: "user", Subject: "user-1", Project: "pj-bound", Scopes: scenario.scopes},
					Email:     "private@example.test", Name: "Private Name", Access: scenario.access,
				}, "Bearer private-token", nil
			})
			response := httptest.NewRecorder()
			newHandler(auth, "bound-installation", "dev").ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/probe/whoami", nil))
			require.Equal(t, http.StatusOK, response.Code)
			scopes := scenario.scopes
			if scopes == nil {
				scopes = []string{}
			}
			encodedScopes, err := json.Marshal(scopes)
			require.NoError(t, err)
			require.JSONEq(t, `{"subject":"user-1","project":"pj-bound","installation":"bound-installation","scopes":`+string(encodedScopes)+`,"access":`+scenario.want+`}`, response.Body.String())
			for _, private := range []string{"private@example.test", "Private Name", "private-token", "Bearer", `"email"`, `"name"`, `"token"`} {
				require.NotContains(t, response.Body.String(), private)
			}
		})
	}
}

func TestAuthenticationFailures(t *testing.T) {
	for _, scenario := range []struct {
		name, code, retry string
		err               error
		status            int
	}{
		{"unauthenticated", "unauthenticated", "", errors.New("private failure detail"), http.StatusUnauthorized},
		{"identity unavailable", "identity_unavailable", "", identity.ErrUnavailable, http.StatusServiceUnavailable},
		{"exchange unavailable", "access_unavailable", "1", &httpx.Error{Status: http.StatusServiceUnavailable, Code: "access_unavailable", Message: "App access verification is unavailable", RetryAfter: "1"}, http.StatusServiceUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			auth := authenticateFunc(func(context.Context, string) (identity.Identity, string, error) {
				// Even a principal with all permissions must not survive a failed exchange.
				return identity.Identity{Principal: accesskey.Principal{Scopes: []string{"probe:read", "probe:write", "probe:admin"}}}, "Bearer private-token", scenario.err
			})
			handler := newHandler(auth, "authz-probe", "dev")
			endpoints := append([]struct{ method, path, permission string }{{http.MethodGet, "/api/probe/whoami", ""}}, guardedEndpoints...)
			for _, endpoint := range endpoints {
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(endpoint.method, endpoint.path, nil))
				require.Equal(t, scenario.status, response.Code, endpoint.path)
				require.Equal(t, scenario.retry, response.Header().Get("Retry-After"))
				var body map[string]string
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
				require.Equal(t, scenario.code, body["error"])
				require.NotContains(t, response.Body.String(), "private")
			}
		})
	}
}

func TestPublicRoutesAndMethods(t *testing.T) {
	auth := authenticateFunc(func(context.Context, string) (identity.Identity, string, error) {
		t.Fatal("public routes and unsupported methods must not authenticate")
		return identity.Identity{}, "", nil
	})
	handler := newHandler(auth, "authz-probe", "0.1.0")
	for _, path := range []string{"/healthz", "/releasez", "/"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, response.Code, path)
		switch path {
		case "/healthz":
			require.JSONEq(t, `{"ok":true}`, response.Body.String())
		case "/releasez":
			require.JSONEq(t, `{"releaseVersion":"0.1.0","app":"authz-probe"}`, response.Body.String())
		case "/":
			require.Equal(t, "text/html; charset=utf-8", response.Header().Get("Content-Type"))
			for _, endpoint := range []string{"/api/probe/whoami", "/api/probe/read", "/api/probe/write", "/api/probe/admin"} {
				require.Contains(t, response.Body.String(), endpoint)
			}
		}
	}
	for _, endpoint := range []struct {
		method, path string
		status       int
	}{
		{http.MethodGet, "/api/probe/write", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/probe/admin", http.StatusMethodNotAllowed},
		{http.MethodPost, "/api/probe/read", http.StatusMethodNotAllowed},
		{http.MethodPost, "/api/probe/whoami", http.StatusMethodNotAllowed},
		{http.MethodGet, "/unknown", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(endpoint.method, endpoint.path, nil))
		require.Equal(t, endpoint.status, response.Code, endpoint.path)
	}
}

func clearIdentityEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PLATFORM_API_URL", "PLATFORM_PROJECT_ID", "PLATFORM_OIDC_ISSUER", "PLATFORM_OIDC_ISSUER_CA_PEM", "PLATFORM_ACCESS_ISSUER",
		"PLATFORM_APP_INSTALLATION_NAME", "PLATFORM_APP_INSTALLATION_UID", "PROBE_OIDC_AUDIENCES", "PROBE_ACCESS_AUDIENCE",
	} {
		t.Setenv(key, "")
	}
}

func TestLocalIdentityUsesSDK(t *testing.T) {
	clearIdentityEnv(t)
	handler, err := handlerFromEnv("127.0.0.1:8080")
	require.NoError(t, err)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/probe/whoami", nil))
	require.Equal(t, http.StatusUnauthorized, response.Code)
	require.JSONEq(t, `{"error":"unauthenticated","message":"A valid bearer token is required"}`, response.Body.String())

	claims := `{"sub":"local-user","email":"local@example.test","name":"Local Name","scope":"probe:admin","groups":["admin"]}`
	bearer := "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + "."
	request := httptest.NewRequest(http.MethodGet, "/api/probe/whoami", nil)
	request.Header.Set("Authorization", bearer)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"subject":"local-user","project":"","installation":"authz-probe","scopes":[],"access":{"declared":false,"accepted":false}}`, response.Body.String())
	for _, endpoint := range guardedEndpoints {
		request := httptest.NewRequest(endpoint.method, endpoint.path, nil)
		request.Header.Set("Authorization", bearer)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusForbidden, response.Code)
	}
}

func TestEnvironmentFailsClosed(t *testing.T) {
	clearIdentityEnv(t)
	_, err := handlerFromEnv(":8080")
	require.EqualError(t, err, "PLATFORM_OIDC_ISSUER is required unless --listen uses a loopback host")
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://oidc.example.test")
	_, err = handlerFromEnv(":8080")
	require.ErrorContains(t, err, "OIDC audiences are required")
	t.Setenv("PROBE_OIDC_AUDIENCES", "probe-user")
	_, err = handlerFromEnv(":8080")
	require.ErrorContains(t, err, "OIDC and access issuers are required for app access")
	t.Setenv("PLATFORM_ACCESS_ISSUER", "https://platform.example.test/access")
	_, err = handlerFromEnv(":8080")
	require.ErrorContains(t, err, "PLATFORM_PROJECT_ID")
	t.Setenv("PLATFORM_PROJECT_ID", "pj-test")
	_, err = handlerFromEnv(":8080")
	require.ErrorContains(t, err, "PLATFORM_API_URL")
	t.Setenv("PLATFORM_API_URL", "https://platform.example.test")
	_, err = handlerFromEnv(":8080")
	require.NoError(t, err)
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "invalid PEM")
	_, err = handlerFromEnv(":8080")
	require.EqualError(t, err, "OIDC CA PEM must contain only PEM certificates")
}
