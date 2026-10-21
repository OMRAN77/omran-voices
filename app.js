'use strict';
// أصوات عمران — page logic. The engine runs behind /api/tts.

const LANGS = [
  ['ar', 'العربية'], ['en', 'الإنجليزية'], ['fr', 'الفرنسية'], ['es', 'الإسبانية'], ['de', 'الألمانية'],
  ['it', 'الإيطالية'], ['pt', 'البرتغالية'], ['ru', 'الروسية'], ['tr', 'التركية'], ['hi', 'الهندية'],
  ['zh', 'الصينية'], ['ja', 'اليابانية'], ['ko', 'الكورية'], ['ms', 'الملايوية'], ['nl', 'الهولندية'],
  ['sv', 'السويدية'], ['no', 'النرويجية'], ['da', 'الدنماركية'], ['fi', 'الفنلندية'], ['pl', 'البولندية'],
  ['el', 'اليونانية'], ['he', 'العبرية'], ['sw', 'السواحلية'],
];
const LANG_NAME = Object.fromEntries(LANGS);
const SAMPLES = 'https://storage.googleapis.com/chatterbox-demo-samples/mtl_prompts/';
const BUILTIN = {
  ar: ['ar_f/ar_prompts2.flac', 'f'], da: ['da_m1.flac', 'm'], de: ['de_f1.flac', 'f'], el: ['el_m.flac', 'm'],
  en: ['en_f1.flac', 'f'], es: ['es_f1.flac', 'f'], fi: ['fi_m.flac', 'm'], fr: ['fr_f1.flac', 'f'],
  he: ['he_m1.flac', 'm'], hi: ['hi_f1.flac', 'f'], it: ['it_m1.flac', 'm'], ja: ['ja/ja_prompts1.flac', ''],
  ko: ['ko_f.flac', 'f'], ms: ['ms_f.flac', 'f'], nl: ['nl_m.flac', 'm'], no: ['no_f1.flac', 'f'],
  pl: ['pl_m.flac', 'm'], pt: ['pt_m1.flac', 'm'], ru: ['ru_m.flac', 'm'], sv: ['sv_f.flac', 'f'],
  sw: ['sw_m.flac', 'm'], tr: ['tr_m.flac', 'm'], zh: ['zh_f2.flac', 'f'],
};
const CHUNK = 260;          // engine limit is 300 characters per piece
const GAP_SEC = 0.25;       // silence between pieces
const TARGET_RATE = 24000;  // engine works at 24 kHz
const MAX_REF_SEC = 30;
const HISTORY_MAX = 30;
const DEFAULTS = { ex: 0.5, temp: 0.8, cfg: 0.5 };

const $ = (id) => document.getElementById(id);
const state = { key: localStorage.getItem('ov_key') || '', voices: [], refPaths: {}, current: null, recBlob: null, stop: null, hfToken: true };

/* ---------- storage (IndexedDB) ---------- */
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('omran-voices', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('voices', { keyPath: 'id' });
      r.result.createObjectStore('history', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: (s) => tx(s, 'readonly', (st) => st.getAll()),
    put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
    del: (s, id) => tx(s, 'readwrite', (st) => st.delete(id)),
  };
})();

/* ---------- text splitting ---------- */
function splitText(text, max = CHUNK) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const pieces = [];
  const pushLong = (s) => {
    // split very long sentences on commas, then on spaces
    const parts = s.match(/[^،,;؛]+[،,;؛]*\s*/g) || [s];
    for (const part of parts) {
      if (part.length <= max) { pieces.push(part.trim()); continue; }
      let cur = '';
      for (const w of part.split(/\s+/)) {
        if (!w) continue;
        if ((cur + ' ' + w).trim().length > max) { if (cur) pieces.push(cur); cur = w.slice(0, max); }
        else cur = (cur + ' ' + w).trim();
      }
      if (cur) pieces.push(cur);
    }
  };
  for (const s of clean.match(/[^.!?؟\n]+[.!?؟]*\s*|\n+/g) || []) {
    const t = s.trim();
    if (!t) continue;
    if (t.length > max) pushLong(t); else pieces.push(t);
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces.filter(Boolean)) {
    if (!cur) cur = p;
    else if ((cur + ' ' + p).length <= max) cur += ' ' + p;
    else { chunks.push(cur); cur = p; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------- WAV helpers ---------- */
function parseWav(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
  let off = 12, fmt = null;
  while (off + 8 <= v.byteLength) {
    const id = v.getUint32(off, false), size = v.getUint32(off + 4, true);
    if (id === 0x666d7420) fmt = { format: v.getUint16(off + 8, true), channels: v.getUint16(off + 10, true), rate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
    if (id === 0x64617461) {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) return null;
      const len = Math.min(size, v.byteLength - off - 8);
      return { rate: fmt.rate, pcm: new Int16Array(buf.slice(off + 8, off + 8 + (len & ~1))) };
    }
    off += 8 + size + (size & 1);
  }
  return null;
}
function encodeWav(int16, rate) {
  const b = new ArrayBuffer(44 + int16.length * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + int16.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
  v.setUint32(40, int16.length * 2, true); new Int16Array(b, 44).set(int16);
  return new Blob([b], { type: 'audio/wav' });
}
const floatToInt16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; };
async function decodeToMono(buf, rate) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const audio = await new Promise((res, rej) => { const c = new Ctx(1, 1, 44100); const p = c.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  const frames = Math.ceil(audio.duration * rate);
  const off = new Ctx(1, Math.max(1, frames), rate);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
async function joinWavs(buffers) {
  const parts = [];
  let rate = null;
  for (const buf of buffers) {
    let p = parseWav(buf);
    if (!p || (rate && p.rate !== rate)) p = { rate: rate || TARGET_RATE, pcm: floatToInt16(await decodeToMono(buf, rate || TARGET_RATE)) };
    rate = rate || p.rate;
    parts.push(p.pcm);
  }
  const gap = Math.round(rate * GAP_SEC);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Int16Array(total);
  let o = 0;
  parts.forEach((p, i) => { out.set(p, o); o += p.length + (i < parts.length - 1 ? gap : 0); });
  return encodeWav(out, rate);
}
const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Access-Key': state.key } });
  if (!r.ok) {
    let j = {};
    try { j = await r.json(); } catch {}
    const e = new Error(j.error || ('خطأ ' + r.status)); e.status = r.status; e.code = j.code; throw e;
  }
  return r;
}

/* ---------- lock ---------- */
async function tryUnlock(key) {
  state.key = key;
  try {
    const r = await api('/api/check');
    const j = await r.json();
    state.hfToken = j.hfToken;
    localStorage.setItem('ov_key', key);
    $('lock').classList.add('hidden');
    $('app').classList.remove('hidden');
    await refreshVoices();
    await renderHistory();
    if (!state.hfToken) setMsg('genMsg', 'ملاحظة: HF_TOKEN مو مضبوط في Vercel، فالحد المجاني صغير وايد.', 'bad');
  } catch (e) {
    localStorage.removeItem('ov_key');
    $('app').classList.add('hidden');
    $('lock').classList.remove('hidden');
    if (key) $('lockMsg').textContent = e.message || 'ما قدرت أدخل.';
  }
}

/* ---------- UI helpers ---------- */
function setMsg(id, text, kind) { const el = $(id); el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
const fmtDate = (t) => new Date(t).toLocaleString('ar-AE', { dateStyle: 'medium', timeStyle: 'short' });
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
let previewAudio = null;
function play(src) { if (previewAudio) previewAudio.pause(); previewAudio = new Audio(src); previewAudio.play().catch(() => {}); }
function voiceLabel(code) { const g = BUILTIN[code][1]; return LANG_NAME[code] + (g === 'f' ? ' - امرأة' : g === 'm' ? ' - رجّال' : ''); }

function fillLangs() {
  $('lang').innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('lang').value = localStorage.getItem('ov_lang') || 'ar';
}
async function refreshVoices() {
  state.voices = (await db.all('voices')).sort((a, b) => b.created - a.created);
  const sel = $('voice'), keep = sel.value || localStorage.getItem('ov_voice');
  const mine = state.voices.map((v) => `<option value="m:${v.id}">${escapeHtml(v.name)}</option>`).join('');
  const built = LANGS.map(([c]) => `<option value="b:${c}">${voiceLabel(c)}</option>`).join('');
  sel.innerHTML = (mine ? `<optgroup label="أصواتي">${mine}</optgroup>` : '') + `<optgroup label="أصوات المحرك">${built}</optgroup>`;
  sel.value = keep && [...sel.options].some((o) => o.value === keep) ? keep : 'b:' + $('lang').value;
  renderMyVoices();
}
function renderMyVoices() {
  const box = $('myVoices');
  if (!state.voices.length) { box.innerHTML = '<div class="empty">ما في أصوات محفوظة. سجّل صوتك من فوق.</div>'; return; }
  box.innerHTML = '';
  for (const v of state.voices) {
    const it = document.createElement('div'); it.className = 'item';
    it.innerHTML = `<div class="t">${escapeHtml(v.name)}<small>${fmtDate(v.created)} · ${v.seconds.toFixed(0)} ثانية</small></div>`;
    const use = btn('استخدمه', () => { $('voice').value = 'm:' + v.id; localStorage.setItem('ov_voice', 'm:' + v.id); $('text').focus(); });
    const pl = btn('▶', () => play(URL.createObjectURL(v.blob)));
    const del = btn('احذف', async () => { if (!confirm('تحذف «' + v.name + '»؟')) return; await db.del('voices', v.id); delete state.refPaths[v.id]; await refreshVoices(); });
    it.append(use, pl, del); box.append(it);
  }
}
async function renderHistory() {
  const items = (await db.all('history')).sort((a, b) => b.created - a.created);
  const box = $('history');
  if (!items.length) { box.innerHTML = '<div class="empty">لين الحين ما سويت أي صوت.</div>'; return; }
  box.innerHTML = '';
  for (const h of items) {
    const it = document.createElement('div'); it.className = 'item';
    it.innerHTML = `<div class="t">${escapeHtml(h.text.slice(0, 80))}<small>${escapeHtml(h.voiceName)} · ${LANG_NAME[h.lang] || h.lang} · ${fmtDate(h.created)}</small></div>`;
    it.append(
      btn('▶', () => play(URL.createObjectURL(h.blob))),
      btn('نزّل', () => download(h.blob, 'omran-voices-' + h.id + '.wav')),
      btn('احذف', async () => { await db.del('history', h.id); renderHistory(); }),
    );
    box.append(it);
  }
}
function btn(text, fn) { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; return b; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function updateCount() {
  const t = $('text').value, n = splitText(t).length;
  $('count').textContent = `${t.length} حرف` + (n > 1 ? ` · ${n} قطع` : '');
}

/* ---------- generation ---------- */
async function generate() {
  const text = $('text').value.trim();
  if (!text) { setMsg('genMsg', 'اكتب الكلام أول.', 'bad'); return; }
  const chunks = splitText(text);
  const lang = $('lang').value;
  const vsel = $('voice').value;
  const mine = vsel.startsWith('m:') ? state.voices.find((v) => v.id === vsel.slice(2)) : null;
  const voiceName = mine ? mine.name : voiceLabel(vsel.slice(2) || lang);
  const settings = { exaggeration: +$('ex').value, temperature: +$('temp').value, cfg: +$('cfg').value };

  const ctrl = new AbortController();
  state.stop = ctrl;
  $('go').disabled = true; $('stop').classList.remove('hidden');
  $('bar').style.display = 'block'; $('bar').firstElementChild.style.width = '3%';
  $('result').classList.add('hidden');
  const buffers = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      setMsg('genMsg', chunks.length > 1 ? `جاري القطعة ${i + 1} من ${chunks.length}...` : 'جاري تحويل الكلام لصوت...');
      buffers.push(await generatePiece(chunks[i], lang, vsel, mine, settings, ctrl.signal));
      $('bar').firstElementChild.style.width = Math.round(((i + 1) / chunks.length) * 100) + '%';
    }
    const blob = buffers.length === 1 ? new Blob([buffers[0]], { type: 'audio/wav' }) : await joinWavs(buffers);
    const id = stamp() + '-' + Math.random().toString(36).slice(2, 6);
    state.current = { blob, id };
    $('player').src = URL.createObjectURL(blob);
    $('result').classList.remove('hidden');
    $('player').play().catch(() => {});
    try {
      await db.put('history', { id, text, lang, voiceName, blob, created: Date.now() });
      const all = (await db.all('history')).sort((a, b) => b.created - a.created);
      for (const old of all.slice(HISTORY_MAX)) await db.del('history', old.id);
      await renderHistory();
      setMsg('genMsg', 'خلص ✅', 'ok');
    } catch {
      setMsg('genMsg', 'خلص ✅ بس ما قدرت أحفظه في السجل، نزّله الحين.', 'ok');
    }
  } catch (e) {
    if (e.name === 'AbortError') setMsg('genMsg', 'وقّفته.' + (buffers.length ? ` خلصت ${buffers.length} قطع من ${chunks.length}.` : ''), 'bad');
    else setMsg('genMsg', e.message || 'صار خطأ.', 'bad');
    if (e.status === 401) tryUnlock('');
  } finally {
    $('go').disabled = false; $('stop').classList.add('hidden'); $('bar').style.display = 'none'; state.stop = null;
  }
}

async function generatePiece(text, lang, vsel, mine, settings, signal) {
  const body = { text, lang, ...settings, voice: {} };
  if (mine) {
    if (state.refPaths[mine.id]) body.voice.refPath = state.refPaths[mine.id];
    else body.voice.wavBase64 = await blobToBase64(mine.blob);
  } else body.voice.builtin = vsel.slice(2) || lang;

  for (let attempt = 0; ; attempt++) {
    try {
      const r = await api('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      const ref = r.headers.get('X-Ref-Path');
      if (mine && ref) state.refPaths[mine.id] = ref;
      return await r.arrayBuffer();
    } catch (e) {
      if (e.name === 'AbortError' || e.status === 401 || e.status === 429 || e.status === 400) throw e;
      if (e.code === 'ref_gone' && mine) { delete state.refPaths[mine.id]; delete body.voice.refPath; body.voice.wavBase64 = await blobToBase64(mine.blob); }
      if (attempt >= 1) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/* ---------- voice cloning ---------- */
let recorder = null, recTimer = null;
async function toggleRecord() {
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch { setMsg('recMsg', 'ما قدرت أفتح المايك. اسمح للموقع يستخدم المايك وجرّب مرة ثانية.', 'bad'); return; }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    clearInterval(recTimer); stream.getTracks().forEach((t) => t.stop());
    $('recBtn').textContent = '🎙️ سجّل';
    await useReference(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
  };
  recorder.start();
  const t0 = Date.now();
  $('recBtn').innerHTML = '<span class="rec"></span>وقّف التسجيل';
  setMsg('recMsg', 'يسجّل... 0 ثانية');
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    setMsg('recMsg', `يسجّل... ${s} ثانية` + (s < 10 ? ' (كمّل لين ١٠ ثواني على الأقل)' : ''));
    if (s >= MAX_REF_SEC) recorder.stop();
  }, 250);
}
async function useReference(blob) {
  try {
    setMsg('recMsg', 'جاري تجهيز الصوت...');
    const f = await decodeToMono(await blob.arrayBuffer(), TARGET_RATE);
    const trimmed = f.subarray(0, TARGET_RATE * MAX_REF_SEC);
    const secs = trimmed.length / TARGET_RATE;
    if (secs < 5) { setMsg('recMsg', `الصوت قصير (${secs.toFixed(1)} ثانية). لازم ٥ ثواني على الأقل، والأحسن ١٠ إلى ٢٠.`, 'bad'); return; }
    state.recBlob = { blob: encodeWav(floatToInt16(trimmed), TARGET_RATE), seconds: secs };
    $('recPlayer').src = URL.createObjectURL(state.recBlob.blob);
    $('recPlayer').classList.remove('hidden'); $('saveVoice').classList.remove('hidden');
    setMsg('recMsg', `جاهز (${secs.toFixed(0)} ثانية). اسمعه، وإذا زين اضغط «احفظ الصوت».`, 'ok');
  } catch {
    setMsg('recMsg', 'ما قدرت أقرا ملف الصوت. جرّب ملف ثاني (mp3 أو wav أو m4a).', 'bad');
  }
}
async function saveVoice() {
  if (!state.recBlob) return;
  const name = $('vname').value.trim() || 'صوتي';
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.put('voices', { id, name, blob: state.recBlob.blob, seconds: state.recBlob.seconds, created: Date.now() });
  state.recBlob = null;
  $('recPlayer').classList.add('hidden'); $('saveVoice').classList.add('hidden'); $('vname').value = '';
  localStorage.setItem('ov_voice', 'm:' + id);
  await refreshVoices();
  $('voice').value = 'm:' + id;
  setMsg('recMsg', `انحفظ «${name}» واخترته لك فوق ✅`, 'ok');
}

/* ---------- wiring ---------- */
function init() {
  fillLangs();
  for (const [id, key] of [['ex', 'ex'], ['temp', 'temp'], ['cfg', 'cfg']]) {
    const el = $(id), saved = localStorage.getItem('ov_' + key);
    if (saved) el.value = saved;
    const show = () => { $(id + 'V').textContent = (+el.value).toFixed(2); localStorage.setItem('ov_' + key, el.value); };
    el.oninput = show; show();
  }
  $('resetSettings').onclick = () => { for (const k of Object.keys(DEFAULTS)) { $(k).value = DEFAULTS[k]; $(k).oninput(); } };
  $('text').value = localStorage.getItem('ov_text') || '';
  $('text').oninput = () => { localStorage.setItem('ov_text', $('text').value); updateCount(); };
  updateCount();
  $('lang').onchange = () => {
    localStorage.setItem('ov_lang', $('lang').value);
    if ($('voice').value.startsWith('b:')) { $('voice').value = 'b:' + $('lang').value; localStorage.setItem('ov_voice', $('voice').value); }
  };
  $('voice').onchange = () => localStorage.setItem('ov_voice', $('voice').value);
  $('preview').onclick = () => {
    const v = $('voice').value;
    if (v.startsWith('b:')) play(SAMPLES + BUILTIN[v.slice(2)][0]);
    else { const m = state.voices.find((x) => x.id === v.slice(2)); if (m) play(URL.createObjectURL(m.blob)); }
  };
  $('go').onclick = generate;
  $('stop').onclick = () => state.stop && state.stop.abort();
  $('download').onclick = () => state.current && download(state.current.blob, 'omran-voices-' + state.current.id + '.wav');
  $('recBtn').onclick = toggleRecord;
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = () => { const f = $('file').files[0]; if (f) useReference(f); $('file').value = ''; };
  $('saveVoice').onclick = saveVoice;
  $('unlock').onclick = () => { $('lockMsg').textContent = ''; tryUnlock($('key').value.trim()); };
  $('key').onkeydown = (e) => { if (e.key === 'Enter') $('unlock').click(); };
  $('foot').textContent = 'المحرك: Chatterbox Multilingual · الأصوات المحفوظة والسجل في جهازك بس';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (state.key) tryUnlock(state.key); else $('lock').classList.remove('hidden');
}
init();
