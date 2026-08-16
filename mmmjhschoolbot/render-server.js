const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const botHandler = require('./api/mmmjhs-bot');
let erpCloudHandler = null;
try {
  erpCloudHandler = require('./api/erp-cloud');
} catch (error) {
  console.error('[ERP] erp-cloud module missing:', error.message);
}

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/index.html' : decoded;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(ROOT, normalized);
  if (!fullPath.startsWith(ROOT)) return null;
  return fullPath;
}

function serveStatic(req, res, urlPath) {
  const filePath = safeStaticPath(urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-store' });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Gzip JSON API responses. Snapshot payloads compress by roughly 85%, which is
 * the difference between megabytes and kilobytes on every sync.
 * Applied only to the API paths, where handlers use setHeader (not writeHead).
 */
function withGzip(req, res) {
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return res;
  const originalEnd = res.end.bind(res);
  res.end = function gzipEnd(chunk, encoding, callback) {
    if (!chunk || res.headersSent || req.method === 'HEAD') {
      return originalEnd(chunk, encoding, callback);
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (buf.length < 1024) return originalEnd(buf);
    zlib.gzip(buf, (err, compressed) => {
      if (err) return originalEnd(buf);
      try {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
      } catch (e) {
        return originalEnd(buf);
      }
      originalEnd(compressed);
    });
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // Uptime monitors should hit this, not a data endpoint.
  if (parsedUrl.pathname === '/api/health' || parsedUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('{"ok":true}');
    return;
  }

  if (parsedUrl.pathname === '/api/mmmjhs-bot' || parsedUrl.pathname === '/api/erp-cloud') {
    try {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = req.method === 'POST' ? await readBody(req) : {};
      withGzip(req, res);
      if (parsedUrl.pathname === '/api/erp-cloud' && erpCloudHandler) {
        await erpCloudHandler(req, res);
      } else {
        await botHandler(req, res);
      }
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  serveStatic(req, res, parsedUrl.pathname);
});

const BUILD_VERSION = '20260816-bandwidth-fix';

server.listen(PORT, () => {
  console.log(`MMM School ERP Render server v${BUILD_VERSION} running on port ${PORT}`);
});
