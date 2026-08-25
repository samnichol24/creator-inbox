// Google OAuth + Gmail read/send. Single-user personal tool.
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];

export function oauthClient() {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${base}/auth/google/callback`
  );
}

export function authUrl() {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
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

// list recent inbox emails (last 7 days), newest first
export async function listRecentEmails(tokens, max = 15) {
  const gmail = google.gmail({ version: 'v1', auth: clientFromTokens(tokens) });
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox newer_than:7d -category:promotions -category:social',
    maxResults: max
  });
  const ids = (list.data.messages || []).map(m => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = msg.data.payload?.headers;
    const from = header(headers, 'From');
    const nameMatch = from.match(/^\s*"?([^"<]*?)"?\s*</);
    const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
    const name = (nameMatch && nameMatch[1].trim()) || (emailMatch && emailMatch[1]) || from || 'Unknown';
    const handle = (emailMatch && emailMatch[1]) || from;
    const subject = header(headers, 'Subject');
    let body = decodeBody(msg.data.payload) || msg.data.snippet || '';
    body = body.replace(/\r/g, '').split(/\n\s*\n(?:On .* wrote:|>{1,})/)[0].trim().slice(0, 1200);
    out.push({
      gid: id,
      threadId: msg.data.threadId,
      name,
      handle,
      subject,
      messageId: header(headers, 'Message-ID'),
      text: subject ? `${subject}\n\n${body}` : body,
      time: timeAgo(parseInt(msg.data.internalDate, 10))
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
