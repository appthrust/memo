CREATE TABLE authors (
 id text PRIMARY KEY, subject text NOT NULL UNIQUE, display_name text NOT NULL,
 email text NOT NULL, directory_person_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE articles (
 id text PRIMARY KEY, author_id text NOT NULL REFERENCES authors(id),
 title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
 body text NOT NULL CHECK (octet_length(body) <= 102400),
 status text NOT NULL CHECK (status IN ('draft', 'published')),
 published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL AND length(btrim(body)) > 0))
);
CREATE TABLE likes (
 article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(article_id, author_id)
);
CREATE TABLE follows (
 follower_id text NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
 followee_id text NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(follower_id, followee_id), CHECK(follower_id <> followee_id)
);
CREATE INDEX articles_timeline ON articles(status, published_at DESC, id DESC);
CREATE INDEX articles_author ON articles(author_id, status, published_at DESC, id DESC);
CREATE INDEX likes_author ON likes(author_id);
CREATE INDEX follows_followee ON follows(followee_id);
