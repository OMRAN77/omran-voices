// The two light voices (Piper, formal Arabic) on the owner's free Hugging Face Space (space/ in this
// repo). Donors v5 (man) and v4 (woman) were trained for it (train/), so an Arabic request in their
// voice goes there instead of the engine: about a second a sentence, no daily limit, no GPU. Other
// voices and languages keep the engine, and so does everything until the Space is set up.
// The Space is public (a private one needs a paid account) and refuses any call without its key.
// Its setup notebook (space/omran-voices-tts-setup.ipynb) writes the address and key to the file
// tts-space in the private recordings dataset once the Space works; read here with HF_TOKEN.
// OV_PIPER_URL + OV_PIPER_KEY replace that file; OV_PIPER_OFF=1 sends everything back to the engine.
const { hfToken, cleanUrl } = require('./_engine');

const VOICES = { v5: 'm', v4: 'f' };
const MAX_CHARS = 1200; // the Space's own limit; the site and the app send ~300-character pieces
const SPACE_FILE = 'tts-space';
const hub = () => String(process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const dataset = () => String(process.env.VOICES_RECORD_DATASET || 'omran77/omran-voices-recordings').trim();
const okKey = (k) => (/^[\x21-\x7e]{16,200}$/.test(String(k || '')) ? String(k) : '');

class PiperError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function speakerFor(donor, lang) {
  if (String(process.env.OV_PIPER_OFF || '').trim() === '1') return null;
  if (String(lang || '').toLowerCase().slice(0, 2) !== 'ar') return null;
  return VOICES[String(donor || '')] || null;
}

// {url, key} of the Space, or null while it is not set up. Remembered five minutes.
let conf = { value: null, at: 0 };
async function settings() {
  const envUrl = cleanUrl(process.env.OV_PIPER_URL);
  const envKey = okKey(String(process.env.OV_PIPER_KEY || '').trim());
  if (envUrl && envKey) return { url: envUrl, key: envKey };
  if (Date.now() - conf.at < 300000) return conf.value;
  let value = null;
  const t = hfToken();
  if (t) {
    try {
      const r = await fetch(hub() + '/datasets/' + dataset() + '/resolve/main/' + SPACE_FILE, { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = await r.json();
        if (cleanUrl(j.url) && okKey(j.key)) value = { url: cleanUrl(j.url), key: okKey(j.key) };
      }
    } catch { /* not set up yet, or Hugging Face slow: the engine is used */ }
  }
  conf = { value, at: Date.now() };
  return value;
}
const forget = () => { conf = { value: null, at: 0 }; };

async function call(s, text, speaker, timeoutMs) {
  try {
    return await fetch(s.url + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Space-Key': s.key },
      body: JSON.stringify({ text, voice: speaker }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PiperError('الصوت الخفيف ما ردّ. لو السيرفر نايم يصحى في دقيقة، جرّب مرّة ثانية.', 503, 'piper_down');
  }
}

async function generate({ text, speaker, timeoutMs = 90000 }) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new PiperError('اكتب نص.', 400, 'input');
  if (t.length > MAX_CHARS) throw new PiperError('القطعة أطول من ' + MAX_CHARS + ' حرف.', 400, 'input');
  let s = await settings();
  if (!s) throw new PiperError('سيرفر الصوتين الخفيفين ما انعدّ لين الحين.', 503, 'piper_off');
  let r = await call(s, t, speaker, timeoutMs);
  if (r.status === 401) { // the setup notebook ran again and made a new key: read it once more
    forget();
    s = await settings();
    if (s) r = await call(s, t, speaker, timeoutMs);
  }
  // A sleeping or building Space answers 503 with a page.
  if (r.status === 503) throw new PiperError('سيرفر الصوت الخفيف يصحى الحين، جرّب بعد دقيقة.', 503, 'piper_down');
  if (r.status === 401) throw new PiperError('مفتاح سيرفر الصوت الخفيف ما ينفع: شغّل نوتبوك السيرفر مرّة ثانية.', 502, 'piper_key');
  if (!r.ok) throw new PiperError('سيرفر الصوت الخفيف رفض الطلب (' + r.status + ').', 502, 'piper_failed');
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new PiperError('سيرفر الصوت الخفيف رجّع شي مب صوت.', 502, 'piper_failed');
  return audio;
}

module.exports = { speakerFor, settings, generate, forget, PiperError, VOICES, MAX_CHARS, SPACE_FILE };
