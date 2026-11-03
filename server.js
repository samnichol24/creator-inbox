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
import { generateDraft } from './lib/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Which platforms have their app keys configured (so the Connect button can work).
const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const hasInstagram = !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
const hasFacebook = !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
const hasThreads = !!(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);

app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, secure: 'auto', sameSite: 'lax' }
}));

// --- simple in-memory store (fine for a personal MVP; swap for a DB later) ---
const store = {
  tokens: null,     // Gmail OAuth tokens (email account)
  email: null,      // connected gmail address
  ytTokens: null,   // YouTube OAuth tokens (may be a different Google account)
  ytName: null,     // connected YouTube channel name
  // Instagram (own professional account)
  igToken: null, igUser: null, igId: null,
  // Facebook Page
  fbToken: null, fbPageId: null, fbPageName: null,
  // Threads (separate Meta app/token)
  thToken: null, thUser: null, thId: null,
  // Discord bot
  dcToken: null, dcName: null,
  tone: { name: 'Sam', samples: '', signoff: '', emojis: '🙌 ✨ 💜 🔥' },
  cache: [],         // last fetched messages
  replied: new Set() // gids we've already replied to (drop them from the list)
};

// --- Permanent connections from saved env vars (survive restarts/sleep) ---
if (process.env.GOOGLE_REFRESH_TOKEN) {
  store.tokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  store.email = process.env.CONNECTED_EMAIL || 'connected';
}
if (process.env.YOUTUBE_REFRESH_TOKEN) {
  store.ytTokens = { refresh_token: process.env.YOUTUBE_REFRESH_TOKEN };
  store.ytName = process.env.YOUTUBE_CHANNEL || 'YouTube';
}
if (process.env.INSTAGRAM_ACCESS_TOKEN) {
  store.igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  store.igUser = process.env.INSTAGRAM_USER || 'Instagram';
  store.igId = process.env.INSTAGRAM_USER_ID || null;
}
if (process.env.FACEBOOK_PAGE_TOKEN) {
  store.fbToken = process.env.FACEBOOK_PAGE_TOKEN;
  store.fbPageId = process.env.FACEBOOK_PAGE_ID || null;
  store.fbPageName = process.env.FACEBOOK_PAGE_NAME || 'Facebook Page';
}
if (process.env.THREADS_ACCESS_TOKEN) {
  store.thToken = process.env.THREADS_ACCESS_TOKEN;
  store.thUser = process.env.THREADS_USER || 'Threads';
  store.thId = process.env.THREADS_USER_ID || null;
}
if (process.env.DISCORD_BOT_TOKEN) {
  store.dcToken = process.env.DISCORD_BOT_TOKEN;
  store.dcName = process.env.DISCORD_BOT_NAME || 'Discord';
}

// Best-effort: extend the 60-day IG/Threads tokens on boot so they keep rolling.
(async () => {
  try { if (store.igToken) store.igToken = await ig.refreshToken(store.igToken); } catch {}
  try { if (store.thToken) store.thToken = await th.refreshToken(store.thToken); } catch {}
})();

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
      if (tokens.refresh_token) console.log('SAVE_THIS_YOUTUBE_REFRESH_TOKEN=' + tokens.refresh_token);
      return res.redirect('/?connected=youtube');
    }
    store.tokens = tokens;
    store.email = await getProfileEmail(tokens);
    req.session.connected = true;
    if (tokens.refresh_token) console.log('SAVE_THIS_REFRESH_TOKEN=' + tokens.refresh_token);
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
    console.log('SAVE_THIS_INSTAGRAM_ACCESS_TOKEN=' + token);
    console.log('SAVE_THIS_INSTAGRAM_USER_ID=' + userId);
    console.log('SAVE_THIS_INSTAGRAM_USER=' + username);
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
    console.log('SAVE_THIS_FACEBOOK_PAGE_TOKEN=' + pageToken);
    console.log('SAVE_THIS_FACEBOOK_PAGE_ID=' + pageId);
    console.log('SAVE_THIS_FACEBOOK_PAGE_NAME=' + pageName);
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
    console.log('SAVE_THIS_THREADS_ACCESS_TOKEN=' + token);
    console.log('SAVE_THIS_THREADS_USER_ID=' + userId);
    console.log('SAVE_THIS_THREADS_USER=' + username);
    res.redirect('/?connected=threads');
  } catch (e) { console.error('threads auth', e.message); res.redirect('/?error=threads'); }
});

// ---------- Discord: no OAuth code flow — just a bot token. Help invite the bot. ----------
app.get('/auth/discord', (req, res) => {
  // Sends the creator to Discord to add their bot to a server. The bot token
  // itself is pasted into env vars (DISCORD_BOT_TOKEN) — it can't be captured here.
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
    hasAi: !!process.env.ANTHROPIC_API_KEY
  });
});

app.post('/api/tone', (req, res) => {
  store.tone = { ...store.tone, ...(req.body || {}) };
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  const anyConnected = store.tokens || store.ytTokens || store.igToken || store.fbToken || store.thToken || store.dcToken;
  if (!anyConnected) return res.json([]);
  try {
    let items = [];
    const add = (arr) => { if (Array.isArray(arr)) items = items.concat(arr); };

    // Each platform is isolated so one failure never blocks the others.
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

    // drop anything already replied to, so sent items leave the list and new ones surface
    items = items.filter(it => !store.replied.has(it.gid));
    // draft a reply for each
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
        // email
        if (!store.tokens) return res.status(401).json({ error: 'Email not connected' });
        await sendReply(store.tokens, {
          to: to || cached.handle,
          subject: cached.subject,
          text,
          threadId: threadId || cached.threadId,
          inReplyTo: cached.messageId
        });
    }
    if (gid) store.replied.add(gid);
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
