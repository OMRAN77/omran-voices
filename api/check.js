const checkAccess = require('./_auth');
const { hfToken, localStatus } = require('./_engine');

module.exports = async (req, res) => {
  if (!checkAccess(req, res)) return;
  // The token's state (never its value) goes to the Vercel logs, for diagnosis.
  console.log('check: HF_TOKEN ' + (hfToken() ? 'ok' : process.env.HF_TOKEN ? 'bad' : 'missing'));
  // The owner's own engine (engine-local/): off | bad | up | down | badkey.
  const engine = await localStatus();
  res.status(200).json({ ok: true, hfToken: Boolean(hfToken()), hfTokenSet: Boolean(process.env.HF_TOKEN), engine });
};
