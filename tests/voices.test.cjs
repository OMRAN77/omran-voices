// أصوات المتبرعين: تنقرا من مستودع خاص على الخادم بس، والقائمة فيها الاسم الأول وريال/حرمة،
// وما فيه ولا عيّنة من Resemble، وكل صوت يشتغل مع كل لغة.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fresh = (rel) => { delete require.cache[require.resolve(path.join(ROOT, rel))]; return require(path.join(ROOT, rel)); };
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000, 1)]);

function storeDir(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-voices-'));
  fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify(entries));
  for (const e of entries) if (e.file && /^[\w.-]+$/.test(e.file)) fs.writeFileSync(path.join(dir, e.file), WAV);
  return dir;
}
const ENTRIES = [
  { id: 'v1', name: 'سالم أحمد', gender: 'm', file: 'v1.wav', consent: true },
  { id: 'v2', name: 'مريم', gender: 'f', file: 'v2.wav', consent: true },
  { id: 'v3', name: 'بدون موافقة', gender: 'f', file: 'v3.wav', consent: false },
  { id: 'v4', name: 'بدون جنس', gender: '', file: 'v4.wav', consent: true },
  { id: 'v5', name: 'ملف غلط', gender: 'm', file: '../x.wav', consent: true },
];

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

test('القائمة: الموافقين بس، بالاسم الأول وريال/حرمة، وبدون اسم ملف أو رابط', () =>
  withEnv({ VOICES_DIR: storeDir(ENTRIES) }, async () => {
    const voices = fresh('api/_voices.js');
    const list = await voices.list();
    assert.deepStrictEqual(list, [{ id: 'v1', name: 'سالم', gender: 'm' }, { id: 'v2', name: 'مريم', gender: 'f' }]);
    assert.ok(!JSON.stringify(list).includes('.wav'));
    assert.strictEqual((await voices.wav('v2')).length, WAV.length);
    await assert.rejects(voices.wav('v3'), /مو موجود/);
  }));

test('المستودع الخاص: يطلب بـHF_TOKEN، وبدونه أو برفض يطلع خطأ واضح', () =>
  withEnv({ VOICES_DIR: undefined, VOICES_DATASET: undefined, HF_TOKEN: 'hf_' + 'Ab1'.repeat(12) }, async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
      if (String(url).endsWith('/voices.json')) return Response.json([{ id: 'v1', name: 'سالم', gender: 'm', file: 'v1.wav', consent: true }]);
      return new Response(WAV);
    };
    try {
      fresh('api/_engine.js');
      const voices = fresh('api/_voices.js');
      assert.deepStrictEqual(await voices.list(), [{ id: 'v1', name: 'سالم', gender: 'm' }]);
      await voices.wav('v1');
      assert.deepStrictEqual(calls.map((c) => c.url), [
        'https://huggingface.co/datasets/omran77/omran-voices-donors/resolve/main/voices.json',
        'https://huggingface.co/datasets/omran77/omran-voices-donors/resolve/main/v1.wav',
      ]);
      assert.ok(calls.every((c) => c.auth === 'Bearer ' + process.env.HF_TOKEN));

      global.fetch = async () => new Response('no', { status: 401 });
      await assert.rejects(fresh('api/_voices.js').list(), (e) => e.code === 'denied');
      process.env.HF_TOKEN = '';
      fresh('api/_engine.js');
      await assert.rejects(fresh('api/_voices.js').list(), (e) => e.code === 'no_token');
    } finally { global.fetch = realFetch; fresh('api/_engine.js'); }
  }));

test('/api/tts بصوت متبرع: الملف ينرفع للمحرك أوّل مرّة، وبعدها مكانه، ولو انمسح ينرفع من جديد', () =>
  withEnv({ VOICES_DIR: storeDir(ENTRIES), VOICES_ACCESS_KEY: 'k' }, async () => {
    const engine = fresh('api/_engine.js');
    fresh('api/_voices.js');
    const real = engine.generate;
    const seen = [];
    let gone = false;
    engine.generate = async (args) => {
      seen.push(args.voice && args.voice.wav ? 'wav' : args.voice && args.voice.refPath ? 'ref' : 'none');
      if (gone && args.voice.refPath) { gone = false; throw new engine.EngineError('gone', 410, 'ref_gone'); }
      return { audio: Buffer.from('RIFF'), refPath: args.voice.wav ? '/tmp/gradio/abc/voice.wav' : undefined };
    };
    try {
      const tts = fresh('api/tts.js');
      const call = (lang) => {
        const res = { headers: {}, code: 0, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
        return tts({ method: 'POST', headers: { 'x-access-key': 'k' }, body: { text: 'hello', lang, voice: { donor: 'v1' } } }, res).then(() => res);
      };
      assert.strictEqual((await call('ar')).code, 200);
      const r2 = await call('en'); // نفس الصوت بلغة ثانية
      assert.strictEqual(r2.code, 200);
      assert.strictEqual(r2.headers['X-Ref-Path'], undefined, 'مكان صوت المتبرع ما يطلع للصفحة');
      gone = true;
      assert.strictEqual((await call('fr')).code, 200);
      assert.deepStrictEqual(seen, ['wav', 'ref', 'ref', 'wav']);
      const r4 = await (async () => {
        const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, send() { return this; } };
        await tts({ method: 'POST', headers: { 'x-access-key': 'k' }, body: { text: 'x', lang: 'ar', voice: { donor: 'v3' } } }, res);
        return res;
      })();
      assert.strictEqual(r4.code, 404, 'صوت بدون موافقة ما ينستخدم');
    } finally { engine.generate = real; }
  }));

test('/api/voices يحتاج كلمة السر، ويرجّع القائمة والعيّنة', () =>
  withEnv({ VOICES_DIR: storeDir(ENTRIES), VOICES_ACCESS_KEY: 'k' }, async () => {
    fresh('api/_voices.js');
    const handler = fresh('api/voices.js');
    const call = (key, query = {}) => {
      const res = { headers: {}, code: 0, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
      return handler({ method: 'GET', headers: key ? { 'x-access-key': key } : {}, query }, res).then(() => res);
    };
    assert.strictEqual((await call('')).code, 401);
    const ok = await call('k');
    assert.strictEqual(ok.body.voices.length, 2);
    const sample = await call('k', { sample: 'v2' });
    assert.strictEqual(sample.headers['Content-Type'], 'audio/wav');
    assert.strictEqual((await call('k', { sample: 'v4' })).code, 404);
  }));

test('ما فيه ولا عيّنة من Resemble، والمحرك يرفض الطلب بدون صوت', async () => {
  for (const f of ['app.js', 'index.html', 'api/_engine.js', 'api/tts.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/chatterbox-demo-samples|storage\.googleapis|builtin/i.test(src), f);
  }
  const engine = fresh('api/_engine.js');
  await assert.rejects(engine.generate({ text: 'x', lang: 'ar', voice: null }), (e) => e.code === 'no_voice');
  assert.strictEqual(engine.LANGS.length, 23);
});

test('الصفحة: القائمة «أصوات المتبرعين» بالاسم وريال/حرمة، وتغيير اللغة ما يغيّر الصوت', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(src, /const GENDER = \{ m: 'ريال', f: 'حرمة' \}/);
  assert.match(src, /optgroup label="أصوات المتبرعين"/);
  assert.match(src, /\$\('lang'\)\.onchange = \(\) => localStorage\.setItem\('ov_lang', \$\('lang'\)\.value\);/);
});
