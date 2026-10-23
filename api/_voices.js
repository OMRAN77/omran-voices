// The donors' voices. They live in a PRIVATE Hugging Face dataset (owner: omran77),
// never in this public repository and never behind a public link: only this server
// reads them, with HF_TOKEN, and hands the bytes to the engine at generation time.
//
// The dataset holds voices.json plus one WAV per voice (made by tools/prepare-donors.py):
//   [{ "id": "v1", "name": "<first name>", "gender": "m" | "f", "file": "v1.wav", "consent": true }]
// or voices.json alone, each voice carrying its WAV inside as base64 ("data" instead of
// "file", tools/prepare-donors.py --one-file): one file for the owner to upload.
// A voice without "consent": true is never listed or used.
//
// VOICES_DIR (a local folder with the same layout) replaces the dataset for local tests.
const fs = require('fs');
const path = require('path');
const { hfToken } = require('./_engine');

const LIST_TTL_MS = 5 * 60 * 1000;
let listCache = null; // { at, voices }
const wavCache = new Map(); // id -> Buffer (a warm server instance keeps them)

class VoicesError extends Error {
  constructor(message, status = 502, code = 'voices') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const dataset = () => String(process.env.VOICES_DATASET || 'omran77/omran-voices-donors').trim();

// A file at the top of the dataset: no folders, no "..". Browser downloads may add
// spaces or brackets ("voices (1).json"), so the name is URL-encoded, not rejected.
const okName = (name) => !!name && !/[\\/]|\.\./.test(name) && name.length <= 200;

async function readFile(name) {
  if (!okName(name)) throw new VoicesError('اسم ملف الصوت غلط.', 400, 'input');
  const dir = process.env.VOICES_DIR;
  if (dir) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      const e = new VoicesError('ملف الصوت مو موجود: ' + name, 404, 'missing');
      e.files = fs.readdirSync(dir);
      throw e;
    }
    return fs.readFileSync(p);
  }
  const token = hfToken();
  if (!token) throw new VoicesError('مستودع الأصوات خاص ويحتاج HF_TOKEN في Vercel.', 500, 'no_token');
  const url = `https://huggingface.co/datasets/${dataset()}/resolve/main/${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401 || r.status === 403) throw new VoicesError('HF_TOKEN ما يقدر يفتح مستودع الأصوات الخاص (' + r.status + ').', 502, 'denied');
  if (r.status === 404) {
    // Hugging Face answers 404 both when the file is not there and when this token
    // cannot see the private dataset; the dataset's own page tells them apart.
    const info = await fetch(`https://huggingface.co/api/datasets/${dataset()}`, { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
    if (info && info.ok) {
      const files = ((await info.json()).siblings || []).map((s) => s.rfilename).filter((f) => f !== '.gitattributes');
      const e = new VoicesError('ما لقيت ' + name + ' في المستودع ' + dataset() + '. الملفات اللي فيه: ' + (files.join('، ') || 'ولا ملف') + '.', 404, 'missing');
      e.files = files;
      throw e;
    }
    throw new VoicesError('مفتاح HF_TOKEN اللي في Vercel ما يشوف المستودع الخاص ' + dataset() + ': يمكن من حساب ثاني غير omran77، أو ما عنده صلاحية قراءة.', 502, 'denied');
  }
  if (!r.ok) throw new VoicesError('مستودع الأصوات ما رد (' + r.status + ').', 502, 'down');
  return Buffer.from(await r.arrayBuffer());
}

function clean(entry) {
  const id = String(entry && entry.id || '');
  const name = String(entry && entry.name || '').trim();
  const gender = entry && entry.gender === 'f' ? 'f' : entry && entry.gender === 'm' ? 'm' : '';
  const file = String(entry && entry.file || '');
  const data = typeof (entry && entry.data) === 'string' && entry.data.length > 1000 ? entry.data : '';
  if (!/^[\w-]{1,40}$/.test(id) || !name || !gender || !(data || /^[\w.-]+\.wav$/.test(file)) || entry.consent !== true) return null;
  return { id, name: name.split(/\s+/)[0], gender, file, data };
}

// voices.json, or else the dataset's only .json file whatever it is called.
async function listFile() {
  try { return await readFile('voices.json'); }
  catch (e) {
    const json = (e.files || []).filter((n) => /\.json$/i.test(n));
    if (e.code !== 'missing' || json.length !== 1) {
      if (e.code === 'missing' && json.length > 1) e.message += ' وفيه أكثر من ملف json، خلّ واحد بس أو سمّه voices.json.';
      throw e;
    }
    return readFile(json[0]);
  }
}

// Full catalog (server side only: includes file names).
async function catalog() {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.voices;
  let raw;
  try { raw = JSON.parse((await listFile()).toString('utf8')); }
  catch (e) {
    if (e instanceof VoicesError) throw e;
    throw new VoicesError('voices.json في مستودع الأصوات مو JSON سليم.', 502, 'bad_list');
  }
  const voices = (Array.isArray(raw) ? raw : []).map(clean).filter(Boolean);
  listCache = { at: Date.now(), voices };
  return voices;
}

// What the page may see: id, first name, gender. No file names, no links.
async function list() {
  return (await catalog()).map(({ id, name, gender }) => ({ id, name, gender }));
}

async function wav(id) {
  if (wavCache.has(id)) return wavCache.get(id);
  const v = (await catalog()).find((x) => x.id === id);
  if (!v) throw new VoicesError('الصوت مو موجود.', 404, 'unknown_voice');
  const buf = v.data ? Buffer.from(v.data, 'base64') : await readFile(v.file);
  wavCache.set(id, buf);
  return buf;
}

function reset() { listCache = null; wavCache.clear(); }

module.exports = { list, wav, reset, VoicesError };
