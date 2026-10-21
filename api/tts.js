// POST /api/tts  { text, lang, voice: {builtin}|{refPath}|{wavBase64}, exaggeration, temperature, cfg, seed }
// Returns audio/wav. When a new voice was uploaded, its engine path comes back
// in the X-Ref-Path header so the page can reuse it for the next pieces.
const checkAccess = require('./_auth');
const engine = require('./_engine');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST فقط.' });
  if (!checkAccess(req, res)) return;
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const v = b.voice || {};
    let voice;
    if (v.wavBase64) {
      const wav = Buffer.from(String(v.wavBase64), 'base64');
      if (wav.length < 1000 || wav.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'ملف الصوت حجمه غلط.' });
      voice = { wav };
    } else if (v.refPath) voice = { refPath: String(v.refPath) };
    else voice = { builtin: v.builtin ? String(v.builtin) : undefined };

    const out = await engine.generate({
      text: b.text, lang: String(b.lang || 'ar'), voice,
      exaggeration: b.exaggeration, temperature: b.temperature, cfg: b.cfg, seed: b.seed,
    });
    if (out.refPath) res.setHeader('X-Ref-Path', out.refPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(out.audio);
  } catch (e) {
    const status = e instanceof engine.EngineError ? e.status : 500;
    const code = e instanceof engine.EngineError ? e.code : 'server';
    return res.status(status).json({ error: e instanceof engine.EngineError ? e.message : 'صار خطأ في الخادم.', code });
  }
};
