// تدريب الصوتين الخفيفين (train/): اختيار الجمل، قاموس النطق مطابق للموقع، فحص المقاطع، قائمة التدريب،
// والنوتبوك مبني من نفس الملفات وكوده سليم. بدون GPU ولا تنزيل.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { python } = require('./_pc-fake.cjs');

test('train/test_train.py يمر', () => {
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  const r = require('child_process').spawnSync(py, [path.join(__dirname, '..', 'train', 'test_train.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
