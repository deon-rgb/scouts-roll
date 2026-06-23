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

**Auth**
- Endpoint: `https://cognito-idp.ap-southeast-2.amazonaws.com/`
- Method: POST with `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`
- Flow: `USER_PASSWORD_AUTH` with `ClientId` + `AuthParameters: {USERNAME, PASSWORD}`
- Returns: `AuthenticationResult.IdToken` (Bearer token, 1 hour expiry)
- ⚠️ JWT `sub` claim is a Cognito internal ID, NOT the Terrain GUID

**Members**
- `GET https://members.terrain.scouts.com.au/members/{terrain_guid}` — profile, name, units[]
- `GET https://members.terrain.scouts.com.au/units/{unit_id}/members` — all members in a unit
- Auth: Bearer IdToken
- Returns member objects with `id` (Terrain GUID), `first_name`, `last_name`, `member_number`, `units[]`

**Calendars (unit discovery)**
- `GET https://events.terrain.scouts.com.au/members/{terrain_guid}/calendars`
- Returns: `{ own_calendars: [{ id, type, title, section, selected }] }`
- Filter to `type === "unit"` to get unit IDs — ignore `type === "group"` entries
- This is the correct way to discover which units a leader manages at login

**Events**
- `GET https://events.terrain.scouts.com.au/members/{terrain_guid}/events`
- Returns events with `invitee_id` = correct unit UUID for that event (use this, not event_type.id)
- Also includes `section` field

**Attendance**
- `PATCH https://events.terrain.scouts.com.au/events/{event_id}`
- Body: `{ attendee_member_ids: [...guids], participant_member_ids: [...guids] }`
- Both arrays must be set to the same values
- Returns: 204 No Content on success

**Achievements (OAS/badges) — NOT YET INTEGRATED**
- Base URL: `https://achiev.terrain.scouts.com.au`
- Endpoints unknown — needs HAR capture from Terrain DevTools session
- This is the blocker for the badge dashboard feature

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
| Badge dashboard | ⚠️ Stub only | Achievements API not integrated |
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

5. **Badge dashboard shows placeholder only** — Needs Terrain achievements API. Requires HAR capture session to discover endpoints.

6. **Debug endpoint still deployed** — `/debug` GET endpoint exposes token data; remove before wider rollout.

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
