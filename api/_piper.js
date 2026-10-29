// The two light voices (Piper, formal Arabic) on the owner's private Hugging Face Space
// (space/ in this repo). Donors v5 (man) and v4 (woman) were trained for it (train/), so an
// Arabic request in their voice goes there instead of the engine: about a second a sentence,
// no daily limit, no GPU. Other voices and languages keep the engine.
// The Space is private: Hugging Face lets in only requests with the owner's token (HF_TOKEN).
// OV_PIPER_URL replaces its address; OV_PIPER_OFF=1 sends everything back to the engine.
const { hfToken } = require('./_engine');

const VOICES = { v5: 'm', v4: 'f' };
const MAX_CHARS = 1200; // the Space's own limit; the site and the app send ~300-character pieces
const url = () => String(process.env.OV_PIPER_URL || 'https://omran77-omran-voices-tts.hf.space').trim().replace(/\/+$/, '');

class PiperError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function speakerFor(donor, lang) {
  if (String(process.env.OV_PIPER_OFF || '').trim() === '1') return null;
  if (String(lang || '').toLowerCase().slice(0, 2) !== 'ar') return null;
  return VOICES[String(donor || '')] || null;
}

async function generate({ text, speaker, timeoutMs = 90000 }) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new PiperError('اكتب نص.', 400, 'input');
  if (t.length > MAX_CHARS) throw new PiperError('القطعة أطول من ' + MAX_CHARS + ' حرف.', 400, 'input');
  const token = hfToken();
  let r;
  try {
    r = await fetch(url() + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ text: t, voice: speaker }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PiperError('الصوت الخفيف ما ردّ. لو السيرفر نايم يصحى في دقيقة، جرّب مرّة ثانية.', 503, 'piper_down');
  }
  // A sleeping or building Space answers 503 with a page; a missing token reads as 401/404 (private).
  if (r.status === 503) throw new PiperError('سيرفر الصوت الخفيف يصحى الحين، جرّب بعد دقيقة.', 503, 'piper_down');
  if (!r.ok) throw new PiperError('سيرفر الصوت الخفيف رفض الطلب (' + r.status + ').', 502, 'piper_failed');
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') throw new PiperError('سيرفر الصوت الخفيف رجّع شي مب صوت.', 502, 'piper_failed');
  return audio;
}

module.exports = { speakerFor, generate, PiperError, VOICES, MAX_CHARS, url };
