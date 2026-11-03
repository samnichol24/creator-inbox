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

// ?code -> long-lived user token -> first Page's token.
// Returns { pageId, pageName, pageToken }.
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
  const page = await firstPage(long.access_token);
  return page;
}

// The creator's first managed Page (most have one). Page tokens from a
// long-lived user token don't expire, so this is the permanent credential.
export async function firstPage(userToken) {
  const accts = await httpJson(
    `${GRAPH}/me/accounts?${form({ fields: 'name,id,access_token', access_token: userToken })}`
  );
  const page = (accts.data || [])[0];
  if (!page) throw new Error('No Facebook Page found on this account.');
  return { pageId: page.id, pageName: page.name, pageToken: page.access_token };
}

// ---- Comments on recent Page posts ----
export async function listComments(pageToken, pageId, { postScan = 15, perPost = 50 } = {}) {
  const feed = await httpJson(
    `${GRAPH}/${pageId}/feed?${form({
      fields: `id,message,created_time,comments.limit(${perPost}){id,message,from,created_time}`,
      limit: postScan,
      access_token: pageToken
    })}`
  );
  const out = [];
  for (const post of (feed.data || [])) {
    for (const c of (post.comments?.data || [])) {
      if (c.from?.id && c.from.id === pageId) continue; // skip the Page's own replies
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
export async function listMessenger(pageToken, pageId, { convScan = 25 } = {}) {
  let convos;
  try {
    convos = await httpJson(
      `${GRAPH}/${pageId}/conversations?${form({
        platform: 'messenger',
        fields: `id,updated_time,messages.limit(5){id,from,message,created_time}`,
        limit: convScan,
        access_token: pageToken
      })}`
    );
  } catch { return []; }
  const out = [];
  for (const conv of (convos.data || [])) {
    const inbound = (conv.messages?.data || []).find(m => m.from?.id && m.from.id !== pageId);
    if (!inbound) continue;
    out.push({
      gid: 'fb_msgr_' + inbound.id,
      ch: 'fb-msgr',
      fbRecipientId: inbound.from.id,
      name: inbound.from?.name || 'Messenger',
      handle: inbound.from?.name || '',
      text: inbound.message || '',
      time: timeAgo(new Date(inbound.created_time).getTime())
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
