// GET /api/voices            -> { voices: [{ id, name, gender }] }  (the donors' voices)
// GET /api/voices?sample=<id> -> that voice's WAV, for the ▶ preview button
// Both need the site password. The WAV is streamed from the private store; the page
// never learns where it lives.
const checkAccess = require('./_auth');
const voices = require('./_voices');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET فقط.' });
  if (!checkAccess(req, res)) return;
  try {
    const sample = req.query && req.query.sample;
    res.setHeader('Cache-Control', 'private, no-store');
    if (sample) {
      const buf = await voices.wav(String(sample));
      res.setHeader('Content-Type', 'audio/wav');
      return res.status(200).send(buf);
    }
    return res.status(200).json({ voices: await voices.list() });
  } catch (e) {
    console.error('voices failed:', e.name, e.code || '', String(e.message || '').replace(/Bearer\s+\S+|hf_\w+/g, '***').slice(0, 300));
    const known = e instanceof voices.VoicesError;
    return res.status(known ? e.status : 500).json({ error: known ? e.message : 'صار خطأ في الخادم.', code: known ? e.code : 'server' });
  }
};
