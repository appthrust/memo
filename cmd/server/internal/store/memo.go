package store

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/memo/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

type scanner interface{ Scan(...any) error }

func scanAuthor(row scanner) (a domain.Author, err error) {
	err = row.Scan(&a.ID, &a.DisplayName, &a.Email, &a.DirectoryPersonID)
	return
}

const authorColumns = "id, display_name, email, directory_person_id"

// UpsertAuthor records the caller from the OIDC claims. Once Directory has
// linked the author (RefreshDirectory), the Directory display name stays
// authoritative and claims only refresh the email.
func (t *Tx) UpsertAuthor(subject, name, email string) (domain.Author, error) {
	return scanAuthor(t.SQL.QueryRowContext(t.Context, `INSERT INTO authors(id,subject,display_name,email) VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET display_name=CASE WHEN authors.directory_person_id IS NULL THEN excluded.display_name ELSE authors.display_name END,email=excluded.email,updated_at=now() RETURNING `+authorColumns, ulid.Make().String(), subject, name, email))
}
func (t *Tx) AuthorBySubject(subject string) (domain.Author, error) {
	return scanAuthor(t.SQL.QueryRowContext(t.Context, `SELECT `+authorColumns+` FROM authors WHERE subject=$1`, subject))
}
func (t *Tx) Author(id string) (domain.Author, error) {
	return scanAuthor(t.SQL.QueryRowContext(t.Context, `SELECT `+authorColumns+` FROM authors WHERE id=$1`, id))
}
func (t *Tx) RefreshDirectory(id, person, name string) (domain.Author, error) {
	return scanAuthor(t.SQL.QueryRowContext(t.Context, `UPDATE authors SET directory_person_id=$2,display_name=$3,updated_at=now() WHERE id=$1 RETURNING `+authorColumns, id, person, name))
}
func (t *Tx) Counts(id string) (c domain.Counts, err error) {
	err = t.SQL.QueryRowContext(t.Context, `SELECT (SELECT count(*) FROM articles WHERE author_id=$1 AND status='published'),(SELECT count(*) FROM articles WHERE author_id=$1 AND status='draft'),(SELECT count(*) FROM follows WHERE followee_id=$1),(SELECT count(*) FROM follows WHERE follower_id=$1)`, id).Scan(&c.Published, &c.Drafts, &c.Followers, &c.Following)
	return
}

const articleSelect = `SELECT a.id,a.title,a.body,a.status,a.published_at,a.created_at,a.updated_at,u.id,u.display_name,u.email,u.directory_person_id,(SELECT count(*) FROM likes l WHERE l.article_id=a.id),EXISTS(SELECT 1 FROM likes l WHERE l.article_id=a.id AND l.author_id=$1) FROM articles a JOIN authors u ON u.id=a.author_id `

func scanArticle(row scanner) (a domain.Article, err error) {
	err = row.Scan(&a.ID, &a.Title, &a.Body, &a.Status, &a.PublishedAt, &a.CreatedAt, &a.UpdatedAt, &a.Author.ID, &a.Author.DisplayName, &a.Author.Email, &a.Author.DirectoryPersonID, &a.LikeCount, &a.LikedByMe)
	a.Excerpt = domain.Excerpt(a.Body)
	return
}
func (t *Tx) Article(id, viewer string) (domain.Article, error) {
	return scanArticle(t.SQL.QueryRowContext(t.Context, articleSelect+`WHERE a.id=$2`, viewer, id))
}
func (t *Tx) CreateArticle(author, title, body string, publish bool) (domain.Article, error) {
	id := ulid.Make().String()
	status := "draft"
	var at *time.Time
	if publish {
		status = "published"
		now := time.Now().UTC()
		at = &now
	}
	if err := t.Exec(`INSERT INTO articles(id,author_id,title,body,status,published_at) VALUES($1,$2,$3,$4,$5,$6)`, id, author, title, body, status, at); err != nil {
		return domain.Article{}, err
	}
	return t.Article(id, author)
}
func (t *Tx) UpdateArticle(a domain.Article, viewer string) (domain.Article, error) {
	err := t.Exec(`UPDATE articles SET title=$2,body=$3,status=$4,published_at=$5,updated_at=now() WHERE id=$1`, a.ID, a.Title, a.Body, a.Status, a.PublishedAt)
	if err != nil {
		return domain.Article{}, err
	}
	return t.Article(a.ID, viewer)
}
func (t *Tx) DeleteArticle(id string) error { return t.Exec(`DELETE FROM articles WHERE id=$1`, id) }

type TimelineOptions struct {
	Limit                  int
	Cursor, Author, Viewer string
	Following              bool
}
type Page struct {
	Items      []domain.ArticleSummary `json:"items"`
	NextCursor *string                 `json:"nextCursor"`
}

func ParseCursor(cursor string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 2 {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	if _, err := ulid.ParseStrict(parts[1]); err != nil {
		return time.Time{}, "", httpx.Invalid("Invalid cursor")
	}
	return at, parts[1], nil
}
func (t *Tx) Timeline(o TimelineOptions) (Page, error) {
	page := Page{Items: []domain.ArticleSummary{}}
	var at any
	id := ""
	if o.Cursor != "" {
		parsed, key, err := ParseCursor(o.Cursor)
		if err != nil {
			return page, err
		}
		at = parsed
		id = key
	}
	rows, err := t.SQL.QueryContext(t.Context, articleSelect+`WHERE a.status='published' AND ($2='' OR a.author_id=$2) AND (NOT $3 OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=a.author_id)) AND ($4::timestamptz IS NULL OR (a.published_at,a.id)<($4::timestamptz,$5)) ORDER BY a.published_at DESC,a.id DESC LIMIT $6`, o.Viewer, o.Author, o.Following, at, id, o.Limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanArticle(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, a.ArticleSummary)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > o.Limit {
		page.Items = page.Items[:o.Limit]
		last := page.Items[o.Limit-1]
		cursor := base64.RawURLEncoding.EncodeToString([]byte(last.PublishedAt.Format(time.RFC3339Nano) + "|" + last.ID))
		page.NextCursor = &cursor
	}
	return page, nil
}
func (t *Tx) Drafts(viewer string) ([]domain.ArticleSummary, error) {
	result := []domain.ArticleSummary{}
	rows, err := t.SQL.QueryContext(t.Context, articleSelect+`WHERE a.author_id=$1 AND a.status='draft' ORDER BY a.updated_at DESC,a.id DESC`, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanArticle(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, a.ArticleSummary)
	}
	return result, rows.Err()
}
func (t *Tx) Like(article, author string, on bool) (int, error) {
	var err error
	if on {
		err = t.Exec(`INSERT INTO likes(article_id,author_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, article, author)
	} else {
		err = t.Exec(`DELETE FROM likes WHERE article_id=$1 AND author_id=$2`, article, author)
	}
	if err != nil {
		return 0, err
	}
	var count int
	err = t.SQL.QueryRowContext(t.Context, `SELECT count(*) FROM likes WHERE article_id=$1`, article).Scan(&count)
	return count, err
}
func (t *Tx) Follow(follower, followee string, on bool) (int, error) {
	var err error
	if on {
		err = t.Exec(`INSERT INTO follows(follower_id,followee_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, follower, followee)
	} else {
		err = t.Exec(`DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2`, follower, followee)
	}
	if err != nil {
		return 0, err
	}
	var count int
	err = t.SQL.QueryRowContext(t.Context, `SELECT count(*) FROM follows WHERE followee_id=$1`, followee).Scan(&count)
	return count, err
}
func (t *Tx) Profile(id, viewer string) (p domain.AuthorProfile, err error) {
	p.Author, err = t.Author(id)
	if err != nil {
		return
	}
	c, err := t.Counts(id)
	if err != nil {
		return p, err
	}
	p.ArticleCount = c.Published
	p.FollowerCount = c.Followers
	p.FollowingCount = c.Following
	p.IsMe = id == viewer
	err = t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2)`, viewer, id).Scan(&p.FollowedByMe)
	return
}
func (t *Tx) Connections(id string, followers bool) ([]domain.Author, error) {
	if _, err := t.Author(id); err != nil {
		return nil, err
	}
	target, other := "f.follower_id", "f.followee_id"
	if !followers {
		target, other = other, target
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT u.id,u.display_name,u.email,u.directory_person_id FROM follows f JOIN authors u ON u.id=`+target+` WHERE `+other+`=$1 ORDER BY f.created_at DESC,u.id DESC LIMIT 200`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.Author{}
	for rows.Next() {
		a, err := scanAuthor(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}
func (s *Store) SeedDev(ctx context.Context) error {
	return s.Do(ctx, true, func(t *Tx) error {
		var n int
		if err := t.SQL.QueryRowContext(ctx, `SELECT count(*) FROM authors`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return nil
		}
		authors := make([]domain.Author, 3)
		for i, name := range []string{"Aoi Tanaka", "Ren Suzuki", "Hana Sato"} {
			a, err := t.UpsertAuthor(fmt.Sprintf("memo-demo-%d", i), name, fmt.Sprintf("memo%d@example.test", i))
			if err != nil {
				return err
			}
			authors[i] = a
		}
		for i := range 8 {
			a, err := t.CreateArticle(authors[i%3].ID, fmt.Sprintf("Memo %d", i+1), "# Team notes\n\nShare what you learned with the team.", i < 6)
			if err != nil {
				return err
			}
			if i < 6 {
				if _, err = t.Like(a.ID, authors[(i+1)%3].ID, true); err != nil {
					return err
				}
			}
		}
		_, err := t.Follow(authors[0].ID, authors[1].ID, true)
		return err
	})
}
