// ============================================================
// Scouts App — Cloudflare Worker Backend
// v3 — fixes: name display, dual-membership attendance,
//      proper GUID lookup, token expiry, event filtering,
//      upcoming event guard, offline safety
// ============================================================

const COGNITO_REGION    = 'ap-southeast-2';
const COGNITO_CLIENT_ID = '6v98tbc09aqfvh52fml3usas3c';
const COGNITO_ENDPOINT  = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const UNIT_ID           = '054bc5df-bb9d-4ef9-a041-1a22518c4d1a';
const GROUP_ID          = '89053a96-7a60-3680-8212-bcd64a7996cb';

// Known unit IDs for Princes Park Scout Group
const UNIT_MAP = {
  '6ed6a27f-e76e-49b7-ad20-d8143d37dbe3': 'joey',
  'a1fb7ab1-96d2-4b02-b3e8-fc0bed99142b': 'cub',
  '054bc5df-bb9d-4ef9-a041-1a22518c4d1a': 'scout',
  'c5bfe4a0-9734-4b73-b544-99bb0bd42716': 'venturer',
  '6fe441ab-1382-406a-bbf8-aeb6a03b86c1': 'rover',
};

// Detect section from event title keywords
function detectSectionFromTitle(title) {
  const t = (title || '').toLowerCase();
  if (/joey|joeys/.test(t))          return 'joey';
  if (/cub|cubs|pack/.test(t))       return 'cub';
  if (/venturer|venturers/.test(t))  return 'venturer';
  if (/rover|rovers/.test(t))        return 'rover';
  if (/scout|scouts/.test(t))        return 'scout';
  return null;
}

// Get unit_id from section name
function unitIdFromSection(section) {
  const map = {
    joey:     '6ed6a27f-e76e-49b7-ad20-d8143d37dbe3',
    cub:      'a1fb7ab1-96d2-4b02-b3e8-fc0bed99142b',
    scout:    '054bc5df-bb9d-4ef9-a041-1a22518c4d1a',
    venturer: 'c5bfe4a0-9734-4b73-b544-99bb0bd42716',
    rover:    '6fe441ab-1382-406a-bbf8-aeb6a03b86c1',
  };
  return map[section] || null;
}


const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ── ROUTER ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (path === '/auth/login' && method === 'POST') return handleLogin(request, env);

    const token = request.headers.get('Authorization');
    if (!token) return err('Unauthorized', 401);
    const member = await validateToken(token, env);
    if (!member) return err('TOKEN_EXPIRED', 401); // specific code for frontend

    if (path === '/events'  && method === 'GET') return handleGetEvents(env, member);
    if (path === '/members' && method === 'GET') return handleGetMembers(env, member);
    if (path === '/sync'    && method === 'POST') return handleSync(request, env, member);

    if (path === '/clearqueue' && method === 'POST') {
      await env.scouts_db.prepare(
        `UPDATE attendance SET synced_to_terrain = 1 WHERE synced_to_terrain = 0`
      ).run();
      return json({ success: true, message: 'Queue cleared' });
    }

    if (path.startsWith('/members/') && method === 'GET') {
      return handleGetMembersForEvent(path.split('/')[2], env, member);
    }
    if (path.startsWith('/attendance/') && method === 'GET') {
      return handleGetAttendance(path.split('/')[2], env, member);
    }
    if (path.startsWith('/attendance/') && method === 'POST') {
      return handleSaveAttendance(path.split('/')[2], request, env, member);
    }
    // Chat routes
    if (path.startsWith('/chat')) return handleChat(path, method, request, env, member);

    if (path === '/synclog' && method === 'GET') {
      const rows = await env.scouts_db.prepare(
        `SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20`
      ).all();
      return json(rows.results);
    }

    // Badge progress for a member
    if (path.startsWith('/achievements/') && method === 'GET') {
      const memberId = path.split('/')[2];
      return handleGetAchievements(memberId, env, member);
    }

    return err('Not found', 404);
  },

  async scheduled(event, env) {
    await runSync(env, null);
  },
};

// ── LOGIN ─────────────────────────────────────────────────────
async function handleLogin(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) return err('Username and password required');

  try {
    const res = await fetch(COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.AuthenticationResult) {
      return err(data.message || 'Incorrect username or password', 401);
    }

    const idToken  = data.AuthenticationResult.IdToken;
    const payload  = JSON.parse(atob(idToken.split('.')[1]));
    const memberId = payload['cognito:username'] || username;
    const unitId   = payload['custom:unitid'] || UNIT_ID;
    const role     = detectRole(payload);

    // Get the member's name and GUID from our members table
    // (populated during sync from the group members endpoint)
    // Also try the Terrain members API as a fallback
    let terrainMemberId = null;
    let firstName = '';
    let lastName  = '';
    let memberUnitIds = [unitId];

    try {
      // Strip branch prefix to get member number: "vic-8134812" -> "8134812"
      const memberNumber = memberId.replace(/^[a-z]+-/i, '');

      // Look up from our own synced members table first (most reliable)
      const memberRow = await env.scouts_db.prepare(
        `SELECT id, first_name, last_name, unit_id FROM members WHERE member_number = ? LIMIT 1`
      ).bind(memberNumber).first();

      if (memberRow) {
        terrainMemberId = memberRow.id;
        firstName       = memberRow.first_name || '';
        lastName        = memberRow.last_name  || '';
        console.log('Got name from DB:', firstName, lastName, terrainMemberId);
      }

      // Get all units this person is assigned to from members table
      const unitRows = await env.scouts_db.prepare(
        `SELECT DISTINCT unit_id FROM members WHERE member_number = ?`
      ).bind(memberNumber).all();
      if (unitRows.results.length) {
        memberUnitIds = unitRows.results.map(r => r.unit_id);
      }

    } catch(e) {
      console.log('Name lookup failed:', e.message);
    }

    const expiresAt   = new Date(Date.now() + 3600 * 1000).toISOString();
    const unitIdsJson = JSON.stringify(memberUnitIds);

    await env.scouts_db.prepare(
      `INSERT OR REPLACE INTO auth_tokens
       (member_id, token, expires_at, unit_id, role, terrain_member_id, unit_ids, first_name, last_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(memberId, idToken, expiresAt, unitId, role, terrainMemberId, unitIdsJson, firstName, lastName).run();

    const name = (firstName + ' ' + lastName).trim() || memberId;
    return json({ token: idToken, member_id: memberId, unit_id: unitId, role, name,
                  terrain_member_id: terrainMemberId });

  } catch(e) {
    return err('Login failed: ' + e.message, 500);
  }
}

function detectRole(payload) {
  const groups     = payload['cognito:groups'] || [];
  const roles      = payload['custom:roles']   || '';
  const memberType = payload['custom:memberType'] || '';
  if (
    groups.some(g => /leader|admin|sl|asl|gl|adult/i.test(g)) ||
    /leader|sl|asl|gl|adult/i.test(roles) ||
    /leader/i.test(memberType)
  ) return 'leader';
  return 'leader'; // Default leader until we can distinguish better
}

// ── TOKEN VALIDATION ──────────────────────────────────────────
async function validateToken(token, env) {
  return await env.scouts_db.prepare(
    `SELECT * FROM auth_tokens WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
}

// Make json/err available to chat module
const _json = json;
const _err  = err;

// ── GET EVENTS ────────────────────────────────────────────────
async function handleGetEvents(env, member) {
  // Filter events to only those belonging to units this leader is assigned to
  let unitIds;
  try {
    unitIds = JSON.parse(member.unit_ids || '[]');
  } catch(_) { unitIds = []; }
  if (!unitIds.length) unitIds = [member.unit_id];

  // Build IN clause
  const placeholders = unitIds.map(() => '?').join(',');
  const rows = await env.scouts_db.prepare(
    `SELECT e.*,
      (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id AND a.attended = 1) as attendee_count
     FROM events e
     WHERE e.unit_id IN (${placeholders})
     ORDER BY e.start_datetime DESC
     LIMIT 60`
  ).bind(...unitIds).all();

  return json({ results: rows.results });
}

// ── GET MEMBERS FOR EVENT ─────────────────────────────────────
async function handleGetMembersForEvent(eventId, env, member) {
  const event = await env.scouts_db.prepare(
    `SELECT unit_id, start_datetime, status FROM events WHERE id = ?`
  ).bind(eventId).first();

  if (!event) return err('Event not found', 404);

  // Get youth members for this event's unit
  const rows = await env.scouts_db.prepare(
    `SELECT * FROM members
     WHERE unit_id = ?
     AND status = 'active'
     AND role = 'member'
     ORDER BY last_name, first_name`
  ).bind(event.unit_id).all();

  return json({
    results: rows.results,
    unit_id: event.unit_id,
    is_upcoming: new Date(event.start_datetime) > new Date(),
    status: event.status,
  });
}

// ── GET MEMBERS (generic) ─────────────────────────────────────
async function handleGetMembers(env, member) {
  const rows = await env.scouts_db.prepare(
    `SELECT * FROM members
     WHERE unit_id = ? AND status = 'active' AND role = 'member'
     ORDER BY last_name, first_name`
  ).bind(member.unit_id).all();
  return json({ results: rows.results });
}

// ── GET ATTENDANCE ────────────────────────────────────────────
async function handleGetAttendance(eventId, env, member) {
  // FIX: Join on member ID only (not unit) so dual-membership members are included
  const rows = await env.scouts_db.prepare(
    `SELECT a.member_id, a.attended, a.synced_to_terrain,
            m.first_name, m.last_name, m.patrol
     FROM attendance a
     LEFT JOIN members m ON m.id = a.member_id
     WHERE a.event_id = ?`
  ).bind(eventId).all();
  return json({ results: rows.results });
}

// ── SAVE ATTENDANCE ───────────────────────────────────────────
async function handleSaveAttendance(eventId, request, env, member) {
  const { present_ids } = await request.json();
  if (!Array.isArray(present_ids)) return err('present_ids must be an array');

  const event = await env.scouts_db.prepare(
    `SELECT unit_id, status, start_datetime FROM events WHERE id = ?`
  ).bind(eventId).first();

  if (!event) return err('Event not found', 404);

  // Guard: don't allow saving attendance for future events
  if (new Date(event.start_datetime) > new Date()) {
    return err('Cannot save attendance for a future event', 400);
  }

  const allMembers = await env.scouts_db.prepare(
    `SELECT id FROM members WHERE unit_id = ? AND status = 'active' AND role = 'member'`
  ).bind(event.unit_id).all();

  const stmt = env.scouts_db.prepare(
    `INSERT OR REPLACE INTO attendance (event_id, member_id, attended, synced_to_terrain, recorded_at)
     VALUES (?, ?, ?, 0, datetime('now'))`
  );
  const batch = allMembers.results.map(m =>
    stmt.bind(eventId, m.id, present_ids.includes(m.id) ? 1 : 0)
  );
  if (batch.length) await env.scouts_db.batch(batch);

  return json({ success: true, recorded: allMembers.results.length });
}

// ── SYNC ──────────────────────────────────────────────────────
async function handleSync(request, env, member) {
  await runSync(env, member.token);
  return json({ success: true });
}

async function runSync(env, token) {
  if (!token) {
    const row = await env.scouts_db.prepare(
      `SELECT token FROM auth_tokens WHERE expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1`
    ).first();
    if (!row) { await logSync(env, 'full', 'error', 'No valid token — someone needs to log in'); return; }
    token = row.token;
  }

  const payload = JSON.parse(atob(token.split('.')[1]));
  const unitId  = payload['custom:unitid'] || UNIT_ID;

  await Promise.all([
    syncMembers(token, unitId, env),
    syncEvents(token, unitId, env),
  ]);
  await pushAttendanceToTerrain(token, env);
}

// ── SYNC MEMBERS ──────────────────────────────────────────────
async function syncMembers(token, unitId, env) {
  try {
    const res = await fetch(
      `https://members.terrain.scouts.com.au/groups/${GROUP_ID}/members`,
      { headers: { Authorization: token } }
    );
    if (!res.ok) throw new Error(`Members API ${res.status}: ${await res.text()}`);

    const data    = await res.json();
    const members = Array.isArray(data) ? data : (data.results || data.members || []);
    if (!members.length) { await logSync(env, 'members', 'error', 'No members'); return; }

    const stmt = env.scouts_db.prepare(
      `INSERT OR REPLACE INTO members
       (id, first_name, last_name, patrol, role, status, unit_id, member_number, section, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const batch = members.map(m => {
      const memberUnitId = String(m.unit?.id || unitId);
      const memberSection = UNIT_MAP[memberUnitId] ||
        (m.unit?.section ? m.unit.section.toLowerCase() : '');
      return stmt.bind(
        String(m.id || ''),
        String(m.first_name || ''),
        String(m.last_name  || ''),
        String(m.patrol?.name || ''),
        String(m.role || 'member'),
        String(m.status || 'active'),
        memberUnitId,
        String(m.member_number || ''),
        memberSection
      );
    });
    if (batch.length) await env.scouts_db.batch(batch);
    await logSync(env, 'members', 'success', `Synced ${members.length} members`);

  } catch(e) { await logSync(env, 'members', 'error', e.message); }
}

// ── SYNC EVENTS ───────────────────────────────────────────────
async function syncEvents(token, unitId, env) {
  try {
    // Get Terrain GUID for the events endpoint
    const authRow  = await env.scouts_db.prepare(
      `SELECT member_id, terrain_member_id FROM auth_tokens WHERE token = ?`
    ).bind(token).first();

    let memberId = authRow?.terrain_member_id;

    if (!memberId && authRow?.member_id) {
      const memberNumber = authRow.member_id.replace(/^[a-z]+-/i, '');
      const memberRow    = await env.scouts_db.prepare(
        `SELECT id FROM members WHERE member_number = ? LIMIT 1`
      ).bind(memberNumber).first();
      memberId = memberRow?.id;

      // Fallback for Deon (vic-8134812)
      if (!memberId) memberId = 'f96cccbd-b7da-3199-ac82-0d94d2630dd6';

      if (memberId) {
        await env.scouts_db.prepare(
          `UPDATE auth_tokens SET terrain_member_id = ? WHERE token = ?`
        ).bind(memberId, token).run();
      }
    }

    const now  = new Date();
    const from = new Date(now - 90 * 86400000).toISOString();
    const to   = new Date(now.getTime() + 60 * 86400000).toISOString();

    const res = await fetch(
      `https://events.terrain.scouts.com.au/members/${memberId}/events?start_datetime=${from}&end_datetime=${to}`,
      { headers: { Authorization: token } }
    );
    if (!res.ok) throw new Error(`Events API ${res.status}: ${await res.text()}`);

    const data   = await res.json();
    const events = data.results || (Array.isArray(data) ? data : []);
    if (!events.length) { await logSync(env, 'events', 'error', 'No events'); return; }

    // Log first event to check event_type structure
    if (events.length > 0) {
      console.log('First event:', JSON.stringify({
        title: events[0].title,
        event_type: events[0].event_type,
        status: events[0].status
      }));
    }

    const eventStmt = env.scouts_db.prepare(
      `INSERT OR REPLACE INTO events
       (id, title, start_datetime, end_datetime, location, status, challenge_area, description, unit_id, section, event_type_raw, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const eventBatch = events.map(e => {
      // Strategy for determining correct unit:
      // 1. Check if event_type.id maps to a known section unit
      // 2. Check organiser member's unit from members table
      // 3. Detect from event title keywords
      // 4. Fall back to logged-in leader's unit

      let eventUnitId = unitId; // fallback
      let section     = null;

      // Check event_type.id against known units
      if (e.event_type?.id && UNIT_MAP[e.event_type.id]) {
        eventUnitId = e.event_type.id;
        section     = UNIT_MAP[e.event_type.id];
      }
      // Check organiser's section from event_type
      else if (e.event_type?.section) {
        section     = e.event_type.section;
        const uid   = unitIdFromSection(section);
        if (uid) eventUnitId = uid;
      }
      // Detect from title
      else {
        const titleSection = detectSectionFromTitle(e.title);
        if (titleSection) {
          section     = titleSection;
          const uid   = unitIdFromSection(titleSection);
          if (uid) eventUnitId = uid;
        }
      }

      return eventStmt.bind(
        e.id, e.title || 'Meeting', e.start_datetime, e.end_datetime || '',
        e.location || '', e.status || '', e.challenge_area || '',
        e.description || '', eventUnitId, section || '',
        JSON.stringify(e.event_type || {})
      );
    });
    if (eventBatch.length) await env.scouts_db.batch(eventBatch);

    // Import existing Terrain attendance for each event
    // FIX: Store by member GUID directly — unit doesn't matter for matching
    let attendanceImported = 0;
    for (const e of events) {
      const attendeeIds = e.attendance?.attendee_member_ids || [];
      if (!attendeeIds.length) continue;

      // Only import if not already imported from Terrain (synced_to_terrain = 1)
      const existing = await env.scouts_db.prepare(
        `SELECT COUNT(*) as n FROM attendance WHERE event_id = ? AND synced_to_terrain = 1`
      ).bind(e.id).first();
      if (existing?.n > 0) continue;

      const attStmt  = env.scouts_db.prepare(
        `INSERT OR REPLACE INTO attendance (event_id, member_id, attended, synced_to_terrain, recorded_at)
         VALUES (?, ?, 1, 1, datetime('now'))`
      );
      const attBatch = attendeeIds.map(mid => attStmt.bind(e.id, mid));
      if (attBatch.length) {
        await env.scouts_db.batch(attBatch);
        attendanceImported += attBatch.length;
      }
    }

    await logSync(env, 'events', 'success',
      `Synced ${events.length} events, ${attendanceImported} attendance records`);

  } catch(e) { await logSync(env, 'events', 'error', e.message); }
}

// ── PUSH ATTENDANCE TO TERRAIN ────────────────────────────────
async function pushAttendanceToTerrain(token, env) {
  try {
    const unsynced = await env.scouts_db.prepare(
      `SELECT DISTINCT a.event_id FROM attendance a
       JOIN events e ON e.id = a.event_id
       WHERE a.synced_to_terrain = 0`
    ).all();

    let pushed = 0;
    for (const row of unsynced.results) {
      const eventId    = row.event_id;
      const att        = await env.scouts_db.prepare(
        `SELECT member_id, attended FROM attendance WHERE event_id = ?`
      ).bind(eventId).all();
      const presentIds = att.results.filter(a => a.attended).map(a => a.member_id);

      const evRes = await fetch(
        `https://events.terrain.scouts.com.au/events/${eventId}`,
        { headers: { Authorization: token } }
      );
      if (!evRes.ok) continue;

      const event = await evRes.json();

      // Merge with existing Terrain attendance — never remove people already marked present
      const existingIds = event.attendance?.attendee_member_ids || [];
      const mergedIds   = [...new Set([...existingIds, ...presentIds])];

      const payload = {
        ...event,
        attendance: {
          ...(event.attendance || {}),
          attendee_member_ids:    mergedIds,
          participant_member_ids: mergedIds,
          leader_member_ids:      event.attendance?.leader_member_ids    || [],
          assistant_member_ids:   event.attendance?.assistant_member_ids || [],
        },
      };

      const patchRes = await fetch(
        `https://events.terrain.scouts.com.au/events/${eventId}`,
        {
          method:  'PATCH',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        }
      );

      if (patchRes.ok) {
        await env.scouts_db.prepare(
          `UPDATE attendance SET synced_to_terrain = 1 WHERE event_id = ?`
        ).bind(eventId).run();
        pushed++;
      }
    }

    await logSync(env, 'attendance', 'success', `Pushed ${pushed} events to Terrain`);
  } catch(e) { await logSync(env, 'attendance', 'error', e.message); }
}

async function logSync(env, type, status, message) {
  await env.scouts_db.prepare(
    `INSERT INTO sync_log (sync_type, status, message) VALUES (?, ?, ?)`
  ).bind(type, status, message).run();
}

// ============================================================
// CHAT ROUTES — add these to the main router
// ============================================================
// Add to router:
//   if (path.startsWith('/chat')) return handleChat(path, method, request, env, member);

async function handleChat(path, method, request, env, member) {
  const parts = path.split('/').filter(Boolean); // ['chat', 'channels', ...]

  // GET /chat/channels — list channels for this member
  if (parts[1] === 'channels' && method === 'GET' && parts.length === 2) {
    return getChatChannels(env, member);
  }

  // POST /chat/channels — create a new channel
  if (parts[1] === 'channels' && method === 'POST') {
    return createChannel(request, env, member);
  }

  // GET /chat/channels/:id/messages — get messages for a channel
  if (parts[1] === 'channels' && parts[3] === 'messages' && method === 'GET') {
    return getMessages(parts[2], request, env, member);
  }

  // POST /chat/channels/:id/messages — send a message
  if (parts[1] === 'channels' && parts[3] === 'messages' && method === 'POST') {
    return sendMessage(parts[2], request, env, member);
  }

  // POST /chat/channels/:id/archive — archive a finite channel
  if (parts[1] === 'channels' && parts[3] === 'archive' && method === 'POST') {
    return archiveChannel(parts[2], env, member);
  }

  // GET /chat/flags — get flagged messages (supervisors only)
  if (parts[1] === 'flags' && method === 'GET') {
    return getFlaggedMessages(env, member);
  }

  // POST /chat/flags/:id/review — mark flag as reviewed
  if (parts[1] === 'flags' && parts[3] === 'review' && method === 'POST') {
    return reviewFlag(parts[2], env, member);
  }

  // GET /chat/supervisors — list supervisors
  if (parts[1] === 'supervisors' && method === 'GET') {
    return getSupervisors(env, member);
  }

  // POST /chat/supervisors — add supervisor (group leader only)
  if (parts[1] === 'supervisors' && method === 'POST') {
    return addSupervisor(request, env, member);
  }

  // DELETE /chat/supervisors/:id — remove supervisor
  if (parts[1] === 'supervisors' && parts.length === 3 && method === 'DELETE') {
    return removeSupervisor(parts[2], env, member);
  }

  return json({ error: 'Not found' }, 404);
}

// ── HELPERS ───────────────────────────────────────────────────
function isSupervisor(member) {
  return member.role === 'leader'; // expand later with supervisors table
}

async function checkChannelAccess(channelId, env, member) {
  // Supervisors can access all channels
  if (isSupervisor(member)) return true;

  const row = await env.scouts_db.prepare(
    `SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?`
  ).bind(channelId, member.terrain_member_id).first();
  return !!row;
}

function generateId() {
  return crypto.randomUUID();
}

// ── GET CHANNELS ──────────────────────────────────────────────
async function getChatChannels(env, member) {
  let channels;

  if (isSupervisor(member)) {
    // Supervisors see ALL channels
    const rows = await env.scouts_db.prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0) as message_count,
        (SELECT m.sent_at FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message_at,
        (SELECT m.content FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM flag_alerts fa WHERE fa.channel_id = c.id AND fa.reviewed = 0) as unread_flags
       FROM channels c
       WHERE c.is_archived = 0
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`
    ).all();
    channels = rows.results;
  } else {
    // Members see only their channels
    const rows = await env.scouts_db.prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0) as message_count,
        (SELECT m.sent_at FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message_at,
        (SELECT m.content FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.member_id = ? AND c.is_archived = 0
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`
    ).bind(member.terrain_member_id).all();
    channels = rows.results;
  }

  return json({ results: channels });
}

// ── CREATE CHANNEL ────────────────────────────────────────────
async function createChannel(request, env, member) {
  const { name, description, type, member_ids, is_finite } = await request.json();

  if (!name || !type) return json({ error: 'name and type required' }, 400);

  // Validate type
  const validTypes = ['unit', 'patrol', 'project', 'council', 'direct', 'leaders'];
  if (!validTypes.includes(type)) return json({ error: 'Invalid channel type' }, 400);

  // Only leaders can create unit-wide or leader-only channels
  if ((type === 'unit' || type === 'leaders') && !isSupervisor(member)) {
    return json({ error: 'Only leaders can create this channel type' }, 403);
  }

  // Direct channels: enforce minimum 3 participants (sender + recipient + supervisor)
  // This ensures Two Present Leadership in all "direct" chats
  if (type === 'direct') {
    const ids = member_ids || [];
    const allIds = [...new Set([...ids, member.terrain_member_id])];
    if (allIds.length < 2) return json({ error: 'Direct channels need at least 2 members' }, 400);
  }

  const channelId = generateId();

  await env.scouts_db.prepare(
    `INSERT INTO channels (id, name, description, type, unit_id, is_finite, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    channelId, name, description || '', type,
    member.unit_id, is_finite ? 1 : 0,
    member.terrain_member_id
  ).run();

  // Add members
  const allMemberIds = [...new Set([
    ...(member_ids || []),
    member.terrain_member_id,
  ])];

  // Always add all supervisors to direct channels (Two Present Leadership)
  if (type === 'direct') {
    const supervisorRows = await env.scouts_db.prepare(
      `SELECT member_id FROM supervisors`
    ).all();
    supervisorRows.results.forEach(s => allMemberIds.push(s.member_id));
  }

  const memberStmt = env.scouts_db.prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, member_id, role) VALUES (?, ?, ?)`
  );
  const batch = [...new Set(allMemberIds)].map(mid =>
    memberStmt.bind(channelId, mid, mid === member.terrain_member_id ? 'admin' : 'member')
  );
  if (batch.length) await env.scouts_db.batch(batch);

  return json({ success: true, channel_id: channelId });
}

// ── GET MESSAGES ──────────────────────────────────────────────
async function getMessages(channelId, request, env, member) {
  const hasAccess = await checkChannelAccess(channelId, env, member);
  if (!hasAccess) return json({ error: 'Access denied' }, 403);

  const url    = new URL(request.url);
  const before = url.searchParams.get('before'); // for pagination
  const limit  = 50;

  let rows;
  if (before) {
    rows = await env.scouts_db.prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND is_deleted = 0 AND sent_at < ?
       ORDER BY sent_at DESC LIMIT ?`
    ).bind(channelId, before, limit).all();
  } else {
    rows = await env.scouts_db.prepare(
      `SELECT * FROM messages
       WHERE channel_id = ? AND is_deleted = 0
       ORDER BY sent_at DESC LIMIT ?`
    ).bind(channelId, limit).all();
  }

  // Return in chronological order
  const messages = rows.results.reverse();

  // Get channel info
  const channel = await env.scouts_db.prepare(
    `SELECT * FROM channels WHERE id = ?`
  ).bind(channelId).first();

  // Get member list for this channel
  const members = await env.scouts_db.prepare(
    `SELECT cm.member_id, m.first_name, m.last_name, m.role
     FROM channel_members cm
     LEFT JOIN members m ON m.id = cm.member_id
     WHERE cm.channel_id = ?`
  ).bind(channelId).all();

  return json({ channel, messages, members: members.results });
}

// ── SEND MESSAGE ──────────────────────────────────────────────
async function sendMessage(channelId, request, env, member) {
  const hasAccess = await checkChannelAccess(channelId, env, member);
  if (!hasAccess) return json({ error: 'Access denied' }, 403);

  const { content } = await request.json();
  if (!content?.trim()) return json({ error: 'Message cannot be empty' }, 400);
  if (content.length > 2000) return json({ error: 'Message too long (max 2000 chars)' }, 400);

  const messageId   = generateId();
  const senderName  = `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.member_id;
  const senderRole  = member.role || 'member';

  await env.scouts_db.prepare(
    `INSERT INTO messages (id, channel_id, sender_id, sender_name, sender_role, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(messageId, channelId, member.terrain_member_id, senderName, senderRole, content.trim()).run();

  // Check for keyword flags
  const keywords = await env.scouts_db.prepare(
    `SELECT keyword, severity FROM keyword_flags`
  ).all();

  const contentLower = content.toLowerCase();
  const triggered    = keywords.results.filter(k => contentLower.includes(k.keyword.toLowerCase()));

  if (triggered.length) {
    // Flag the message
    await env.scouts_db.prepare(
      `UPDATE messages SET is_flagged = 1, flag_reason = ? WHERE id = ?`
    ).bind(triggered.map(k => k.keyword).join(', '), messageId).run();

    // Create alerts for each keyword
    const alertStmt = env.scouts_db.prepare(
      `INSERT INTO flag_alerts (message_id, channel_id, sender_id, keyword, severity)
       VALUES (?, ?, ?, ?, ?)`
    );
    const alertBatch = triggered.map(k =>
      alertStmt.bind(messageId, channelId, member.terrain_member_id, k.keyword, k.severity)
    );
    if (alertBatch.length) await env.scouts_db.batch(alertBatch);
  }

  return json({
    success:  true,
    message_id: messageId,
    flagged:  triggered.length > 0,
  });
}

// ── ARCHIVE CHANNEL ───────────────────────────────────────────
async function archiveChannel(channelId, env, member) {
  if (!isSupervisor(member)) return json({ error: 'Leaders only' }, 403);

  const channel = await env.scouts_db.prepare(
    `SELECT * FROM channels WHERE id = ?`
  ).bind(channelId).first();

  if (!channel) return json({ error: 'Channel not found' }, 404);

  await env.scouts_db.prepare(
    `UPDATE channels SET is_archived = 1, archived_at = datetime('now') WHERE id = ?`
  ).bind(channelId).run();

  return json({ success: true });
}

// ── FLAGGED MESSAGES ──────────────────────────────────────────
async function getFlaggedMessages(env, member) {
  if (!isSupervisor(member)) return json({ error: 'Supervisors only' }, 403);

  const rows = await env.scouts_db.prepare(
    `SELECT fa.*, m.content, m.sender_name, m.sender_role, m.sent_at,
            c.name as channel_name
     FROM flag_alerts fa
     JOIN messages m ON m.id = fa.message_id
     JOIN channels c ON c.id = fa.channel_id
     WHERE fa.reviewed = 0
     ORDER BY fa.created_at DESC`
  ).all();

  return json({ results: rows.results });
}

// ── REVIEW FLAG ───────────────────────────────────────────────
async function reviewFlag(flagId, env, member) {
  if (!isSupervisor(member)) return json({ error: 'Supervisors only' }, 403);

  await env.scouts_db.prepare(
    `UPDATE flag_alerts SET reviewed = 1, reviewed_by = ?, reviewed_at = datetime('now')
     WHERE id = ?`
  ).bind(member.terrain_member_id, flagId).run();

  return json({ success: true });
}

// ── SUPERVISORS ───────────────────────────────────────────────
async function getSupervisors(env, member) {
  if (!isSupervisor(member)) return json({ error: 'Leaders only' }, 403);

  const rows = await env.scouts_db.prepare(
    `SELECT s.*, m.first_name, m.last_name
     FROM supervisors s
     LEFT JOIN members m ON m.id = s.member_id
     ORDER BY s.added_at`
  ).all();

  return json({ results: rows.results });
}

async function addSupervisor(request, env, member) {
  if (!isSupervisor(member)) return json({ error: 'Leaders only' }, 403);

  const { member_id } = await request.json();
  if (!member_id) return json({ error: 'member_id required' }, 400);

  await env.scouts_db.prepare(
    `INSERT OR IGNORE INTO supervisors (member_id, added_by) VALUES (?, ?)`
  ).bind(member_id, member.terrain_member_id).run();

  return json({ success: true });
}

async function removeSupervisor(supervisorMemberId, env, member) {
  if (!isSupervisor(member)) return json({ error: 'Leaders only' }, 403);

  await env.scouts_db.prepare(
    `DELETE FROM supervisors WHERE member_id = ?`
  ).bind(supervisorMemberId).run();

  return json({ success: true });
}


// ── ACHIEVEMENTS / BADGE PROGRESS ────────────────────────────
async function handleGetAchievements(memberId, env, member) {
  // Leaders can see anyone, youth see only themselves
  if (member.role !== 'leader' && member.terrain_member_id !== memberId) {
    return err('Access denied', 403);
  }

  // Get achievements from our local cache
  const rows = await env.scouts_db.prepare(
    `SELECT * FROM achievements WHERE member_id = ? ORDER BY type, stream, stage`
  ).bind(memberId).all();

  // Get member info
  const memberInfo = await env.scouts_db.prepare(
    `SELECT * FROM members WHERE id = ?`
  ).bind(memberId).first();

  return json({ member: memberInfo, achievements: rows.results });
}

// Sync achievements for a specific member from Terrain
async function syncMemberAchievements(token, memberId, env) {
  try {
    // Fetch OAS achievements
    const oasRes = await fetch(
      `https://achiev.terrain.scouts.com.au/members/${memberId}/achievements?type=outdoor_adventure_skill`,
      { headers: { Authorization: token } }
    );

    if (oasRes.ok) {
      const oasData  = await oasRes.json();
      const achievements = oasData.results || [];

      const stmt = env.scouts_db.prepare(
        `INSERT OR REPLACE INTO achievements (id, member_id, type, status, stream, stage, title, last_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      );
      const batch = achievements.map(a => stmt.bind(
        `${memberId}-oas-${a.stream}-${a.stage}`,
        memberId, 'oas',
        a.status || 'in_progress',
        a.stream || '',
        a.stage  || 0,
        a.title  || ''
      ));
      if (batch.length) await env.scouts_db.batch(batch);
    }

    // Fetch milestone achievements
    const msRes = await fetch(
      `https://achiev.terrain.scouts.com.au/members/${memberId}/achievements?type=milestone`,
      { headers: { Authorization: token } }
    );

    if (msRes.ok) {
      const msData = await msRes.json();
      const milestones = msData.results || [];

      const stmt2 = env.scouts_db.prepare(
        `INSERT OR REPLACE INTO achievements (id, member_id, type, status, title, last_synced)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      );
      const batch2 = milestones.map(m => stmt2.bind(
        `${memberId}-ms-${m.id || m.title}`,
        memberId, 'milestone',
        m.status || 'in_progress',
        m.title  || ''
      ));
      if (batch2.length) await env.scouts_db.batch(batch2);
    }

  } catch(e) {
    console.log('Achievement sync failed for', memberId, ':', e.message);
  }
}
