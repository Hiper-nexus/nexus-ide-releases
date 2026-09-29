/**
 * shot-bridge: endpoint HTTP loopback que recebe arquivos do Nexus Shot
 * (contrato em src/shared/shot-bridge.ts).
 *
 * Espelha o padrão de agent-hooks/hook-http-server.ts: bind só em 127.0.0.1,
 * porta efêmera, token aleatório por sessão gravado em endpoint.json (0600)
 * sob userData. Validação de caminho é a fronteira de segurança: só entram
 * arquivos cujo realpath fica sob as raízes do Shot (~/Pictures/Nexus Shot,
 * ~/Movies/Nexus Shot; no Windows, Imagens/Vídeos\Nexus Shot) — sem
 * traversal, sem symlink para fora, sem paths arbitrários do sistema.
 *
 * O módulo NÃO importa electron: a borda (foco de janela, notificação,
 * webContents.send) vive no callback `onFiles` injetado pelo main.ts, o que
 * mantém este arquivo testável em vitest puro (padrão do repo).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import {
  SHOT_FILE_MAX_BYTES,
  SHOT_INGEST_MAX_FILES,
  SHOT_REQUEST_MAX_BYTES,
  type ShotFileKind,
  type ShotFileMeta,
  type ShotIngestRejectReason,
} from '../../shared/shot-bridge';

export type ShotBridgeServerHandle = {
  readonly port: number;
  readonly token: string;
  readonly endpointFilePath: string;
  close: () => Promise<void>;
};

export type ShotIngestOutcome =
  | { ok: true; files: ShotFileMeta[] }
  | { ok: false; reason: ShotIngestRejectReason };

let active: ShotBridgeServerHandle | null = null;

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pastas conhecidas do SO (app.getPath) — cobrem Imagens/Vídeos redirecionados
 *  (OneDrive no Windows), que o Shot também resolve pela pasta conhecida. */
export type ShotKnownFolders = { pictures?: string; videos?: string };

/** Raízes permitidas: apenas os diretórios de destino do Nexus Shot. O Shot
 *  grava gravações em ~/Movies no macOS e em Vídeos (~\Videos) no Windows. */
export function shotAllowedRoots(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  knownFolders: ShotKnownFolders = {},
): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const videos = platform === 'win32' ? 'Videos' : 'Movies';
  const roots = [path.join(home, 'Pictures', 'Nexus Shot'), path.join(home, videos, 'Nexus Shot')];
  for (const folder of [knownFolders.pictures, knownFolders.videos]) {
    if (folder && path.isAbsolute(folder)) roots.push(path.join(folder, 'Nexus Shot'));
  }
  return [...new Set(roots)];
}

/** Absoluto no formato que o Shot envia. No Windows só letra de unidade
 *  (C:\…): UNC e device paths (\\host\share, \\?\, \\.\) ficam fora — o
 *  realpath de um UNC abriria conexão SMB com o host informado. */
function isAcceptedAbsolute(raw: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(raw);
  return raw.startsWith('/');
}

function isUnderRoot(realPath: string, realRoot: string, platform: NodeJS.Platform): boolean {
  const sep = platform === 'win32' ? win32.sep : posix.sep;
  // NTFS não diferencia caixa: C:\Users\x\pictures é a mesma pasta.
  const [p, root] = platform === 'win32'
    ? [realPath.toLowerCase(), realRoot.toLowerCase()]
    : [realPath, realRoot];
  return p === root || p.startsWith(root + sep);
}

function kindOf(name: string): ShotFileKind {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return 'image';
  if (/\.(mp4|mov|webm)$/.test(lower)) return 'video';
  return 'other';
}

/**
 * Valida e canonicaliza a lista de caminhos do ingest. Pura (fs real, sem
 * electron): toda a política de aceite vive aqui para ser testada de perto.
 */
export function validateShotIngestFiles(
  input: unknown,
  options: {
    homeDir?: string;
    realpathFn?: (p: string) => string;
    platform?: NodeJS.Platform;
    knownFolders?: ShotKnownFolders;
  } = {},
): ShotIngestOutcome {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: 'invalid-shape' };
  }
  if (input.length > SHOT_INGEST_MAX_FILES) {
    return { ok: false, reason: 'too-many-files' };
  }
  const platform = options.platform ?? process.platform;
  const realpathFn = options.realpathFn ?? ((p: string) => realpathSync(p));
  // Roots canonicalizadas: sem isso um symlink numa raiz compararia errado.
  const roots = shotAllowedRoots(options.homeDir, platform, options.knownFolders).flatMap((root) => {
    try {
      return [realpathFn(root)];
    } catch {
      return []; // raiz inexistente nesta máquina: simplesmente não permite
    }
  });

  const files: ShotFileMeta[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) {
      return { ok: false, reason: 'invalid-shape' };
    }
    if (!isAcceptedAbsolute(raw, platform)) {
      return { ok: false, reason: 'path-not-absolute' };
    }
    let real: string;
    try {
      real = realpathFn(raw);
    } catch {
      return { ok: false, reason: 'path-not-found' };
    }
    if (!roots.some((root) => isUnderRoot(real, root, platform))) {
      return { ok: false, reason: 'path-outside-allowed' };
    }
    let size: number;
    try {
      const st = statSync(real);
      if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
      size = st.size;
    } catch {
      return { ok: false, reason: 'path-not-found' };
    }
    if (size > SHOT_FILE_MAX_BYTES) {
      return { ok: false, reason: 'file-too-large' };
    }
    files.push({ path: real, name: basename(real), size, kind: kindOf(real) });
  }
  return { ok: true, files };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeEndpointFile(path: string, port: number, token: string): void {
  if (!/^[0-9a-f]+$/i.test(token)) {
    throw new Error('shot-bridge: token must be hex');
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('shot-bridge: invalid port');
  }
  mkdirSync(dirname(path), { recursive: true });
  // JSON (não .env): o cliente é o binário Rust do Shot, não um shell script.
  writeFileSync(path, JSON.stringify({ port, token }) + '\n', { mode: 0o600 });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
  onFiles: (files: ShotFileMeta[]) => void,
  homeDir?: string,
  knownFolders?: ShotKnownFolders,
): Promise<void> {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== '/shot/ingest') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'not-found' }));
    return;
  }
  const headerToken = req.headers['x-nexus-shot-token'];
  if (typeof headerToken !== 'string' || !tokenMatches(headerToken, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'unauthorized' }));
    return;
  }

  let body: string;
  try {
    body = await readBody(req, SHOT_REQUEST_MAX_BYTES);
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'body-too-large' }));
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid-json' }));
    return;
  }
  const shape = payload as { type?: unknown; files?: unknown; source?: unknown };
  if (shape?.type !== 'ingest' || shape?.source !== 'nexus-shot') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid-shape' }));
    return;
  }

  const outcome = validateShotIngestFiles(shape.files, { homeDir, knownFolders });
  if (!outcome.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: outcome.reason }));
    return;
  }

  onFiles(outcome.files);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, received: outcome.files.length }));
}

/**
 * Sobe o endpoint do shot-bridge. `userDataPath` deve ser o userData do
 * Electron (ou tmp de teste) — nunca a árvore de um projeto.
 */
export async function startShotBridgeServer(options: {
  userDataPath: string;
  token?: string;
  /** Override de teste: raiz home para as pastas permitidas. */
  homeDir?: string;
  /** app.getPath('pictures'|'videos') — pastas conhecidas redirecionadas. */
  knownFolders?: ShotKnownFolders;
  onFiles: (files: ShotFileMeta[]) => void;
}): Promise<ShotBridgeServerHandle> {
  if (active) return active;

  const token = options.token ?? randomBytes(24).toString('hex');
  const endpointFilePath = join(options.userDataPath, 'shot-bridge', 'endpoint.json');

  const server: Server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, token, options.onFiles, options.homeDir, options.knownFolders);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'internal' }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only — nunca bind em 0.0.0.0.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('shot-bridge: failed to bind loopback port');
  }
  const port = addr.port;
  writeEndpointFile(endpointFilePath, port, token);

  const handle: ShotBridgeServerHandle = {
    port,
    token,
    endpointFilePath,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (active === handle) active = null;
          try {
            if (existsSync(endpointFilePath)) unlinkSync(endpointFilePath);
          } catch {
            // best effort
          }
          resolve();
        });
      }),
  };
  active = handle;
  return handle;
}

export async function stopShotBridgeServer(): Promise<void> {
  if (active) await active.close();
}
