// The two light voices (Piper, formal Arabic) in this site's own Python function (api/piper.py).
// Donors v5 (man) and v4 (woman) were trained for it (train/), so an Arabic request in their voice
// goes there instead of the engine: a few seconds a piece, no daily limit, no GPU, nothing to set up.
// Other voices and languages keep the engine; OV_PIPER_OFF=1 sends everything back to it.
// The function answers only this file: X-Piper-Key is an HMAC of HF_TOKEN, computed on both sides,
// so the token itself never travels and there is no key to set.
const crypto = require('crypto');
const { hfToken } = require('./_engine');

const VOICES = { v5: 'm', v4: 'f' };
const MAX_CHARS = 1200; // api/piper.py's own limit; the site and the app send ~300-character pieces

class PiperError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function speakerFor(donor, lang) {
  if (String(process.env.OV_PIPER_OFF || '').trim() === '1') return null;
  if (String(lang || '').toLowerCase().slice(0, 2) !== 'ar') return null;
  return VOICES[String(donor || '')] || null;
}

// The function reads the private models with HF_TOKEN: without it the engine is used, as before.
const ready = () => Boolean(hfToken());
const siteKey = (t) => crypto.createHmac('sha256', t).update('omran-voices-piper').digest('hex');

// The function on the same deployment, reached through the address this request came in on.
function address(host) {
  const h = String(host || '').trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(h)) throw new PiperError('عنوان الموقع غلط.', 400, 'input');
  return (/^(localhost|127\.0\.0\.1)(:|$)/.test(h) ? 'http://' : 'https://') + h + '/api/piper';
}

async function generate({ text, speaker, host, timeoutMs = 120000 }) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new PiperError('اكتب نص.', 400, 'input');
  if (t.length > MAX_CHARS) throw new PiperError('القطعة أطول من ' + MAX_CHARS + ' حرف.', 400, 'input');
  const token = hfToken();
  if (!token) throw new PiperError('الصوتين الخفيفين يحتاجون HF_TOKEN في Vercel.', 503, 'piper_off');
  const headers = { 'Content-Type': 'application/json', 'X-Piper-Key': siteKey(token) };
  // Vercel's protection of preview deployments lets the site's own call through with this, when it is on
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let r;
  try {
    r = await fetch(address(host), { method: 'POST', headers, body: JSON.stringify({ text: t, voice: speaker }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof PiperError) throw e;
    throw new PiperError('الصوت الخفيف ما ردّ، جرّب مرّة ثانية.', 503, 'piper_down');
  }
  // Vercel answers 503/504 while the function is starting or when it ran out of time
  if (r.status === 503 || r.status === 504) throw new PiperError('الصوت الخفيف يشتغل الحين، جرّب بعد دقيقة.', 503, 'piper_down');
  if (r.status === 401) throw new PiperError('دالّة الصوت الخفيف رفضت مفتاح الموقع.', 502, 'piper_key');
  if (r.status === 502) throw new PiperError('دالّة الصوت الخفيف ما قدرت تقرا الموديل من Hugging Face (شوف سجلّ Vercel).', 502, 'piper_model');
  if (!r.ok) throw new PiperError('دالّة الصوت الخفيف رفضت الطلب (' + r.status + ').', 502, 'piper_failed');
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new PiperError('دالّة الصوت الخفيف رجّعت شي مب صوت.', 502, 'piper_failed');
  return audio;
}

module.exports = { speakerFor, ready, siteKey, address, generate, PiperError, VOICES, MAX_CHARS };
