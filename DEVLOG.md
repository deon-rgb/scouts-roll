# Princes Park Scouts App — Dev Log

## Project overview
A PWA for Princes Park Scout Group (Victoria) to replace paper roll call and make Terrain more accessible for leaders and youth members. Built on Cloudflare Workers + D1 (backend) and Netlify (frontend).

**Live URLs**
- Frontend: https://taupe-melba-cdf100.netlify.app
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
# Worker
cd ~/scouts-roll/backend && wrangler deploy

# Frontend
cd ~/scouts-roll && git add index.html && git commit -m "..." && git push origin main

# DB migration
cd ~/scouts-roll && wrangler d1 execute scouts-db --remote --file=migrateN.sql
```

---

## Architecture notes

- `members.id` IS the Terrain GUID (TEXT PRIMARY KEY) — not a separate column
- `auth_tokens.terrain_member_id` also stores the Terrain GUID for the logged-in leader
- `channel_members.member_id` = Terrain GUID — JOINs to `members.id` directly
- All chat JOINs must use `members.id`, never `members.terrain_member_id` (that column doesn't exist on members)
- Terrain's `event_type.id` returns the *logged-in leader's* unit, not the event's unit — unit detection uses title keywords as a workaround
- All auth goes through the Cloudflare Worker proxy — direct browser requests to Cognito are blocked by CORS

---

## Terrain API reference

**Auth**
- Endpoint: `https://cognito-idp.ap-southeast-2.amazonaws.com/`
- Method: POST with `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`
- Flow: `USER_PASSWORD_AUTH` with `ClientId` + `AuthParameters: {USERNAME, PASSWORD}`
- Returns: `AuthenticationResult.IdToken` (Bearer token, 1 hour expiry)

**Members**
- `GET https://members.terrain.scouts.com.au/groups/{group_id}/members`
- `GET https://members.terrain.scouts.com.au/members/{cognito_username}`
- Auth: Bearer IdToken
- Returns: `{ members: [...] }` with `id` (GUID), `first_name`, `last_name`, `role`, `status`, `unit.id`, `member_number`

**Events**
- `GET https://events.terrain.scouts.com.au/members/{terrain_guid}/events`
- Auth: Bearer IdToken
- Returns programming events for the leader's units

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

> See SCHEMA.sql for the current complete database state.

---

## Feature status

| Feature | Status | Notes |
|---------|--------|-------|
| Login / auth | ✅ Working | Cognito via Worker proxy |
| Roll call — take attendance | ✅ Working | Pre-ticks existing Terrain attendance |
| Roll call — save to Terrain | ✅ Working | PATCH via nightly sync |
| Events list | ✅ Working | Filtered by leader's unit(s) |
| Unit selector (roll tab) | ✅ Working | Filters event list by unit; members load filtered by selected unit |
| Concluded event read-only | ✅ Working | Edit Roll button to override |
| Reauth modal (token expiry) | ✅ Working | Shows after 1 hour |
| Offline banner | ✅ Working | |
| Name display | ✅ Working | Fetched from Terrain members API on login |
| Chat — channels | ✅ Deployed | Tables exist, routes deployed — needs end-to-end test |
| Chat — send messages | ✅ Deployed | Keyword flagging included |
| Chat — supervisor visibility | ✅ Deployed | All leaders see all channels |
| Badge dashboard | ⚠️ Stub only | Shows placeholder data — achievements API not integrated |
| PWA / installable | ✅ Working | manifest.json + service worker deployed |
| Nightly sync cron | ✅ Working | `0 14 * * *` (midnight AEST) |
| Push notifications | ❌ Not built | Planned: Resend email + web push |
| RSVP system | ❌ Not built | Planned |
| OAS/badge sync from Terrain | ❌ Not built | Blocked: achievements API endpoints unknown |
| Parent hub | ❌ Not built | Planned |
| Program planning | ❌ Not built | Planned |

---

## Known bugs / outstanding issues

1. **Dual-membership youth don't pre-tick attendance** — Freya DAGLISH, Kayden SUTEDJA, Max TAYLOR, Bowie BEN-MEIR, Jasper GRIMWADE, Ramsay MATHESON, Sebastian MARGERISON. Attendance pre-tick matches by unit but should match by GUID only.

2. **Clay night shows wrong unit members** — Event `unit_id` stored incorrectly because Terrain's `event_type.id` returns the logged-in leader's unit, not the event's unit. Keyword detection workaround deployed but untested.

3. **Upcoming events allow attendance saving** — Should be blocked until event date has passed.

4. **Nightly sync fails if token expired** — Graceful handling exists (logs error) but no alerting.

5. **Chat not yet fully tested end-to-end** — Tables and routes deployed 2026-06-22. Needs a real test with two accounts sending messages.

6. **Badge dashboard shows placeholder only** — Needs Terrain achievements API. Requires HAR capture session to discover endpoints.

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
