/**
 * F-789: o `mcode` instalado pelo npm abre com `#!/usr/bin/env node`, isto é,
 * pelo primeiro Node do PATH. O SQLite nativo dele (better-sqlite3) é
 * compilado para UM ABI do Node: com outro Node à frente no PATH (o Nexus
 * herdou o Node 22, ABI 127; o addon era do Node 26, ABI 147) a TUI sobe e
 * morre em ~10 s, em "Loading session". O Nexus escolhe um Node já instalado
 * no PATH que carregue o addon. Nunca recompila nem reinstala o pacote.
 *
 * A sondagem (`process.dlopen` do addon num Node candidato) roda em
 * subprocesso assíncrono, com cache por realpath+mtime do addon e de cada
 * Node, na preparação assíncrona do spawn (permit da CLI). O spawn, que é
 * síncrono, só consulta a decisão já pronta.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface MinimaxNodeLaunch {
  readonly file: string;
  readonly argsPrefix: readonly string[];
}

export type MinimaxNodeRuntime =
  /** Spawn normal: o Node do shebang carrega o addon, ou não há o que decidir. */
  | { readonly kind: 'default' }
  /** O Node do shebang não carrega o addon; este carrega. */
  | { readonly kind: 'pinned'; readonly launch: MinimaxNodeLaunch }
  /** Nenhum Node do PATH carrega o addon: só reinstalar resolve. */
  | { readonly kind: 'incompatible' };

export type NodeAddonProbeResult = 'loads' | 'fails' | 'unknown';
export type NodeAddonProbe = (node: string, addon: string) => Promise<NodeAddonProbeResult>;

const DEFAULT: MinimaxNodeRuntime = Object.freeze({ kind: 'default' });
const INCOMPATIBLE: MinimaxNodeRuntime = Object.freeze({ kind: 'incompatible' });
const PROBE_TIMEOUT_MS = 5_000;

interface FileIdentity {
  readonly real: string;
  readonly key: string;
}

/** Resultado por par (addon, Node), pela identidade dos dois arquivos. */
const probes = new Map<string, Promise<NodeAddonProbeResult>>();
/** Última decisão por lançador, com o PATH em que foi tomada. */
const decisions = new Map<string, {
  readonly pathEnv: string;
  readonly runtime: MinimaxNodeRuntime;
  /** Ordem de início da preparação: uma mais antiga nunca sobrescreve a nova. */
  readonly sequence: number;
}>();
let preparations = 0;

/**
 * Carrega o addon num Node e só isso: sem HOME, sem token, sem JS do pacote,
 * sem abrir banco. Código de saída ≠ 0 = não carrega; timeout ou Node que
 * nem abriu = sem prova.
 */
export const probeNodeAddon: NodeAddonProbe = (node, addon) =>
  new Promise((resolve) => {
    execFile(
      node,
      ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', addon],
      { env: {}, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (!error) {
          resolve('loads');
          return;
        }
        const failure = error as { killed?: boolean; code?: unknown };
        resolve(!failure.killed && typeof failure.code === 'number' ? 'fails' : 'unknown');
      },
    );
  });

async function identity(file: string): Promise<FileIdentity | null> {
  try {
    const real = await fs.promises.realpath(file);
    const stat = await fs.promises.stat(real);
    return stat.isFile() ? { real, key: `${real}:${stat.mtimeMs}:${stat.size}` } : null;
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** mcode do npm: entrypoint JS do pacote `@minimax-ai/code` e o addon do better-sqlite3. */
async function minimaxInstall(
  binPath: string,
): Promise<{ readonly entry: string; readonly addon: FileIdentity } | null> {
  const entryIdentity = await identity(binPath);
  if (!entryIdentity || !/\.[cm]?js$/u.test(entryIdentity.real)) return null;
  const entry = entryIdentity.real;
  let packageRoot: string | null = null;
  for (let dir = path.dirname(entry), depth = 0; depth < 4; depth += 1) {
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg) {
      const bins = typeof pkg.bin === 'string'
        ? [pkg.bin]
        : Object.values((pkg.bin ?? {}) as Record<string, unknown>);
      if (pkg.name !== '@minimax-ai/code' ||
          !bins.some((rel) => typeof rel === 'string' && path.resolve(dir, rel) === entry)) {
        return null;
      }
      packageRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!packageRoot) return null;
  // Onde o `require('better-sqlite3')` do pacote acharia o módulo.
  for (let base = packageRoot; ; base = path.dirname(base)) {
    const addon = await identity(path.join(
      base, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node',
    ));
    if (addon) return { entry, addon };
    if (path.dirname(base) === base) return null;
  }
}

/** Os `node` que o `env node` do shebang acharia, na ordem do PATH, sem repetição. */
async function nodeCandidates(pathEnv: string): Promise<FileIdentity[]> {
  const seen = new Set<string>();
  const found: FileIdentity[] = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
    } catch {
      continue; // ausente, link quebrado ou sem permissão: o `env` também pula
    }
    const node = await identity(candidate);
    if (!node || seen.has(node.real)) continue;
    seen.add(node.real);
    found.push(node);
  }
  return found;
}

function probeOnce(
  node: FileIdentity,
  addon: FileIdentity,
  probe: NodeAddonProbe,
): Promise<NodeAddonProbeResult> {
  const key = `${addon.key}|${node.key}`;
  let pending = probes.get(key);
  if (!pending) {
    pending = probe(node.real, addon.real).then((result) => {
      // Sem prova (timeout) não fica em cache: o próximo spawn tenta de novo.
      if (result === 'unknown') probes.delete(key);
      return result;
    });
    probes.set(key, pending);
  }
  return pending;
}

async function decide(
  binPath: string,
  pathEnv: string,
  probe: NodeAddonProbe,
): Promise<MinimaxNodeRuntime> {
  if (process.platform === 'win32') return DEFAULT;
  const install = await minimaxInstall(binPath);
  if (!install) return DEFAULT;
  const [first, ...others] = await nodeCandidates(pathEnv);
  // Só troca o Node com prova de que o do shebang não carrega o addon.
  if (!first || (await probeOnce(first, install.addon, probe)) !== 'fails') return DEFAULT;
  for (const node of others) {
    if ((await probeOnce(node, install.addon, probe)) === 'loads') {
      return { kind: 'pinned', launch: { file: node.real, argsPrefix: [install.entry] } };
    }
  }
  return INCOMPATIBLE;
}

/**
 * Preparação assíncrona (permit da CLI): decide e guarda para o spawn. Nunca
 * rejeita; qualquer erro vira `default` (o spawn segue como sempre).
 */
export async function prepareMinimaxNodeRuntime(
  binPath: string,
  pathEnv: string = process.env.PATH ?? '',
  probe: NodeAddonProbe = probeNodeAddon,
): Promise<MinimaxNodeRuntime> {
  const sequence = ++preparations;
  let runtime: MinimaxNodeRuntime;
  try {
    runtime = await decide(binPath, pathEnv, probe);
  } catch {
    runtime = DEFAULT;
  }
  if ((decisions.get(binPath)?.sequence ?? 0) < sequence) {
    decisions.set(binPath, { pathEnv, runtime, sequence });
  }
  return runtime;
}

/** Spawn (síncrono): só a decisão já preparada para este lançador e este PATH. */
export function minimaxNodeRuntimeForSpawn(
  binPath: string,
  pathEnv: string,
): MinimaxNodeRuntime | undefined {
  const prepared = decisions.get(binPath);
  return prepared && prepared.pathEnv === pathEnv ? prepared.runtime : undefined;
}

export function resetMinimaxNodeRuntimeForTests(): void {
  probes.clear();
  decisions.clear();
}
