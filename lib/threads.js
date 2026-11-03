// Threads — read and reply to replies on the creator's OWN Threads account,
// via the Threads API (host graph.threads.com). This is a SEPARATE Meta "use
// case" with its own app credentials and its own token — not the Instagram one.
//
// Own-account access only (no App Review). 60-day long-lived token, refreshable.
//
// Scopes: threads_basic, threads_content_publish, threads_manage_replies, threads_read_replies
import { timeAgo, httpJson, form } from './util.js';

const GRAPH = 'https://graph.threads.com/v1.0';
const ROOT = 'https://graph.threads.com';
const AUTH = 'https://threads.net/oauth/authorize';

const SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_replies',
  'threads_read_replies'
];

// The Threads app ID isn't secret, so it defaults here; only the Threads app
// secret must be supplied (THREADS_APP_SECRET in Render).
const APP_ID = process.env.THREADS_APP_ID || '4202597606705704';
const APP_SECRET = process.env.THREADS_APP_SECRET || '';

function redirectUri() {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return `${base}/auth/threads/callback`;
}

export function authUrl() {
  const p = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(',')
  });
  return `${AUTH}?${p.toString()}`;
}

// ?code -> short-lived -> long-lived (~60 day) token. Returns { token, userId, username }.
export async function exchangeCode(code) {
  const short = await httpJson(`${ROOT}/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code
    })
  });
  const long = await httpJson(
    `${ROOT}/access_token?${form({
      grant_type: 'th_exchange_token',
      client_secret: APP_SECRET,
      access_token: short.access_token
    })}`
  );
  const token = long.access_token || short.access_token;
  const me = await getProfile(token);
  return { token, userId: me.id, username: me.username };
}

export async function refreshToken(token) {
  try {
    const r = await httpJson(
      `${ROOT}/refresh_access_token?${form({ grant_type: 'th_refresh_token', access_token: token })}`
    );
    return r.access_token || token;
  } catch {
    return token;
  }
}

export async function getProfile(token) {
  return httpJson(`${GRAPH}/me?${form({ fields: 'id,username', access_token: token })}`);
}

// Scan recent posts, collect replies from other people we haven't answered.
export async function listReplies(token, { postScan = 25, perPost = 50 } = {}) {
  const me = await getProfile(token);
  const myId = me.id;
  const posts = await httpJson(
    `${GRAPH}/me/threads?${form({ fields: 'id,text,timestamp', limit: postScan, access_token: token })}`
  );
  const out = [];
  for (const post of (posts.data || [])) {
    let rep;
    try {
      rep = await httpJson(
        `${GRAPH}/${post.id}/replies?${form({
          fields: 'id,text,username,timestamp,from,is_reply_owned_by_me',
          limit: perPost,
          access_token: token
        })}`
      );
    } catch { continue; }
    for (const r of (rep.data || [])) {
      if (r.is_reply_owned_by_me) continue;          // our own replies
      if (r.from?.id && r.from.id === myId) continue;
      out.push({
        gid: 'th_' + r.id,
        ch: 'threads',
        threadsReplyId: r.id,
        name: r.username || 'Threads user',
        handle: r.username ? '@' + r.username : '',
        text: r.text || '',
        time: timeAgo(new Date(r.timestamp).getTime()),
        _postText: (post.text || '').slice(0, 80)
      });
    }
  }
  return out;
}

// Reply to a specific reply/post: create a TEXT container, then publish it.
export async function postReply(token, replyToId, text) {
  const me = await getProfile(token);
  const created = await httpJson(`${GRAPH}/${me.id}/threads?${form({ access_token: token })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ media_type: 'TEXT', text, reply_to_id: replyToId })
  });
  const creationId = created.id;
  // Threads asks for a brief pause before publishing a freshly created container.
  await new Promise(r => setTimeout(r, 1500));
  await httpJson(`${GRAPH}/${me.id}/threads_publish?${form({ access_token: token })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId })
  });
  return true;
}
