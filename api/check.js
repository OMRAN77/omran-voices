const checkAccess = require('./_auth');
const { hfToken } = require('./_engine');

module.exports = (req, res) => {
  if (!checkAccess(req, res)) return;
  res.status(200).json({ ok: true, hfToken: Boolean(hfToken()), hfTokenSet: Boolean(process.env.HF_TOKEN) });
};
