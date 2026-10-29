// POST /api/tts  { text, lang, voice: {donor}|{refPath}|{wavBase64}, exaggeration, temperature, cfg, seed }
// Returns audio/wav. When the user's own voice was uploaded, its engine path comes
// back in the X-Ref-Path header so the page can reuse it for the next pieces.
// A donor voice is read from the private store (api/_voices.js) here on the server;
// the page only ever sends its id.
const checkAccess = require('./_auth');
const engine = require('./_engine');
const dialect = require('./_dialect');
const voices = require('./_voices');
const piper = require('./_piper');

// The pronunciation dictionary (api/_dialect.js) rewrites Emirati words for the
// engine only; the page keeps the user's own text. Diacritics add characters, so
// a piece that would pass the engine's limit is sent as written instead.
function spokenText(text, lang) {
  const original = String(text || '');
  const spoken = dialect.apply(original, lang);
  return spoken.trim().length <= engine.MAX_CHARS ? spoken : original;
}

// Engine path of each donor voice already uploaded by this server instance, so the
// next pieces do not upload the same WAV again.
const donorRef = new Map();

async function generateWithDonor(id, args) {
  const known = donorRef.get(id);
  if (known) {
    try { return await engine.generate({ ...args, voice: { refPath: known } }); }
    catch (e) {
      if (!(e instanceof engine.EngineError) || e.code !== 'ref_gone') throw e;
      donorRef.delete(id); // the engine cleaned its temp files: upload again below
    }
  }
  const out = await engine.generate({ ...args, voice: { wav: await voices.wav(id) } });
  if (out.refPath) donorRef.set(id, out.refPath);
  return { audio: out.audio };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST فقط.' });
  if (!checkAccess(req, res)) return;
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const v = b.voice || {};
    const lang = String(b.lang || 'ar');
    const args = {
      text: spokenText(b.text, lang), lang,
      exaggeration: b.exaggeration, temperature: b.temperature, cfg: b.cfg, seed: b.seed,
    };
    let out;
    // A trained light voice (api/piper.py on this same site; anything else: the engine): the text as
    // written (Piper adds its own diacritics), the donor's consent checked like every donor.
    const speaker = v.donor ? piper.speakerFor(v.donor, lang) : null;
    if (speaker && piper.ready()) {
      if (!(await voices.list()).some((d) => d.id === String(v.donor))) throw new voices.VoicesError('الصوت مو موجود.', 404, 'unknown_voice');
      out = { audio: await piper.generate({ text: b.text, speaker, host: req.headers && req.headers.host }) };
    } else if (v.donor) out = await generateWithDonor(String(v.donor), args);
    else if (v.wavBase64) {
      const wav = Buffer.from(String(v.wavBase64), 'base64');
      if (wav.length < 1000 || wav.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'ملف الصوت حجمه غلط.' });
      out = await engine.generate({ ...args, voice: { wav } });
    } else if (v.refPath) out = await engine.generate({ ...args, voice: { refPath: String(v.refPath) } });
    else out = await engine.generate({ ...args, voice: null });

    if (out.refPath) res.setHeader('X-Ref-Path', out.refPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(out.audio);
  } catch (e) {
    // For the owner's Vercel logs. Header values are masked: fetch errors can quote
    // them (the token or the password).
    console.error('tts failed:', e.name, e.code || '', String(e.message || '').replace(/Bearer\s+\S+|hf_\w+/g, '***').slice(0, 300));
    const known = e instanceof engine.EngineError || e instanceof voices.VoicesError || e instanceof piper.PiperError;
    return res.status(known ? e.status : 500).json({ error: known ? e.message : 'صار خطأ في الخادم.', code: known ? e.code : 'server' });
  }
};
module.exports.spokenText = spokenText;
