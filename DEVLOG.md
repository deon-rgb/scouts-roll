# Princes Park Scouts App — Dev Log

## Project overview
A PWA for Princes Park Scout Group (Victoria) to replace paper roll call and make Terrain more accessible for leaders and youth members. Built on Cloudflare Workers + D1 (backend) and Cloudflare Pages (frontend).

**Live URLs**
- Frontend: https://scouts-roll.pages.dev
- Backend: https://backend.scouts-app-deon.workers.dev
- GitHub: https://github.com/deon-rgb/scouts-roll

**Key identifiers**
- D1 database: `scouts-db` (ID: `b9488abf-c33b-4ba4-a912-c36219f29c70`)
- Cognito client ID: `6v98tbc09aqfvh52fml3usas3c`
- Cognito region: `ap-southeast-2`
- Group ID: `89053a96-7a60-3680-8212-bcd64a7996cb`
- Deon's Terrain GUID: `f96cccbd-b7da-3199-ac82-0d94d2630dd6`
- Deon's member number: `8134812` (Cognito username: `vic-8134812`)

**Deploy commands**
```bash
# Worker (must use --no-bundle flag)
cd ~/scouts-roll/backend && npx wrangler deploy --no-bundle

# Frontend
cd ~/scouts-roll && git add index.html && git commit -m "..." && git push origin main

# DB migration
cd ~/scouts-roll && npx wrangler d1 execute scouts-db --remote --file=migrateN.sql
```

---

## Architecture notes

- `members.id` IS the Terrain GUID (TEXT PRIMARY KEY) — not a separate column
- `auth_tokens.terrain_member_id` stores the Terrain GUID for the logged-in leader
- `channel_members.member_id` = Terrain GUID — JOINs to `members.id` directly
- All chat JOINs must use `members.id`, never `members.terrain_member_id` (that column doesn't exist on members)
- Cognito JWT `sub` claim is NOT the Terrain GUID — it's a Cognito internal ID. To get the Terrain GUID: strip prefix from Cognito username (e.g. `vic-8134812` → `8134812`), look up `members` table by `member_number`
- Calendars endpoint returns `own_calendars` array with `type: "unit"` and `type: "group"` entries — filter to `type === "unit"` only to get unit IDs
- Events from `/members/{guid}/events` include `invitee_id` = correct unit UUID for that event
- All auth goes through the Cloudflare Worker proxy — direct browser requests to Cognito are blocked by CORS
- Worker must be deployed with `--no-bundle` flag — bundler caches old code

---

## Terrain API reference

> **Last mapped: 2026-06-23** — systematic API exploration with live token

### Auth
- Endpoint: `https://cognito-idp.ap-southeast-2.amazonaws.com/`
- Method: POST with `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`
- Flow: `USER_PASSWORD_AUTH` with `ClientId` + `AuthParameters: {USERNAME, PASSWORD}`
- Returns: `AuthenticationResult.IdToken` (Bearer token, 1 hour expiry)
- ⚠️ JWT `sub` claim is a Cognito internal ID, NOT the Terrain GUID

### API domains
Six domains exist at `*.terrain.scouts.com.au`. All accept `Authorization: Bearer {IdToken}` except where noted.

| Domain | Status | Notes |
|--------|--------|-------|
| `members.terrain.scouts.com.au` | ✅ Bearer token | Profile, unit, group data |
| `events.terrain.scouts.com.au` | ✅ Bearer token | Calendars, events, attendance |
| `achievements.terrain.scouts.com.au` | ✅ Bearer token | OAS, milestones, logbook |
| `templates.terrain.scouts.com.au` | ✅ Public S3 | No auth — JSON form schemas |
| `agenda.terrain.scouts.com.au` | ❌ 403 all paths | Requires AWS SigV4 signing |
| `metrics.terrain.scouts.com.au` | ❌ 403 all paths | Requires AWS SigV4 signing |

> The 403 error `"Invalid key=value pair (missing equal-sign) in Authorization header (hashed with SHA-256 and encoded with Base64)"` means the path is behind an AWS WAF/API Gateway that requires SigV4 signing — these are internal-only.

> ⚠️ **`achiev.terrain.scouts.com.au` does NOT exist** — the correct subdomain is `achievements.terrain.scouts.com.au`.

---

### members.terrain.scouts.com.au

**GET /members/{terrain_guid}**
- Returns: `{ id, first_name, last_name, status, role, member_number, date_of_birth, units[], patrols[], groups[] }`
- `units[]` entries: `{ id, section, duty, unit_council }` — `duty` is "adult_leader" or "member"
- `groups[]` entries: `{ id, name }`

**GET /units/{unit_id}/members**
- Returns: `{ results: [{ id, member_number, first_name, last_name, status, date_of_birth, groups[], unit, patrol, metadata }] }`
- `unit` entry includes `duty`, `unit_council`, `group_id`
- `patrol` entry: `{ id, name, duty }`
- `metadata["achievement-import"]` = ISO timestamp of last achievement import

**GET /groups/{group_id}/members**
- Returns: `{ results: [{ id, first_name, last_name, status, member_number, date_of_birth, units[], role, unit }] }`
- Includes ALL members across all units in the group
- Each member has a `units[]` array (all units they belong to) and `unit` (primary unit)
- `units[]` entries include `name` field (e.g. "Princes Park Scouts")

---

### events.terrain.scouts.com.au

**GET /members/{terrain_guid}/calendars**
- Returns: `{ member_id, own_calendars[], other_calendars[] }`
- `own_calendars` types: `"group"`, `"unit"`, `"member"` (personal project patrol calendar)
- `other_calendars` types: `"unit"` (subscribed units), `"patrol"` (patrol calendars)
- Each entry: `{ id, type, title, selected, section }`
- Filter `own_calendars` to `type === "unit"` for managed units
- ⚠️ `other_calendars` can include units you're subscribed to but don't lead

**GET /members/{terrain_guid}/events?start_datetime=...&end_datetime=...**
- ⚠️ **Both `start_datetime` and `end_datetime` are REQUIRED** (returns 400 without them)
- Format: `2026-01-01T00:00:00` (no timezone, treated as UTC)
- Returns: `{ results: [{ id, start_datetime, end_datetime, title, invitee_type, status, challenge_area, section, invitee_id, invitee_name, group_id }] }`
- `invitee_type`: `"unit"` or `"group"`
- `invitee_id` = the unit/group UUID the event belongs to — use this for unit filtering
- `status`: `"upcoming"` or `"concluded"`
- `section`: `"scout"`, `"joey"`, `"cub"`, `"venturer"`, `"rover"`, or `""` for group events
- Events across all calendars are returned (including subscribed units and group events)

**GET /events/{event_id}**
- Returns full event detail with attendance roles, review, OAS data
- Key fields:
  ```
  {
    id, status, title, location, challenge_area,
    start_datetime, end_datetime,
    organiser: { id, first_name, last_name, member_number },
    organisers: [...],
    attendance: {
      leader_members: [...],       // patrol leaders (youth) — have patrol_name
      assistant_members: [...],    // APLs (youth) — have patrol_name
      participant_members: [...],  // regular youth — have patrol_name
      attendee_members: [...]      // who actually attended (subset)
    },
    invitees: [{ invitee_id, invitee_type, invitee_name, id }],
    review: {
      general_rating: "great"|"ok"|"poor",
      general_tags: [...],
      scout_method_elements: [...],
      scout_spices_elements: [...]
    },
    owner_type: "unit"|"group",
    owner_id: "...",
    achievement_pathway_oas_data: {
      award_rule: "individual"|"group",
      verifier: { name, contact, type },
      groups: [...]
    },
    achievement_pathway_logbook_data: {
      distance_travelled, distance_walkabout,
      achievement_meta: { stream, branch },
      categories: [...],
      details: { activity_time_length, activity_grade },
      title
    }
  }
  ```
- `leader_members` = youth in patrol leader role; `assistant_members` = APLs; both also appear in `participant_members`
- `attendee_members` = who ticked as attended (not necessarily same as participant_members)

**PATCH /events/{event_id}**
- Body: `{ attendee_member_ids: [...guids], participant_member_ids: [...guids] }`
- Both arrays must be set to the same values
- Returns: 204 No Content on success

---

### achievements.terrain.scouts.com.au

**GET /members/{terrain_guid}/achievements**
- Returns ALL achievement records for the member across all sections
- `{ results: [{ id, member_id, section, type, status, status_updated, last_updated, achievement_meta, ... }] }`
- **Types:**
  - `outdoor_adventure_skill` — OAS; meta: `{ stage, stream, branch }`; has `template`, `version`, `answers`, `latest_submission`
  - `milestone` — milestone review; meta: `{ stage }`; has `event_log[]`, `event_count{}`, `milestone_requirement_status`
  - `special_interest_area` — SIA; meta: `{ sia_area }`; has `template`, `answers`, `can_archive`
  - `adventurous_journey` — AJ plan/review; has `template`, `answers`, `uploads[]`
  - `intro_section` — section intro; may have `imported`
  - `intro_scouting` — intro to Scouting; may have `imported`
  - `course_reflection` — PDC etc.; has `template`, `answers`, `latest_submission`
  - `personal_reflection` — top award reflection; has `template`, `answers`, `uploads[]`
  - `additional_award` — historic awards; meta: `{ additional_award_id }`; has `imported`
  - `peak_award` — Queen's Scout / Grey Wolf etc.; may have `imported`
- **Statuses:** `awarded`, `in_progress`, `draft_review`, `feedback_review`, `feedback_approval`, `draft_approval`, `approved`, `pending_review`, `not_required`
- `uploads[]` entries have: `id`, `filename`, `bucket`, `key`, `url` (pre-signed S3 URL), `uploaded_on`
- `event_log[]` in milestones: `{ credit_type, challenge_area, event_id, event_name, event_start_datetime }`
- `event_count{}` in milestones: `{ participant: {community,outdoors,creative,personal_growth}, assistant: {...}, leader: {...} }`
- Leaders (adult) return `{ results: [] }` — achievements only exist for youth members

**GET /members/{terrain_guid}/logbook**
- Returns: `{ results: [{ id, title, start_date, achievement_meta: { stream, branch } }] }`
- Leader logbook entries (camping nights, bushwalks etc.)
- Returns empty for youth members

**GET /units/{unit_id}/achievements**
- Returns ALL achievements for ALL members in the unit in a flat `{ results: [...] }` array
- Same schema as per-member achievements
- Useful for building a unit-wide badge dashboard

---

### templates.terrain.scouts.com.au (Public S3)

No authentication required. Base URL: `https://templates.terrain.scouts.com.au`

Achievement form templates as versioned JSON files. Pattern: `/{type}/{section}/{version}.json` or `/{type}/{section}/{subtype}/{version}.json`

**Top-level structure:**
- `additional-awards/historic-awards.json` — list of historic award IDs
- `additional-awards/specifications.json` — award specs
- `adventurous-journey/{section}/{version}.json` — sections: joey, cub, scout, venturer, rover
- `intro-scouting/{section}/` — same sections
- `intro-section/{section}/` — same sections
- `milestone/{section}/review/{stage}/{version}.json` — stages 1-3
- `oas/{stream}/{version}.json` — streams: alpine, aquatics, boating, bushcraft, bushwalking, camping, cycling, paddling, vertical
- `oas/{section}/` — section-specific OAS: joey, cub, scout, venturer, rover
- `personal-development-course/{section}/`
- `personal-reflection/{section}/`
- `sia/{section}/` — SIA templates

Use `latest.json` for the current version of any template.

Template `version` in achievement records (e.g. `"template": "oas/vertical/1"`) matches these paths.

---

## Migration history

| File | Date | What it did |
|------|------|-------------|
| schema.sql | Session 1 | Base tables: members, events, attendance, auth_tokens, sync_log |
| migrate.sql | Session 2 | Added `terrain_member_id` to auth_tokens |
| migrate2.sql | Session 2 | Added `member_number` to members |
| migrate3.sql | Session 3 | Added `unit_ids`, `first_name`, `last_name` to auth_tokens |
| migrate4.sql | Session 4 | Added `event_type_raw` to events, achievements table (stub), `section` to members |
| migrate5b.sql | 2026-06-22 | Chat tables: channels, channel_members, messages, flag_alerts, supervisors, keyword_flags + indexes |
| (manual) | 2026-06-23 | `ALTER TABLE sync_log ADD COLUMN detail TEXT` — worker expects this column |

> See SCHEMA.sql for the current complete database state.

---

## Feature status

| Feature | Status | Notes |
|---------|--------|-------|
| Login / auth | ✅ Working | Cognito via Worker proxy; GUID via member_number lookup |
| Roll call — take attendance | ✅ Working | Pre-ticks existing Terrain attendance |
| Roll call — save to Terrain | ✅ Working | PATCH via nightly sync |
| Events list | ✅ Working | Filtered by leader's unit(s); correct unit via invitee_id |
| Unit selector (roll tab) | ✅ Working | Filters event list by unit |
| Correct members per event | ✅ Fixed 2026-06-23 | Uses invitee_id — Clay night now shows Joeys correctly |
| Multi-unit leader support | ✅ Fixed 2026-06-23 | Calendars endpoint populates all unit_ids at login |
| Event sync from Terrain | ✅ Working | Runs on /sync and nightly cron |
| Member sync from Terrain | ✅ Working | Runs at login per unit via /units/{id}/members |
| Concluded event read-only | ✅ Working | Edit Roll button to override |
| Reauth modal (token expiry) | ✅ Working | Shows after 1 hour |
| Offline banner | ✅ Working | |
| Name display | ✅ Working | |
| Chat — channels | ✅ Deployed | Needs end-to-end test |
| Chat — send messages | ✅ Deployed | Keyword flagging included |
| Chat — supervisor visibility | ✅ Deployed | All leaders see all channels |
| Badge dashboard | ⚠️ Stub only | API now mapped — see achievements domain above |
| PWA / installable | ✅ Working | manifest.json + service worker |
| Nightly sync cron | ✅ Working | `0 14 * * *` (midnight AEST) |
| Push notifications | ❌ Not built | Planned |
| RSVP system | ❌ Not built | Planned |
| OAS/badge sync from Terrain | ❌ Not built | Blocked: achievements API unknown |
| Parent hub | ❌ Not built | Planned |
| Program planning | ❌ Not built | Planned |

---

## Known bugs / outstanding issues

1. **Dual-membership youth don't pre-tick attendance** — Freya DAGLISH, Kayden SUTEDJA, Max TAYLOR, Bowie BEN-MEIR, Jasper GRIMWADE, Ramsay MATHESON, Sebastian MARGERISON. Attendance pre-tick matches by unit but should match by GUID only.

2. **Upcoming events allow attendance saving** — Should be blocked until event date has passed.

3. **Nightly sync fails if token expired** — Graceful handling exists (logs error) but no alerting.

4. **Chat not yet fully tested end-to-end** — Needs a real test with two accounts sending messages.

5. **Badge dashboard shows placeholder only** — API is now fully mapped (2026-06-23). Use `GET achievements.terrain.scouts.com.au/members/{guid}/achievements` per member, or `GET .../units/{unit_id}/achievements` for the whole unit at once. Leader accounts return `{ results: [] }` — query youth member GUIDs only.

6. **Debug endpoint still deployed** — `/debug` GET endpoint exposes token data; remove before wider rollout.

7. **Events API requires date params** — `GET /members/{guid}/events` with no query params returns 502. Must pass `start_datetime` and `end_datetime`. The current worker sync may be broken if it omits these.

---

---

## Session log: 2026-06-23 (API exploration)

Systematic mapping of all Terrain API endpoints using live token from D1. Key discoveries:

1. **Achievements subdomain corrected** — `achiev.terrain.scouts.com.au` doesn't exist. Correct: `achievements.terrain.scouts.com.au`. Badge dashboard is now unblocked.
2. **Three additional domains found** — `agenda`, `metrics` (both 403 with Bearer token, require SigV4), and `templates` (public S3 bucket with all achievement form schemas as JSON).
3. **Events API requires date params** — `/members/{guid}/events` without `start_datetime`+`end_datetime` returns 502. Verify the sync worker is passing these.
4. **Calendars response is richer than documented** — includes `type: "member"` (personal calendar) and `other_calendars` with `type: "patrol"` entries for subscribed patrols.
5. **Event detail has attendance roles** — `leader_members` (patrol leaders), `assistant_members` (APLs), `participant_members` (regulars), `attendee_members` (who attended). All include `patrol_name`.
6. **`/groups/{group_id}/members` works** — returns all members across all units in the group in one call.
7. **`/units/{unit_id}/achievements` works** — returns entire unit's achievement data in one call. 491 records for Scouts alone (308 OAS, 90 milestones, 42 SIA, etc.).
8. **Achievement types enumerated** — 10 types: outdoor_adventure_skill, milestone, special_interest_area, adventurous_journey, intro_section, intro_scouting, course_reflection, personal_reflection, additional_award, peak_award.

---

## What to do at the start of each dev session

1. Read this DEVLOG.md
2. Read SCHEMA.sql
3. Check the "Known bugs" section above and confirm which to tackle
4. Run a quick smoke test on the live app before making changes

## What to do at the end of each dev session

1. Update the Feature status table
2. Update Known bugs
3. Add any new Terrain API discoveries to the API reference section
4. Note any new migrations in the Migration history table
