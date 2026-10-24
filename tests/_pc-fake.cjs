'use strict';
// The real engine-local/server.py with a fake model (no GPU, no download), on a free local port.
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const python = () => ['python3', 'python'].find((c) => spawnSync(c, ['--version']).status === 0);

async function startPc(key) {
  const code = [
    'import sys, tempfile; sys.path.insert(0, sys.argv[1]); import server',
    'class F:',
    '    name = "fake"',
    '    def speak(self, text, lang, ref_id, ref_path, **a): return b"\\x00\\x01" * 240, 24000',
    'd = tempfile.mkdtemp(); s = server.make_server(F(), sys.argv[2], port=0, ref_dir=d)',
    'print(s.server_address[1], d, flush=True); s.serve_forever()',
  ].join('\n');
  const child = spawn(python(), ['-c', code, path.join(__dirname, '..', 'engine-local'), key]);
  // The first line is "<port> <dir>". A pipe can deliver it in pieces: read up to the newline.
  const [port, dir] = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(out.split('\n')[0].trim().split(' '));
    });
    child.once('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return {
    url: 'http://127.0.0.1:' + port,
    dir,
    close() { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { startPc, python };
