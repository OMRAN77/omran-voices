// POST /api/tts  { text, lang, voice: {builtin}|{refPath}|{wavBase64}, exaggeration, temperature, cfg, seed }
// Returns audio/wav. When a new voice was uploaded, its engine path comes back
// in the X-Ref-Path header so the page can reuse it for the next pieces.
const checkAccess = require('./_auth');
const engine = require('./_engine');
const dialect = require('./_dialect');

// The pronunciation dictionary (api/_dialect.js) rewrites Emirati words for the
// engine only; the page keeps the user's own text. Diacritics add characters, so
// a piece that would pass the engine's limit is sent as written instead.
function spokenText(text, lang) {
  const original = String(text || '');
  const spoken = dialect.apply(original, lang);
  return spoken.trim().length <= engine.MAX_CHARS ? spoken : original;
}

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

    const lang = String(b.lang || 'ar');
    const out = await engine.generate({
      text: spokenText(b.text, lang), lang, voice,
      exaggeration: b.exaggeration, temperature: b.temperature, cfg: b.cfg, seed: b.seed,
    });
    if (out.refPath) res.setHeader('X-Ref-Path', out.refPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(out.audio);
  } catch (e) {
    // For the owner's Vercel logs. Header values are masked: fetch errors can quote
    // them (the token or the password).
    console.error('tts failed:', e.name, e.code || '', String(e.message || '').replace(/Bearer\s+\S+|hf_\w+/g, '***').slice(0, 300));
    const status = e instanceof engine.EngineError ? e.status : 500;
    const code = e instanceof engine.EngineError ? e.code : 'server';
    return res.status(status).json({ error: e instanceof engine.EngineError ? e.message : 'صار خطأ في الخادم.', code });
  }
};
module.exports.spokenText = spokenText;
