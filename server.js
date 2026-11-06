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
  if (req.path === '/privacy') return next(); // public privacy policy (Meta/Google fetch it)
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
  brands: {}, // acctId -> brandId override (e.g. "instagram:178...": "ignite")
  // Persistent analytics so history survives even after messages age out:
  volume: {},    // { 'YYYY-MM-DD': { acctId: { chId: peakCount } } } — messages RECEIVED
  responses: {}  // { 'YYYY-MM-DD': { acctId: { user: { c, d } } } } — replies SENT by each person
};

// Which type each message channel is (comment vs dm), used for stats tallies.
const CH_TYPE = {
  'email': 'd', 'yt-cmt': 'c', 'ig-cmt': 'c', 'ig-dm': 'd',
  'fb-cmt': 'c', 'fb-msgr': 'd', 'threads': 'c', 'discord': 'd'
};
// Turn a relative time label ("2h","5d","12w") into whole days ago.
function relDaysAgo(s) {
  const m = String(s || '').match(/^(\d+)\s*([mhdw])/i);
  if (!m) return 0;
  const n = +m[1], u = m[2].toLowerCase();
  if (u === 'm' || u === 'h') return 0;
  if (u === 'w') return n * 7;
  return n;
}
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Merge this pull's per-day/account/channel counts into the persistent history,
// keeping the PEAK seen for each (a past day's count only shrinks as it ages out
// of the pull window, so max() captures the true total while it was fresh).
function recordVolume(items, todayStr) {
  let base = new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(todayStr || '')) { const [y, m, d] = todayStr.split('-').map(Number); base = new Date(y, m - 1, d); }
  base.setHours(0, 0, 0, 0);
  const cur = {};
  for (const it of items) {
    if (!it.acct || !it.ch) continue;
    const d = new Date(base.getTime()); d.setDate(d.getDate() - relDaysAgo(it.time));
    const dk = ymd(d);
    const acctMap = (cur[dk] = cur[dk] || {});
    const chMap = (acctMap[it.acct] = acctMap[it.acct] || {});
    chMap[it.ch] = (chMap[it.ch] || 0) + 1;
  }
  let changed = false;
  for (const dk in cur) for (const acct in cur[dk]) for (const ch in cur[dk][acct]) {
    const n = cur[dk][acct][ch];
    const prev = ((store.volume[dk] || {})[acct] || {})[ch] || 0;
    if (n > prev) {
      const am = (store.volume[dk] = store.volume[dk] || {});
      (am[acct] = am[acct] || {})[ch] = n;
      changed = true;
    }
  }
  if (changed) {
    const keys = Object.keys(store.volume).sort();            // keep ~200 days
    for (let i = 0; i < keys.length - 200; i++) delete store.volume[keys[i]];
    db.save('volume', store.volume);
  }
}

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
  if (saved.volume && typeof saved.volume === 'object') store.volume = saved.volume;
  if (saved.responses && typeof saved.responses === 'object') store.responses = saved.responses;

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

    // Run every account's fetch CONCURRENTLY (was sequential, which made a full
    // pull take ~80s). Each task returns {arr, platform, account} or null on error.
    const t = (fn, platform, account, label) => (async () => {
      try { return { arr: await fn(), platform, account }; }
      catch (e) { console.error(label + ' error', e.message); return null; }
    })();
    const tasks = [];
    for (const a of store.email)
      tasks.push(t(async () => { const e = await listRecentEmails({ refresh_token: a.refresh_token }, 50); e.forEach(x => x.ch = 'email'); return e; }, 'email', a, 'gmail'));
    for (const a of store.youtube)
      // 365-day window, capped at 2500 recent comments so the scan stays fast.
      tasks.push(t(() => listRecentComments({ refresh_token: a.refresh_token }, 365, 2500), 'youtube', a, 'youtube'));
    for (const a of store.instagram) {
      tasks.push(t(() => ig.listComments(a.token), 'instagram', a, 'ig cmt'));
      tasks.push(t(() => ig.listDMs(a.token), 'instagram', a, 'ig dm'));
    }
    for (const a of store.facebook) {
      tasks.push(t(() => fb.listComments(a.pageToken, a.pageId), 'facebook', a, 'fb cmt'));
      tasks.push(t(() => fb.listMessenger(a.pageToken, a.pageId), 'facebook', a, 'fb msgr'));
    }
    for (const a of store.threads)
      tasks.push(t(() => th.listReplies(a.token), 'threads', a, 'threads'));
    for (const a of store.discord)
      tasks.push(t(() => dc.listMessages(a.botToken), 'discord', a, 'discord'));

    const results = await Promise.all(tasks);
    for (const r of results) if (r) tag(r.arr, r.platform, r.account);

    // ---- Record daily RECEIVED volume (peak per day/account/channel) so the
    // analytics history accumulates and survives messages ageing out. Dates are
    // anchored to the viewer's "today" (passed as ?today=YYYY-MM-DD) so the chart
    // lines up with their local calendar.
    recordVolume(items, req.query.today);

    items = items.filter(it => !store.replied.has(it.gid));
    // NOTE: drafts are generated on the client (instant), not here — pre-drafting
    // thousands of items server-side was slow and (with an AI key) impractical.
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
    recordResponse(req, cached, account, platform);
    res.json({ ok: true });
  } catch (e) {
    console.error('send error', e.message);
    res.status(500).json({ error: 'Send failed: ' + e.message });
  }
});

// Log one sent reply against the person who sent it (Sam / Kim), the account,
// the type (comment/dm) and the day — so the Activity page can show who answered
// how many, per platform/account, without anyone tallying by hand.
function recordResponse(req, cached, account, platform) {
  try {
    const user = req.session?.user || cookieUser(req) || 'someone';
    const dk = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.localDate || '') ? req.body.localDate : ymd(new Date());
    const acct = cached.acct || (account ? acctId(platform, account) : platform + ':?');
    const type = CH_TYPE[cached.ch] === 'd' ? 'd' : 'c';
    const day = (store.responses[dk] = store.responses[dk] || {});
    const ac = (day[acct] = day[acct] || {});
    const u = (ac[user] = ac[user] || { c: 0, d: 0 });
    u[type]++;
    // keep ~200 days
    const keys = Object.keys(store.responses).sort();
    for (let i = 0; i < keys.length - 200; i++) delete store.responses[keys[i]];
    db.save('responses', store.responses);
  } catch (e) { console.error('recordResponse', e.message); }
}

// Stats for the Analytics + Activity pages: accumulated received volume and the
// per-person response log. Returns the accounts too (label/brand) so the client
// can show friendly names.
app.get('/api/stats', (req, res) => {
  const accounts = {};
  for (const platform of ['email', 'youtube', 'instagram', 'facebook', 'threads', 'discord'])
    for (const a of store[platform])
      accounts[acctId(platform, a)] = { label: LABEL[platform](a), brand: brandOf(platform, a), platform };
  res.json({ volume: store.volume, responses: store.responses, accounts, brands: BRANDS });
});

// ---------- Privacy policy (required to publish the Meta/Google apps) ----------
app.get('/privacy', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Creator Inbox — Privacy Policy</title>
<style>body{max-width:720px;margin:40px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1a1a1a}h1{font-size:24px}h2{font-size:17px;margin-top:28px}p,li{font-size:15px}.muted{color:#666;font-size:13px}</style>
</head><body>
<h1>Creator Inbox — Privacy Policy</h1>
<p class="muted">Last updated: November 2026</p>
<p>Creator Inbox is a private tool that the account owner uses to read and reply to messages and comments on their own connected accounts (email, YouTube, Instagram, Facebook, Threads, and Discord), all in one place.</p>
<h2>What we access</h2>
<p>When you connect an account, Creator Inbox accesses only what is needed to show your incoming messages and comments and to send replies you approve: the messages, comments, and the names/handles of the people who sent them, along with basic profile information for the connected account itself.</p>
<h2>How we use it</h2>
<p>This information is used solely to display your inbox and to send the replies you approve. It is not sold, rented, or shared with third parties, and it is not used for advertising.</p>
<h2>Storage</h2>
<p>Connection tokens and settings are stored privately for the account owner so the inbox keeps working between sessions. Message content is fetched on demand to display your inbox and is not retained beyond what is needed to operate the tool.</p>
<h2>Data deletion</h2>
<p>You can disconnect any account at any time from the Connections screen, which removes its stored access token. To request deletion of all stored data, contact the address below.</p>
<h2>Contact</h2>
<p>Questions or deletion requests: <a href="mailto:samnicholson2@gmail.com">samnicholson2@gmail.com</a>.</p>
</body></html>`);
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
