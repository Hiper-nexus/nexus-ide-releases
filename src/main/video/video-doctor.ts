import fs from 'node:fs';
import path from 'node:path';
import {
  buildEngineEnv,
  HYPERFRAMES_VERSION,
  MIN_NODE_MAJOR,
  resolveNodeRuntime,
  toolVersion,
  videoEnginePaths,
  type NodeRuntime,
} from './video-engine';
import { readEngineState } from './video-engine-install';

/**
 * Read-only check of what a render needs on this machine (F-1594). It runs
 * `node -p` and `ffmpeg -version`, reads folders and free space; it never
 * installs, downloads or writes. Each failing check says what to run.
 */

export type VideoDoctorCheckId =
  | 'node'
  | 'npm'
  | 'ffmpeg'
  | 'ffprobe'
  | 'engine'
  | 'chrome'
  | 'disk'
  | 'path-length'
  | 'telemetry';

export interface VideoDoctorCheck {
  readonly id: VideoDoctorCheckId;
  /** false only for what blocks a render; warnings keep ok true with a note. */
  readonly ok: boolean;
  readonly detail: string;
  /** Command or step that fixes it, for the operator (never run by the doctor). */
  readonly fix?: string;
}

export interface VideoDoctorReport {
  readonly ok: boolean;
  readonly engine: { readonly name: 'hyperframes'; readonly version: string };
  readonly checks: readonly VideoDoctorCheck[];
}

export interface VideoDoctorInput {
  readonly userData: string;
  readonly manifestDir: string;
  readonly workspaceDir?: string;
  readonly pathValue: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly lookup: (command: string) => string | null;
  readonly platform?: NodeJS.Platform;
  readonly freeBytes?: (dir: string) => number | null;
  readonly resolveNode?: typeof resolveNodeRuntime;
  readonly versionOf?: typeof toolVersion;
}

const MIN_FREE_ENGINE_BYTES = 1.5 * 1024 ** 3;
const MIN_FREE_WORKSPACE_BYTES = 1 * 1024 ** 3;
/**
 * Deepest path below the engine dir, measured on Windows on 19/10/2026: 120
 * characters in node_modules, 159 in the Chrome cache of the engine HOME.
 */
const ENGINE_DEEPEST_SUFFIX = 165;
const WINDOWS_MAX_PATH = 260;

export function installHint(tool: 'ffmpeg' | 'node', platform: NodeJS.Platform): string {
  if (tool === 'ffmpeg') {
    if (platform === 'win32') return 'winget install --id Gyan.FFmpeg -e';
    if (platform === 'darwin') return 'brew install ffmpeg';
    return 'sudo apt install ffmpeg (ou o gerenciador de pacotes da sua distribuição)';
  }
  if (platform === 'win32') return 'winget install --id OpenJS.NodeJS.LTS -e';
  if (platform === 'darwin') return 'brew install node';
  return 'instale o Node.js 22 ou mais novo pelo gerenciador da distribuição ou por nodejs.org';
}

function defaultFreeBytes(dir: string): number | null {
  try {
    let probe = dir;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    const stats = fs.statfsSync(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

export async function runVideoDoctor(input: VideoDoctorInput): Promise<VideoDoctorReport & { node: NodeRuntime | null }> {
  const platform = input.platform ?? process.platform;
  const paths = videoEnginePaths(input.userData);
  const env = buildEngineEnv({ base: input.baseEnv, pathValue: input.pathValue, home: paths.home, platform });
  const checks: VideoDoctorCheck[] = [];

  const node = await (input.resolveNode ?? resolveNodeRuntime)({ nodeOnPath: input.lookup('node'), env });
  if (!node) {
    checks.push({ id: 'node', ok: false, detail: 'Node.js não encontrado no PATH.', fix: installHint('node', platform) });
  } else if (node.major < MIN_NODE_MAJOR) {
    checks.push({
      id: 'node',
      ok: false,
      detail: `Node.js ${node.version}; o motor exige ${MIN_NODE_MAJOR} ou mais novo.`,
      fix: installHint('node', platform),
    });
  } else {
    checks.push({ id: 'node', ok: true, detail: `Node.js ${node.version}` });
  }
  checks.push(
    node?.npmCli
      ? { id: 'npm', ok: true, detail: 'npm junto do Node (usado só para instalar o motor fixado).' }
      : { id: 'npm', ok: false, detail: 'npm não encontrado ao lado do Node.', fix: installHint('node', platform) },
  );

  const versionOf = input.versionOf ?? toolVersion;
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    const version = await versionOf(input.lookup(tool), env);
    checks.push(
      version
        ? { id: tool, ok: true, detail: version }
        : {
            id: tool,
            ok: false,
            detail: `${tool} não encontrado no PATH; o HyperFrames usa o do sistema.`,
            fix: installHint('ffmpeg', platform),
          },
    );
  }

  const state = readEngineState(paths, input.manifestDir);
  checks.push(
    state.status === 'ready'
      ? { id: 'engine', ok: true, detail: `HyperFrames ${HYPERFRAMES_VERSION} instalado em ${paths.engineDir}` }
      : {
          id: 'engine',
          ok: true,
          detail:
            state.status === 'missing'
              ? `HyperFrames ${HYPERFRAMES_VERSION} ainda não instalado: o Nexus instala no primeiro render ` +
                '(npm ci do lockfile fixado, sem scripts, ~110 MB).'
              : `HyperFrames instalado não é o ${HYPERFRAMES_VERSION} fixado: o Nexus reinstala no próximo render.`,
        },
  );

  const chromeDir = path.join(paths.home, '.cache', 'hyperframes', 'chrome');
  let chromeReady = false;
  try {
    chromeReady = fs.readdirSync(chromeDir).length > 0;
  } catch {
    chromeReady = false;
  }
  checks.push({
    id: 'chrome',
    ok: true,
    detail: chromeReady
      ? 'Chrome Headless Shell do motor já baixado.'
      : 'O HyperFrames baixa o Chrome Headless Shell no primeiro render (~120 MB, cache do motor).',
  });

  const freeBytes = input.freeBytes ?? defaultFreeBytes;
  const engineFree = freeBytes(paths.root);
  const workspaceFree = input.workspaceDir ? freeBytes(input.workspaceDir) : null;
  const lowEngine = engineFree !== null && engineFree < MIN_FREE_ENGINE_BYTES;
  const lowWorkspace = workspaceFree !== null && workspaceFree < MIN_FREE_WORKSPACE_BYTES;
  checks.push({
    id: 'disk',
    ok: !lowEngine && !lowWorkspace,
    detail: [
      engineFree === null ? 'espaço do motor não medido' : `${gb(engineFree)} livres para o motor`,
      workspaceFree === null ? null : `${gb(workspaceFree)} livres no projeto`,
    ]
      .filter(Boolean)
      .join(' · '),
    ...(lowEngine || lowWorkspace ? { fix: 'Libere espaço: o motor pede 1,5 GB e o render, 1 GB.' } : {}),
  });

  if (platform === 'win32') {
    const deepest = paths.engineDir.length + ENGINE_DEEPEST_SUFFIX;
    checks.push({
      id: 'path-length',
      ok: deepest < WINDOWS_MAX_PATH,
      detail: `caminho mais fundo do motor ≈ ${deepest} de ${WINDOWS_MAX_PATH} caracteres`,
      ...(deepest >= WINDOWS_MAX_PATH
        ? { fix: 'A pasta de dados do Nexus está num caminho longo demais para o Windows.' }
        : {}),
    });
  }

  checks.push({
    id: 'telemetry',
    ok: true,
    detail:
      'Renders do Nexus rodam sem telemetria (HYPERFRAMES_NO_TELEMETRY=1, DO_NOT_TRACK=1), sem instalar skills ' +
      'por fora, sem checar atualização e sem nenhuma chave de API no ambiente.',
  });

  return {
    ok: checks.every((check) => check.ok),
    engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION },
    checks,
    node,
  };
}
