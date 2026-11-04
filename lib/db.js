// Persistent store via Supabase (PostgREST). Keeps every platform's tokens, the
// tone sheet, and the "replied" set in a database so connections survive
// restarts automatically — no more copying tokens from logs into env vars.
//
// Uses the service_role key, which is server-side only and kept in Render env
// (RLS blocks anyone else). If SUPABASE_URL / SUPABASE_SERVICE_KEY aren't set,
// the app silently falls back to its old in-memory + env-var behavior.
const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'creator_inbox_store';

export function enabled() {
  return !!(BASE && KEY);
}

function headers(extra = {}) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
    ...extra
  };
}

// Load every saved row as a plain { key: value } object.
export async function loadAll() {
  if (!enabled()) return {};
  const res = await fetch(`${BASE}/rest/v1/${TABLE}?select=key,value`, { headers: headers() });
  if (!res.ok) throw new Error('db load HTTP ' + res.status);
  const rows = await res.json();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Upsert one key's value. Safe to call without awaiting (errors are swallowed
// and logged) so it never blocks a request or a sign-in.
export async function save(key, value) {
  if (!enabled()) return false;
  try {
    const res = await fetch(`${BASE}/rest/v1/${TABLE}?on_conflict=key`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }])
    });
    if (!res.ok) { console.error('db save', key, 'HTTP', res.status); return false; }
    return true;
  } catch (e) {
    console.error('db save', key, e.message);
    return false;
  }
}
