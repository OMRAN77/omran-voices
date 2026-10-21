// كلمة السر: العربيّة تصل مشفّرة من الصفحة، والخطأ يرفض، وغيابها يقفل الموقع.
const test = require('node:test');
const assert = require('node:assert');
const checkAccess = require('../api/_auth');

function call(headerValue) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { headers: headerValue === undefined ? {} : { 'x-access-key': headerValue } };
  return { ok: checkAccess(req, res), res };
}
function withKey(value, fn) {
  const old = process.env.VOICES_ACCESS_KEY;
  if (value === undefined) delete process.env.VOICES_ACCESS_KEY; else process.env.VOICES_ACCESS_KEY = value;
  try { fn(); } finally { if (old === undefined) delete process.env.VOICES_ACCESS_KEY; else process.env.VOICES_ACCESS_KEY = old; }
}

test('كلمة سر عربيّة تمرّ كما ترسلها الصفحة (encodeURIComponent)', () => {
  withKey('عبدالله', () => {
    const { ok, res } = call(encodeURIComponent('عبدالله'));
    assert.strictEqual(ok, true, JSON.stringify(res.body));
  });
});

test('fetch يرفض ترويسة عربيّة خامًا — لذلك الصفحة تشفّرها', () => {
  assert.throws(() => new Headers({ 'X-Access-Key': 'عبدالله' }));
  assert.doesNotThrow(() => new Headers({ 'X-Access-Key': encodeURIComponent('عبدالله') }));
});

test('سطر زائد في متغيّر Vercel لا يكسر الدخول', () => {
  withKey('عبدالله\n', () => assert.strictEqual(call(encodeURIComponent('عبدالله')).ok, true));
});

test('كلمة سر غلط = 401', () => {
  withKey('عبدالله', () => {
    const { ok, res } = call(encodeURIComponent('عبدالرحمن'));
    assert.strictEqual(ok, false);
    assert.strictEqual(res.code, 401);
  });
  withKey('عبدالله', () => assert.strictEqual(call(undefined).res.code, 401));
  withKey('abc', () => assert.strictEqual(call('%E0%A4%A').res.code, 401)); // ترميز مكسور لا يرمي
});

test('كلمة سر لاتينيّة تمرّ مشفّرة أو خامًا', () => {
  withKey('Om ai 77%', () => {
    assert.strictEqual(call(encodeURIComponent('Om ai 77%')).ok, true);
  });
  withKey('omran77', () => assert.strictEqual(call('omran77').ok, true));
});

test('بلا VOICES_ACCESS_KEY يرفض كلّ طلب (500)', () => {
  withKey(undefined, () => {
    const { ok, res } = call(encodeURIComponent('أي شي'));
    assert.strictEqual(ok, false);
    assert.strictEqual(res.code, 500);
  });
  withKey('   ', () => assert.strictEqual(call('').res.code, 500));
});
