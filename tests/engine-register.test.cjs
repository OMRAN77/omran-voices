// الجهاز يبلّغ الموقع برابط النفق (POST /api/engine) لأنه يتغيّر كل تشغيل. الموقع يتأكّد إن الرابط
// يرد بنفس المفتاح، ويحفظه في مستودع التسجيلات الخاص، وكل نسخة من الخادم تقراه من هناك.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { start } = require('./_hf-mock.cjs');
const { startPc } = require('./_pc-fake.cjs');

const REPO = 'omran77/test-recordings';
const KEY = 'reg-' + 'k'.repeat(28);
const fresh = (rel) => {
  for (const m of ['api/_engine.js', 'api/_recordings.js', 'api/engine.js']) delete require.cache[require.resolve(path.join(__dirname, '..', m))];
  return require(path.join(__dirname, '..', rel));
};

async function withSite(env, fn) {
  const hub = await start();
  hub.state.repos.set(REPO, { private: true, files: new Map() });
  let pc;
  try { pc = await startPc(KEY); } catch (e) { await hub.close(); throw e; }
  const all = { HF_ENDPOINT: hub.url, HF_WRITE_TOKEN: hub.token, HF_TOKEN: hub.token, VOICES_RECORD_DATASET: REPO, OV_ENGINE_KEY: KEY, OV_ENGINE_URL: undefined, ...env };
  const old = {};
  for (const [k, v] of Object.entries(all)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn({ hub, pc, files: hub.state.repos.get(REPO).files }); } finally {
    pc.close();
    await hub.close();
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function post(body, headers = {}) {
  const handler = fresh('api/engine.js');
  let out;
  const res = { status(c) { this.code = c; return this; }, json(o) { out = o; return this; } };
  await handler({ method: 'POST', headers, body }, res);
  return { status: res.code, body: out };
}

test('مفتاح غلط أو ناقص: ما ينحفظ شي', () =>
  withSite({}, async ({ pc, files }) => {
    assert.deepStrictEqual(await post({ url: pc.url }, { 'x-engine-key': 'wrong-key-wrong-key' }), { status: 401, body: { error: 'This key is not the OV_ENGINE_KEY in Vercel.', code: 'key' } });
    assert.strictEqual((await post({ url: pc.url }, {})).status, 401);
    assert.strictEqual(files.has('engine-address'), false);
  }));

test('بدون OV_ENGINE_KEY في Vercel: 500 برمز no_key عشان الجهاز يقول وش الناقص', () =>
  withSite({ OV_ENGINE_KEY: undefined }, async ({ pc }) => {
    const r = await post({ url: pc.url }, { 'x-engine-key': KEY });
    assert.deepStrictEqual([r.status, r.body.code], [500, 'no_key']);
  }));

test('رابط ما يرد أو مو رابط: ما ينحفظ', () =>
  withSite({}, async ({ files }) => {
    assert.deepStrictEqual((await post({ url: 'http://127.0.0.1:1' }, { 'x-engine-key': KEY })).body.code, 'unreachable');
    assert.deepStrictEqual((await post({ url: 'http://example.com' }, { 'x-engine-key': KEY })).body.code, 'input');
    assert.deepStrictEqual((await post({ url: 'javascript:alert(1)' }, { 'x-engine-key': KEY })).body.code, 'input');
    assert.strictEqual(files.has('engine-address'), false);
  }));

test('تسجيل صحيح: ينحفظ في المستودع الخاص، ونسخة جديدة من الخادم تلقى الجهاز وتولّد منه', () =>
  withSite({}, async ({ hub, pc, files }) => {
    const r = await post({ url: pc.url + '/' }, { 'x-engine-key': KEY });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
    assert.strictEqual(JSON.parse(files.get('engine-address').bytes.toString()).url, pc.url);

    // another server instance: nothing in memory, it reads the address from the dataset
    const e = fresh('api/_engine.js');
    assert.strictEqual(await e.localStatus(), 'up');
    const out = await e.generate({ text: 'هلا والله', lang: 'ar', voice: { wav: Buffer.alloc(5000, 1) } });
    assert.match(out.refPath, /^local:/);
    const read = hub.state.calls.find((c) => c.path === '/datasets/' + REPO + '/resolve/main/engine-address');
    assert.ok(read && read.status === 200);
  }));

test('OV_ENGINE_URL في Vercel يغلب الرابط المسجّل', () =>
  withSite({}, async ({ pc, files }) => {
    files.set('engine-address', { bytes: Buffer.from(JSON.stringify({ url: 'http://127.0.0.1:1' })) });
    process.env.OV_ENGINE_URL = pc.url;
    const e = fresh('api/_engine.js');
    assert.strictEqual(await e.localStatus(), 'up');
  }));

test('بدون تسجيل وبدون OV_ENGINE_URL: الحالة down والصوت يطلع من المحرك العام', () =>
  withSite({}, async () => {
    const e = fresh('api/_engine.js');
    assert.strictEqual(await e.localStatus(), 'down');
  }));
