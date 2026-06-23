// ── CONSTANTS ─────────────────────────────────────────────────
const COGNITO_ENDPOINT = 'https://cognito-idp.ap-southeast-2.amazonaws.com/';
const COGNITO_CLIENT_ID = '6v98tbc09aqfvh52fml3usas3c';
const TERRAIN_MEMBERS  = 'https://members.terrain.scouts.com.au';
const TERRAIN_EVENTS   = 'https://events.terrain.scouts.com.au';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

// ── HELPERS ───────────────────────────────────────────────────
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const err = (msg, status = 400) => json({ error: msg }, status);

function generateId() { return crypto.randomUUID(); }

function isSupervisor(member) { return member.role === 'leader'; }

// Decode JWT payload (no verification — we trust our own DB)
function decodeJwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch(_) { return null; }
}

// ── MAIN ROUTER ───────────────────────────────────────────────
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
    if (!member) return err('TOKEN_EXPIRED', 401);

    // Chat routes — before other routes to avoid /members clash
    if (path.startsWith('/chat')) return handleChat(path, method, request, url, env, member);

    // Events
    if (path === '/events' && method === 'GET') return handleGetEvents(env, member);

    // Members for a specific event (with optional unit_id override)
    if (path.startsWith('/members/') && method === 'GET') {
      const eventId    = path.split('/')[2];
      const unitOverride = url.searchParams.get('unit_id') || null;
      return handleGetMembersForEvent(eventId, unitOverride, env, member);
    }

    // Generic members list (home tab count)
    if (path === '/members' && method === 'GET') return handleGetMembers(env, member);

    // Sync
    if (path === '/sync' && method === 'POST') return handleSync(request, env, member);

    // Clear queue (safety valve)
    if (path === '/clearqueue' && method === 'POST') {
      await env.scouts_db.prepare(
        `UPDATE attendance SET synced_to_terrain = 1 WHERE synced_to_terrain = 0`
      ).run();
      return json({ success: true, message: 'Queue cleared' });
    }

    // Attendance
    if (path.startsWith('/attendance/') && method === 'GET') {
      return handleGetAttendance(path.split('/')[2], env, member);
    }
    if (path.startsWith('/attendance/') && method === 'POST') {
      return handleSaveAttendance(path.split('/')[2], request, env, member);
    }

    // Debug / admin
    if (path === '/synclog' && method === 'GET') {
      const rows = await env.scouts_db.prepare(
        `SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 20`
      ).all();
      return json(rows.results);
    }

    // Debug: show auth token row + trigger sync manually
    if (path === '/debug' && method === 'GET') {
      const tokenRow = await env.scouts_db.prepare(
        `SELECT member_id, expires_at, unit_id, unit_ids, role, terrain_member_id, first_name, last_name
         FROM auth_tokens WHERE token = ? LIMIT 1`
      ).bind(token).first();

      const eventCount = await env.scouts_db.prepare(
        `SELECT COUNT(*) as c FROM events`
      ).first();

      const memberCount = await env.scouts_db.prepare(
        `SELECT COUNT(*) as c FROM members`
      ).first();

      // Try calendars with sub-claim GUID
      let calendarsRaw = null;
      if (tokenRow?.terrain_member_id) {
        try {
          const calRes = await fetch(
            `https://events.terrain.scouts.com.au/members/${tokenRow.terrain_member_id}/calendars`,
            { headers: { Authorization: token } }
          );
          const t1 = await calRes.text();
          calendarsRaw = { status: calRes.status, raw: t1.slice(0, 500) };
        } catch(e) {
          calendarsRaw = { error: e.message };
        }
      }

      // Try calendars with known correct Terrain GUID
      let calendarsKnown = null;
      try {
        const calRes2 = await fetch(
          `https://events.terrain.scouts.com.au/members/f96cccbd-b7da-3199-ac82-0d94d2630dd6/calendars`,
          { headers: { Authorization: token } }
        );
        const t2 = await calRes2.text();
        calendarsKnown = { status: calRes2.status, raw: t2.slice(0, 500) };
      } catch(e) {
        calendarsKnown = { error: e.message };
      }

      // Also try members profile with known GUID
      let memberProfile = null;
      try {
        const mpRes = await fetch(
          `https://members.terrain.scouts.com.au/members/f96cccbd-b7da-3199-ac82-0d94d2630dd6`,
          { headers: { Authorization: token } }
        );
        const t3 = await mpRes.text();
        memberProfile = { status: mpRes.status, raw: t3.slice(0, 500) };
      } catch(e) {
        memberProfile = { error: e.message };
      }

      return json({ tokenRow, eventCount, memberCount, calendarsRaw, calendarsKnown, memberProfile });
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
    // 1. Authenticate with Cognito
    const cognitoRes = await fetch(COGNITO_ENDPOINT, {
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

    const cognitoData = await cognitoRes.json();
    if (!cognitoRes.ok || !cognitoData.AuthenticationResult) {
      return err(cognitoData.message || 'Incorrect username or password', 401);
    }

    const idToken = cognitoData.AuthenticationResult.IdToken;

    // 2. Decode JWT to get Cognito username (e.g. "vic-8134812")
    const payload         = decodeJwtPayload(idToken);
    const cognitoUsername = payload?.['cognito:username'] || username;
    const memberNumber    = cognitoUsername.replace(/^[a-z]+-/i, ''); // strip "vic-" → "8134812"

    // 3. Get Terrain GUID + name from local DB first (fast, reliable)
    let terrainGuid = null;
    let firstName   = '';
    let lastName    = '';
    try {
      const localMember = await env.scouts_db.prepare(
        `SELECT id, first_name, last_name FROM members WHERE member_number = ? LIMIT 1`
      ).bind(memberNumber).first();
      if (localMember) {
        terrainGuid = localMember.id;
        firstName   = localMember.first_name || '';
        lastName    = localMember.last_name  || '';
      }
    } catch(_) {}

    // Also try Terrain members API with member number (works for some endpoints)
    if (!terrainGuid) {
      try {
        const profileRes = await fetch(
          `${TERRAIN_MEMBERS}/members/${memberNumber}`,
          { headers: { Authorization: idToken } }
        );
        if (profileRes.ok) {
          const pd  = await profileRes.json();
          terrainGuid = pd.id || null;
          firstName   = pd.first_name || firstName;
          lastName    = pd.last_name  || lastName;
        }
      } catch(e) {
        console.log('Profile fetch by member number failed:', e.message);
      }
    }

    if (!terrainGuid) {
      return err('Could not determine Terrain GUID. Please ensure members are synced.', 500);
    }

    // 4. Fetch the leader's unit assignments via the calendars endpoint
    //    GET /members/{terrain_guid}/calendars — returns all units this leader manages
    let unitIds   = [];
    let primaryUnitId = null;
    try {
      const calRes = await fetch(
        `${TERRAIN_EVENTS}/members/${terrainGuid}/calendars`,
        { headers: { Authorization: idToken } }
      );
      if (calRes.ok) {
        const calData = await calRes.json();
        // Response shape: { calendars: [ { id, unit_id, section, ... }, ... ] }
        // Each calendar entry has the unit's invitee_id / unit_id
        // own_calendars has entries with type "group" and "unit" — we only want units
        const calendars = calData.own_calendars || calData.calendars || calData.results || [];
        unitIds = calendars
          .filter(c => c.type === 'unit')
          .map(c => c.id)
          .filter(Boolean);
        // Primary unit = first unit returned
        primaryUnitId = unitIds[0] || null;
        console.log('Calendars fetched:', JSON.stringify(unitIds));
      } else {
        console.log('Calendars fetch failed:', calRes.status, await calRes.text());
      }
    } catch(e) {
      console.log('Calendars fetch error:', e.message);
    }

    // Fallback: look up unit from local DB if calendars call failed
    if (!primaryUnitId) {
      try {
        const localMember = await env.scouts_db.prepare(
          `SELECT unit_id FROM members WHERE id = ? LIMIT 1`
        ).bind(terrainGuid).first();
        if (localMember?.unit_id) {
          primaryUnitId = localMember.unit_id;
          unitIds = [primaryUnitId];
        }
      } catch(_) {}
    }

    // 5. Sync this leader's units' members from Terrain
    //    Do this in the background — don't block the login response
    if (unitIds.length > 0) {
      syncMembersForUnits(unitIds, idToken, env).catch(e =>
        console.log('Member sync error (non-fatal):', e.message)
      );
    }

    // 6. Store auth token with correct unit assignments
    const expiresAt   = new Date(Date.now() + 3600 * 1000).toISOString();
    const unitIdsJson = JSON.stringify(unitIds);
    const role        = 'leader'; // All app users are leaders for now

    await env.scouts_db.prepare(
      `INSERT OR REPLACE INTO auth_tokens
       (member_id, token, expires_at, unit_id, role, terrain_member_id, unit_ids, first_name, last_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(cognitoUsername, idToken, expiresAt, primaryUnitId, role, terrainGuid,
           unitIdsJson, firstName, lastName).run();

    const name = (firstName + ' ' + lastName).trim() || cognitoUsername;
    return json({
      token:              idToken,
      member_id:          cognitoUsername,
      unit_id:            primaryUnitId,
      unit_ids:           unitIds,
      role,
      name,
      terrain_member_id:  terrainGuid,
    });

  } catch(e) {
    return err('Login failed: ' + e.message, 500);
  }
}

// ── MEMBER SYNC PER UNIT ──────────────────────────────────────
// Called at login to keep member lists fresh.
// Uses /units/{unit_id}/members — the correct per-unit endpoint.
async function syncMembersForUnits(unitIds, token, env) {
  for (const unitId of unitIds) {
    try {
      const res = await fetch(
        `${TERRAIN_MEMBERS}/units/${unitId}/members`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) {
        console.log(`Unit member sync failed for ${unitId}:`, res.status);
        continue;
      }
      const data    = await res.json();
      const members = data.members || data.results || [];

      const stmt = env.scouts_db.prepare(
        `INSERT OR REPLACE INTO members
         (id, first_name, last_name, patrol, role, status, unit_id, member_number, last_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      );

      const batch = members.map(m => stmt.bind(
        m.id,
        m.first_name || '',
        m.last_name  || '',
        m.patrol?.name || null,
        m.member_type?.includes('adult') || m.member_type?.includes('leader') ? 'leader' : 'member',
        m.status || 'active',
        unitId,
        m.member_number || null,
      ));

      if (batch.length) await env.scouts_db.batch(batch);
      console.log(`Synced ${batch.length} members for unit ${unitId}`);
    } catch(e) {
      console.log(`syncMembersForUnits error for ${unitId}:`, e.message);
    }
  }
}

// ── TOKEN VALIDATION ──────────────────────────────────────────
async function validateToken(token, env) {
  return await env.scouts_db.prepare(
    `SELECT * FROM auth_tokens WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
}

// ── GET EVENTS ────────────────────────────────────────────────
async function handleGetEvents(env, member) {
  let unitIds;
  try { unitIds = JSON.parse(member.unit_ids || '[]'); } catch(_) { unitIds = []; }
  if (!unitIds.length) unitIds = member.unit_id ? [member.unit_id] : [];

  if (!unitIds.length) return json({ results: [] });

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
async function handleGetMembersForEvent(eventId, unitOverride, env, member) {
  const event = await env.scouts_db.prepare(
    `SELECT unit_id, start_datetime, status FROM events WHERE id = ?`
  ).bind(eventId).first();

  if (!event) return err('Event not found', 404);

  let targetUnitId = event.unit_id;
  let allUnits     = false;

  if (unitOverride === 'all') {
    allUnits = true;
  } else if (unitOverride) {
    targetUnitId = unitOverride;
  }

  let rows;
  if (allUnits) {
    rows = await env.scouts_db.prepare(
      `SELECT * FROM members
       WHERE status = 'active' AND role = 'member'
       ORDER BY last_name, first_name`
    ).all();
  } else {
    rows = await env.scouts_db.prepare(
      `SELECT * FROM members
       WHERE unit_id = ? AND status = 'active' AND role = 'member'
       ORDER BY last_name, first_name`
    ).bind(targetUnitId).all();
  }

  return json({
    results:     rows.results,
    unit_id:     targetUnitId,
    is_upcoming: new Date(event.start_datetime) > new Date(),
    status:      event.status,
  });
}

// ── GET MEMBERS (generic — home tab count) ────────────────────
async function handleGetMembers(env, member) {
  const unitId = member.unit_id;
  if (!unitId) return json({ results: [] });
  const rows = await env.scouts_db.prepare(
    `SELECT * FROM members
     WHERE unit_id = ? AND status = 'active' AND role = 'member'
     ORDER BY last_name, first_name`
  ).bind(unitId).all();
  return json({ results: rows.results });
}

// ── GET ATTENDANCE ────────────────────────────────────────────
async function handleGetAttendance(eventId, env, member) {
  const rows = await env.scouts_db.prepare(
    `SELECT member_id, attended FROM attendance WHERE event_id = ?`
  ).bind(eventId).all();
  return json({ results: rows.results });
}

// ── SAVE ATTENDANCE ───────────────────────────────────────────
async function handleSaveAttendance(eventId, request, env, member) {
  const { present_ids } = await request.json();
  if (!Array.isArray(present_ids)) return err('present_ids must be an array');

  const event = await env.scouts_db.prepare(
    `SELECT unit_id FROM events WHERE id = ?`
  ).bind(eventId).first();
  if (!event) return err('Event not found', 404);

  const allMembers = await env.scouts_db.prepare(
    `SELECT id FROM members WHERE unit_id = ? AND status = 'active' AND role = 'member'`
  ).bind(event.unit_id).all();

  const presentSet = new Set(present_ids);

  const stmt = env.scouts_db.prepare(
    `INSERT OR REPLACE INTO attendance (event_id, member_id, attended, synced_to_terrain)
     VALUES (?, ?, ?, 0)`
  );

  const batch = allMembers.results.map(m =>
    stmt.bind(eventId, m.id, presentSet.has(m.id) ? 1 : 0)
  );

  if (batch.length) await env.scouts_db.batch(batch);

  return json({ success: true });
}

// ── SYNC ──────────────────────────────────────────────────────
async function handleSync(request, env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);

  // Also sync events from Terrain
  const token = member.token || null;
  await runFullSync(env, token, member);
  return json({ success: true });
}

// ── FULL SYNC (attendance + events) ──────────────────────────
async function runSync(env, token) {
  await runFullSync(env, token, null);
}

async function runFullSync(env, token, member) {
  let syncToken = token;

  if (!syncToken) {
    const latest = await env.scouts_db.prepare(
      `SELECT token, terrain_member_id, unit_ids FROM auth_tokens
       WHERE expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1`
    ).first();
    syncToken = latest?.token || null;

    // Also sync events while we have the token and terrain GUID
    if (syncToken && latest?.terrain_member_id) {
      await syncEventsFromTerrain(
        latest.terrain_member_id,
        syncToken,
        JSON.parse(latest.unit_ids || '[]'),
        env
      ).catch(e => console.log('Event sync error:', e.message));
    }
  } else if (member?.terrain_member_id) {
    let unitIds = [];
    try { unitIds = JSON.parse(member.unit_ids || '[]'); } catch(_) {}
    await syncEventsFromTerrain(member.terrain_member_id, syncToken, unitIds, env)
      .catch(e => console.log('Event sync error:', e.message));
  }

  // Push pending attendance to Terrain
  await pushAttendanceToTerrain(syncToken, env);
}

// ── SYNC EVENTS FROM TERRAIN ──────────────────────────────────
// Uses invitee_id from the events response for correct unit_id assignment
async function syncEventsFromTerrain(terrainGuid, token, unitIds, env) {
  try {
    const res = await fetch(
      `${TERRAIN_EVENTS}/members/${terrainGuid}/events`,
      { headers: { Authorization: token } }
    );
    if (!res.ok) {
      console.log('Events fetch failed:', res.status);
      return;
    }
    const data   = await res.json();
    const events = data.results || data.events || [];

    const stmt = env.scouts_db.prepare(
      `INSERT OR REPLACE INTO events
       (id, title, start_datetime, end_datetime, location, status, challenge_area, description, unit_id, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    const batch = events.map(e => {
      // invitee_id is the correct unit UUID for this event — use it directly
      const eventUnitId = e.invitee_id || e.unit_id || (unitIds[0] || null);
      const status = new Date(e.end_datetime || e.start_datetime) < new Date()
        ? 'concluded' : 'upcoming';

      return stmt.bind(
        e.id,
        e.title || '',
        e.start_datetime || '',
        e.end_datetime   || '',
        e.location       || '',
        status,
        e.challenge_area || '',
        e.description    || '',
        eventUnitId,
      );
    });

    if (batch.length) await env.scouts_db.batch(batch);
    console.log(`Synced ${batch.length} events for ${terrainGuid}`);
  } catch(e) {
    console.log('syncEventsFromTerrain error:', e.message);
  }
}

// ── PUSH ATTENDANCE TO TERRAIN ────────────────────────────────
async function pushAttendanceToTerrain(syncToken, env) {
  const pending = await env.scouts_db.prepare(
    `SELECT a.*, e.id as event_uuid, m.id as t_guid
     FROM attendance a
     JOIN events e ON e.id = a.event_id
     JOIN members m ON m.id = a.member_id
     WHERE a.synced_to_terrain = 0 AND a.attended = 1`
  ).all();

  if (!pending.results.length) {
    await env.scouts_db.prepare(
      `INSERT INTO sync_log (status, detail) VALUES ('ok', 'Nothing to sync')`
    ).run();
    return;
  }

  if (!syncToken) {
    await env.scouts_db.prepare(
      `INSERT INTO sync_log (status, detail) VALUES ('error', 'No valid token available for sync')`
    ).run();
    return;
  }

  // Group by event
  const byEvent = {};
  for (const row of pending.results) {
    if (!byEvent[row.event_uuid]) byEvent[row.event_uuid] = [];
    byEvent[row.event_uuid].push(row.t_guid);
  }

  let synced = 0;
  let errors = 0;

  for (const [eventId, guids] of Object.entries(byEvent)) {
    try {
      const res = await fetch(`${TERRAIN_EVENTS}/events/${eventId}`, {
        method:  'PATCH',
        headers: { Authorization: syncToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ attendee_member_ids: guids, participant_member_ids: guids }),
      });

      if (res.ok || res.status === 204) {
        await env.scouts_db.prepare(
          `UPDATE attendance SET synced_to_terrain = 1
           WHERE event_id = ? AND member_id IN (${guids.map(() => '?').join(',')})`
        ).bind(eventId, ...guids).run();
        synced += guids.length;
      } else {
        errors++;
      }
    } catch(e) {
      errors++;
    }
  }

  await env.scouts_db.prepare(
    `INSERT INTO sync_log (status, detail) VALUES (?, ?)`
  ).bind(errors ? 'partial' : 'ok', `Synced ${synced} records, ${errors} errors`).run();
}

// ═══════════════════════════════════════════════════════════════
// CHAT ROUTES
// ═══════════════════════════════════════════════════════════════

async function handleChat(path, method, request, url, env, member) {
  const parts = path.split('/').filter(Boolean); // ['chat', 'channels', ...]

  // GET /chat/channels
  if (parts[1] === 'channels' && method === 'GET' && parts.length === 2)
    return getChatChannels(env, member);

  // POST /chat/channels
  if (parts[1] === 'channels' && method === 'POST' && parts.length === 2)
    return createChannel(request, env, member);

  // GET /chat/channels/:id/messages
  if (parts[1] === 'channels' && parts[3] === 'messages' && method === 'GET')
    return getMessages(parts[2], request, url, env, member);

  // POST /chat/channels/:id/messages
  if (parts[1] === 'channels' && parts[3] === 'messages' && method === 'POST')
    return sendMessage(parts[2], request, env, member);

  // POST /chat/channels/:id/archive
  if (parts[1] === 'channels' && parts[3] === 'archive' && method === 'POST')
    return archiveChannel(parts[2], env, member);

  // GET /chat/flags
  if (parts[1] === 'flags' && method === 'GET' && parts.length === 2)
    return getFlags(env, member);

  // POST /chat/flags/:id/review
  if (parts[1] === 'flags' && parts[3] === 'review' && method === 'POST')
    return reviewFlag(parts[2], env, member);

  // POST /chat/supervisors/:memberId
  if (parts[1] === 'supervisors' && method === 'POST')
    return addSupervisor(parts[2], env, member);

  // DELETE /chat/supervisors/:memberId
  if (parts[1] === 'supervisors' && method === 'DELETE')
    return removeSupervisor(parts[2], env, member);

  return err('Chat route not found', 404);
}

// ── GET CHANNELS ──────────────────────────────────────────────
async function getChatChannels(env, member) {
  let channels;

  if (isSupervisor(member)) {
    const rows = await env.scouts_db.prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0) as message_count,
        (SELECT m.sent_at  FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message_at,
        (SELECT m.content  FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*)   FROM flag_alerts fa WHERE fa.channel_id = c.id AND fa.reviewed = 0) as unread_flags
       FROM channels c
       WHERE c.is_archived = 0
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`
    ).all();
    channels = rows.results;
  } else {
    const senderId = member.terrain_member_id || member.member_id;
    const rows = await env.scouts_db.prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0) as message_count,
        (SELECT m.sent_at FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message_at,
        (SELECT m.content FROM messages m WHERE m.channel_id = c.id AND m.is_deleted = 0 ORDER BY m.sent_at DESC LIMIT 1) as last_message
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.member_id = ? AND c.is_archived = 0
       ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC`
    ).bind(senderId).all();
    channels = rows.results;
  }

  return json({ results: channels });
}

// ── CREATE CHANNEL ────────────────────────────────────────────
async function createChannel(request, env, member) {
  const { name, description, type, member_ids, is_finite } = await request.json();

  if (!name || !type) return err('name and type required');

  const validTypes = ['unit', 'patrol', 'project', 'council', 'direct', 'leaders'];
  if (!validTypes.includes(type)) return err('Invalid channel type');

  if ((type === 'unit' || type === 'leaders') && !isSupervisor(member)) {
    return err('Only leaders can create this channel type', 403);
  }

  const channelId = generateId();
  const senderId  = member.terrain_member_id || member.member_id;

  await env.scouts_db.prepare(
    `INSERT INTO channels (id, name, description, type, unit_id, is_finite, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(channelId, name, description || '', type, member.unit_id, is_finite ? 1 : 0, senderId).run();

  const allMemberIds = [...new Set([...(member_ids || []), senderId])];

  if (type === 'direct') {
    const supervisorRows = await env.scouts_db.prepare(
      `SELECT member_id FROM supervisors`
    ).all();
    supervisorRows.results.forEach(s => allMemberIds.push(s.member_id));
  }

  if (type === 'unit') {
    const unitMembers = await env.scouts_db.prepare(
      `SELECT id FROM members WHERE unit_id = ? AND status = 'active'`
    ).bind(member.unit_id).all();
    unitMembers.results.forEach(m => allMemberIds.push(m.id));
  }

  const uniqueIds = [...new Set(allMemberIds)].filter(Boolean);
  const stmt = env.scouts_db.prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, member_id, role) VALUES (?, ?, ?)`
  );
  const batch = uniqueIds.map(mid =>
    stmt.bind(channelId, mid, mid === senderId ? 'admin' : 'member')
  );
  if (batch.length) await env.scouts_db.batch(batch);

  return json({ success: true, channel_id: channelId });
}

// ── GET MESSAGES ──────────────────────────────────────────────
async function getMessages(channelId, request, url, env, member) {
  const hasAccess = await checkChannelAccess(channelId, env, member);
  if (!hasAccess) return err('Access denied', 403);

  const before = url.searchParams.get('before');
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

  const messages = rows.results.reverse();

  const channel = await env.scouts_db.prepare(
    `SELECT * FROM channels WHERE id = ?`
  ).bind(channelId).first();

  const membersRows = await env.scouts_db.prepare(
    `SELECT cm.member_id, m.first_name, m.last_name, m.role
     FROM channel_members cm
     LEFT JOIN members m ON m.id = cm.member_id
     WHERE cm.channel_id = ?`
  ).bind(channelId).all();

  return json({ channel, messages, members: membersRows.results });
}

// ── SEND MESSAGE ──────────────────────────────────────────────
async function sendMessage(channelId, request, env, member) {
  const hasAccess = await checkChannelAccess(channelId, env, member);
  if (!hasAccess) return err('Access denied', 403);

  let body;
  try { body = await request.json(); } catch(_) { return err('Invalid JSON body'); }

  const { content } = body;
  if (!content?.trim()) return err('Message cannot be empty');
  if (content.length > 2000) return err('Message too long (max 2000 chars)');

  const messageId  = generateId();
  const senderId   = member.terrain_member_id || member.member_id;
  const senderName = (member.first_name + ' ' + (member.last_name || '')).trim() || member.member_id;
  const senderRole = member.role || 'member';

  await env.scouts_db.prepare(
    `INSERT INTO messages (id, channel_id, sender_id, sender_name, sender_role, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(messageId, channelId, senderId, senderName, senderRole, content.trim()).run();

  try {
    const keywords = await env.scouts_db.prepare(
      `SELECT keyword, severity FROM keyword_flags`
    ).all();

    const contentLower = content.toLowerCase();
    const triggered    = keywords.results.filter(k => contentLower.includes(k.keyword.toLowerCase()));

    if (triggered.length) {
      await env.scouts_db.prepare(
        `UPDATE messages SET is_flagged = 1, flag_reason = ? WHERE id = ?`
      ).bind(triggered.map(k => k.keyword).join(', '), messageId).run();

      const alertStmt = env.scouts_db.prepare(
        `INSERT INTO flag_alerts (message_id, channel_id, sender_id, keyword, severity)
         VALUES (?, ?, ?, ?, ?)`
      );
      await env.scouts_db.batch(
        triggered.map(k => alertStmt.bind(messageId, channelId, senderId, k.keyword, k.severity))
      );
    }
  } catch(e) {
    console.log('Keyword scan failed (non-fatal):', e.message);
  }

  return json({ success: true, message_id: messageId });
}

// ── ARCHIVE CHANNEL ───────────────────────────────────────────
async function archiveChannel(channelId, env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);
  await env.scouts_db.prepare(
    `UPDATE channels SET is_archived = 1 WHERE id = ?`
  ).bind(channelId).run();
  return json({ success: true });
}

// ── GET FLAGS ─────────────────────────────────────────────────
async function getFlags(env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);
  const rows = await env.scouts_db.prepare(
    `SELECT fa.*, m.content as message_content, ch.name as channel_name
     FROM flag_alerts fa
     JOIN messages m ON m.id = fa.message_id
     JOIN channels ch ON ch.id = fa.channel_id
     WHERE fa.reviewed = 0
     ORDER BY fa.created_at DESC
     LIMIT 50`
  ).all();
  return json({ results: rows.results });
}

// ── REVIEW FLAG ───────────────────────────────────────────────
async function reviewFlag(flagId, env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);
  const reviewerId = member.terrain_member_id || member.member_id;
  await env.scouts_db.prepare(
    `UPDATE flag_alerts SET reviewed = 1, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`
  ).bind(reviewerId, flagId).run();
  return json({ success: true });
}

// ── CHANNEL ACCESS CHECK ──────────────────────────────────────
async function checkChannelAccess(channelId, env, member) {
  if (isSupervisor(member)) return true;
  const senderId = member.terrain_member_id || member.member_id;
  const row = await env.scouts_db.prepare(
    `SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?`
  ).bind(channelId, senderId).first();
  return !!row;
}

// ── SUPERVISORS ───────────────────────────────────────────────
async function addSupervisor(supervisorMemberId, env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);
  const addedBy = member.terrain_member_id || member.member_id;
  await env.scouts_db.prepare(
    `INSERT OR IGNORE INTO supervisors (member_id, added_by) VALUES (?, ?)`
  ).bind(supervisorMemberId, addedBy).run();
  return json({ success: true });
}

async function removeSupervisor(supervisorMemberId, env, member) {
  if (!isSupervisor(member)) return err('Leaders only', 403);
  await env.scouts_db.prepare(
    `DELETE FROM supervisors WHERE member_id = ?`
  ).bind(supervisorMemberId).run();
  return json({ success: true });
}
