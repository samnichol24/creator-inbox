// Google OAuth + Gmail read/send. Single-user personal tool.
import { google } from 'googleapis';

// Email account uses Gmail scopes; YouTube account uses the YouTube scope.
// They can be two different Google accounts, connected separately.
const EMAIL_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];
const YT_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

export function oauthClient() {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${base}/auth/google/callback`
  );
}

export function authUrl(kind = 'email') {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: kind === 'youtube' ? YT_SCOPES : EMAIL_SCOPES,
    state: kind
  });
}

export async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

function clientFromTokens(tokens) {
  const client = oauthClient();
  client.setCredentials(tokens);
  return client;
}

function decodeBody(payload) {
  // find text/plain, else text/html, else snippet
  function walk(part) {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    if (part.parts) {
      for (const p of part.parts) {
        const t = walk(p);
        if (t) return t;
      }
    }
    return '';
  }
  return walk(payload);
}

function header(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function timeAgo(ms) {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

// list recent inbox emails, newest first. Pages through the inbox up to `max`.
export async function listRecentEmails(tokens, max = 50) {
  const gmail = google.gmail({ version: 'v1', auth: clientFromTokens(tokens) });
  const q = 'in:inbox newer_than:60d -from:noreply -from:no-reply -from:donotreply -from:do-not-reply -from:mailer-daemon -from:postmaster -from:notifications -from:notification -subject:dmarc -subject:"report domain"';
  // collect message ids, paging until we have `max` (Gmail returns 100/page max)
  const ids = [];
  let pageToken;
  while (ids.length < max) {
    const list = await gmail.users.messages.list({
      userId: 'me', q, maxResults: Math.min(100, max - ids.length), pageToken
    });
    (list.data.messages || []).forEach(m => ids.push(m.id));
    pageToken = list.data.nextPageToken;
    if (!pageToken) break;
  }
  // fetch each message's full content in parallel (keeps large pulls fast)
  const msgs = await Promise.all(ids.map(id =>
    gmail.users.messages.get({ userId: 'me', id, format: 'full' }).then(r => r.data).catch(() => null)
  ));
  const out = [];
  for (const data of msgs) {
    if (!data) continue;
    const headers = data.payload?.headers;
    const from = header(headers, 'From');
    const nameMatch = from.match(/^\s*"?([^"<]*?)"?\s*</);
    const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
    const name = (nameMatch && nameMatch[1].trim()) || (emailMatch && emailMatch[1]) || from || 'Unknown';
    const handle = (emailMatch && emailMatch[1]) || from;
    const subject = header(headers, 'Subject');
    let body = decodeBody(data.payload) || data.snippet || '';
    body = body.replace(/\r/g, '').split(/\n\s*\n(?:On .* wrote:|>{1,})/)[0].trim().slice(0, 4000);
    out.push({
      gid: data.id,
      threadId: data.threadId,
      name,
      handle,
      subject,
      messageId: header(headers, 'Message-ID'),
      text: subject ? `${subject}\n\n${body}` : body,
      time: timeAgo(parseInt(data.internalDate, 10))
    });
  }
  return out;
}

// send a reply in the same thread
export async function sendReply(tokens, { to, subject, text, threadId, inReplyTo }) {
  const gmail = google.gmail({ version: 'v1', auth: clientFromTokens(tokens) });
  const subj = subject && !/^re:/i.test(subject) ? `Re: ${subject}` : (subject || 'Re:');
  const lines = [
    `To: ${to}`,
    `Subject: ${subj}`,
    'Content-Type: text/plain; charset="UTF-8"'
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  const raw = Buffer.from(lines.join('\r\n') + '\r\n\r\n' + text)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId }
  });
  return true;
}

export async function getProfileEmail(tokens) {
  const oauth2 = google.oauth2({ version: 'v2', auth: clientFromTokens(tokens) });
  const me = await oauth2.userinfo.get();
  return me.data.email;
}

// ---------- YouTube comments ----------
// Pulls ALL comments across the channel from the last `days` days (no count limit),
// newest first. hardCap is just a runaway safety backstop.
export async function listRecentComments(tokens, days = 90, hardCap = 8000) {
  const yt = google.youtube({ version: 'v3', auth: clientFromTokens(tokens) });
  const ch = await yt.channels.list({ part: 'id', mine: true });
  const channelId = ch.data.items?.[0]?.id;
  if (!channelId) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  let pageToken;
  while (out.length < hardCap) {
    const res = await yt.commentThreads.list({
      part: 'snippet,replies',
      allThreadsRelatedToChannelId: channelId,
      order: 'time',
      maxResults: 100, // API caps at 100/page; we page through as needed
      textFormat: 'plainText',
      pageToken
    });
    let inWindow = 0;
    for (const t of (res.data.items || [])) {
      const c = t.snippet?.topLevelComment;
      const s = c?.snippet;
      if (!s) continue;
      const published = new Date(s.publishedAt).getTime();
      if (published < cutoff) continue; // older than window; keep scanning the page
      inWindow++;
      if (s.authorChannelId?.value === channelId) continue; // skip your own comments
      // skip comments we've already replied to (our reply shows in the thread)
      const weReplied = (t.replies?.comments || []).some(rc => rc.snippet?.authorChannelId?.value === channelId);
      if (weReplied) continue;
      out.push({
        gid: 'yt_' + c.id,
        ytCommentId: c.id,
        ch: 'yt-cmt',
        name: s.authorDisplayName || 'YouTube viewer',
        handle: s.authorDisplayName || '',
        authorChannelId: s.authorChannelId?.value || '',
        text: s.textDisplay || '',
        time: timeAgo(published)
      });
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
    if (inWindow === 0) break; // an entire page fell outside the window → past 90 days
  }
  return out;
}

// name of the connected YouTube channel (for showing which account is linked)
export async function getChannelTitle(tokens) {
  const yt = google.youtube({ version: 'v3', auth: clientFromTokens(tokens) });
  const ch = await yt.channels.list({ part: 'snippet', mine: true });
  return ch.data.items?.[0]?.snippet?.title || 'YouTube';
}

export async function replyToComment(tokens, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth: clientFromTokens(tokens) });
  await yt.comments.insert({
    part: 'snippet',
    requestBody: { snippet: { parentId, textOriginal: text } }
  });
  return true;
}
