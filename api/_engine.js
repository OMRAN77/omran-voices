// The voice engine. Everything that talks to the model lives in this one file.
//
// Engine: Chatterbox Multilingual (MIT licence), in two places:
//  1. The owner's own PC (engine-local/, NVIDIA GPU), reached through a tunnel with
//     OV_ENGINE_URL + OV_ENGINE_KEY. Used first whenever it answers: no daily limit.
//  2. The free Hugging Face demo, when the PC is off or not set. HF_TOKEN (a free
//     Hugging Face read token) gives the owner's account quota there instead of the
//     small anonymous limit.

const crypto = require('crypto');

const SPACE = 'https://resembleai-chatterbox-multilingual-tts.hf.space';
const API = SPACE + '/gradio_api';
// Every language the engine speaks. Any voice speaks all of them.
const LANGS = ['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh'];
const MAX_CHARS = 300;

class EngineError extends Error {
  constructor(message, status = 502, code = 'engine') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A token pasted into a terminal can arrive broken (one stray character), and a
// bad value makes every request fail. Only a real-looking token is used.
// Invisible direction marks (an Arabic keyboard adds them) are removed first,
// so a real token wrapped in them still counts.
function hfToken() {
  const t = String(process.env.HF_TOKEN || '').replace(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  return /^hf_[A-Za-z0-9]{20,}$/.test(t) ? t : '';
}

function headers(extra = {}) {
  const h = { ...extra };
  const t = hfToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

const fileData = (path) => ({ path, meta: { _type: 'gradio.FileData' } });

let fnIndexCache = null;
async function fnIndex() {
  if (fnIndexCache !== null) return fnIndexCache;
  const r = await fetch(SPACE + '/config', { headers: headers() });
  if (!r.ok) throw new EngineError('المحرك مطفي أو يشتغل الحين. جرّب بعد دقيقة.', 503, 'down');
  const cfg = await r.json();
  const deps = cfg.dependencies || [];
  const i = deps.findIndex((d) => d.api_name === 'generate_tts_audio');
  if (i < 0) throw new EngineError('المحرك تغيّر وما لقيت أمر التوليد.', 502, 'changed');
  fnIndexCache = { index: deps[i].id ?? i, trigger: (deps[i].targets && deps[i].targets[0] && deps[i].targets[0][0]) ?? null };
  return fnIndexCache;
}

// Uploads a reference voice (WAV bytes) and returns the engine's file path.
async function uploadVoice(wavBuffer) {
  const fd = new FormData();
  fd.append('files', new Blob([wavBuffer], { type: 'audio/wav' }), 'voice.wav');
  const r = await fetch(API + '/upload', { method: 'POST', headers: headers(), body: fd });
  if (!r.ok) throw new EngineError('ما قدرت أرفع الصوت للمحرك (' + r.status + ').');
  const paths = await r.json();
  if (!Array.isArray(paths) || !paths[0]) throw new EngineError('المحرك ما رجّع مكان الصوت المرفوع.');
  return paths[0];
}

function friendly(errText) {
  const t = String(errText || '');
  if (/quota|runs limit|exceeded/i.test(t)) {
    // Hugging Face says when the daily quota comes back ("Try again in 5:12:09").
    const wait = t.match(/try again in (\d+):(\d\d):\d\d/i);
    const back = wait && (+wait[1] || +wait[2]) ? ' يرجع بعد ' + (+wait[1] ? wait[1] + ' ساعة و' : '') + (+wait[2]) + ' دقيقة.' : ' يرجع بعد كم ساعة.';
    // "Authenticate with a Hugging Face token" although we sent one = the token was not accepted.
    if (hfToken() && /authenticate with a hugging face token/i.test(t)) {
      return new EngineError('Hugging Face ما قبل مفتاح HF_TOKEN اللي في Vercel (منتهي أو منسوخ غلط). سوّ مفتاح جديد نوعه Read وحطّه من جديد.', 429, 'quota');
    }
    return new EngineError(
      hfToken()
        ? 'خلص الحد المجاني اليومي لحسابك في Hugging Face.' + back
        : 'خلص الحد المجاني بدون حساب. حط HF_TOKEN في Vercel عشان يزيد الحد.',
      429, 'quota');
  }
  if (/not found|no such file|does not exist/i.test(t)) return new EngineError('الصوت المرفوع انمسح من المحرك.', 410, 'ref_gone');
  return new EngineError('المحرك ما قدر يسوي الصوت' + (t ? ': ' + t.slice(0, 200) : '.'));
}

// Reads the queue's server-sent events until the job finishes.
async function waitForResult(sessionHash, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API + '/queue/data?session_hash=' + sessionHash, { headers: headers(), signal: ctrl.signal });
    if (!r.ok || !r.body) throw new EngineError('المحرك ما رد (' + r.status + ').');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5)); } catch { continue; }
        if (msg.msg === 'process_completed') {
          ctrl.abort();
          if (!msg.success) throw friendly(msg.output && (msg.output.error || msg.title));
          const out = msg.output && msg.output.data && msg.output.data[0];
          if (!out || !(out.url || out.path)) throw new EngineError('المحرك خلص بس ما رجّع صوت.');
          return out.url || (API + '/file=' + out.path);
        }
        if (msg.msg === 'unexpected_error') throw friendly(msg.message);
      }
    }
    throw new EngineError('المحرك قطع الاتصال قبل ما يخلص.');
  } catch (e) {
    if (e.name === 'AbortError') throw new EngineError('المحرك طوّل وايد. جرّب مرة ثانية.', 504, 'timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function checkInput(text, lang) {
  text = String(text || '').trim();
  if (!text) throw new EngineError('ما في كلام.', 400, 'input');
  if (text.length > MAX_CHARS) throw new EngineError('القطعة أطول من ' + MAX_CHARS + ' حرف.', 400, 'input');
  if (!LANGS.includes(lang)) throw new EngineError('اللغة مو مدعومة.', 400, 'input');
  return text;
}

// ---------- The owner's own engine (engine-local/server.py on his PC) ----------
// Used first when OV_ENGINE_URL and OV_ENGINE_KEY are set in Vercel and the PC answers;
// otherwise the public demo below. A voice sent to the PC comes back as 'local:<sha256>'.

const LOCAL_REF = /^local:([0-9a-f]{64})$/;
const clean = (s) => String(s || '').replace(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

function localSettings() {
  const url = clean(process.env.OV_ENGINE_URL).replace(/\/+$/, '');
  const key = clean(process.env.OV_ENGINE_KEY);
  const urlOk = /^https:\/\/[\w.-]+(:\d+)?$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
  return urlOk && /^[\x21-\x7e]{16,200}$/.test(key) ? { url, key } : null;
}

// The PC's state is remembered for a short while, so an off PC costs one quick check
// per half minute instead of a wait on every piece.
let localState = { status: null, at: 0 };
const localFresh = () => localState.status !== null && Date.now() - localState.at < (localState.status === 'up' ? 60000 : 30000);
const markLocal = (status) => { localState = { status, at: Date.now() }; };

/** 'off' (not set) | 'bad' (set wrong) | 'up' | 'down' (PC off or engine closed) | 'badkey' */
async function localStatus() {
  const s = localSettings();
  if (!s) return process.env.OV_ENGINE_URL || process.env.OV_ENGINE_KEY ? 'bad' : 'off';
  if (localFresh()) return localState.status;
  let status = 'down';
  try {
    const r = await fetch(s.url + '/health', { headers: { 'X-Engine-Key': s.key }, signal: AbortSignal.timeout(4000) });
    status = r.ok ? 'up' : r.status === 401 ? 'badkey' : 'down';
  } catch { status = 'down'; }
  markLocal(status);
  return status;
}

async function localGenerate(s, { text, lang, voice, exaggeration, temperature, cfg, seed, timeoutMs }) {
  let refId;
  let refWav;
  if (voice && voice.wav) {
    refId = crypto.createHash('sha256').update(voice.wav).digest('hex');
    refWav = Buffer.from(voice.wav).toString('base64');
  } else if (voice && voice.refPath) {
    const m = LOCAL_REF.exec(voice.refPath);
    // A path from the public demo means nothing to the PC: the caller sends the WAV again.
    if (!m) throw new EngineError('الصوت مو موجود في جهازك.', 410, 'ref_gone');
    refId = m[1];
  } else {
    throw new EngineError('اختار صوت من القائمة.', 400, 'no_voice');
  }
  let r;
  try {
    r = await fetch(s.url + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Engine-Key': s.key },
      body: JSON.stringify({ text, lang, refId, refWav, exaggeration, temperature, cfg, seed }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new EngineError('المحرك في جهازك طوّل وايد. جرّب مرة ثانية.', 504, 'timeout');
    markLocal('down');
    throw new EngineError('جهازك ما رد.', 503, 'local_down');
  }
  if (r.ok) return { audio: Buffer.from(await r.arrayBuffer()), refPath: refWav ? 'local:' + refId : undefined };
  let j = {};
  try { j = await r.json(); } catch { /* the tunnel's own error page, not JSON */ }
  if (r.status === 410) throw new EngineError('الصوت انمسح من جهازك.', 410, 'ref_gone');
  if (r.status === 400 || r.status === 413) throw new EngineError('المحرك في جهازك رفض الطلب.', 400, 'input');
  if (r.status === 500 && j.code === 'engine') throw new EngineError('المحرك في جهازك ما قدر يسوي الصوت: ' + String(j.error || '').slice(0, 200));
  // 401 = the key in Vercel is not the PC's; 502/530… = the tunnel is up but the engine is closed.
  markLocal(r.status === 401 ? 'badkey' : 'down');
  throw new EngineError('جهازك ما رد (' + r.status + ').', 503, 'local_down');
}

/**
 * Generates speech for one piece of text (max 300 characters).
 * voice: { wav: Buffer } (a donor's or the user's own voice) or { refPath } (that WAV
 * already sent: '/tmp/gradio/...' on the public demo, 'local:<sha256>' on the owner's PC).
 * There is no built-in voice. Returns { audio: Buffer, refPath?: string }.
 */
async function generate(args) {
  const text = checkInput(args.text, args.lang);
  const s = localSettings();
  if (s && (await localStatus()) === 'up') {
    try {
      return await localGenerate(s, { ...args, text, timeoutMs: args.timeoutMs || 90000 });
    } catch (e) {
      if (e.code !== 'local_down') throw e;
    }
  }
  if (args.voice && args.voice.refPath && LOCAL_REF.test(args.voice.refPath)) {
    throw new EngineError('جهازك مطفي، فالصوت ينرسل للمحرك العام.', 410, 'ref_gone');
  }
  return spaceGenerate(args);
}

async function spaceGenerate({ text, lang, voice, exaggeration = 0.5, temperature = 0.8, cfg = 0.5, seed = 0, timeoutMs = 150000 }) {
  text = checkInput(text, lang);

  let refPath;
  let uploaded;
  if (voice && voice.wav) {
    refPath = uploaded = await uploadVoice(voice.wav);
  } else if (voice && voice.refPath) {
    if (!/^\/tmp\/gradio\/[\w./-]+$/.test(voice.refPath) || voice.refPath.includes('..')) {
      throw new EngineError('مكان الصوت غلط.', 400, 'input');
    }
    refPath = voice.refPath;
  } else {
    throw new EngineError('اختار صوت من القائمة.', 400, 'no_voice');
  }

  const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const { index, trigger } = await fnIndex();
  const sessionHash = Math.random().toString(36).slice(2, 14);
  const join = await fetch(API + '/queue/join', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      data: [text, lang, fileData(refPath), clamp(exaggeration, 0.25, 2, 0.5), clamp(temperature, 0.05, 2, 0.8), clamp(seed, 0, 2 ** 31, 0), clamp(cfg, 0.2, 1, 0.5)],
      fn_index: index,
      trigger_id: trigger,
      session_hash: sessionHash,
      event_data: null,
    }),
  });
  if (!join.ok) {
    fnIndexCache = null;
    throw new EngineError('المحرك رفض الطلب (' + join.status + ').', join.status === 429 ? 429 : 502);
  }
  const url = await waitForResult(sessionHash, timeoutMs);
  const a = await fetch(url, { headers: headers() });
  if (!a.ok) throw new EngineError('ما قدرت أنزّل الصوت من المحرك (' + a.status + ').');
  return { audio: Buffer.from(await a.arrayBuffer()), refPath: uploaded };
}

module.exports = { generate, localStatus, hfToken, EngineError, LANGS, MAX_CHARS, name: 'Chatterbox Multilingual (Hugging Face)' };
