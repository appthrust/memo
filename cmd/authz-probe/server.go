package main

import (
	"context"
	_ "embed"
	"io"
	"net/http"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/platformenv"
)

const appName = "authz-probe"

//go:embed index.html
var indexHTML string

type authenticator interface {
	Authenticate(context.Context, string) (identity.Identity, string, error)
}

func handlerFromEnv(listen string) (http.Handler, error) {
	trust := identity.FromEnv("PROBE")
	if err := platformenv.ValidateIdentityListen(listen, trust.OIDCIssuer); err != nil {
		return nil, err
	}
	access := identity.AppAccessFromEnv(appName)
	if trust.OIDCIssuer != "" {
		// Keep RequirePermissions false: whoami must expose pending acceptance
		// and empty grants. Each guarded endpoint checks its own permission.
		trust.AppAccess = &access
	}
	auth, err := identity.New(trust)
	if err != nil {
		return nil, err
	}
	// The SDK verifies the exchange's installation against this configuration;
	// Identity.Principal exposes the bound Project but not the installation.
	return newHandler(auth, access.Installation, releaseVersion), nil
}

func newHandler(auth authenticator, installation, version string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, struct {
			OK bool `json:"ok"`
		}{OK: true})
	})
	mux.HandleFunc("GET /releasez", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, struct {
			ReleaseVersion string `json:"releaseVersion"`
			App            string `json:"app"`
		}{ReleaseVersion: version, App: appName})
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, indexHTML)
	})
	mux.HandleFunc("GET /api/probe/whoami", authenticated(auth, func(w http.ResponseWriter, user identity.Identity) {
		scopes := user.Principal.Scopes
		if scopes == nil {
			scopes = []string{}
		}
		access := identity.AppAccess{}
		if user.Access != nil {
			access = *user.Access
		}
		// Explicit fields keep profile information and the forwarded bearer out
		// of the diagnostic response, including when the SDK grows new fields.
		httpx.WriteJSON(w, http.StatusOK, struct {
			Subject      string             `json:"subject"`
			Project      string             `json:"project"`
			Installation string             `json:"installation"`
			Scopes       []string           `json:"scopes"`
			Access       identity.AppAccess `json:"access"`
		}{user.Principal.Subject, user.Principal.Project, installation, scopes, access})
	}))
	mux.HandleFunc("GET /api/probe/read", permissionHandler(auth, "probe:read"))
	mux.HandleFunc("POST /api/probe/write", permissionHandler(auth, "probe:write"))
	mux.HandleFunc("POST /api/probe/admin", permissionHandler(auth, "probe:admin"))
	return mux
}

func authenticated(auth authenticator, next func(http.ResponseWriter, identity.Identity)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _, err := auth.Authenticate(r.Context(), r.Header.Get("Authorization"))
		if err != nil {
			identity.WriteError(w, err)
			return
		}
		next(w, user)
	}
}

func permissionHandler(auth authenticator, permission string) http.HandlerFunc {
	return authenticated(auth, func(w http.ResponseWriter, user identity.Identity) {
		if !user.Principal.Has(permission) {
			httpx.WriteJSON(w, http.StatusForbidden, struct {
				Code       string `json:"code"`
				Permission string `json:"permission"`
			}{Code: "forbidden", Permission: permission})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, struct {
			OK         bool   `json:"ok"`
			Permission string `json:"permission"`
		}{OK: true, Permission: permission})
	})
}
