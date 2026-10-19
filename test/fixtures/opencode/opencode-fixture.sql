-- OpenCode opencode.db fixture. Mirrors the V2 generation DDL from
-- packages/core/src/database/schema.gen.ts (session_v2 + session_message)
-- plus the frozen V1 tables (session + message) that survive an upgrade
-- (migration 20260127222353_familiar_lady_ursula.ts). Foreign keys are
-- omitted so the file runs standalone.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS `project` (
  `id` text PRIMARY KEY,
  `worktree` text NOT NULL,
  `vcs` text,
  `name` text,
  `icon_url` text,
  `icon_color` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_initialized` integer,
  `sandboxes` text NOT NULL
);

-- V1 (legacy, frozen after upgrade to 2.x)
CREATE TABLE IF NOT EXISTS `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `parent_id` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `title` text NOT NULL,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `revert` text,
  `permission` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_compacting` integer,
  `time_archived` integer
);
CREATE TABLE IF NOT EXISTS `message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE TABLE IF NOT EXISTS `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);

-- V2 (OpenCode 2.x, current)
CREATE TABLE IF NOT EXISTS `session_v2` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `fork_session_id` text,
  `fork_boundary` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,
  `path` text,
  `title` text,
  `version` text NOT NULL,
  `share_url` text,
  `summary_additions` integer,
  `summary_deletions` integer,
  `summary_files` integer,
  `summary_diffs` text,
  `metadata` text,
  `cost` real DEFAULT 0 NOT NULL,
  `tokens_input` integer DEFAULT 0 NOT NULL,
  `tokens_output` integer DEFAULT 0 NOT NULL,
  `tokens_reasoning` integer DEFAULT 0 NOT NULL,
  `tokens_cache_read` integer DEFAULT 0 NOT NULL,
  `tokens_cache_write` integer DEFAULT 0 NOT NULL,
  `revert` text,
  `permission` text,
  `agent` text,
  `model` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_idle` integer,
  `time_viewed` integer,
  `idle_outcome` text,
  `time_compacting` integer,
  `time_archived` integer,
  `time_suspended` integer,
  `resume_attempts` integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS `session_message` (
  `id` text PRIMARY KEY,
  `session_id` text NOT NULL,
  `type` text NOT NULL,
  `seq` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE INDEX IF NOT EXISTS `session_message_time_created_idx` ON `session_message` (`time_created`);

INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
VALUES ('prj_01HZ3K8Q0W7R6E5Y4U3I2O1P0A', '/home/dev/projects/pricetag', 'git', 'pricetag', 1776519000000, 1776519000000, '[]');

-- V2 session: directory is the absolute project cwd (forward slashes even on Windows,
-- see migration 20260601010001_normalize_storage_paths.ts). time_created is Unix ms.
INSERT INTO session_v2 (id, project_id, slug, directory, title, version, cost,
  tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  model, time_created, time_updated)
VALUES ('ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P', 'prj_01HZ3K8Q0W7R6E5Y4U3I2O1P0A', 'json-report-flag',
  '/home/dev/projects/pricetag', 'Add --json flag to report', '2.0.32',
  0.0334, 3774, 1816, 1024, 22656, 1200,
  '{"providerID":"anthropic","id":"claude-sonnet-4-5"}', 1776519602000, 1776519641000);

-- user message (no tokens)
INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
VALUES ('msg_01HZ3K9T5A1B2C3D4E5F6G7H8I', 'ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P', 'user', 1, 1776519602551, 1776519602551,
  '{"id":"msg_01HZ3K9T5A1B2C3D4E5F6G7H8I","type":"user","time":{"created":1776519602551},"content":[{"type":"text","text":"Add a --json flag to the report command"}]}');

-- assistant message 1: data.tokens.input is NON-cached input; cache.read/write are separate buckets
INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
VALUES ('msg_01HZ3K9T9J2K3L4M5N6O7P8Q9R', 'ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P', 'assistant', 2, 1776519606318, 1776519606318,
  '{"id":"msg_01HZ3K9T9J2K3L4M5N6O7P8Q9R","type":"assistant","agent":"build","model":{"id":"claude-sonnet-4-5","providerID":"anthropic"},"content":[{"type":"text","text":"Looking at the report command."},{"type":"tool","name":"read","state":{"status":"completed","input":{"filePath":"src/report.ts"}}}],"finish":"tool-calls","cost":0.0124,"tokens":{"input":2240,"output":612,"reasoning":384,"cache":{"read":10240,"write":1200}},"time":{"created":1776519606318,"completed":1776519609880}}');

-- assistant message 2
INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
VALUES ('msg_01HZ3K9TCS3T4U5V6W7X8Y9Z0A', 'ses_01HZ3K9T2Q8W7R6E5Y4U3I2O1P', 'assistant', 3, 1776519624117, 1776519624117,
  '{"id":"msg_01HZ3K9TCS3T4U5V6W7X8Y9Z0A","type":"assistant","agent":"build","model":{"id":"claude-sonnet-4-5","providerID":"anthropic"},"content":[{"type":"text","text":"Added the flag and a test."}],"finish":"stop","cost":0.0210,"tokens":{"input":1534,"output":1204,"reasoning":640,"cache":{"read":12416,"write":0}},"time":{"created":1776519624117,"completed":1776519641902}}');

-- Legacy V1 rows (a pre-2.x session that was never copied forward)
INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
VALUES ('ses_01HX0LEGACY00000000000000', 'prj_01HZ3K8Q0W7R6E5Y4U3I2O1P0A', 'legacy-fix', '/home/dev/projects/pricetag', 'Legacy fix', '1.1.24', 1770000000000, 1770000005000);
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES ('msg_01HX0LEGACYASSISTANT000001', 'ses_01HX0LEGACY00000000000000', 1770000003000, 1770000003000,
  '{"id":"msg_01HX0LEGACYASSISTANT000001","sessionID":"ses_01HX0LEGACY00000000000000","role":"assistant","parentID":"msg_01HX0LEGACYUSER0000000001","modelID":"claude-sonnet-4-20250514","providerID":"anthropic","mode":"build","agent":"build","path":{"cwd":"/home/dev/projects/pricetag","root":"/home/dev/projects/pricetag"},"cost":0.0051,"tokens":{"total":5300,"input":900,"output":400,"reasoning":0,"cache":{"read":4000,"write":0}},"time":{"created":1770000003000,"completed":1770000004900},"finish":"stop"}');
