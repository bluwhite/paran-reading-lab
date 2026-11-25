CREATE TABLE studies (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 config TEXT NOT NULL,
 secret_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE sessions (
 study_id TEXT NOT NULL REFERENCES studies(id),
 id TEXT NOT NULL,
 participant TEXT NOT NULL,
 name TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(study_id,id)
);
