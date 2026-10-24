'use strict';
// A local stand-in for huggingface.co, only as far as api/_recordings.js uses it. It follows what the
// official @huggingface/hub client does (preupload -> LFS batch -> PUT -> NDJSON commit) and is
// strict where the real Hub is strict, so a wrong request fails here instead of in production:
//  - the storage PUT must NOT carry the Hub token (the real URL is presigned),
//  - an LFS file in a commit must already have been uploaded with the right size and sha256,
//  - a missing folder answers 404, a private repo is invisible to a wrong token,
//  - the tree listing is paged through a Link header.
// It is NOT the real Hub: nothing here proves the real service accepts the same calls.
const http = require('http');
const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function start(opts = {}) {
  const TOKEN = opts.token || 'hf_' + 'Ab1'.repeat(12);
  const state = {
    repos: new Map(),     // 'org/name' -> { private, files: Map(path -> { oid?, bytes }) , commits }
    objects: new Map(),   // oid -> Buffer (the LFS storage)
    calls: [],            // { method, path, auth, status }
    commits: [],          // { repo, summary, lines }
    pageSize: opts.pageSize || 1000,
    failCommit: 0,        // next commit answers this status
    failBatch: 0,
    publicOnCreate: !!opts.publicOnCreate,
  };
  let base = '';

  const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(buf);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    const auth = req.headers.authorization || '';
    const log = { method: req.method, path, auth: auth ? 'yes' : 'no' };
    state.calls.push(log);
    const done = (status, body, headers) => { log.status = status; send(res, status, body, headers); };
    const body = await readBody(req);
    const authed = auth === 'Bearer ' + TOKEN;

    // presigned storage: no Hub token allowed
    let m = /^\/s3\/([0-9a-f]{64})$/.exec(path);
    if (m && req.method === 'PUT') {
      if (auth) return done(400, { error: 'presigned URL must not carry Authorization' });
      if (sha256(body) !== m[1]) return done(400, { error: 'checksum mismatch' });
      state.objects.set(m[1], body);
      return done(200, '');
    }

    if (!authed) return done(401, { error: 'Invalid credentials in Authorization header' });
    if (path === '/api/whoami-v2') return done(200, { name: 'omran77' });

    if (path === '/api/repos/create' && req.method === 'POST') {
      const j = JSON.parse(body.toString());
      const id = j.organization + '/' + j.name;
      if (state.repos.has(id)) return done(409, { error: 'You already created this dataset repo' });
      const files = new Map();
      for (const f of j.files || []) files.set(f.path, { bytes: Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8') });
      state.repos.set(id, { private: state.publicOnCreate ? false : j.visibility === 'private', files });
      return done(200, { url: base + '/datasets/' + id, name: id, id });
    }

    m = /^\/api\/datasets\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const id = m[1], rest = m[2] || '';
      const repo = state.repos.get(id);
      if (!repo) return done(404, { error: 'Repository not found' });
      if (rest === '') return done(200, { id, private: repo.private });

      if (rest === '/preupload/main' && req.method === 'POST') {
        const j = JSON.parse(body.toString());
        return done(200, { files: j.files.map((f) => ({ path: f.path, uploadMode: /\.wav$/.test(f.path) ? 'lfs' : 'regular', shouldIgnore: false })) });
      }

      if (rest === '/commit/main' && req.method === 'POST') {
        if (state.failCommit) { const s = state.failCommit; state.failCommit = 0; return done(s, { error: 'commit refused' }, s === 429 ? { 'Retry-After': '17' } : {}); }
        if (req.headers['content-type'] !== 'application/x-ndjson') return done(400, { error: 'commit body must be ndjson' });
        const lines = body.toString().split('\n').map((l) => JSON.parse(l));
        if (lines[0].key !== 'header' || !lines[0].value.summary) return done(400, { error: 'missing header' });
        const staged = [];
        for (const l of lines.slice(1)) {
          if (l.key === 'lfsFile') {
            const o = state.objects.get(l.value.oid);
            if (!o || o.length !== l.value.size || l.value.algo !== 'sha256') return done(400, { error: 'LFS pointer for ' + l.value.path + ' has no uploaded object' });
            staged.push([l.value.path, { oid: l.value.oid, bytes: o }]);
          } else if (l.key === 'file') {
            if (/\.wav$/.test(l.value.path)) return done(400, { error: 'binary files must go through LFS: ' + l.value.path });
            staged.push([l.value.path, { bytes: Buffer.from(l.value.content, 'base64') }]);
          } else return done(400, { error: 'unknown operation ' + l.key });
        }
        for (const [p, f] of staged) repo.files.set(p, f);
        state.commits.push({ repo: id, summary: lines[0].value.summary, lines });
        return done(200, { commitOid: 'c' + state.commits.length, commitUrl: base + '/c', hookOutput: '' });
      }

      m = /^\/tree\/main(\/.*)?$/.exec(rest);
      if (m && req.method === 'GET') {
        const dir = (m[1] || '').replace(/^\//, '');
        const prefix = dir ? dir + '/' : '';
        const kids = new Map();
        for (const [p, f] of repo.files) {
          if (!p.startsWith(prefix)) continue;
          const rel = p.slice(prefix.length), first = rel.split('/')[0];
          if (rel.includes('/')) kids.set(first, { type: 'directory', path: prefix + first, size: 0 });
          else kids.set(first, { type: 'file', path: p, size: f.bytes.length });
        }
        if (!kids.size) return done(404, { error: 'Path not found' });
        const all = [...kids.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
        const page = +(url.searchParams.get('cursor') || 0);
        const slice = all.slice(page * state.pageSize, (page + 1) * state.pageSize);
        const headers = {};
        if ((page + 1) * state.pageSize < all.length) {
          const next = new URL(base + url.pathname + url.search);
          next.searchParams.set('cursor', String(page + 1));
          headers.Link = '<' + next.toString().replace(/%2F/gi, '/') + '>; rel="next"';
        }
        return done(200, slice, headers);
      }
      return done(404, { error: 'unknown route ' + rest });
    }

    m = /^\/datasets\/([^/]+\/[^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(path);
    if (m && req.method === 'POST') {
      if (!state.repos.has(m[1])) return done(404, { error: 'Repository not found' });
      if (state.failBatch) { const s = state.failBatch; state.failBatch = 0; return done(s, { error: 'batch refused' }); }
      if (!/git-lfs/.test(req.headers.accept || '') || !/git-lfs/.test(req.headers['content-type'] || '')) return done(400, { error: 'wrong LFS media type' });
      const j = JSON.parse(body.toString());
      if (j.operation !== 'upload' || j.hash_algo !== 'sha_256' || !(j.transfers || []).includes('basic')) return done(400, { error: 'bad batch request' });
      return done(200, {
        transfer: 'basic',
        objects: j.objects.map((o) => (state.objects.has(o.oid)
          ? { oid: o.oid, size: o.size }
          : { oid: o.oid, size: o.size, actions: { upload: { href: base + '/s3/' + o.oid, header: {} } } })),
      });
    }
    // a file's content (api/_engine.js reads the PC's registered address this way)
    m = /^\/datasets\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(path);
    if (m && req.method === 'GET') {
      const f = state.repos.has(m[1]) && state.repos.get(m[1]).files.get(m[2]);
      if (!f) return done(404, { error: 'Entry not found' });
      return done(200, f.bytes);
    }
    return done(404, { error: 'unknown route ' + path });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  return { url: base, token: TOKEN, state, close: () => new Promise((r) => server.close(r)) };
}

// A real mono 16-bit WAV: a sine of `sec` seconds.
function wav(sec = 2, rate = 24000, amp = 0.4) {
  const n = Math.round(sec * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * amp * 32767), 44 + i * 2);
  return b;
}

module.exports = { start, wav, sha256 };
