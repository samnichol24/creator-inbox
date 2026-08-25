import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { authUrl, exchangeCode, listRecentEmails, sendReply, getProfileEmail } from './lib/google.js';
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
  tokens: null,     // Gmail OAuth tokens
  email: null,      // connected gmail address
  tone: { name: 'Sam', samples: '', signoff: '', emojis: '🙌 ✨ 💜 🔥' },
  cache: []         // last fetched emails
};

// ---------- Auth ----------
app.get('/auth/google', (req, res) => {
  if (!hasGoogle) return res.status(400).send('Google keys not set yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your host settings.');
  res.redirect(authUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const tokens = await exchangeCode(req.query.code);
    store.tokens = tokens;
    store.email = await getProfileEmail(tokens);
    req.session.connected = true;
    res.redirect('/?connected=1');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=auth');
  }
});

app.get('/logout', (req, res) => {
  store.tokens = null; store.email = null; store.cache = [];
  req.session.destroy(() => res.redirect('/'));
});

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({ connected: !!store.tokens, email: store.email, hasGoogleKeys: hasGoogle, hasAi: !!process.env.ANTHROPIC_API_KEY });
});

app.post('/api/tone', (req, res) => {
  store.tone = { ...store.tone, ...(req.body || {}) };
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  if (!store.tokens) return res.json([]);
  try {
    const emails = await listRecentEmails(store.tokens, 15);
    // add a draft to each
    for (const e of emails) {
      e.draft = await generateDraft(e, store.tone);
    }
    store.cache = emails;
    res.json(emails);
  } catch (e) {
    console.error('list error', e.message);
    res.status(500).json({ error: 'Could not fetch email. Try reconnecting.' });
  }
});

app.post('/api/send', async (req, res) => {
  if (!store.tokens) return res.status(401).json({ error: 'Not connected' });
  const { gid, threadId, to, text } = req.body || {};
  const cached = store.cache.find(m => m.gid === gid) || {};
  try {
    await sendReply(store.tokens, {
      to: to || cached.handle,
      subject: cached.subject,
      text,
      threadId: threadId || cached.threadId,
      inReplyTo: cached.messageId
    });
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
