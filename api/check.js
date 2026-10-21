const checkAccess = require('./_auth');

module.exports = (req, res) => {
  if (!checkAccess(req, res)) return;
  res.status(200).json({ ok: true, hfToken: Boolean(process.env.HF_TOKEN) });
};
