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
const hasThreads = !!(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);

app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, secure: 'auto', sameSite: 'lax' }
}));

// --- in-memory store, backed by the database (see initStore) ---
const store = {
  tokens: null, email: null,          // Gmail (email account)
  ytTokens: null, ytName: null,       // YouTube (may be a different Google account)
  igToken: null, igUser: null, igId: null,          // Instagram
  fbToken: null, fbPageId: null, fbPageName: null,  // Facebook Page
  thToken: null, thUser: null, thId: null,          // Threads
  dcToken: null, dcName: null,        // Discord bot
  tone: { name: 'Sam', samples: '', signoff: '', emojis: '🙌 ✨ 💜 🔥' },
  cache: [],
  replied: new Set()
};

// --- Load everything from the database on boot, falling back to env vars ---
// The database is the source of truth. For backward compatibility, any token
// still only in an env var is loaded AND migrated into the database, so after
// the first boot nothing depends on env vars for tokens anymore.
async function initStore() {
  let saved = {};
  if (db.enabled()) {
    try { saved = await db.loadAll(); }
    catch (e) { console.error('db load failed, using env vars:', e.message); }
  }
  // Prefer the DB value; else take the env value and migrate it into the DB.
  async function pick(key, fromDb, fromEnv) {
    if (fromDb) return fromDb;
    if (fromEnv) { await db.save(key, fromEnv); return fromEnv; }
    return null;
  }

  const g = await pick('google_email', saved.google_email,
    process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN, email: process.env.CONNECTED_EMAIL || 'connected' } : null);
  if (g?.refresh_token) { store.tokens = { refresh_token: g.refresh_token }; store.email = g.email || 'connected'; }

  const yt = await pick('google_youtube', saved.google_youtube,
    process.env.YOUTUBE_REFRESH_TOKEN ? { refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, channel: process.env.YOUTUBE_CHANNEL || 'YouTube' } : null);
  if (yt?.refresh_token) { store.ytTokens = { refresh_token: yt.refresh_token }; store.ytName = yt.channel || 'YouTube'; }

  const i = await pick('instagram', saved.instagram,
    process.env.INSTAGRAM_ACCESS_TOKEN ? { token: process.env.INSTAGRAM_ACCESS_TOKEN, userId: process.env.INSTAGRAM_USER_ID || null, username: process.env.INSTAGRAM_USER || 'Instagram' } : null);
  if (i?.token) { store.igToken = i.token; store.igId = i.userId; store.igUser = i.username; }

  const f = await pick('facebook', saved.facebook,
    process.env.FACEBOOK_PAGE_TOKEN ? { pageToken: process.env.FACEBOOK_PAGE_TOKEN, pageId: process.env.FACEBOOK_PAGE_ID || null, pageName: process.env.FACEBOOK_PAGE_NAME || 'Facebook Page' } : null);
  if (f?.pageToken) { store.fbToken = f.pageToken; store.fbPageId = f.pageId; store.fbPageName = f.pageName; }

  const t = await pick('threads', saved.threads,
    process.env.THREADS_ACCESS_TOKEN ? { token: process.env.THREADS_ACCESS_TOKEN, userId: process.env.THREADS_USER_ID || null, username: process.env.THREADS_USER || 'Threads' } : null);
  if (t?.token) { store.thToken = t.token; store.thId = t.userId; store.thUser = t.username; }

  const d = await pick('discord', saved.discord,
    process.env.DISCORD_BOT_TOKEN ? { botToken: process.env.DISCORD_BOT_TOKEN, name: process.env.DISCORD_BOT_NAME || 'Discord' } : null);
  if (d?.botToken) { store.dcToken = d.botToken; store.dcName = d.name; }

  if (saved.tone) store.tone = { ...store.tone, ...saved.tone };
  if (Array.isArray(saved.replied)) store.replied = new Set(saved.replied);

  // Roll the 60-day Instagram/Threads tokens forward and persist the new ones.
  try { if (store.igToken) { store.igToken = await ig.refreshToken(store.igToken); await db.save('instagram', { token: store.igToken, userId: store.igId, username: store.igUser }); } } catch {}
  try { if (store.thToken) { store.thToken = await th.refreshToken(store.thToken); await db.save('threads', { token: store.thToken, userId: store.thId, username: store.thUser }); } } catch {}

  console.log('Store initialized' + (db.enabled() ? ' (database connected)' : ' (no database — using env vars only)'));
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
      store.ytTokens = tokens;
      try { store.ytName = await getChannelTitle(tokens); } catch (e) { store.ytName = 'YouTube'; }
      if (tokens.refresh_token) await db.save('google_youtube', { refresh_token: tokens.refresh_token, channel: store.ytName });
      return res.redirect('/?connected=youtube');
    }
    store.tokens = tokens;
    store.email = await getProfileEmail(tokens);
    req.session.connected = true;
    if (tokens.refresh_token) await db.save('google_email', { refresh_token: tokens.refresh_token, email: store.email });
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
    store.igToken = token; store.igId = userId; store.igUser = username;
    await db.save('instagram', { token, userId, username });
    res.redirect('/?connected=instagram');
  } catch (e) { console.error('ig auth', e.message); res.redirect('/?error=instagram'); }
});

// ---------- Auth: Facebook ----------
app.get('/auth/facebook', (req, res) => {
  if (!hasFacebook) return res.status(400).send('Facebook keys not set yet. Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in your host settings.');
  res.redirect(fb.authUrl());
});
app.get('/auth/facebook/callback', async (req, res) => {
  try {
    const { pageId, pageName, pageToken } = await fb.exchangeCode(req.query.code);
    store.fbToken = pageToken; store.fbPageId = pageId; store.fbPageName = pageName;
    await db.save('facebook', { pageToken, pageId, pageName });
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
    store.thToken = token; store.thId = userId; store.thUser = username;
    await db.save('threads', { token, userId, username });
    res.redirect('/?connected=threads');
  } catch (e) { console.error('threads auth', e.message); res.redirect('/?error=threads'); }
});

// ---------- Discord: no OAuth code flow — just a bot token. Help invite the bot. ----------
app.get('/auth/discord', (req, res) => {
  res.redirect(dc.inviteUrl(process.env.DISCORD_APP_ID));
});

app.get('/logout', (req, res) => {
  store.tokens = null; store.email = null;
  store.ytTokens = null; store.ytName = null;
  store.cache = [];
  req.session.destroy(() => res.redirect('/'));
});

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!store.tokens, email: store.email,
    ytConnected: !!store.ytTokens, ytName: store.ytName,
    igConnected: !!store.igToken, igUser: store.igUser,
    fbConnected: !!store.fbToken, fbPageName: store.fbPageName,
    thConnected: !!store.thToken, thUser: store.thUser,
    dcConnected: !!store.dcToken, dcName: store.dcName,
    hasGoogleKeys: hasGoogle, hasInstagramKeys: hasInstagram,
    hasFacebookKeys: hasFacebook, hasThreadsKeys: hasThreads,
    hasDb: db.enabled(), hasAi: !!process.env.ANTHROPIC_API_KEY
  });
});

app.post('/api/tone', (req, res) => {
  store.tone = { ...store.tone, ...(req.body || {}) };
  db.save('tone', store.tone);
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  const anyConnected = store.tokens || store.ytTokens || store.igToken || store.fbToken || store.thToken || store.dcToken;
  if (!anyConnected) return res.json([]);
  try {
    let items = [];
    const add = (arr) => { if (Array.isArray(arr)) items = items.concat(arr); };

    if (store.tokens) {
      try { const e = await listRecentEmails(store.tokens, 50); e.forEach(x => x.ch = 'email'); add(e); }
      catch (e) { console.error('gmail error', e.message); }
    }
    if (store.ytTokens) {
      try { add(await listRecentComments(store.ytTokens, 90)); }
      catch (e) { console.error('youtube error', e.message); }
    }
    if (store.igToken) {
      try { add(await ig.listComments(store.igToken)); } catch (e) { console.error('ig cmt error', e.message); }
      try { add(await ig.listDMs(store.igToken)); } catch (e) { console.error('ig dm error', e.message); }
    }
    if (store.fbToken && store.fbPageId) {
      try { add(await fb.listComments(store.fbToken, store.fbPageId)); } catch (e) { console.error('fb cmt error', e.message); }
      try { add(await fb.listMessenger(store.fbToken, store.fbPageId)); } catch (e) { console.error('fb msgr error', e.message); }
    }
    if (store.thToken) {
      try { add(await th.listReplies(store.thToken)); } catch (e) { console.error('threads error', e.message); }
    }
    if (store.dcToken) {
      try { add(await dc.listMessages(store.dcToken)); } catch (e) { console.error('discord error', e.message); }
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
  try {
    switch (cached.ch) {
      case 'yt-cmt':
        if (!store.ytTokens) return res.status(401).json({ error: 'YouTube not connected' });
        await replyToComment(store.ytTokens, cached.ytCommentId, text);
        break;
      case 'ig-cmt':
        if (!store.igToken) return res.status(401).json({ error: 'Instagram not connected' });
        await ig.replyToComment(store.igToken, cached.igCommentId, text);
        break;
      case 'ig-dm':
        if (!store.igToken) return res.status(401).json({ error: 'Instagram not connected' });
        await ig.sendDM(store.igToken, cached.igRecipientId, text);
        break;
      case 'fb-cmt':
        if (!store.fbToken) return res.status(401).json({ error: 'Facebook not connected' });
        await fb.replyToComment(store.fbToken, cached.fbCommentId, text);
        break;
      case 'fb-msgr':
        if (!store.fbToken) return res.status(401).json({ error: 'Facebook not connected' });
        await fb.sendMessenger(store.fbToken, store.fbPageId, cached.fbRecipientId, text);
        break;
      case 'threads':
        if (!store.thToken) return res.status(401).json({ error: 'Threads not connected' });
        await th.postReply(store.thToken, cached.threadsReplyId, text);
        break;
      case 'discord':
        if (!store.dcToken) return res.status(401).json({ error: 'Discord not connected' });
        await dc.reply(store.dcToken, cached.discordChannelId, cached.discordMessageId, text);
        break;
      default:
        if (!store.tokens) return res.status(401).json({ error: 'Email not connected' });
        await sendReply(store.tokens, {
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
