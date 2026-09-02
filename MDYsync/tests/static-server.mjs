// Zero-dependency static file server for the test suite.
//
// Deliberately not `http-server`/`serve`/`vite`: this repo has no build step
// and only two runtime dependencies, and `npm test` should work on a clean
// checkout without pulling a server package (or reaching the network) just to
// serve files that Netlify serves statically in production.
//
// Serves the MDYsync/ directory -- the same directory netlify.toml publishes
// (`base = "MDYsync"`, `publish = "."`), so paths resolve in tests exactly as
// they do on the deployed site.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

async function resolveFile(urlPath) {
  // normalize() collapses any ../ segments before the prefix check below, so a
  // request cannot escape ROOT.
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  let candidate = join(ROOT, normalize(decoded));
  if (!candidate.startsWith(ROOT + sep) && candidate !== ROOT) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) candidate = join(candidate, 'index.html');
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const file = await resolveFile(request.url || '/');
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

const port = Number(process.env.PORT || 8941);
server.listen(port, '127.0.0.1', () => {
  console.log(`DafSync test server listening on http://127.0.0.1:${port} (root: ${ROOT})`);
});
