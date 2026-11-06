package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/pending"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/memo/cmd/server/internal/api"
	"github.com/appthrust/memo/cmd/server/internal/store"
)

const storeOpenTimeout = 30 * time.Second

// storeRetryInitial is the first wait after a failed database connection.
// Tests shorten it.
var storeRetryInitial = time.Second

func memoHandler(upstreamURL, projectID string) (*pending.Handler, func(), error) {
	auth, err := identity.New(identity.FromEnv("MEMO"))
	if err != nil {
		return nil, nil, err
	}
	publicURL := os.Getenv("MEMO_PUBLIC_URL")
	if publicURL != "" {
		origin, err := parseOrigin(publicURL)
		if err != nil || origin.Scheme != "https" || origin.Path != "" || strings.Contains(publicURL, "#") {
			return nil, nil, errors.New("MEMO_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment")
		}
	}
	if raw := os.Getenv("MEMO_DIRECTORY_URL"); raw != "" {
		origin, err := parseOrigin(raw)
		if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") {
			return nil, nil, errors.New("MEMO_DIRECTORY_URL must be an HTTP or HTTPS origin")
		}
	}
	platform := platformclient.New(upstreamURL, projectID, platformclient.WithHTTPClient(auth.HTTPClient()))
	links := link.NewClient(link.NewResolver(platform, "memo", os.LookupEnv, map[string]link.Required{"directory": {URLEnv: "MEMO_DIRECTORY_URL", PublicURLEnv: "MEMO_DIRECTORY_PUBLIC_URL"}}), nil)
	memo := pending.Serve(api.Unavailable())
	dsn := os.Getenv("MEMO_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		// Nothing to wait for: the API reports the missing configuration itself.
		memo.Swap(api.Unavailable())
		return memo, func() {}, nil
	}
	seed := os.Getenv("MEMO_DEV_SEED") == "1"
	directoryPublicURL := os.Getenv("MEMO_DIRECTORY_PUBLIC_URL")
	stop := pending.Connect("memo database", storeRetryInitial, func(ctx context.Context) (io.Closer, error) {
		ctx, cancel := context.WithTimeout(ctx, storeOpenTimeout)
		defer cancel()
		database, err := store.Open(ctx, dsn)
		if err != nil {
			return nil, err
		}
		if seed {
			if err := database.SeedDev(ctx); err != nil {
				_ = database.Close()
				return nil, err
			}
		}
		memo.Swap(api.New(database, auth, platform, links, directoryPublicURL))
		return database, nil
	})
	return memo, stop, nil
}
