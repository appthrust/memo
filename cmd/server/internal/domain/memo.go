package domain

import (
	"regexp"
	"strings"
	"time"
)

type Author struct {
	ID                string  `json:"id"`
	DisplayName       string  `json:"displayName"`
	Email             string  `json:"email"`
	DirectoryPersonID *string `json:"directoryPersonId"`
}
type ArticleSummary struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Excerpt     string     `json:"excerpt"`
	Status      string     `json:"status"`
	Author      Author     `json:"author"`
	PublishedAt *time.Time `json:"publishedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	LikeCount   int        `json:"likeCount"`
	LikedByMe   bool       `json:"likedByMe"`
}
type Article struct {
	ArticleSummary
	Body string `json:"body"`
}
type AuthorProfile struct {
	Author         Author `json:"author"`
	ArticleCount   int    `json:"articleCount"`
	FollowerCount  int    `json:"followerCount"`
	FollowingCount int    `json:"followingCount"`
	FollowedByMe   bool   `json:"followedByMe"`
	IsMe           bool   `json:"isMe"`
}
type Counts struct {
	Published int `json:"published"`
	Drafts    int `json:"drafts"`
	Followers int `json:"followers"`
	Following int `json:"following"`
}

var markdownLink = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
var htmlTag = regexp.MustCompile(`<[^>]*>`)
var markdownMarkers = strings.NewReplacer("#", "", "*", "", "_", "", "`", "", ">", "", "-", "")

// Excerpt removes Markdown presentation and inline HTML before taking a
// Unicode-safe preview. The excerpt is plain text; the SPA renders it as such.
func Excerpt(body string) string {
	text := htmlTag.ReplaceAllString(markdownLink.ReplaceAllString(body, "$1"), " ")
	text = strings.Join(strings.Fields(markdownMarkers.Replace(text)), " ")
	runes := []rune(text)
	if len(runes) > 160 {
		return string(runes[:160])
	}
	return text
}
