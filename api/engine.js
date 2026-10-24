// POST /api/engine  { url }   header X-Engine-Key = OV_ENGINE_KEY
// The owner's PC (engine-local/server.py) opens a free Cloudflare tunnel on every start and its
// address changes each time, so the PC tells the site here. The site first checks that the
// address answers with the same key, then keeps it in the private recordings dataset, where
// every server instance reads it (api/_engine.js). Answers are English: they show in the PC's
// console, which does not show Arabic.
const crypto = require('crypto');
const engine = require('./_engine');
const rec = require('./_recordings');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  const key = engine.engineKey();
  if (!key) return res.status(500).json({ error: 'OV_ENGINE_KEY is not set in Vercel (or is not plain letters and digits).', code: 'no_key' });
  if (!crypto.timingSafeEqual(sha256(req.headers['x-engine-key'] || ''), sha256(key))) {
    return res.status(401).json({ error: 'This key is not the OV_ENGINE_KEY in Vercel.', code: 'key' });
  }
  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; } catch { b = {}; }
  const url = engine.cleanUrl(b.url);
  if (!url) return res.status(400).json({ error: 'Bad address.', code: 'input' });

  // Every request will go there with the key: it must really be this PC first.
  let ok = false;
  try {
    const r = await fetch(url + '/health', { headers: { 'X-Engine-Key': key }, signal: AbortSignal.timeout(10000) });
    ok = r.ok;
  } catch { ok = false; }
  if (!ok) return res.status(502).json({ error: 'The site cannot reach this address yet.', code: 'unreachable' });

  const token = rec.writeToken();
  if (!token) return res.status(500).json({ error: 'HF_WRITE_TOKEN is not set in Vercel.', code: 'no_token' });
  try {
    const bytes = Buffer.from(JSON.stringify({ url, at: new Date().toISOString() }) + '\n');
    await rec.commitFiles(token, [{ path: engine.ENGINE_FILE, bytes }], 'engine address');
  } catch (e) {
    console.error('engine: saving the address failed:', e.code || '', String(e.message || '').slice(0, 200));
    return res.status(502).json({ error: 'Saving the address failed: ' + (e.code || 'hf'), code: 'save' });
  }
  engine.setLink(url);
  console.log('engine: the PC registered a new address');
  return res.status(200).json({ ok: true });
};
