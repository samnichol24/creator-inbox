import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { authUrl, exchangeCode, listRecentEmails, sendReply, getProfileEmail, listRecentComments, replyToComment, getChannelTitle } from './lib/google.js';
import * as ig from './lib/instagram.js';
import * as fb from './lib/facebook.js';
import * as th from './lib/threads.js';
import * as dc from './lib/discord.js';
import * as db from './lib/db.js';
import { generateDraft } from './lib/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Which platforms have their app keys configured (so the Connect button can work).
const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const hasInstagram = !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
const hasFacebook = !!process.env.FACEBOOK_APP_SECRET; // app id + config id default in lib/facebook.js
const hasThreads = !!process.env.THREADS_APP_SECRET; // app id defaults in lib/threads.js

app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, secure: 'auto', sameSite: 'lax' }
}));
app.use(express.urlencoded({ extended: false })); // parse the login form POST

// ---------- Portal login gate ----------
// Optional: when PORTAL_USERS is set in the environment (format
// "sam:pass1,assistant:pass2"), the whole portal requires a login. Until it's
// set the portal stays open, so deploying this never locks anyone out. Add or
// remove people — or change passwords to revoke access — by editing PORTAL_USERS.
function portalUsers() {
  const map = {};
  for (const pair of (process.env.PORTAL_USERS || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return map;
}
const loginOn = () => Object.keys(portalUsers()).length > 0;

// Stateless signed-cookie auth so a redeploy (which wipes the in-memory session
// store) does NOT log everyone out. The cookie is an HMAC of the username using
// SESSION_SECRET, which is stable across restarts, so sessions survive deploys.
const AUTH_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const signUser = (u) => crypto.createHmac('sha256', AUTH_SECRET).update(u).digest('hex');
function cookieUser(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)ci_user=([^;]+)/);
  if (!m) return null;
  try {
    const val = decodeURIComponent(m[1]);
    const i = val.lastIndexOf('.');
    if (i < 0) return null;
    const user = val.slice(0, i), sig = val.slice(i + 1);
    if (sig === signUser(user) && portalUsers()[user] !== undefined) return user;
  } catch {}
  return null;
}

const LOGIN_PAGE = (err) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Creator Inbox — Sign in</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0e1016;color:#e8eaf0}
.card{width:340px;max-width:90vw;background:#171a23;border:1px solid #262b38;border-radius:16px;padding:30px 28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{font-size:19px;margin:0 0 4px}.sub{margin:0 0 22px;color:#8b93a7;font-size:13px}
label{display:block;font-size:12px;color:#8b93a7;margin:14px 0 6px}
input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid #2b3140;background:#0e1016;color:#e8eaf0;font-size:14px}
input:focus{outline:none;border-color:#6366f1}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:10px;background:#6366f1;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}
.err{background:#3a1d22;border:1px solid #5b2a31;color:#f1a7ae;font-size:12.5px;padding:9px 12px;border-radius:9px;margin-top:16px}
.logo{width:34px;height:34px;border-radius:9px;background:#6366f1;display:grid;place-items:center;margin-bottom:16px;font-weight:700;color:#fff}
</style></head><body>
<form class="card" method="post" action="/login">
<div class="logo">CI</div><h1>Creator Inbox</h1><p class="sub">Sign in to your inbox</p>
<label>Username</label><input name="username" autocomplete="username" autofocus>
<label>Password</label><input name="password" type="password" autocomplete="current-password">
${err ? '<div class="err">Wrong username or password.</div>' : ''}
<button type="submit">Sign in</button>
</form></body></html>`;

app.get('/login', (req, res) => res.type('html').send(LOGIN_PAGE(req.query.e)));
app.post('/login', (req, res) => {
  const users = portalUsers();
  const { username, password } = req.body || {};
  if (username && users[username] !== undefined && users[username] === password) {
    req.session.user = username;
    res.cookie('ci_user', `${username}.${signUser(username)}`, {
      httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax', secure: 'auto'
    });
    return res.redirect('/');
  }
  res.redirect('/login?e=1');
});

// Gate everything below once PORTAL_USERS is configured.
app.use((req, res, next) => {
  if (!loginOn() || req.session?.user || cookieUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in.' });
  res.redirect('/login');
});

// --- in-memory store, backed by the database (see initStore) ---
// Every platform now holds an ARRAY of connected accounts, so one inbox can
// merge, e.g., two Instagram accounts + two Gmail inboxes + two Pages at once.
//
// Account shapes:
//   email     { refresh_token, email }
//   youtube   { refresh_token, channel }
//   instagram { token, userId, username }
//   facebook  { pageToken, pageId, pageName }
//   threads   { token, userId, username }
//   discord   { botToken, name }
const store = {
  email: [],
  youtube: [],
  instagram: [],
  facebook: [],
  threads: [],
  discord: [],
  tone: { name: 'Sam', samples: '', signoff: '', emojis: '🙌 ✨ 💜 🔥' },
  cache: [],
  replied: new Set(),
  brands: {} // acctId -> brandId override (e.g. "instagram:178...": "ignite")
};

// ---- Brands: let Sam keep "Sam Nicholson Music" and "Ignite Music Marketing"
// separate so the two never get mixed up in the inbox. Every account belongs to
// a brand; the brand is guessed from the account name and can be overridden per
// account (stored in store.brands and persisted under the 'brands' db key).
const BRANDS = { sam: 'Sam Nicholson Music', ignite: 'Ignite Music Marketing' };
function brandOf(platform, account) {
  const id = acctId(platform, account);
  if (store.brands[id] && BRANDS[store.brands[id]]) return store.brands[id];
  // Heuristic: anything mentioning "ignite" is the Ignite brand; everything else
  // defaults to Sam Nicholson Music.
  const hay = [account.pageName, account.channel, account.username, account.email, account.name]
    .filter(Boolean).join(' ').toLowerCase();
  return /ignite/.test(hay) ? 'ignite' : 'sam';
}

// Each account gets a stable id + a human label, used to tag every message so
// the inbox can show "from @ignitemymusic" and /api/send can route the reply
// back out through the right account.
const ID = {
  email:     a => a.email,
  youtube:   a => a.channel,
  instagram: a => a.userId,
  facebook:  a => a.pageId,
  threads:   a => a.userId,
  discord:   a => a.name
};
const LABEL = {
  email:     a => a.email,
  youtube:   a => a.channel,
  instagram: a => '@' + a.username,
  facebook:  a => a.pageName,
  threads:   a => '@' + a.username,
  discord:   a => a.name
};
// Which platform array a given message channel (ch) belongs to.
const CH_PLATFORM = {
  'email': 'email',
  'yt-cmt': 'youtube',
  'ig-cmt': 'instagram', 'ig-dm': 'instagram',
  'fb-cmt': 'facebook', 'fb-msgr': 'facebook',
  'threads': 'threads',
  'discord': 'discord'
};

function acctId(platform, a) { return platform + ':' + ID[platform](a); }
// Add or replace an account in its array (dedupe by stable id), then persist the
// whole array to the database under the platform's key.
function upsert(platform, dbKey, account) {
  const arr = store[platform];
  const id = ID[platform](account);
  const i = arr.findIndex(x => ID[platform](x) === id);
  if (i >= 0) arr[i] = { ...arr[i], ...account }; else arr.push(account);
  db.save(dbKey, arr);
}
function findAccount(platform, acct) {
  const arr = store[platform] || [];
  if (acct) {
    const hit = arr.find(a => acctId(platform, a) === acct);
    if (hit) return hit;
  }
  return arr[0] || null; // fallback: first account of that platform
}

// Wrap a possibly-old single-object DB value as an array (migration helper).
const asArray = v => Array.isArray(v) ? v : (v ? [v] : []);

// --- Load everything from the database on boot, falling back to env vars ---
// The database is the source of truth. Old single-account DB values (plain
// objects) and legacy env-var tokens are both migrated into the new arrays.
async function initStore() {
  let saved = {};
  if (db.enabled()) {
    try { saved = await db.loadAll(); }
    catch (e) { console.error('db load failed, using env vars:', e.message); }
  }

  store.email     = asArray(saved.google_email);
  store.youtube   = asArray(saved.google_youtube);
  store.instagram = asArray(saved.instagram);
  store.facebook  = asArray(saved.facebook);
  store.threads   = asArray(saved.threads);
  store.discord   = asArray(saved.discord);

  // One-time migration of any legacy env-var tokens into the arrays (only if
  // that platform has nothing saved yet), so older setups keep working.
  if (!store.email.length && process.env.GOOGLE_REFRESH_TOKEN) {
    store.email.push({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN, email: process.env.CONNECTED_EMAIL || 'connected' });
    db.save('google_email', store.email);
  }
  if (!store.youtube.length && process.env.YOUTUBE_REFRESH_TOKEN) {
    store.youtube.push({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, channel: process.env.YOUTUBE_CHANNEL || 'YouTube' });
    db.save('google_youtube', store.youtube);
  }
  if (!store.instagram.length && process.env.INSTAGRAM_ACCESS_TOKEN) {
    store.instagram.push({ token: process.env.INSTAGRAM_ACCESS_TOKEN, userId: process.env.INSTAGRAM_USER_ID || null, username: process.env.INSTAGRAM_USER || 'Instagram' });
    db.save('instagram', store.instagram);
  }
  if (!store.facebook.length && process.env.FACEBOOK_PAGE_TOKEN) {
    store.facebook.push({ pageToken: process.env.FACEBOOK_PAGE_TOKEN, pageId: process.env.FACEBOOK_PAGE_ID || null, pageName: process.env.FACEBOOK_PAGE_NAME || 'Facebook Page' });
    db.save('facebook', store.facebook);
  }
  if (!store.threads.length && process.env.THREADS_ACCESS_TOKEN) {
    store.threads.push({ token: process.env.THREADS_ACCESS_TOKEN, userId: process.env.THREADS_USER_ID || null, username: process.env.THREADS_USER || 'Threads' });
    db.save('threads', store.threads);
  }
  // Discord has no OAuth sign-in; its bot token lives in env. Seed one entry.
  if (!store.discord.length && process.env.DISCORD_BOT_TOKEN) {
    store.discord.push({ botToken: process.env.DISCORD_BOT_TOKEN, name: process.env.DISCORD_BOT_NAME || 'Discord' });
    db.save('discord', store.discord);
  }

  if (saved.tone) store.tone = { ...store.tone, ...saved.tone };
  if (Array.isArray(saved.replied)) store.replied = new Set(saved.replied);
  if (saved.brands && typeof saved.brands === 'object') store.brands = saved.brands;

  // Roll the 60-day Instagram/Threads tokens forward (per account) and persist.
  let igChanged = false, thChanged = false;
  for (const a of store.instagram) {
    try { const t = await ig.refreshToken(a.token); if (t && t !== a.token) { a.token = t; igChanged = true; } } catch {}
  }
  for (const a of store.threads) {
    try { const t = await th.refreshToken(a.token); if (t && t !== a.token) { a.token = t; thChanged = true; } } catch {}
  }
  if (igChanged) db.save('instagram', store.instagram);
  if (thChanged) db.save('threads', store.threads);

  const counts = `email:${store.email.length} yt:${store.youtube.length} ig:${store.instagram.length} fb:${store.facebook.length} threads:${store.threads.length} discord:${store.discord.length}`;
  console.log('Store initialized' + (db.enabled() ? ' (database connected)' : ' (no database — env vars only)') + ' — ' + counts);
}
initStore();

// ---------- Auth: Google (email + YouTube) ----------
app.get('/auth/google', (req, res) => {
  if (!hasGoogle) return res.status(400).send('Google keys not set yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your host settings.');
  res.redirect(authUrl('email'));
});
app.get('/auth/google/youtube', (req, res) => {
  if (!hasGoogle) return res.status(400).send('Google keys not set yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your host settings.');
  res.redirect(authUrl('youtube'));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await exchangeCode(req.query.code);
    if (req.query.state === 'youtube') {
      let channel = 'YouTube';
      try { channel = await getChannelTitle(tokens); } catch {}
      if (tokens.refresh_token) upsert('youtube', 'google_youtube', { refresh_token: tokens.refresh_token, channel });
      return res.redirect('/?connected=youtube');
    }
    const email = await getProfileEmail(tokens);
    req.session.connected = true;
    if (tokens.refresh_token) upsert('email', 'google_email', { refresh_token: tokens.refresh_token, email });
    res.redirect('/?connected=1');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth');
  }
});

// ---------- Auth: Instagram ----------
app.get('/auth/instagram', (req, res) => {
  if (!hasInstagram) return res.status(400).send('Instagram keys not set yet. Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET in your host settings.');
  res.redirect(ig.authUrl());
});
app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { token, userId, username } = await ig.exchangeCode(req.query.code);
    upsert('instagram', 'instagram', { token, userId, username });
    res.redirect('/?connected=instagram');
  } catch (e) { console.error('ig auth', e.message); res.redirect('/?error=instagram'); }
});

// ---------- Auth: Facebook (may return several Pages at once) ----------
app.get('/auth/facebook', (req, res) => {
  if (!hasFacebook) return res.status(400).send('Facebook keys not set yet. Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in your host settings.');
  res.redirect(fb.authUrl());
});
app.get('/auth/facebook/callback', async (req, res) => {
  try {
    const { pages } = await fb.exchangeCode(req.query.code);
    if (!pages || !pages.length) throw new Error('No Facebook Page found on this account.');
    for (const p of pages) upsert('facebook', 'facebook', { pageToken: p.pageToken, pageId: p.pageId, pageName: p.pageName });
    res.redirect('/?connected=facebook');
  } catch (e) { console.error('fb auth', e.message); res.redirect('/?error=facebook'); }
});

// ---------- Auth: Threads ----------
app.get('/auth/threads', (req, res) => {
  if (!hasThreads) return res.status(400).send('Threads keys not set yet. Add THREADS_APP_ID and THREADS_APP_SECRET in your host settings.');
  res.redirect(th.authUrl());
});
app.get('/auth/threads/callback', async (req, res) => {
  try {
    const { token, userId, username } = await th.exchangeCode(req.query.code);
    upsert('threads', 'threads', { token, userId, username });
    res.redirect('/?connected=threads');
  } catch (e) { console.error('threads auth', e.message); res.redirect('/?error=threads'); }
});

// ---------- Discord: no OAuth code flow — just a bot token. Help invite the bot. ----------
app.get('/auth/discord', (req, res) => {
  res.redirect(dc.inviteUrl(process.env.DISCORD_APP_ID));
});

app.get('/logout', (req, res) => {
  res.clearCookie('ci_user');
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- API ----------
// Status reports, per platform, the list of connected accounts (label + id) so
// the UI can show them and offer "add another". Legacy booleans/names are kept
// so the existing front-end keeps working unchanged.
function accountList(platform) {
  return store[platform].map(a => ({
    id: acctId(platform, a),
    label: LABEL[platform](a),
    brand: brandOf(platform, a),
    brandLabel: BRANDS[brandOf(platform, a)]
  }));
}
app.get('/api/status', (req, res) => {
  const email = accountList('email');
  const youtube = accountList('youtube');
  const instagram = accountList('instagram');
  const facebook = accountList('facebook');
  const threads = accountList('threads');
  const discord = accountList('discord');
  res.json({
    accounts: { email, youtube, instagram, facebook, threads, discord },
    brands: Object.entries(BRANDS).map(([id, label]) => ({ id, label })),
    // --- back-compat fields (first account of each) ---
    connected: email.length > 0, email: email[0]?.label || null,
    ytConnected: youtube.length > 0, ytName: youtube[0]?.label || null,
    igConnected: instagram.length > 0, igUser: store.instagram[0]?.username || null,
    fbConnected: facebook.length > 0, fbPageName: facebook[0]?.label || null,
    thConnected: threads.length > 0, thUser: store.threads[0]?.username || null,
    dcConnected: discord.length > 0, dcName: discord[0]?.label || null,
    hasGoogleKeys: hasGoogle, hasInstagramKeys: hasInstagram,
    hasFacebookKeys: hasFacebook, hasThreadsKeys: hasThreads,
    hasDb: db.enabled(), hasAi: !!process.env.ANTHROPIC_API_KEY
  });
});

// Remove one connected account.  ?platform=instagram&acct=instagram:1784...
app.post('/api/disconnect', (req, res) => {
  const platform = req.query.platform || req.body?.platform;
  const acct = req.query.acct || req.body?.acct;
  const dbKey = { email: 'google_email', youtube: 'google_youtube', instagram: 'instagram', facebook: 'facebook', threads: 'threads', discord: 'discord' }[platform];
  if (!dbKey) return res.status(400).json({ error: 'Unknown platform' });
  const before = store[platform].length;
  store[platform] = store[platform].filter(a => acctId(platform, a) !== acct);
  db.save(dbKey, store[platform]);
  res.json({ ok: true, removed: before - store[platform].length });
});

// Assign one account to a brand.  { acct: "instagram:178...", brand: "ignite" }
app.post('/api/brand', (req, res) => {
  const { acct, brand } = req.body || {};
  if (!acct || !BRANDS[brand]) return res.status(400).json({ error: 'Need acct + valid brand' });
  store.brands[acct] = brand;
  db.save('brands', store.brands);
  res.json({ ok: true });
});

app.post('/api/tone', (req, res) => {
  store.tone = { ...store.tone, ...(req.body || {}) };
  db.save('tone', store.tone);
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  const anyConnected = store.email.length || store.youtube.length || store.instagram.length ||
    store.facebook.length || store.threads.length || store.discord.length;
  if (!anyConnected) return res.json([]);
  try {
    let items = [];
    // Tag every item with which account it came from, then collect it.
    const tag = (arr, platform, account) => {
      if (!Array.isArray(arr)) return;
      const id = acctId(platform, account);
      const label = LABEL[platform](account);
      const brand = brandOf(platform, account);
      for (const it of arr) {
        it.acct = id; it.acctLabel = label;
        it.brand = brand; it.brandLabel = BRANDS[brand];
        items.push(it);
      }
    };

    for (const a of store.email) {
      try { const e = await listRecentEmails({ refresh_token: a.refresh_token }, 50); e.forEach(x => x.ch = 'email'); tag(e, 'email', a); }
      catch (e) { console.error('gmail error', a.email, e.message); }
    }
    for (const a of store.youtube) {
      // 365-day window so older comments across all videos are pulled in, not
      // just the last few months.
      try { tag(await listRecentComments({ refresh_token: a.refresh_token }, 365), 'youtube', a); }
      catch (e) { console.error('youtube error', a.channel, e.message); }
    }
    for (const a of store.instagram) {
      try { tag(await ig.listComments(a.token), 'instagram', a); } catch (e) { console.error('ig cmt error', a.username, e.message); }
      try { tag(await ig.listDMs(a.token), 'instagram', a); } catch (e) { console.error('ig dm error', a.username, e.message); }
    }
    for (const a of store.facebook) {
      try { tag(await fb.listComments(a.pageToken, a.pageId), 'facebook', a); } catch (e) { console.error('fb cmt error', a.pageName, e.message); }
      try { tag(await fb.listMessenger(a.pageToken, a.pageId), 'facebook', a); } catch (e) { console.error('fb msgr error', a.pageName, e.message); }
    }
    for (const a of store.threads) {
      try { tag(await th.listReplies(a.token), 'threads', a); } catch (e) { console.error('threads error', a.username, e.message); }
    }
    for (const a of store.discord) {
      try { tag(await dc.listMessages(a.botToken), 'discord', a); } catch (e) { console.error('discord error', a.name, e.message); }
    }

    items = items.filter(it => !store.replied.has(it.gid));
    for (const it of items) {
      it.draft = await generateDraft(it, store.tone);
    }
    store.cache = items;
    res.json(items);
  } catch (e) {
    console.error('list error', e.message);
    res.status(500).json({ error: 'Could not fetch messages. Try reconnecting.' });
  }
});

// ---------- Diagnostics ----------
// Signed-in health check: runs each platform's fetch per connected account and
// reports ok/count/error — WITHOUT exposing any tokens or message text — so a
// broken connection (e.g. Instagram DMs) can be pinpointed fast. Just visit
// /api/diag while signed in to the portal.
app.get('/api/diag', async (req, res) => {
  const probe = async (fn) => {
    try { const r = await fn(); return { ok: true, count: Array.isArray(r) ? r.length : 0 }; }
    catch (e) { return { ok: false, error: (e && e.message ? e.message : String(e)).slice(0, 300) }; }
  };
  const out = { brands: BRANDS, accounts: [] };
  for (const a of store.email)
    out.accounts.push({ platform: 'email', label: LABEL.email(a), brand: brandOf('email', a),
      emails: await probe(() => listRecentEmails({ refresh_token: a.refresh_token }, 50)) });
  for (const a of store.youtube)
    out.accounts.push({ platform: 'youtube', label: LABEL.youtube(a), brand: brandOf('youtube', a),
      comments: await probe(() => listRecentComments({ refresh_token: a.refresh_token }, 30)) });
  for (const a of store.instagram)
    out.accounts.push({ platform: 'instagram', label: LABEL.instagram(a), brand: brandOf('instagram', a),
      comments: await probe(() => ig.listComments(a.token)),
      dms: await probe(() => ig.listDMs(a.token)),
      detail: await ig.diagnose(a.token) });
  for (const a of store.facebook)
    out.accounts.push({ platform: 'facebook', label: LABEL.facebook(a), brand: brandOf('facebook', a),
      comments: await probe(() => fb.listComments(a.pageToken, a.pageId)),
      messenger: await probe(() => fb.listMessenger(a.pageToken, a.pageId)) });
  for (const a of store.threads)
    out.accounts.push({ platform: 'threads', label: LABEL.threads(a), brand: brandOf('threads', a),
      replies: await probe(() => th.listReplies(a.token)) });
  for (const a of store.discord)
    out.accounts.push({ platform: 'discord', label: LABEL.discord(a), brand: brandOf('discord', a),
      messages: await probe(() => dc.listMessages(a.botToken)) });
  res.json(out);
});

app.post('/api/send', async (req, res) => {
  const { gid, threadId, to, text } = req.body || {};
  const cached = store.cache.find(m => m.gid === gid) || {};
  const platform = CH_PLATFORM[cached.ch] || 'email';
  const account = findAccount(platform, cached.acct);
  try {
    if (!account) return res.status(401).json({ error: `${platform} not connected` });
    switch (cached.ch) {
      case 'yt-cmt':
        await replyToComment({ refresh_token: account.refresh_token }, cached.ytCommentId, text);
        break;
      case 'ig-cmt':
        await ig.replyToComment(account.token, cached.igCommentId, text);
        break;
      case 'ig-dm':
        await ig.sendDM(account.token, cached.igRecipientId, text);
        break;
      case 'fb-cmt':
        await fb.replyToComment(account.pageToken, cached.fbCommentId, text);
        break;
      case 'fb-msgr':
        await fb.sendMessenger(account.pageToken, account.pageId, cached.fbRecipientId, text);
        break;
      case 'threads':
        await th.postReply(account.token, cached.threadsReplyId, text);
        break;
      case 'discord':
        await dc.reply(account.botToken, cached.discordChannelId, cached.discordMessageId, text);
        break;
      default: // email
        await sendReply({ refresh_token: account.refresh_token }, {
          to: to || cached.handle,
          subject: cached.subject,
          text,
          threadId: threadId || cached.threadId,
          inReplyTo: cached.messageId
        });
    }
    if (gid) { store.replied.add(gid); db.save('replied', [...store.replied]); }
    res.json({ ok: true });
  } catch (e) {
    console.error('send error', e.message);
    res.status(500).json({ error: 'Send failed: ' + e.message });
  }
});

// ---------- Static site ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Creator Inbox running on http://localhost:${PORT}`);
  const on = [
    hasGoogle && 'Google', hasInstagram && 'Instagram', hasFacebook && 'Facebook', hasThreads && 'Threads'
  ].filter(Boolean).join(', ') || 'none';
  console.log(`OAuth keys configured for: ${on}`);
});
