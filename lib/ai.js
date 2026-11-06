// Draft generation. Uses Anthropic if a key is present, otherwise a short templated
// fallback so the app still works with zero AI keys.

const GENERIC = new Set(['instagram user', 'facebook user', 'youtube viewer', 'messenger',
  'instagram dm', 'instagram', 'facebook', 'threads', 'discord', 'unknown', '']);

export async function generateDraft(msg, tone = {}) {
  const name = (msg.name || '').trim();
  const first = GENERIC.has(name.toLowerCase()) ? '' : (name.split(/[\s(]/)[0] || '');
  const signoff = tone.signoff && tone.signoff.trim() ? '\n\n' + tone.signoff.trim() : '';

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const bits = [];
      if (tone.samples && tone.samples.trim())
        bits.push(`Here is EXACTLY how ${tone.name || 'I'} write(s) — mirror this voice, slang, punctuation, capitalization AND length very closely:\n${tone.samples.trim()}`);
      if (tone.shortcuts && tone.shortcuts.trim())
        bits.push(`Go-to replies / text shortcuts I reuse (lean on these):\n${tone.shortcuts.trim()}`);
      if (tone.phrases && tone.phrases.trim())
        bits.push(`Signature words/phrases I use: ${tone.phrases.trim()}`);
      if (tone.emojis && tone.emojis.trim())
        bits.push(`The only emojis I use (sparingly, 0–1 per reply): ${tone.emojis.trim()}`);

      const isDm = msg.ch && String(msg.ch).includes('dm');
      const sys =
        `You write replies that ${tone.name || 'the creator'} sends to fans who leave comments or DMs. ` +
        `Output ONLY the reply text — no greeting line unless it's natural, no "Dear", no sign-off, no quotation marks, no explanation. ` +
        `Keep it VERY short: usually a single line, at most two short sentences — a quick, casual, human reply, NEVER a paragraph. ` +
        `Match the examples' brevity and vibe above all. ` +
        (first ? `You may address them as "${first}" only if it feels natural.` : `Do NOT invent, guess, or use their name.`) +
        (bits.length ? `\n\n${bits.join('\n\n')}` : '');
      const user = `The ${isDm ? 'DM' : 'comment'} says:\n"${(msg.text || '').slice(0, 600)}"\n\nWrite my short reply.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
          max_tokens: 160, // keeps replies short
          system: sys,
          messages: [{ role: 'user', content: user }]
        })
      });
      const data = await res.json();
      let text = data?.content?.[0]?.text?.trim();
      if (text) {
        text = text.replace(/^["']+|["']+$/g, '').trim();
        return text + signoff;
      }
    } catch (e) {
      console.error('AI draft failed, using fallback:', e.message);
    }
  }

  // Zero-key fallback — short and name-safe.
  const hi = first ? `${first}, ` : '';
  return `${hi}thank you so much — really appreciate this!${signoff}`.trim();
}
