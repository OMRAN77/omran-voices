// تدريب صوت خاص من تسجيلات حقيقية (train/prep_real.py): تقطيع الكلام عند السكتات، إيجاد جمل الشاشة داخل
// الكلام، فحص الطول، الوقف على آخر الكلمة، والنوتبوك مبني من نفس الملفات وكوده سليم. بدون GPU ولا تنزيل.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { python } = require('./_pc-fake.cjs');

test('train/test_real.py يمر', () => {
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  const r = require('child_process').spawnSync(py, [path.join(__dirname, '..', 'train', 'test_real.py')],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
