-- ============================================================
-- SCHEMA.sql — scouts-db (D1)
-- Princes Park Scout Group App
-- Last updated: 2026-06-22
-- 
-- IMPORTANT: This file reflects the CURRENT live database state.
-- Do not re-run this file — it will fail on existing tables.
-- For new changes, create migrate6.sql, migrate7.sql etc.
-- ============================================================

-- Members synced from Terrain
-- NOTE: id IS the Terrain GUID (TEXT) — this is the primary key
--       used everywhere including channel_members.member_id
CREATE TABLE members (
  id            TEXT PRIMARY KEY,   -- Terrain GUID e.g. "f96cccbd-b7da-3199-ac82-0d94d2630dd6"
  first_name    TEXT,
  last_name     TEXT,
  patrol        TEXT,
  role          TEXT,               -- 'member' (youth) or 'leader'
  status        TEXT,               -- 'active' or 'inactive'
  unit_id       TEXT,               -- Terrain unit GUID
  member_number TEXT,               -- e.g. "8134812" (numeric part of Cognito username)
  last_synced   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Events synced from Terrain
CREATE TABLE events (
  id             TEXT PRIMARY KEY,  -- Terrain event GUID
  title          TEXT,
  start_datetime TEXT,
  end_datetime   TEXT,
  location       TEXT,
  status         TEXT,              -- 'upcoming', 'concluded'
  challenge_area TEXT,
  description    TEXT,
  unit_id        TEXT,              -- which unit this event belongs to
  last_synced    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Attendance records (local + pending sync to Terrain)
CREATE TABLE attendance (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT,
  member_id          TEXT,          -- members.id (Terrain GUID)
  attended           INTEGER DEFAULT 0,  -- 0 or 1
  synced_to_terrain  INTEGER DEFAULT 0,  -- 0 = pending, 1 = done
  recorded_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, member_id)
);

-- Auth tokens (Cognito ID tokens, expire after 1 hour)
CREATE TABLE auth_tokens (
  member_id         TEXT PRIMARY KEY,  -- Cognito username e.g. "vic-8134812"
  token             TEXT,              -- Cognito IdToken (Bearer)
  expires_at        DATETIME,
  unit_id           TEXT,              -- leader's primary unit
  unit_ids          TEXT,              -- JSON array of all unit GUIDs this leader manages
  role              TEXT,              -- 'leader' or 'member'
  terrain_member_id TEXT,              -- Terrain GUID (same as members.id)
  first_name        TEXT,
  last_name         TEXT
);

-- Sync log
CREATE TABLE sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  status    TEXT,              -- 'ok', 'error', 'partial'
  detail    TEXT,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── CHAT TABLES (added migrate5b.sql) ────────────────────────

-- Chat channels
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT NOT NULL,   -- 'unit','patrol','project','council','direct','leaders'
  unit_id     TEXT,
  is_finite   INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  created_by  TEXT,            -- terrain GUID of creator
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channel membership
-- member_id stores Terrain GUID — joins to members.id (NOT members.terrain_member_id)
CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  member_id  TEXT NOT NULL,   -- Terrain GUID = members.id
  role       TEXT DEFAULT 'member',
  joined_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, member_id)
);

-- Messages
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,  -- Terrain GUID = members.id
  sender_name TEXT,
  sender_role TEXT DEFAULT 'member',
  content     TEXT NOT NULL,
  is_deleted  INTEGER DEFAULT 0,
  is_flagged  INTEGER DEFAULT 0,
  flag_reason TEXT,
  sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Keyword-triggered alerts for safeguarding
CREATE TABLE flag_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  severity    TEXT DEFAULT 'low',   -- 'low','medium','high'
  reviewed    INTEGER DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Leaders with full channel visibility (Two Present Leadership)
CREATE TABLE supervisors (
  member_id TEXT PRIMARY KEY,  -- Terrain GUID
  added_by  TEXT,
  added_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Configurable keyword list for chat moderation
CREATE TABLE keyword_flags (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword  TEXT UNIQUE NOT NULL,
  severity TEXT DEFAULT 'low'
);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX idx_messages_channel        ON messages(channel_id, sent_at);
CREATE INDEX idx_channel_members_member  ON channel_members(member_id);
CREATE INDEX idx_flag_alerts_unreviewed  ON flag_alerts(reviewed, created_at);

-- ── KNOWN UNIT IDs ────────────────────────────────────────────
-- Joeys:     6ed6a27f-e76e-49b7-ad20-d8143d37dbe3
-- Cubs:      a1fb7ab1-96d2-4b02-b3e8-fc0bed99142b
-- Scouts:    054bc5df-bb9d-4ef9-a041-1a22518c4d1a  (default)
-- Venturers: c5bfe4a0-9734-4b73-b544-99bb0bd42716
-- Rovers:    6fe441ab-1382-406a-bbf8-aeb6a03b86c1
-- Group ID:  89053a96-7a60-3680-8212-bcd64a7996cb
