// Discord — read and reply to messages on the creator's OWN server(s),
// via Discord's REST API with a bot token. No OAuth code flow and no persistent
// gateway connection: the creator creates a bot, adds it to their server, and
// pastes the bot token. We discover the bot's servers + text channels and poll
// recent messages, then reply as the bot.
//
// The bot needs the "Message Content" privileged intent toggled ON in the
// Developer Portal, or message text comes back empty. Under 100 servers this
// needs no verification.
import { timeAgo, httpJson } from './util.js';

const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://creator-inbox.onrender.com, 1.0)';

function headers(botToken) {
  return {
    Authorization: `Bot ${botToken}`,
    'User-Agent': UA,
    'content-type': 'application/json'
  };
}

// Convenience: the invite URL the creator clicks to add their bot to a server.
// Permissions = View Channel + Send Messages + Read Message History (68608).
export function inviteUrl(appId) {
  const p = new URLSearchParams({
    client_id: appId || process.env.DISCORD_APP_ID || '',
    scope: 'bot',
    permissions: '68608'
  });
  return `https://discord.com/oauth2/authorize?${p.toString()}`;
}

export async function getBotUser(botToken) {
  return httpJson(`${API}/users/@me`, { headers: headers(botToken) });
}

// Poll recent messages across the bot's servers' text channels.
export async function listMessages(botToken, { maxChannels = 20, perChannel = 25, days = 14 } = {}) {
  const meId = (await getBotUser(botToken)).id;
  const guilds = await httpJson(`${API}/users/@me/guilds`, { headers: headers(botToken) });
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  let scanned = 0;
  for (const g of (guilds || [])) {
    let channels;
    try {
      channels = await httpJson(`${API}/guilds/${g.id}/channels`, { headers: headers(botToken) });
    } catch { continue; }
    const textChannels = (channels || []).filter(c => c.type === 0 || c.type === 5);
    for (const ch of textChannels) {
      if (scanned >= maxChannels) break;
      scanned++;
      let msgs;
      try {
        msgs = await httpJson(`${API}/channels/${ch.id}/messages?limit=${perChannel}`, { headers: headers(botToken) });
      } catch { continue; } // no access to this channel — skip
      for (const m of (msgs || [])) {
        if (m.author?.id === meId) continue;   // skip our own messages
        if (m.author?.bot) continue;           // skip other bots
        if (!m.content) continue;              // nothing to reply to (or intent off)
        const ts = new Date(m.timestamp).getTime();
        if (ts < cutoff) continue;
        out.push({
          gid: 'dc_' + m.id,
          ch: 'discord',
          discordChannelId: ch.id,
          discordMessageId: m.id,
          name: m.author?.global_name || m.author?.username || 'Discord user',
          handle: m.author?.username ? '@' + m.author.username : '',
          text: m.content,
          time: timeAgo(ts),
          _channel: '#' + (ch.name || 'channel') + ' · ' + (g.name || 'server')
        });
      }
    }
    if (scanned >= maxChannels) break;
  }
  return out;
}

// Reply as a threaded reply to the original message.
export async function reply(botToken, channelId, messageId, text) {
  await httpJson(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: headers(botToken),
    body: JSON.stringify({
      content: text,
      message_reference: { message_id: messageId, fail_if_not_exists: false }
    })
  });
  return true;
}
