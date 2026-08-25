// Draft generation. Uses Anthropic if a key is present, otherwise a clean templated fallback
// so the app still works with zero AI keys (great for testing tonight).

export async function generateDraft(email, tone = {}) {
  const first = (email.name || 'there').split(/[\s(]/)[0] || 'there';
  const signoff = tone.signoff ? `\n\n${tone.signoff}` : '';
  const samples = tone.samples ? `\n\nHere are examples of how I write, match this voice:\n${tone.samples}` : '';
  const emojis = tone.emojis ? `\nEmojis I use: ${tone.emojis}` : '';

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const sys = `You are drafting a short, warm reply that ${tone.name || 'the creator'} will send to a fan/contact.` +
        ` Write ONLY the reply body, first person, no subject line, no "Dear", keep it natural and concise.` +
        `${samples}${emojis}`;
      const user = `The message from ${email.name} says:\n"${email.text}"\n\nWrite my reply.`;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
          max_tokens: 400,
          system: sys,
          messages: [{ role: 'user', content: user }]
        })
      });
      const data = await res.json();
      const text = data?.content?.[0]?.text?.trim();
      if (text) return text + signoff;
    } catch (e) {
      console.error('AI draft failed, using fallback:', e.message);
    }
  }

  // Zero-key fallback so the loop still works
  return `Hi ${first}, thanks so much for reaching out — I really appreciate it. ` +
    `I read your message and wanted to reply personally. Let me know if there's anything else I can help with!${signoff}`;
}
