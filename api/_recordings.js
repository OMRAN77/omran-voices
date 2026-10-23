// The friends' recordings. Every recording is a WAV with its text, saved in a PRIVATE
// Hugging Face dataset of the owner (default omran77/omran-voices-recordings). Never in
// GitHub, never behind a public link: this server writes with HF_WRITE_TOKEN and nothing
// else can.
//
// Layout of the dataset (the "audiofolder" layout, so the Hub's viewer and `datasets` read it):
//   data/<name>-<hash6>/b<hash10>-n<count>-d<deciseconds>/
//       <sentence id>_<recording id>.wav
//       metadata.jsonl        one line per WAV: file_name, text, original_text, edited, speaker, ...
// One upload = one folder = one commit. The folder name carries the batch's size
// (n = recordings, d = tenths of a second), so the minutes counter only lists folder names:
// no shared counter file to update, so two people recording at once can never overwrite
// each other's numbers, and the numbers always match what is really stored.
//
// The protocol (preupload -> LFS batch -> PUT -> commit) is the one the official
// @huggingface/hub client uses, written with fetch like the rest of this project.
// HF_ENDPOINT replaces https://huggingface.co for local tests.
const crypto = require('crypto');

const TARGET_RATE_MIN = 8000;
const TARGET_RATE_MAX = 48000;
const MAX_ITEMS = 12;
const MAX_WAV_BYTES = 1300000;       // ~27 s at 24 kHz mono 16-bit
const MIN_SEC = 0.5;
const MAX_SEC = 30;
const MAX_TEXT = 300;
const STATS_TTL_MS = 20 * 1000;
const REPO_TTL_MS = 10 * 60 * 1000;
const REGS = ['gulf', 'ar', 'msa'];

class RecordError extends Error {
  constructor(message, status = 502, code = 'record', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const hub = () => String(process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const dataset = () => String(process.env.VOICES_RECORD_DATASET || 'omran77/omran-voices-recordings').trim();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mask = (s) => String(s || '').replace(/Bearer\s+\S+|hf_\w+/g, '***');

// The WRITE token. It is a different variable from HF_TOKEN (read-only, used by the voice
// engine) so the engine never holds the power to write, and a leak of one does not give the other.
// Same cleaning as api/_engine.js: invisible direction marks from an Arabic keyboard are removed.
function writeToken() {
  const t = String(process.env.HF_WRITE_TOKEN || '').replace(/[\s​-‏‪-‮⁦-⁩﻿]/g, '');
  return /^hf_[A-Za-z0-9]{20,}$/.test(t) ? t : '';
}
function needToken() {
  const t = writeToken();
  if (!t) {
    throw new RecordError(process.env.HF_WRITE_TOKEN
      ? 'HF_WRITE_TOKEN في Vercel شكله غلط (لازم يبدأ بـ hf_).'
      : 'مفتاح الكتابة HF_WRITE_TOKEN مو مضبوط في Vercel.', 500, 'no_token');
  }
  return t;
}

/* ---------- names ---------- */
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, 30).trim();
}
// Folder of one speaker: readable name + a short hash, so "سالم" and "سالم " are one person
// and two different names that clean to the same letters stay apart.
function speakerDir(name) {
  const low = cleanName(name).toLocaleLowerCase();
  const base = low.replace(/\s+/g, '_').replace(/[^\p{L}\p{M}\p{N}_-]/gu, '').replace(/^[-_.]+/, '').slice(0, 30) || 'spk';
  return base + '-' + sha256(Buffer.from(low, 'utf8')).slice(0, 6);
}
const nameOfDir = (dir) => String(dir).replace(/-[0-9a-f]{6}$/, '').replace(/_/g, ' ');

/* ---------- WAV check ---------- */
// The page writes mono 16-bit PCM. The server does not trust the claim: it reads the header,
// derives the duration itself, and refuses what cannot be a real recording.
function inspectWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return { error: 'ملف قصير' };
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return { error: 'مو WAV' };
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    } else if (id === 'data') {
      data = { start: pos + 8, length: Math.min(size, buf.length - (pos + 8)) };
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { error: 'WAV ناقص' };
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return { error: 'لازم WAV أحادي 16 بت' };
  if (fmt.rate < TARGET_RATE_MIN || fmt.rate > TARGET_RATE_MAX) return { error: 'معدّل العيّنات غريب' };
  const seconds = data.length / (fmt.rate * 2);
  if (seconds < MIN_SEC) return { error: 'التسجيل قصير' };
  if (seconds > MAX_SEC) return { error: 'التسجيل طويل' };
  let peak = 0;
  for (let i = data.start; i + 1 < data.start + data.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak < 40) return { error: 'التسجيل صامت' };
  return { rate: fmt.rate, seconds: Math.round(seconds * 100) / 100 };
}

function cleanText(raw, max = MAX_TEXT) {
  return String(raw == null ? '' : raw).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ---------- Hugging Face calls ---------- */
async function call(path, { method = 'GET', token, json, body, headers = {} } = {}) {
  // A presigned storage URL (token: null) must not get the Hub token: it is signed already,
  // and the token goes only to the Hub itself.
  const h = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  try { return await fetch(path.startsWith('http') ? path : hub() + path, { method, headers: h, body: payload }); }
  catch (e) { throw new RecordError('ما قدرت أوصل Hugging Face: ' + mask(e && e.message).slice(0, 120), 502, 'down'); }
}

// Anything that is not a success becomes a short Arabic message for the owner's Vercel logs
// and for the page; HF's own text is kept (masked) so the cause is visible.
async function fail(r, what) {
  const text = mask(await r.text().catch(() => '')).slice(0, 200);
  if (r.status === 401 || r.status === 403) {
    return new RecordError('HF_WRITE_TOKEN ما عنده صلاحية كتابة على ' + dataset() + ' (' + r.status + '). لازم مفتاح Write من حساب omran77.', 502, 'denied');
  }
  if (r.status === 429) {
    const wait = parseInt(r.headers.get('retry-after') || '', 10);
    return new RecordError('Hugging Face يطلب ننتظر شوي قبل الرفع.', 503, 'rate', { retryAfter: wait > 0 ? wait : 60 });
  }
  if (r.status >= 500) return new RecordError('Hugging Face مشغول الحين (' + r.status + ').', 502, 'down');
  return new RecordError(what + ' (' + r.status + ')' + (text ? ': ' + text : ''), 502, 'hf');
}

const CARD = [
  '---', 'pretty_name: omran-voices recordings', 'task_categories:', '- automatic-speech-recognition', '- text-to-speech',
  'language:', '- ar', 'license: other', '---', '',
  '# omran-voices recordings', '',
  'Private dataset. Friends read everyday sentences (Emirati/Gulf dialect, general Arabic, Modern Standard Arabic).',
  'Every WAV is mono 16-bit PCM with its text. `data/<speaker>/<batch>/metadata.jsonl` lists `file_name`, `text`',
  '(what was actually read, after any edit), `original_text`, `edited`, `speaker`, `sentence_id`, `register`,',
  '`topic`, `duration`, `sampling_rate`, `recorded_at`, `consent`.', '',
].join('\n');

let repoCheckedAt = 0;
async function ensureRepo(token) {
  if (Date.now() - repoCheckedAt < REPO_TTL_MS) return;
  const repo = dataset();
  const [org, name] = repo.split('/');
  if (!org || !name) throw new RecordError('VOICES_RECORD_DATASET لازم يكون بشكل «حساب/اسم».', 500, 'config');
  let r = await call('/api/datasets/' + repo, { token });
  if (r.status === 404) {
    const c = await call('/api/repos/create', {
      method: 'POST', token,
      json: { name, organization: org, type: 'dataset', visibility: 'private', files: [{ path: 'README.md', encoding: 'base64', content: Buffer.from(CARD).toString('base64') }] },
    });
    if (c.status === 409) throw new RecordError('المستودع ' + repo + ' موجود بس هذا المفتاح ما يشوفه: تأكّد إنه من حساب omran77 وفيه صلاحية Write.', 502, 'denied');
    if (!c.ok) throw await fail(c, 'ما قدرت أسوّي مستودع التسجيلات');
    r = await call('/api/datasets/' + repo, { token });
  }
  if (!r.ok) throw await fail(r, 'ما قدرت أقرا مستودع التسجيلات');
  const info = await r.json().catch(() => ({}));
  // The friends' voices must never sit in a public dataset.
  if (info.private !== true) throw new RecordError('المستودع ' + repo + ' عام! أصوات الناس ما تنرفع فيه. خلّه Private من Settings في Hugging Face.', 500, 'public_repo');
  repoCheckedAt = Date.now();
}

const treeUrl = (path) => '/api/datasets/' + dataset() + '/tree/main' + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '') + '?recursive=false&expand=false';

// All entries directly inside `path` ([] when the folder does not exist yet).
async function listDir(token, path) {
  const out = [];
  let url = treeUrl(path);
  for (let page = 0; url && page < 50; page++) {
    const r = await call(url, { token, headers: { accept: 'application/json' } });
    if (r.status === 404) return out;
    if (!r.ok) throw await fail(r, 'ما قدرت أقرا قائمة الملفات');
    out.push(...await r.json());
    const next = (r.headers.get('link') || '').match(/<(https?:[^>]+)>;\s*rel="next"/);
    // Follow only links that stay on the Hub: the token is never sent anywhere else.
    url = next && next[1].startsWith(hub() + '/') ? next[1] : '';
  }
  return out;
}

async function pathExists(token, path) {
  const r = await call(treeUrl(path), { token, headers: { accept: 'application/json' } });
  if (r.status === 404) return false;
  if (!r.ok) throw await fail(r, 'ما قدرت أتأكّد من الدفعة');
  return true;
}

// preupload -> (LFS batch -> PUT) -> commit, as the official client does it.
async function commitFiles(token, files, title) {
  const repo = dataset();
  const pre = await call('/api/datasets/' + repo + '/preupload/main', {
    method: 'POST', token,
    json: { files: files.map((f) => ({ path: f.path, size: f.bytes.length, sample: f.bytes.subarray(0, 512).toString('base64') })) },
  });
  if (!pre.ok) throw await fail(pre, 'فحص الرفع فشل');
  const modes = new Map(((await pre.json().catch(() => ({}))).files || []).map((f) => [f.path, f]));
  const todo = files.filter((f) => !(modes.get(f.path) || {}).shouldIgnore);
  const lfs = todo.filter((f) => ((modes.get(f.path) || {}).uploadMode || (/\.wav$/.test(f.path) ? 'lfs' : 'regular')) === 'lfs');
  for (const f of lfs) f.oid = sha256(f.bytes);

  if (lfs.length) {
    const b = await call('/datasets/' + repo + '.git/info/lfs/objects/batch', {
      method: 'POST', token,
      headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], hash_algo: 'sha_256', ref: { name: 'main' }, objects: lfs.map((f) => ({ oid: f.oid, size: f.bytes.length })) }),
    });
    if (!b.ok) throw await fail(b, 'طلب مكان التخزين فشل');
    const j = await b.json().catch(() => ({}));
    if (j.transfer && j.transfer !== 'basic') throw new RecordError('Hugging Face طلب طريقة رفع غير مدعومة (' + j.transfer + ').', 502, 'protocol');
    const byOid = new Map(lfs.map((f) => [f.oid, f]));
    const jobs = [];
    for (const o of j.objects || []) {
      const f = byOid.get(o.oid);
      if (!f) throw new RecordError('Hugging Face رجّع ملف ما طلبناه.', 502, 'protocol');
      if (o.error) throw new RecordError('Hugging Face رفض ' + f.path + ': ' + mask(o.error.message), 502, 'hf');
      if (!o.actions || !o.actions.upload) continue; // already stored
      const up = o.actions.upload;
      if (up.header && up.header.chunk_size) throw new RecordError('ملف التسجيل كبير على الرفع البسيط.', 502, 'protocol');
      jobs.push(async () => {
        const r = await call(up.href, { method: 'PUT', token: null, body: f.bytes, headers: Object.assign({}, up.header || {}) });
        if (!r.ok) throw await fail(r, 'رفع ' + f.path + ' فشل');
      });
    }
    // 4 uploads at a time
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((fn) => fn()));
  }

  const lines = [{ key: 'header', value: { summary: title } }];
  for (const f of todo) {
    if (f.oid) lines.push({ key: 'lfsFile', value: { path: f.path, algo: 'sha256', size: f.bytes.length, oid: f.oid } });
    else lines.push({ key: 'file', value: { content: f.bytes.toString('base64'), path: f.path, encoding: 'base64' } });
  }
  const c = await call('/api/datasets/' + repo + '/commit/main', {
    method: 'POST', token, headers: { 'Content-Type': 'application/x-ndjson' }, body: lines.map((x) => JSON.stringify(x)).join('\n'),
  });
  if (!c.ok) throw await fail(c, 'الحفظ في المستودع فشل');
}

/* ---------- saving ---------- */
let statsCache = null;

// body: { speaker, consent, items: [{ rid, sid, text, original, reg, topic, ts, wav (base64) }] }
// Returns which recordings are safely stored and which were refused (and why), so the page
// can delete both from its queue and never retry a recording that can never be accepted.
async function save(body) {
  const token = needToken();
  const speaker = cleanName(body && body.speaker);
  if (speaker.length < 2) throw new RecordError('اكتب اسمك (حرفين على الأقل).', 400, 'input');
  const items = Array.isArray(body && body.items) ? body.items : [];
  if (!items.length) throw new RecordError('ما فيه تسجيلات.', 400, 'input');
  if (items.length > MAX_ITEMS) throw new RecordError('الدفعة كبيرة: أقصى شي ' + MAX_ITEMS + ' تسجيل.', 413, 'too_big');

  const dir = speakerDir(speaker);
  const good = [], rejected = [], seen = new Set();
  for (const it of items) {
    const rid = String((it && it.rid) || '');
    if (!/^[a-z0-9]{6,32}$/.test(rid) || seen.has(rid)) { rejected.push({ rid, reason: 'معرّف غلط' }); continue; }
    seen.add(rid);
    const text = cleanText(it.text);
    if (!text) { rejected.push({ rid, reason: 'النص فاضي' }); continue; }
    const b64 = String(it.wav || '');
    if (b64.length > MAX_WAV_BYTES * 1.4) { rejected.push({ rid, reason: 'الملف كبير' }); continue; }
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > MAX_WAV_BYTES) { rejected.push({ rid, reason: 'الملف كبير' }); continue; }
    const w = inspectWav(bytes);
    if (w.error) { rejected.push({ rid, reason: w.error }); continue; }
    const sid = Number.isInteger(it.sid) && it.sid >= 0 && it.sid < 1000000 ? it.sid : -1;
    const original = cleanText(it.original) || text;
    const ts = Number(it.ts) > 0 ? new Date(Number(it.ts)) : new Date();
    good.push({
      rid, bytes, name: String(Math.max(sid, 0)).padStart(5, '0') + '_' + rid + '.wav',
      meta: {
        text, original_text: original, edited: text !== original, speaker, speaker_id: dir,
        sentence_id: sid, register: REGS.includes(it.reg) ? it.reg : '', topic: cleanText(it.topic, 30),
        duration: w.seconds, sampling_rate: w.rate, recorded_at: isNaN(ts) ? new Date().toISOString() : ts.toISOString(), consent: body.consent === true,
      },
    });
  }
  if (!good.length) return { ok: true, saved: [], rejected, batch: '', seconds: 0, count: 0 };

  const deci = Math.round(good.reduce((s, g) => s + g.meta.duration, 0) * 10);
  // Same recordings -> same folder name: a retry after a lost answer finds its folder and
  // stops, instead of storing (and counting) the batch twice.
  const batch = 'b' + sha256(Buffer.from(good.map((g) => g.rid).sort().join(','))).slice(0, 10) + '-n' + good.length + '-d' + deci;
  const base = 'data/' + dir + '/' + batch;
  await ensureRepo(token);
  const result = { ok: true, saved: good.map((g) => g.rid), rejected, batch, seconds: deci / 10, count: good.length };
  if (await pathExists(token, base)) return Object.assign(result, { duplicate: true });

  const files = good.map((g) => ({ path: base + '/' + g.name, bytes: g.bytes }));
  const jsonl = good.map((g) => JSON.stringify(Object.assign({ file_name: g.name }, g.meta))).join('\n') + '\n';
  files.push({ path: base + '/metadata.jsonl', bytes: Buffer.from(jsonl, 'utf8') });
  await commitFiles(token, files, 'recordings: ' + good.length + ' from ' + dir);
  statsCache = null;
  return result;
}

/* ---------- minutes counter ---------- */
// From the folder names only: n and d of every batch folder, per speaker folder.
async function stats() {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;
  const token = needToken();
  await ensureRepo(token);
  const speakers = (await listDir(token, 'data')).filter((e) => e.type === 'directory');
  const rows = [];
  for (let i = 0; i < speakers.length; i += 6) {
    rows.push(...await Promise.all(speakers.slice(i, i + 6).map(async (s) => {
      const dir = String(s.path).split('/').pop();
      let count = 0, deci = 0;
      for (const b of await listDir(token, s.path)) {
        const m = b.type === 'directory' && /-n(\d+)-d(\d+)$/.exec(String(b.path));
        if (m) { count += +m[1]; deci += +m[2]; }
      }
      return { id: dir, name: nameOfDir(dir), count, seconds: deci / 10 };
    })));
  }
  rows.sort((a, b) => b.seconds - a.seconds);
  const data = {
    speakers: rows,
    total: { count: rows.reduce((s, r) => s + r.count, 0), seconds: Math.round(rows.reduce((s, r) => s + r.seconds, 0) * 10) / 10 },
    at: Date.now(),
  };
  statsCache = { at: Date.now(), data };
  return data;
}

// For the owner after setting the Vercel variables: does the token work, is the dataset there and private?
async function check() {
  const out = { repo: dataset(), token: process.env.HF_WRITE_TOKEN ? (writeToken() ? 'ok' : 'bad') : 'missing' };
  if (out.token !== 'ok') return Object.assign(out, { ok: false });
  const token = writeToken();
  const who = await call('/api/whoami-v2', { token });
  out.user = who.ok ? String((await who.json().catch(() => ({}))).name || '') : '';
  repoCheckedAt = 0;
  await ensureRepo(token);
  return Object.assign(out, { ok: true, private: true });
}

function reset() { statsCache = null; repoCheckedAt = 0; }

module.exports = { save, stats, check, reset, cleanName, speakerDir, nameOfDir, inspectWav, cleanText, writeToken, RecordError, MAX_ITEMS };
