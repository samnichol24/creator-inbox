import 'dotenv/config';
import express from 'express';
import session from 'express-session';
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
  replied: new Set()
};

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
  req.session.destroy(() => res.redirect('/'));
});

// ---------- API ----------
// Status reports, per platform, the list of connected accounts (label + id) so
// the UI can show them and offer "add another". Legacy booleans/names are kept
// so the existing front-end keeps working unchanged.
function accountList(platform) {
  return store[platform].map(a => ({ id: acctId(platform, a), label: LABEL[platform](a) }));
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
      for (const it of arr) { it.acct = id; it.acctLabel = label; items.push(it); }
    };

    for (const a of store.email) {
      try { const e = await listRecentEmails({ refresh_token: a.refresh_token }, 50); e.forEach(x => x.ch = 'email'); tag(e, 'email', a); }
      catch (e) { console.error('gmail error', a.email, e.message); }
    }
    for (const a of store.youtube) {
      try { tag(await listRecentComments({ refresh_token: a.refresh_token }, 90), 'youtube', a); }
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
