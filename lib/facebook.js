// Facebook — comments on the creator's OWN Page posts + Page Messenger,
// via the Facebook Graph API (host graph.facebook.com).
//
// Own-Page access only (Standard Access, no App Review). The creator signs in
// with Facebook, we read their Pages, and use the Page access token (which is
// long-lived / effectively non-expiring once derived from a long-lived user token).
//
// User scopes: pages_show_list, pages_read_engagement, pages_manage_engagement,
//              pages_manage_metadata, pages_messaging, pages_read_user_content
import { timeAgo, httpJson, form } from './util.js';

const V = 'v23.0';
const GRAPH = `https://graph.facebook.com/${V}`;
const DIALOG = `https://www.facebook.com/${V}/dialog/oauth`;

// Facebook Login for Business uses a saved "configuration" (config_id) that
// bundles the Page permissions, instead of passing scopes in the URL.
// The App ID and config ID aren't secret, so they default here; only the
// App Secret must be supplied (FACEBOOK_APP_SECRET in Render).
const APP_ID = process.env.FACEBOOK_APP_ID || '2171085083827638';
const APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const CONFIG_ID = process.env.FACEBOOK_CONFIG_ID || '3277753272409841';

function redirectUri() {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return `${base}/auth/facebook/callback`;
}

export function authUrl() {
  const p = new URLSearchParams({
    client_id: APP_ID,
    config_id: CONFIG_ID,
    redirect_uri: redirectUri(),
    response_type: 'code'
  });
  return `${DIALOG}?${p.toString()}`;
}

// ?code -> long-lived user token -> ALL of the creator's Page tokens.
// Returns { pages: [{ pageId, pageName, pageToken }, ...] }.
export async function exchangeCode(code) {
  const short = await httpJson(
    `${GRAPH}/oauth/access_token?${form({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: redirectUri(),
      code
    })}`
  );
  const long = await httpJson(
    `${GRAPH}/oauth/access_token?${form({
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: short.access_token
    })}`
  );
  const pages = await allPages(long.access_token);
  if (!pages.length) throw new Error('No Facebook Page found on this account.');
  return { pages };
}

// Every Page the creator can manage. Page tokens derived from a long-lived user
// token don't expire, so these are permanent credentials.
//
// /me/accounts only lists Pages owned directly by the personal profile. Pages
// owned by a Business Portfolio don't appear there, so we also walk the
// portfolios (/me/businesses -> owned_pages + client_pages) and merge, deduping
// by Page id. For a portfolio Page we still need a PAGE token, which we fetch
// per-Page via /{page-id}?fields=access_token using the user token.
export async function allPages(userToken) {
  const byId = new Map();

  // 1) Directly-owned Pages (these already include a page access_token).
  try {
    let url = `${GRAPH}/me/accounts?${form({ fields: 'name,id,access_token', limit: 100, access_token: userToken })}`;
    while (url) {
      const accts = await httpJson(url);
      for (const p of (accts.data || [])) {
        if (p.access_token) byId.set(p.id, { pageId: p.id, pageName: p.name, pageToken: p.access_token });
      }
      url = accts.paging?.next || null;
    }
  } catch (e) { /* fall through to portfolios */ }

  // 1.5) Pages granted through Facebook Login for Business — including ones owned
  // by a Business Portfolio, which DON'T show up in /me/accounts. The user token's
  // granular_scopes list the exact Page IDs that were granted; fetch each Page's
  // own token directly. This needs no business_management permission.
  try {
    const dbg = await httpJson(
      `${GRAPH}/debug_token?${form({ input_token: userToken, access_token: `${APP_ID}|${APP_SECRET}` })}`
    );
    const ids = new Set();
    for (const gs of (dbg.data?.granular_scopes || [])) {
      for (const id of (gs.target_ids || [])) ids.add(id);
    }
    for (const id of ids) {
      if (byId.has(id)) continue;
      const tok = await pageToken(id, userToken);
      if (!tok) continue;
      let name = 'Facebook Page';
      try { const p = await httpJson(`${GRAPH}/${id}?${form({ fields: 'name', access_token: userToken })}`); name = p.name || name; } catch {}
      byId.set(id, { pageId: id, pageName: name, pageToken: tok });
    }
  } catch { /* granular scopes unavailable */ }

  // 2) Business-portfolio Pages (owned + client). These need a per-Page token.
  try {
    const biz = await httpJson(
      `${GRAPH}/me/businesses?${form({ fields: 'id,name', limit: 100, access_token: userToken })}`
    );
    for (const b of (biz.data || [])) {
      for (const edge of ['owned_pages', 'client_pages']) {
        try {
          let url = `${GRAPH}/${b.id}/${edge}?${form({ fields: 'name,id', limit: 100, access_token: userToken })}`;
          while (url) {
            const list = await httpJson(url);
            for (const p of (list.data || [])) {
              if (byId.has(p.id)) continue; // already have a token for it
              const tok = await pageToken(p.id, userToken);
              if (tok) byId.set(p.id, { pageId: p.id, pageName: p.name, pageToken: tok });
            }
            url = list.paging?.next || null;
          }
        } catch { /* skip this edge */ }
      }
    }
  } catch { /* no business access — directly-owned Pages only */ }

  return [...byId.values()];
}

// Fetch a Page access token for a single Page id using the user token.
async function pageToken(pageId, userToken) {
  try {
    const r = await httpJson(`${GRAPH}/${pageId}?${form({ fields: 'access_token', access_token: userToken })}`);
    return r.access_token || null;
  } catch { return null; }
}

// ---- Comments on recent Page posts ----
export async function listComments(pageToken, pageId, { postScan = 15, perPost = 50 } = {}) {
  let feed;
  try {
    feed = await httpJson(
      `${GRAPH}/${pageId}/feed?${form({
        fields: `id,message,created_time,comments.limit(${perPost}){id,message,from,created_time,comments.limit(25){from}}`,
        limit: postScan,
        access_token: pageToken
      })}`
    );
  } catch {
    // Fall back without nested replies (no reply-detection, but still lists comments).
    feed = await httpJson(
      `${GRAPH}/${pageId}/feed?${form({
        fields: `id,message,created_time,comments.limit(${perPost}){id,message,from,created_time}`,
        limit: postScan,
        access_token: pageToken
      })}`
    );
  }
  const out = [];
  for (const post of (feed.data || [])) {
    for (const c of (post.comments?.data || [])) {
      if (c.from?.id && c.from.id === pageId) continue; // skip the Page's own comments
      // skip comments the Page has ALREADY REPLIED TO (in-app or portal). Other
      // people replying does NOT hide it — only the Page's own reply does.
      const replies = c.comments?.data || [];
      if (replies.some(r => r.from?.id && r.from.id === pageId)) continue;
      out.push({
        gid: 'fb_cmt_' + c.id,
        ch: 'fb-cmt',
        fbCommentId: c.id,
        name: c.from?.name || 'Facebook user',
        handle: c.from?.name || '',
        text: c.message || '',
        time: timeAgo(new Date(c.created_time).getTime()),
        _postText: (post.message || '').slice(0, 80)
      });
    }
  }
  return out;
}

// ---- Page Messenger: latest inbound message per conversation ----
export async function listMessenger(pageToken, pageId, { convScan = 25, perConv = 12 } = {}) {
  let convos;
  try {
    convos = await httpJson(
      `${GRAPH}/${pageId}/conversations?${form({
        platform: 'messenger',
        fields: `id,updated_time,messages.limit(${perConv}){id,from,message,created_time}`,
        limit: convScan,
        access_token: pageToken
      })}`
    );
  } catch { return []; }
  const out = [];
  for (const conv of (convos.data || [])) {
    const data = conv.messages?.data || [];
    const inbound = data.find(m => m.from?.id && m.from.id !== pageId);
    if (!inbound) continue;
    // If the Page sent the most recent message, it's already handled — skip it.
    const newest = data.find(m => m.from?.id);
    if (newest && newest.from.id === pageId) continue;
    // Recent back-and-forth, oldest-first, for context (our Page replies vs theirs).
    const thread = data
      .filter(m => m.message)
      .reverse()
      .map(m => ({ who: (m.from?.id && m.from.id === pageId) ? 'me' : 'them',
                   text: m.message || '',
                   time: timeAgo(new Date(m.created_time).getTime()) }));
    out.push({
      gid: 'fb_msgr_' + inbound.id,
      ch: 'fb-msgr',
      fbRecipientId: inbound.from.id,
      name: inbound.from?.name || 'Messenger',
      handle: inbound.from?.name || '',
      text: inbound.message || '',
      time: timeAgo(new Date(inbound.created_time).getTime()),
      thread
    });
  }
  return out;
}

export async function replyToComment(pageToken, commentId, text) {
  await httpJson(`${GRAPH}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ message: text, access_token: pageToken })
  });
  return true;
}

// Reply in Messenger (RESPONSE = inside the 24h window).
export async function sendMessenger(pageToken, pageId, recipientPsid, text) {
  await httpJson(`${GRAPH}/${pageId}/messages?${form({ access_token: pageToken })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      messaging_type: 'RESPONSE',
      message: { text }
    })
  });
  return true;
}

// Diagnostic: probe what the comments edge returns for the commenter's name, so
// we can tell whether "Facebook user" is a missing field vs an API restriction.
export async function diagnose(pageToken, pageId, { postScan = 15 } = {}) {
  const out = {};
  try {
    const feed = await httpJson(
      `${GRAPH}/${pageId}/feed?${form({ fields: 'id,comments.limit(5){id,message,from}', limit: postScan, access_token: pageToken })}`
    );
    const posts = feed.data || [];
    out.postsScanned = posts.length;
    const withC = posts.find(p => (p.comments?.data || []).length);
    if (!withC) { out.note = 'no comments in scan'; return out; }
    out.probePostId = withC.id;
    const edge = async (label, qs) => {
      try {
        const r = await httpJson(`${GRAPH}/${withC.id}/comments?${qs}&access_token=${pageToken}`);
        const c = (r.data || [])[0] || {};
        out[label] = { count: (r.data || []).length, name: c.from?.name || null, fromId: c.from?.id || null, hasFrom: !!c.from, keys: Object.keys(c) };
      } catch (e) { out[label] = { error: (e && e.message ? e.message : String(e)).slice(0, 200) }; }
    };
    await edge('from_name', 'fields=id,message,from{id,name}');
    await edge('from_bare', 'fields=id,message,from');
    await edge('with_tags', 'fields=id,message,from{id,name},message_tags');
  } catch (e) { out.error = e.message; }
  return out;
}
