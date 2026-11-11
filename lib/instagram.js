// Instagram — comments + DMs on the creator's OWN professional account,
// via the "Instagram API with Instagram Login" (host graph.instagram.com).
//
// Own-account access only, so no App Review is needed (Standard Access).
// Permanent connection: we exchange for a long-lived (~60 day) token and keep it
// in an env var; on boot we refresh it so it keeps extending as long as the app
// is used at least once every 60 days.
//
// Scopes: instagram_business_basic, instagram_business_manage_comments,
//         instagram_business_manage_messages
import { timeAgo, httpJson, form } from './util.js';

const GRAPH = 'https://graph.instagram.com';           // API host (no version prefix needed)
const AUTH = 'https://www.instagram.com/oauth/authorize';
const TOKEN = 'https://api.instagram.com/oauth/access_token';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages'
];

function redirectUri() {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return `${base}/auth/instagram/callback`;
}

// Step 1 — where we send the creator to approve access.
export function authUrl() {
  const p = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(',')
  });
  return `${AUTH}?${p.toString()}`;
}

// Step 2 — swap the ?code for a token. Returns { token, userId, username }.
// We go short-lived -> long-lived so the connection can be saved permanently.
export async function exchangeCode(code) {
  const short = await httpJson(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: process.env.INSTAGRAM_APP_ID || '',
      client_secret: process.env.INSTAGRAM_APP_SECRET || '',
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code
    })
  });
  // short.access_token is valid ~1h; upgrade to the 60-day token.
  const long = await httpJson(
    `${GRAPH}/access_token?${form({
      grant_type: 'ig_exchange_token',
      client_secret: process.env.INSTAGRAM_APP_SECRET || '',
      access_token: short.access_token
    })}`
  );
  const token = long.access_token || short.access_token;
  const me = await getProfile(token);
  return { token, userId: me.id, username: me.username };
}

// Extend a long-lived token for another 60 days (safe to call on every boot).
export async function refreshToken(token) {
  try {
    const r = await httpJson(
      `${GRAPH}/refresh_access_token?${form({ grant_type: 'ig_refresh_token', access_token: token })}`
    );
    return r.access_token || token;
  } catch {
    return token; // keep the existing token if refresh isn't due / fails
  }
}

export async function getProfile(token) {
  return httpJson(`${GRAPH}/me?${form({ fields: 'id,username', access_token: token })}`);
}

// ---- Comments: scan recent media, collect fan comments we haven't answered ----
// NOTE: we deliberately do NOT request the `from` field on comments. On the
// Instagram API with Instagram Login (graph.instagram.com) that field is often
// rejected ("nonexisting field (from) on node type (Comment)"), which throws the
// whole comments request and makes every comment silently disappear. We read
// `username` instead and skip our own comments by comparing usernames.
export async function listComments(token, { mediaScan = 25, perMedia = 50 } = {}) {
  const me = await getProfile(token);
  const myUser = (me.username || '').toLowerCase();
  const myId = me.id;
  const media = await httpJson(
    `${GRAPH}/me/media?${form({ fields: 'id,caption,timestamp,comments_count', limit: mediaScan, access_token: token })}`
  );
  const withComments = (media.data || []).filter(m => (m.comments_count || 0) > 0);
  const out = [];
  for (const m of withComments) {
    let cm;
    try {
      // IMPORTANT: `from{id,username}` returns the commenter's REAL username. The
      // top-level `username` field only comes back for our OWN comments, which is
      // why other people's comments used to show as "Instagram user". We keep
      // `username` as a secondary fallback.
      cm = await httpJson(
        `${GRAPH}/${m.id}/comments?${form({ fields: 'id,text,from{id,username},username,timestamp,like_count', limit: perMedia, access_token: token })}`
      );
    } catch {
      // If a given media ever rejects the from-field query, fall back to basics.
      try {
        cm = await httpJson(
          `${GRAPH}/${m.id}/comments?${form({ fields: 'id,text,username,timestamp,like_count', limit: perMedia, access_token: token })}`
        );
      } catch { continue; }
    }
    for (const c of (cm.data || [])) {
      const uname = c.from?.username || c.username || '';
      const uid = c.from?.id || '';
      // skip our own comments (by id when available, else by username)
      if ((myId && uid && uid === myId) || (myUser && uname.toLowerCase() === myUser)) continue;
      out.push({
        gid: 'ig_cmt_' + c.id,
        ch: 'ig-cmt',
        igCommentId: c.id,
        name: uname || 'Instagram user',
        handle: uname ? '@' + uname : '',
        text: c.text || '',
        time: timeAgo(new Date(c.timestamp).getTime()),
        _postCaption: (m.caption || '').slice(0, 80)
      });
    }
  }
  return out;
}

// ---- DMs: latest inbound message per conversation (within Meta's 24h window) ----
export async function listDMs(token, { convScan = 25, perConv = 12 } = {}) {
  const me = await getProfile(token);
  const myId = me.id;
  let convos;
  try {
    convos = await httpJson(
      `${GRAPH}/me/conversations?${form({ fields: 'id,updated_time', limit: convScan, access_token: token })}`
    );
  } catch { return []; }
  const out = [];
  for (const conv of (convos.data || [])) {
    let msgs;
    try {
      msgs = await httpJson(
        `${GRAPH}/${conv.id}/messages?${form({ fields: 'id,from,message,created_time', limit: perConv, access_token: token })}`
      );
    } catch { continue; }
    const data = msgs.data || [];
    // messages come newest-first; find the newest one that isn't from us
    const inbound = data.find(m => m.from?.id && m.from.id !== myId);
    if (!inbound) continue;
    // Recent back-and-forth, oldest-first, so the assistant has context (not just
    // the latest line). `who` marks our own replies vs the fan's messages.
    const thread = data
      .filter(m => m.message)
      .reverse()
      .map(m => ({ who: (m.from?.id && m.from.id === myId) ? 'me' : 'them',
                   text: m.message || '',
                   time: timeAgo(new Date(m.created_time).getTime()) }));
    out.push({
      gid: 'ig_dm_' + inbound.id,
      ch: 'ig-dm',
      igRecipientId: inbound.from.id,
      name: inbound.from?.username || 'Instagram DM',
      handle: inbound.from?.username ? '@' + inbound.from.username : '',
      text: inbound.message || '',
      time: timeAgo(new Date(inbound.created_time).getTime()),
      thread
    });
  }
  return out;
}

// Deep diagnostic: show exactly what the account's media and conversations
// endpoints return (counts + any error), so we can tell "no media" from
// "media but no comments" from "messaging returns nothing".
export async function diagnose(token) {
  const out = {};
  try { const me = await getProfile(token); out.username = me.username; out.userId = me.id; }
  catch (e) { out.profileError = e.message; return out; }
  let data = [];
  try {
    const media = await httpJson(
      `${GRAPH}/me/media?${form({ fields: 'id,caption,comments_count,media_type,timestamp', limit: 25, access_token: token })}`
    );
    data = media.data || [];
    out.mediaCount = data.length;
    out.mediaWithComments = data.filter(m => (m.comments_count || 0) > 0).length;
    out.totalCommentsOnRecentMedia = data.reduce((n, m) => n + (m.comments_count || 0), 0);
    out.sampleMedia = data.slice(0, 3).map(m => ({ type: m.media_type, comments: m.comments_count || 0, when: m.timestamp }));
  } catch (e) { out.mediaError = e.message; }

  // The real test: hit the comments edge on the first media that HAS comments,
  // trying several field sets to see which (if any) returns data vs errors.
  const withC = data.find(m => (m.comments_count || 0) > 0);
  if (withC) {
    out.probeMediaId = withC.id;
    const edge = async (label, qs) => {
      try {
        const r = await httpJson(`${GRAPH}/${withC.id}/comments?${qs}&access_token=${token}`);
        const c = (r.data || [])[0] || {};
        out[label] = { count: (r.data || []).length, u: c.from?.username || c.username || null, t: (c.text || '').slice(0, 25) };
      } catch (e) { out[label] = { error: e.message }; }
    };
    // `from{id,username}` is what returns the commenter's real username.
    await edge('edge_from', 'fields=id,text,from{id,username}&limit=10');
    await edge('edge_username', 'fields=id,text,username&limit=10');
  }

  try {
    const conv = await httpJson(
      `${GRAPH}/me/conversations?${form({ fields: 'id,updated_time', limit: 25, access_token: token })}`
    );
    out.conversationCount = (conv.data || []).length;
  } catch (e) { out.conversationError = e.message; }
  return out;
}

// Reply publicly to a comment.
export async function replyToComment(token, commentId, text) {
  await httpJson(`${GRAPH}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ message: text, access_token: token })
  });
  return true;
}

// Send a DM reply to the person who messaged (recipient = their IGSID).
// Only works inside Meta's 24h window (they must have messaged first).
export async function sendDM(token, recipientId, text) {
  await httpJson(`${GRAPH}/me/messages?${form({ access_token: token })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    })
  });
  return true;
}
