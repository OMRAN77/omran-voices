// The recording page's server.
//   POST /api/record            a batch of recordings -> saved in the private dataset
//   GET  /api/record            the minutes counter: every speaker + the total
//   GET  /api/record?check=1    for the owner: does the write token work, is the dataset private?
// Every call needs the page's own key (VOICES_RECORD_KEY, header X-Record-Key) — the key that is
// inside the private link, NOT the site password: the link goes to friends and must never open
// the voice engine. The storage is api/_recordings.js.
const { makeCheck } = require('./_auth');
const rec = require('./_recordings');

const checkKey = makeCheck({
  env: 'VOICES_RECORD_KEY',
  header: 'x-record-key',
  missing: 'مفتاح صفحة التسجيل مو مضبوط في Vercel (VOICES_RECORD_KEY).',
  wrong: 'الرابط غلط أو قديم. اطلب الرابط الجديد من عمران.',
});

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET أو POST فقط.' });
  if (!checkKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json(req.query && req.query.check ? await rec.check() : await rec.stats());
    }
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { return res.status(400).json({ error: 'الطلب مو JSON سليم.', code: 'input' }); }
    }
    return res.status(200).json(await rec.save(body || {}));
  } catch (e) {
    // For the owner's Vercel logs. The token and the key are masked.
    console.error('record failed:', e.name, e.code || '', String(e.message || '').replace(/Bearer\s+\S+|hf_\w+/g, '***').slice(0, 300));
    const known = e instanceof rec.RecordError;
    if (known && e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
    return res.status(known ? e.status : 500).json({ error: known ? e.message : 'صار خطأ في الخادم.', code: known ? e.code : 'server', retryAfter: known ? e.retryAfter : undefined });
  }
};
