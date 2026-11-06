package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/memo/cmd/server/internal/domain"
	"github.com/appthrust/memo/cmd/server/internal/store"
)

type meResponse struct {
	Author domain.Author `json:"author"`
	Roles  struct {
		MemoAdmin bool `json:"memoAdmin"`
	} `json:"roles"`
	Directory struct {
		Linked    bool    `json:"linked"`
		PublicURL *string `json:"publicUrl"`
	} `json:"directory"`
	Counts domain.Counts `json:"counts"`
}

// me upserts the caller and refreshes the author from Directory. Directory is
// an enhancement: any link failure (absent, installing, unreachable, denied,
// rejected) degrades to the OIDC claims instead of failing the session.
func (a *API) me(s *request) (any, int, error) {
	result := meResponse{Author: s.author}
	result.Roles.MemoAdmin = s.access.IsConsoleAdmin
	if a.directoryPublicURL != "" {
		public := a.directoryPublicURL
		result.Directory.PublicURL = &public
	}
	if a.links != nil {
		var me directory.MeResponse
		if err := a.links.Do(s.r.Context(), s.bearer, directory.Me, link.Params{}, nil, &me); err == nil {
			var err error
			result.Author, err = s.tx.RefreshDirectory(s.author.ID, me.Person.ID, me.Person.DisplayName)
			if err != nil {
				return nil, 0, err
			}
			result.Directory.Linked = true
		}
	}
	var err error
	result.Counts, err = s.tx.Counts(s.author.ID)
	return result, 200, err
}
func (a *API) timeline(s *request) (any, int, error) {
	q := s.r.URL.Query()
	limit := 20
	if values, ok := q["limit"]; ok {
		n, err := strconv.Atoi(values[0])
		if err != nil || n < 1 || n > 50 {
			return nil, 0, httpx.Invalid("Limit must be between 1 and 50")
		}
		limit = n
	}
	page, err := s.tx.Timeline(store.TimelineOptions{Limit: limit, Cursor: q.Get("cursor"), Author: q.Get("author"), Viewer: s.author.ID, Following: q.Get("following") == "true"})
	return page, 200, err
}
func (a *API) drafts(s *request) (any, int, error) {
	rows, err := s.tx.Drafts(s.author.ID)
	return map[string]any{"items": rows}, 200, err
}
func (a *API) createArticle(s *request) (any, int, error) {
	var input struct {
		Title   string `json:"title"`
		Body    string `json:"body"`
		Publish bool   `json:"publish"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	status := "draft"
	if input.Publish {
		status = "published"
	}
	title, err := validateArticle(input.Title, input.Body, status)
	if err != nil {
		return nil, 0, err
	}
	article, err := s.tx.CreateArticle(s.author.ID, title, input.Body, input.Publish)
	return article, 201, err
}
func visibleArticle(s *request) (domain.Article, error) {
	article, err := s.tx.Article(s.r.PathValue("id"), s.author.ID)
	if err != nil {
		return article, err
	}
	if article.Status == "draft" && article.Author.ID != s.author.ID {
		return domain.Article{}, httpx.NotFound()
	}
	return article, nil
}
func (a *API) article(s *request) (any, int, error) {
	article, err := visibleArticle(s)
	return article, 200, err
}
func (a *API) patchArticle(s *request) (any, int, error) {
	article, err := visibleArticle(s)
	if err != nil {
		return nil, 0, err
	}
	if article.Author.ID != s.author.ID {
		return nil, 0, httpx.Forbidden()
	}
	var input struct {
		Title  *string `json:"title"`
		Body   *string `json:"body"`
		Status *string `json:"status"`
	}
	if err := decode(s, &input); err != nil {
		return nil, 0, err
	}
	if input.Title != nil {
		article.Title = *input.Title
	}
	if input.Body != nil {
		article.Body = *input.Body
	}
	if input.Status != nil {
		article.Status = *input.Status
	}
	article.Title, err = validateArticle(article.Title, article.Body, article.Status)
	if err != nil {
		return nil, 0, err
	}
	if article.Status == "draft" {
		article.PublishedAt = nil
	} else if article.PublishedAt == nil {
		now := time.Now().UTC()
		article.PublishedAt = &now
	}
	result, err := s.tx.UpdateArticle(article, s.author.ID)
	return result, 200, err
}
func (a *API) deleteArticle(s *request) (any, int, error) {
	article, err := visibleArticle(s)
	if err != nil {
		return nil, 0, err
	}
	if article.Author.ID != s.author.ID && !s.access.IsConsoleAdmin {
		return nil, 0, httpx.Forbidden()
	}
	return nil, 204, s.tx.DeleteArticle(article.ID)
}
func (a *API) like(s *request) (any, int, error) {
	article, err := visibleArticle(s)
	if err != nil {
		return nil, 0, err
	}
	if article.Status != "published" {
		return nil, 0, httpx.NotFound()
	}
	on := s.r.Method == http.MethodPut
	count, err := s.tx.Like(article.ID, s.author.ID, on)
	return map[string]any{"likeCount": count, "likedByMe": on}, 200, err
}
func (a *API) profile(s *request) (any, int, error) {
	profile, err := s.tx.Profile(s.r.PathValue("id"), s.author.ID)
	return profile, 200, err
}
func (a *API) followers(s *request) (any, int, error) {
	rows, err := s.tx.Connections(s.r.PathValue("id"), true)
	return map[string]any{"items": rows}, 200, err
}
func (a *API) following(s *request) (any, int, error) {
	rows, err := s.tx.Connections(s.r.PathValue("id"), false)
	return map[string]any{"items": rows}, 200, err
}
func (a *API) follow(s *request) (any, int, error) {
	id := s.r.PathValue("id")
	if _, err := s.tx.Author(id); err != nil {
		return nil, 0, err
	}
	if id == s.author.ID {
		return nil, 0, httpx.Fail(400, "self_follow", "You cannot follow yourself")
	}
	on := s.r.Method == http.MethodPut
	count, err := s.tx.Follow(s.author.ID, id, on)
	return map[string]any{"followerCount": count, "followedByMe": on}, 200, err
}
