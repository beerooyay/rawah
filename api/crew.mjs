import { cleanCompanionReply } from '../src/crew.js';
import { dialogueMessages, dialogueTurn } from '../src/crew-dialogue.js';

// A bounded companion endpoint, never a general-purpose credentialed proxy.
const visits = new Map();
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Open chat from the game.' }); }
    catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  }
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return res.status(503).json({ error: 'The crew chat server is not connected yet. Try again later.' });
  const now = Date.now(), ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0];
  // Best-effort per-instance burst limit; provider quota remains the global limit.
  for (const [k, v] of visits) if (now - v.start > 60000) visits.delete(k);
  const v = visits.get(ip) || { start: now, count: 0 };
  if (++v.count > 12 || visits.size > 5000) return res.status(429).json({ error: 'Give him a second. Try again in a minute.' });
  visits.set(ip, v);
  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch { return res.status(400).json({ error: 'Invalid conversation.' }); }
  if (!b || typeof b.name !== 'string' || !Array.isArray(b.history) || b.history.length < 1 || b.history.length > 16 ||
      b.history.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 800) ||
      b.history.at(-1).role !== 'user' || (b.context !== undefined && (typeof b.context !== 'string' || b.context.length > 4000))) {
    return res.status(400).json({ error: 'Invalid conversation.' });
  }
  let messages;
  try { messages = dialogueMessages(b.name, b.history, b.context); } catch { return res.status(400).json({ error: 'Unknown companion.' }); }
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.RAWAH_CREW_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b', messages, max_tokens: dialogueTurn(b.history).maxTokens, temperature: 0.9, top_p: 0.95, stream: false, chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) { console.warn('crew upstream status', response.status); return res.status(502).json({ error: 'Nemotron could not answer right now. Try again shortly.' }); }
    const data = await response.json(), content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty reply');
    return res.status(200).json({ content: cleanCompanionReply(content.slice(0, 800), b.name), source: 'nemotron' });
  } catch { return res.status(502).json({ error: 'The connection to Nemotron timed out. Try again.' }); }
}
