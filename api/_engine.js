// The voice engine. Everything that talks to the model lives in this one file,
// so moving to our own GPU server later means replacing only this file.
//
// Current engine: Chatterbox Multilingual (MIT licence) through the free
// Hugging Face demo. HF_TOKEN (a free Hugging Face read token) gives the
// owner's account quota instead of the small anonymous limit.

const SPACE = 'https://resembleai-chatterbox-multilingual-tts.hf.space';
const API = SPACE + '/gradio_api';
const SAMPLES = 'https://storage.googleapis.com/chatterbox-demo-samples/mtl_prompts/';

// Built-in voice of each language (the demo's own reference samples).
const BUILTIN = {
  ar: 'ar_f/ar_prompts2.flac', da: 'da_m1.flac', de: 'de_f1.flac', el: 'el_m.flac',
  en: 'en_f1.flac', es: 'es_f1.flac', fi: 'fi_m.flac', fr: 'fr_f1.flac',
  he: 'he_m1.flac', hi: 'hi_f1.flac', it: 'it_m1.flac', ja: 'ja/ja_prompts1.flac',
  ko: 'ko_f.flac', ms: 'ms_f.flac', nl: 'nl_m.flac', no: 'no_f1.flac',
  pl: 'pl_m.flac', pt: 'pt_m1.flac', ru: 'ru_m.flac', sv: 'sv_f.flac',
  sw: 'sw_m.flac', tr: 'tr_m.flac', zh: 'zh_f2.flac',
};
const LANGS = Object.keys(BUILTIN);
const MAX_CHARS = 300;

class EngineError extends Error {
  constructor(message, status = 502, code = 'engine') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function headers(extra = {}) {
  const h = { ...extra };
  if (process.env.HF_TOKEN) h.Authorization = 'Bearer ' + process.env.HF_TOKEN;
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
    return new EngineError(
      process.env.HF_TOKEN
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

/**
 * Generates speech for one piece of text (max 300 characters).
 * voice: { builtin: 'ar' } or { refPath: '/tmp/gradio/...' } or { wav: Buffer }
 * Returns { audio: Buffer, refPath?: string }.
 */
async function generate({ text, lang, voice, exaggeration = 0.5, temperature = 0.8, cfg = 0.5, seed = 0, timeoutMs = 150000 }) {
  text = String(text || '').trim();
  if (!text) throw new EngineError('ما في كلام.', 400, 'input');
  if (text.length > MAX_CHARS) throw new EngineError('القطعة أطول من ' + MAX_CHARS + ' حرف.', 400, 'input');
  if (!LANGS.includes(lang)) throw new EngineError('اللغة مو مدعومة.', 400, 'input');

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
    const b = (voice && voice.builtin) || lang;
    if (!BUILTIN[b]) throw new EngineError('الصوت مو موجود.', 400, 'input');
    refPath = SAMPLES + BUILTIN[b];
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

module.exports = { generate, EngineError, LANGS, BUILTIN, SAMPLES, MAX_CHARS, name: 'Chatterbox Multilingual (Hugging Face)' };
