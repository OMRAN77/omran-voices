// Password check shared by the /api routes. The owner sets VOICES_ACCESS_KEY
// in Vercel; the page sends it in the X-Access-Key header. If the variable is
// missing the API refuses every request (fail closed).
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

// The page sends the key URL-encoded: fetch() refuses header values outside
// Latin-1, so an Arabic password like «عبدالله» would never leave the browser.
function decodeKey(v) {
  const s = String(v || '');
  try { return decodeURIComponent(s); } catch { return s; }
}
// Same letters typed on another keyboard can differ in Unicode form, and a value
// pasted into Vercel often carries a trailing newline.
const norm = (s) => String(s).normalize('NFC').trim();

// One checker per key. The site password (VOICES_ACCESS_KEY, header X-Access-Key) is the
// default export. The recording page has its OWN key (VOICES_RECORD_KEY, header X-Record-Key):
// the private link the owner sends to friends must never open the voice engine, whose
// free Hugging Face quota belongs to the owner.
function makeCheck({ env, header, missing, wrong }) {
  return function check(req, res) {
    const expected = norm(process.env[env] || '');
    if (!expected) {
      res.status(500).json({ error: missing });
      return false;
    }
    const given = norm(decodeKey(req.headers[header]));
    if (!crypto.timingSafeEqual(sha256(given), sha256(expected))) {
      res.status(401).json({ error: wrong });
      return false;
    }
    return true;
  };
}

const checkAccess = makeCheck({
  env: 'VOICES_ACCESS_KEY',
  header: 'x-access-key',
  missing: 'كلمة السر مو مضبوطة في Vercel (VOICES_ACCESS_KEY).',
  wrong: 'كلمة السر غلط.',
});

module.exports = checkAccess;
module.exports.makeCheck = makeCheck;
