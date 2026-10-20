/**
 * F-1385: prefixa no PATH do worker o `bin` do Node que o projeto fixa.
 *
 * O projeto declara a versão de Node em `.nvmrc`/`.node-version` ou em
 * `package.json` (`nexusRelease.node` — versão exata — ou `engines.node` —
 * faixa). A máquina do operador costuma ter outro Node como default (v26 no
 * Homebrew, por exemplo); um worker que herda esse PATH roda `npx vitest`/`tsc`
 * com a versão errada e o better-sqlite3 nativo quebra com ERR_DLOPEN_FAILED.
 * Com o `bin` do Node fixado prefixado, `npx`/`node` resolvem a versão certa
 * sem reinstalar nada.
 *
 * Regra: só quando há versão fixada E um Node compatível instalado; caso
 * contrário nada muda. Nunca instala. Tudo puro e injetável para teste
 * hermético.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface NodeVersionDeps {
  /** Lê um arquivo (absoluto) ou devolve null quando ausente/ilegível. */
  readonly readFile?: (filePath: string) => string | null;
  /** Candidatos de diretório `bin` para um major, por plataforma. */
  readonly candidateDirs?: (
    major: string,
    homeDir: string,
    platform: NodeJS.Platform,
  ) => string[];
  /** Testa se um diretório existe. */
  readonly dirExists?: (dir: string) => boolean;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface AppliedNodeInfo {
  readonly applied: boolean;
  readonly binDir: string | null;
  readonly major: string | null;
  /** Motivo legível: fonte do pin, ou por que nada foi aplicado. */
  readonly reason: string;
}

/** Arquivos que declaram a versão, na ordem de precedência. */
const NODE_VERSION_FILES = ['.nvmrc', '.node-version'] as const;

/** Extrai o major ("22") da primeira versão numérica de uma string. */
export function majorFromVersion(value: string): string | null {
  const m = /v?(\d+)(?:\.\d+)*/.exec(value.trim());
  return m ? m[1] : null;
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Descobre o major do Node fixado pelo projeto. Devolve null quando o projeto
 * não declara versão (ou declara algo não numérico como `lts/iron`).
 */
export function detectPinnedNodeMajor(
  projectRoot: string,
  deps?: NodeVersionDeps,
): { readonly major: string; readonly source: string } | null {
  const readFile = deps?.readFile ?? defaultReadFile;
  for (const name of NODE_VERSION_FILES) {
    const content = readFile(path.join(projectRoot, name));
    if (!content) continue;
    const major = majorFromVersion(content);
    if (major) return { major, source: name };
  }
  const pkgText = readFile(path.join(projectRoot, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as {
        nexusRelease?: { node?: string };
        engines?: { node?: string };
      };
      const exact = majorFromVersion(pkg.nexusRelease?.node ?? '');
      if (exact) return { major: exact, source: 'package.json#nexusRelease.node' };
      const range = majorFromVersion(pkg.engines?.node ?? '');
      if (range) return { major: range, source: 'package.json#engines.node' };
    } catch {
      // package.json inválido: sem pin.
    }
  }
  return null;
}

function nvmNodeBins(major: string, homeDir: string): string[] {
  const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
  let entries: string[];
  try {
    entries = fs.readdirSync(versionsDir);
  } catch {
    return [];
  }
  const prefix = `v${major}.`;
  // Revisão Fable: semver, não texto — "v22.9.0" > "v22.10.0" na ordem de string.
  const parts = (entry: string) => entry.slice(1).split('.').map((n) => Number.parseInt(n, 10) || 0);
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .sort((a, b) => {
      const [pa, pb] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((entry) => path.join(versionsDir, entry, 'bin'));
}

/** Diretórios `bin` de Node candidatos por plataforma. */
export function candidateNodeBinDirs(
  major: string,
  homeDir: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform === 'win32') return [];
  // Homebrew (ARM64/Intel macOS, Linuxbrew) + nvm.
  return [
    `/opt/homebrew/opt/node@${major}/bin`,
    `/usr/local/opt/node@${major}/bin`,
    `/home/linuxbrew/.linuxbrew/opt/node@${major}/bin`,
    ...nvmNodeBins(major, homeDir),
  ];
}

/** Primeiro diretório `bin` candidato que existe, ou null. */
export function resolveInstalledNodeBin(
  major: string,
  deps?: NodeVersionDeps,
): string | null {
  const platform = deps?.platform ?? process.platform;
  const homeDir = deps?.homeDir ?? os.homedir();
  const dirExists = deps?.dirExists ?? ((dir: string) => fs.existsSync(dir));
  const candidates = deps?.candidateDirs
    ? deps.candidateDirs(major, homeDir, platform)
    : candidateNodeBinDirs(major, homeDir, platform);
  return candidates.find(dirExists) ?? null;
}

/**
 * F-1583: cache do resultado de `applyProjectNodeToWorkerPath` por raiz de
 * projeto, invalidado quando os arquivos de versão mudam de mtime. A leitura
 * síncrona de .nvmrc/.node-version/package.json e a varredura de
 * ~/.nvm/versions acontecia em todo spawn de agente e, no primeiro spawn a
 * frio no Windows, somava centenas de ms com o FS cache vazio.
 */
const nodePathCache = new Map<
  string,
  { info: AppliedNodeInfo; pinMtimeMs: number; binMtimeMs: number }
>();

function versionFilesMtime(
  projectRoot: string,
  deps: NodeVersionDeps | undefined,
): { pinMtimeMs: number; binMtimeMs: number } {
  let pinMtimeMs = 0;
  for (const name of NODE_VERSION_FILES) {
    try {
      const s = fs.statSync(path.join(projectRoot, name));
      if (s.mtimeMs > pinMtimeMs) pinMtimeMs = s.mtimeMs;
    } catch {}
  }
  try {
    const s = fs.statSync(path.join(projectRoot, 'package.json'));
    if (s.mtimeMs > pinMtimeMs) pinMtimeMs = s.mtimeMs;
  } catch {}
  let binMtimeMs = 0;
  const homeDir = deps?.homeDir ?? os.homedir();
  const versionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
  try {
    const s = fs.statSync(versionsDir);
    binMtimeMs = s.mtimeMs;
  } catch {}
  return { pinMtimeMs, binMtimeMs };
}

/**
 * Prefixa o `bin` do Node fixado pelo projeto no PATH de um env de worker.
 * Sem versão fixada, ou sem Node compatível instalado, deixa o env intacto.
 *
 * O resultado é cacheado por projectRoot. O cache é invalidado quando qualquer
 * arquivo de versão (.nvmrc, .node-version, package.json) ou o diretório
 * ~/.nvm/versions/node muda de mtime.
 */
export function applyProjectNodeToWorkerPath(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  deps?: NodeVersionDeps,
): AppliedNodeInfo {
  const mtimes = versionFilesMtime(projectRoot, deps);
  const cached = nodePathCache.get(projectRoot);
  if (
    cached &&
    cached.pinMtimeMs === mtimes.pinMtimeMs &&
    cached.binMtimeMs === mtimes.binMtimeMs
  ) {
    if (cached.info.applied && cached.info.binDir) {
      const current = env.PATH ?? '';
      env.PATH = current
        ? `${cached.info.binDir}${path.delimiter}${current}`
        : cached.info.binDir;
    }
    return cached.info;
  }
  const pin = detectPinnedNodeMajor(projectRoot, deps);
  if (!pin) {
    const info: AppliedNodeInfo = {
      applied: false,
      binDir: null,
      major: null,
      reason: 'no-pinned-node',
    };
    nodePathCache.set(projectRoot, {
      info,
      pinMtimeMs: mtimes.pinMtimeMs,
      binMtimeMs: mtimes.binMtimeMs,
    });
    return info;
  }
  const binDir = resolveInstalledNodeBin(pin.major, deps);
  if (!binDir) {
    const info: AppliedNodeInfo = {
      applied: false,
      binDir: null,
      major: pin.major,
      reason: 'no-compatible-node-installed',
    };
    nodePathCache.set(projectRoot, {
      info,
      pinMtimeMs: mtimes.pinMtimeMs,
      binMtimeMs: mtimes.binMtimeMs,
    });
    return info;
  }
  const current = env.PATH ?? '';
  env.PATH = current ? `${binDir}${path.delimiter}${current}` : binDir;
  const info: AppliedNodeInfo = {
    applied: true,
    binDir,
    major: pin.major,
    reason: `${pin.source}=${pin.major}`,
  };
  nodePathCache.set(projectRoot, {
    info,
    pinMtimeMs: mtimes.pinMtimeMs,
    binMtimeMs: mtimes.binMtimeMs,
  });
  return info;
}

/** Só para testes: limpa o cache interno (entre testes ou simulação de mudança). */
export function clearNodePathCacheForTests(): void {
  nodePathCache.clear();
}
