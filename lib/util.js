// Small shared helpers used across the platform modules.

// "3m", "4h", "2d" — compact relative time from a ms timestamp.
export function timeAgo(ms) {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

// GET/POST JSON against a REST API with a bearer-style token baked into the URL
// or headers. Throws a readable error when the platform returns one.
export async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  let data = null;
  const txt = await res.text();
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || data?.error_message || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Encode an object as application/x-www-form-urlencoded (Meta token endpoints want this).
export function form(obj) {
  return new URLSearchParams(obj).toString();
}
