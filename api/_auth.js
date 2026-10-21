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

module.exports = function checkAccess(req, res) {
  const expected = norm(process.env.VOICES_ACCESS_KEY || '');
  if (!expected) {
    res.status(500).json({ error: 'كلمة السر مو مضبوطة في Vercel (VOICES_ACCESS_KEY).' });
    return false;
  }
  const given = norm(decodeKey(req.headers['x-access-key']));
  if (!crypto.timingSafeEqual(sha256(given), sha256(expected))) {
    res.status(401).json({ error: 'كلمة السر غلط.' });
    return false;
  }
  return true;
};
