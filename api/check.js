const checkAccess = require('./_auth');
const { hfToken } = require('./_engine');

module.exports = (req, res) => {
  if (!checkAccess(req, res)) return;
  // The token's state (never its value) goes to the Vercel logs, for diagnosis.
  console.log('check: HF_TOKEN ' + (hfToken() ? 'ok' : process.env.HF_TOKEN ? 'bad' : 'missing'));
  res.status(200).json({ ok: true, hfToken: Boolean(hfToken()), hfTokenSet: Boolean(process.env.HF_TOKEN) });
};
