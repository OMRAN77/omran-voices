// خادم المحرك في جهاز المالك (engine-local/server.py) بنموذج وهمي: المفتاح، إرسال الصوت مرة وحدة، 410، المدخلات الغلط.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startPc, python } = require('./_pc-fake.cjs');

test('engine-local/test_server.py يمر', () => {
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  const r = require('child_process').spawnSync(py, [path.join(__dirname, '..', 'engine-local', 'test_server.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

// الموقع (api/_engine.js) والخادم (server.py) يتكلمون نفس اللغة: طلب حقيقي بين الاثنين بنموذج وهمي.
test('api/_engine.js مع server.py الحقيقي: أول قطعة بالملف، الثانية بالبصمة، والملف الممسوح يرجع ref_gone', async () => {
  const key = 'e2e-' + 'k'.repeat(28);
  const pc = await startPc(key);
  try {
    process.env.OV_ENGINE_URL = pc.url;
    process.env.OV_ENGINE_KEY = key;
    const enginePath = path.join(__dirname, '..', 'api', '_engine.js');
    delete require.cache[require.resolve(enginePath)];
    const e = require(enginePath);
    assert.strictEqual(await e.localStatus(), 'up');
    const wav = Buffer.alloc(5000, 3);
    const a = await e.generate({ text: 'هلا والله', lang: 'ar', voice: { wav } });
    assert.match(a.refPath, /^local:[0-9a-f]{64}$/);
    assert.strictEqual(a.audio.subarray(0, 4).toString(), 'RIFF');
    const b = await e.generate({ text: 'شحالك', lang: 'ar', voice: { refPath: a.refPath } });
    assert.strictEqual(b.audio.subarray(0, 4).toString(), 'RIFF');
    require('fs').rmSync(path.join(pc.dir, a.refPath.slice(6) + '.wav'));
    await assert.rejects(e.generate({ text: 'شحالك', lang: 'ar', voice: { refPath: a.refPath } }), (err) => err.code === 'ref_gone');
  } finally {
    pc.close();
    delete process.env.OV_ENGINE_URL;
    delete process.env.OV_ENGINE_KEY;
  }
});
