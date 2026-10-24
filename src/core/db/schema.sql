-- xsuite schema v1
-- 迁移器按 schema_version 顺序执行，这里只放 v1 的完整结构。

-- 0. 版本记录（由迁移器创建，这里只保证首次执行时不冲突）
CREATE TABLE IF NOT EXISTS schema_version (
  version       INTEGER PRIMARY KEY,
  applied_at    TEXT NOT NULL
);

-- 1. 账号
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL,
  name          TEXT,
  followers     INTEGER DEFAULT 0,
  following     INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 2. 用户画像
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL,
  prev_handles  TEXT DEFAULT '[]',
  name          TEXT,
  bio           TEXT,
  location      TEXT,
  followers     INTEGER,
  following     INTEGER,
  tweets        INTEGER,
  media_count   INTEGER,
  joined_at     TEXT,
  verified      INTEGER DEFAULT 0,
  has_avatar    INTEGER DEFAULT 1,
  protected     INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  last_tweet_at TEXT,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX idx_users_handle ON users(handle);

-- 3. 关系当前状态与历史
CREATE TABLE relationships (
  account_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  since         TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ended_at      TEXT,
  PRIMARY KEY (account_id, user_id, kind)
);
CREATE INDEX idx_rel_active ON relationships(account_id, kind, active);

-- 4. 白名单
CREATE TABLE whitelist (
  account_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

-- 5. 快照头
CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  taken_at      TEXT NOT NULL,
  item_count    INTEGER NOT NULL,
  expected_min  INTEGER,
  bottom_cursor TEXT,
  complete      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_snapshots_valid ON snapshots(account_id, kind, complete, id DESC);

-- 6. 快照明细
CREATE TABLE snapshot_members (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  position      INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, user_id)
);

-- 7. 关系变化
CREATE TABLE changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  change        TEXT NOT NULL,
  action_id     INTEGER,
  detected_at   TEXT NOT NULL,
  from_snapshot INTEGER NOT NULL,
  to_snapshot   INTEGER NOT NULL
);
CREATE INDEX idx_changes_kind_time ON changes(account_id, kind, detected_at DESC);

-- 8. 操作队列
CREATE TABLE actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  status        TEXT NOT NULL,
  source        TEXT,
  reason        TEXT,
  batch_id      TEXT,
  created_at    TEXT NOT NULL,
  approved_at   TEXT,
  executed_at   TEXT,
  error         TEXT
);
CREATE INDEX idx_actions_status ON actions(status, created_at);

-- 9. 推文存档
CREATE TABLE tweets (
  rowid_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT UNIQUE NOT NULL,
  author_id     TEXT NOT NULL,
  author_handle TEXT,
  text          TEXT NOT NULL,
  lang          TEXT,
  created_at    TEXT NOT NULL,
  likes         INTEGER DEFAULT 0,
  retweets      INTEGER DEFAULT 0,
  replies       INTEGER DEFAULT 0,
  views         INTEGER DEFAULT 0,
  is_reply      INTEGER NOT NULL DEFAULT 0,
  is_retweet    INTEGER NOT NULL DEFAULT 0,
  has_media     INTEGER NOT NULL DEFAULT 0,
  raw           TEXT,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX idx_tweets_author ON tweets(author_id, created_at DESC);
CREATE INDEX idx_tweets_time   ON tweets(created_at DESC);

-- 10. FTS5 全文检索（trigram，支持中日英子串；两字查询需走 LIKE 降级）
CREATE VIRTUAL TABLE tweets_fts USING fts5(
  text,
  content='tweets',
  content_rowid='rowid_id',
  tokenize='trigram'
);

CREATE TRIGGER tweets_ai AFTER INSERT ON tweets BEGIN
  INSERT INTO tweets_fts(rowid, text) VALUES (new.rowid_id, new.text);
END;
CREATE TRIGGER tweets_ad AFTER DELETE ON tweets BEGIN
  INSERT INTO tweets_fts(tweets_fts, rowid, text) VALUES('delete', old.rowid_id, old.text);
END;
CREATE TRIGGER tweets_au AFTER UPDATE OF text ON tweets BEGIN
  INSERT INTO tweets_fts(tweets_fts, rowid, text) VALUES('delete', old.rowid_id, old.text);
  INSERT INTO tweets_fts(rowid, text) VALUES (new.rowid_id, new.text);
END;

-- 11. 关键词追踪
CREATE TABLE watch_terms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  term          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_run_at   TEXT,
  since_id      TEXT
);

-- 12. 命中关联
CREATE TABLE term_hits (
  term_id       INTEGER NOT NULL REFERENCES watch_terms(id) ON DELETE CASCADE,
  tweet_id      TEXT NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  found_at      TEXT NOT NULL,
  PRIMARY KEY (term_id, tweet_id)
);
CREATE INDEX idx_hits_time ON term_hits(found_at DESC);

-- 13. 统计快照
CREATE TABLE stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  snapshot_id   INTEGER REFERENCES snapshots(id),
  kind          TEXT NOT NULL,
  taken_at      TEXT NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX idx_stats_kind_time ON stats(account_id, kind, taken_at DESC);

-- 14. AI 结果缓存
CREATE TABLE analyses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  task          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  result        TEXT,
  status        TEXT NOT NULL DEFAULT 'done',
  error         TEXT,
  cost_tokens   INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_analyses_cache ON analyses(task, input_hash);
CREATE INDEX idx_analyses_subject ON analyses(subject_type, subject_id, task);

-- 15. 请求防重账本
CREATE TABLE fetch_log (
  endpoint      TEXT NOT NULL,
  params_hash   TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  item_count    INTEGER DEFAULT 0,
  PRIMARY KEY (endpoint, params_hash)
);

-- 16. 每日配额
CREATE TABLE daily_quota (
  account_id    TEXT NOT NULL,
  day           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, kind)
);
