// Password check shared by the /api routes. The owner sets VOICES_ACCESS_KEY
// in Vercel; the page sends it in the X-Access-Key header. If the variable is
// missing the API refuses every request (fail closed).
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

module.exports = function checkAccess(req, res) {
  const expected = process.env.VOICES_ACCESS_KEY;
  if (!expected) {
    res.status(500).json({ error: 'كلمة السر مو مضبوطة في Vercel (VOICES_ACCESS_KEY).' });
    return false;
  }
  const given = req.headers['x-access-key'] || '';
  if (!crypto.timingSafeEqual(sha256(given), sha256(expected))) {
    res.status(401).json({ error: 'كلمة السر غلط.' });
    return false;
  }
  return true;
};
