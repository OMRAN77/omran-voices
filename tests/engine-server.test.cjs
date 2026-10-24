// خادم المحرك في جهاز المالك (engine-local/server.py) بنموذج وهمي: المفتاح، إرسال الصوت مرة وحدة، 410، المدخلات الغلط.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('engine-local/test_server.py يمر', () => {
  const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version']).status === 0);
  assert.ok(py, 'يحتاج Python 3');
  const r = spawnSync(py, [path.join(__dirname, '..', 'engine-local', 'test_server.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

// الموقع (api/_engine.js) والخادم (server.py) يتكلمون نفس اللغة: طلب حقيقي بين الاثنين بنموذج وهمي.
test('api/_engine.js مع server.py الحقيقي: أول قطعة بالملف، الثانية بالبصمة، والملف الممسوح يرجع ref_gone', async () => {
  const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version']).status === 0);
  const key = 'e2e-' + 'k'.repeat(28);
  const code = [
    'import sys, shutil, tempfile; sys.path.insert(0, sys.argv[1]); import server',
    'class F:',
    '    name = "fake"',
    '    def speak(self, text, lang, ref_id, ref_path, **a): return b"\\x00\\x01" * 240, 24000',
    'd = tempfile.mkdtemp(); s = server.make_server(F(), sys.argv[2], port=0, ref_dir=d)',
    'print(s.server_address[1], d, flush=True); s.serve_forever()',
  ].join('\n');
  const { spawn } = require('child_process');
  const child = spawn(py, ['-c', code, path.join(__dirname, '..', 'engine-local'), key]);
  let dir;
  try {
    let port;
    [port, dir] = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(String(d).trim().split(' ')));
      child.once('exit', (c) => reject(new Error('server exited ' + c)));
    });
    process.env.OV_ENGINE_URL = 'http://127.0.0.1:' + port;
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
    require('fs').rmSync(path.join(dir, a.refPath.slice(6) + '.wav'));
    await assert.rejects(e.generate({ text: 'شحالك', lang: 'ar', voice: { refPath: a.refPath } }), (err) => err.code === 'ref_gone');
  } finally {
    child.kill();
    if (dir) require('fs').rmSync(dir, { recursive: true, force: true });
    delete process.env.OV_ENGINE_URL;
    delete process.env.OV_ENGINE_KEY;
  }
});
