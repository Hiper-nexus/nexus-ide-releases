import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Preview server local (benchmark §7): serve um diretório estático (build de
 * app web) em 127.0.0.1:<porta aleatória>, para o agente entregar uma URL
 * clicável de preview em vez de "roda npm run dev aí".
 *
 * Segurança: só GET/HEAD, bind exclusivo em loopback, raiz fixada no spawn e
 * path traversal bloqueado por resolução canônica (o path servido PRECISA
 * continuar dentro da raiz). Um servidor por diretório (idempotente).
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

interface RunningPreview {
  server: http.Server;
  port: number;
  root: string;
}

const running = new Map<string, RunningPreview>(); // root canônica → server

function resolveSafe(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function serve(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let file = resolveSafe(root, req.url ?? '/');
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    let stat = fs.statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.statSync(file);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

export async function startPreview(dir: string): Promise<{ url: string; port: number }> {
  const root = path.resolve(dir);
  const stat = fs.statSync(root); // lança se não existe — o caller traduz
  if (!stat.isDirectory()) throw new Error(`não é um diretório: ${root}`);

  const existing = running.get(root);
  if (existing) {
    return { url: `http://127.0.0.1:${existing.port}/`, port: existing.port };
  }

  const server = http.createServer((req, res) => serve(root, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  running.set(root, { server, port, root });
  console.log(`[preview] servindo ${root} em http://127.0.0.1:${port}/`);
  return { url: `http://127.0.0.1:${port}/`, port };
}

export function stopPreview(dir: string): boolean {
  const root = path.resolve(dir);
  const entry = running.get(root);
  if (!entry) return false;
  entry.server.close();
  running.delete(root);
  return true;
}

export function stopAllPreviews(): void {
  for (const entry of running.values()) entry.server.close();
  running.clear();
}

export function listPreviews(): Array<{ dir: string; url: string }> {
  return [...running.values()].map((p) => ({
    dir: p.root,
    url: `http://127.0.0.1:${p.port}/`,
  }));
}
