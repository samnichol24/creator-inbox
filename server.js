import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { authUrl, exchangeCode, listRecentEmails, sendReply, getProfileEmail, listRecentComments, replyToComment, getChannelTitle } from './lib/google.js';
import { generateDraft } from './lib/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

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
  tokens: null,     // Gmail OAuth tokens (email account, e.g. sam-nicholson.com)
  email: null,      // connected gmail address
  ytTokens: null,   // YouTube OAuth tokens (can be a DIFFERENT Google account)
  ytName: null,     // connected YouTube channel name
  tone: { name: 'Sam', samples: '', signoff: '', emojis: '🙌 ✨ 💜 🔥' },
  cache: []         // last fetched messages
};

// Permanent connection: if saved refresh tokens are present, we're always connected —
// survives the server sleeping or restarting, no need to reconnect each time.
// Email and YouTube are independent, so each has its own saved token.
if (process.env.GOOGLE_REFRESH_TOKEN) {
  store.tokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  store.email = process.env.CONNECTED_EMAIL || 'connected';
}
if (process.env.YOUTUBE_REFRESH_TOKEN) {
  store.ytTokens = { refresh_token: process.env.YOUTUBE_REFRESH_TOKEN };
  store.ytName = process.env.YOUTUBE_CHANNEL || 'YouTube';
}

// ---------- Auth ----------
app.get('/auth/google', (req, res) => {
  if (!hasGoogle) return res.status(400).send('Google keys not set yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your host settings.');
  res.redirect(authUrl('email'));
});

// separate sign-in for the YouTube account (can be a different Google login than email)
app.get('/auth/google/youtube', (req, res) => {
  if (!hasGoogle) return res.status(400).send('Google keys not set yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your host settings.');
  res.redirect(authUrl('youtube'));
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await exchangeCode(req.query.code);
    if (req.query.state === 'youtube') {
      // YouTube account
      store.ytTokens = tokens;
      try { store.ytName = await getChannelTitle(tokens); } catch (e) { store.ytName = 'YouTube'; }
      // print the refresh token once so it can be saved as YOUTUBE_REFRESH_TOKEN for a permanent connection
      if (tokens.refresh_token) console.log('SAVE_THIS_YOUTUBE_REFRESH_TOKEN=' + tokens.refresh_token);
      return res.redirect('/?connected=youtube');
    }
    // Email account
    store.tokens = tokens;
    store.email = await getProfileEmail(tokens);
    req.session.connected = true;
    // print the refresh token once so it can be saved as GOOGLE_REFRESH_TOKEN for a permanent connection
    if (tokens.refresh_token) console.log('SAVE_THIS_REFRESH_TOKEN=' + tokens.refresh_token);
    res.redirect('/?connected=1');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth');
  }
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
    hasGoogleKeys: hasGoogle, hasAi: !!process.env.ANTHROPIC_API_KEY
  });
});

app.post('/api/tone', (req, res) => {
  store.tone = { ...store.tone, ...(req.body || {}) };
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  if (!store.tokens && !store.ytTokens) return res.json([]);
  try {
    let items = [];
    // Email (Gmail) — email account
    if (store.tokens) {
      try {
        const emails = await listRecentEmails(store.tokens, 50);
        emails.forEach(e => { e.ch = 'email'; });
        items = items.concat(emails);
      } catch (e) { console.error('gmail error', e.message); }
    }
    // YouTube comments — YouTube account (may be a different Google login)
    if (store.ytTokens) {
      try {
        const yt = await listRecentComments(store.ytTokens, 90); // all comments from last 90 days
        items = items.concat(yt);
      } catch (e) { console.error('youtube error', e.message); }
    }
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
    if (cached.ch === 'yt-cmt') {
      // reply to a YouTube comment (YouTube account)
      if (!store.ytTokens) return res.status(401).json({ error: 'YouTube not connected' });
      await replyToComment(store.ytTokens, cached.ytCommentId, text);
    } else {
      // reply to an email (email account)
      if (!store.tokens) return res.status(401).json({ error: 'Email not connected' });
      await sendReply(store.tokens, {
        to: to || cached.handle,
        subject: cached.subject,
        text,
        threadId: threadId || cached.threadId,
        inReplyTo: cached.messageId
      });
    }
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
  console.log(`Google connected sign-in: ${hasGoogle ? 'ENABLED' : 'NOT SET (add keys to enable Gmail)'}`);
});
