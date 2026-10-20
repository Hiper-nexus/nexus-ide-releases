import fs from 'node:fs';
import path from 'node:path';
import type { StorageCategoryId } from '../../shared/storage-hygiene';
import { AsyncProcessGitRunner, assertSafeLocalGitConfigAsync } from '../runtime/git-command';
import type { StorageHygienePolicy } from './hygiene-policy';
import {
  EMPTY_SWEEP,
  addSweeps,
  capAppendOnlyFile,
  keepNewestFiles,
  pruneEmptyDirs,
  sweepStaleChildren,
  type SweepOutcome,
} from './stale-sweep';

/**
 * Onde o Nexus grava, por SO. Tudo vem do Electron/Node (`userData`, `logs`,
 * `os.homedir()`, `os.tmpdir()`): no Windows `userData` é %APPDATA%\NexusIDE,
 * `logs` é %APPDATA%\NexusIDE\logs e o temporário é %LOCALAPPDATA%\Temp —
 * que o Windows, ao contrário do macOS, nunca esvazia sozinho.
 */
export interface StorageRoots {
  readonly userDataDir: string;
  readonly logsDir: string;
  readonly homeDir: string;
  readonly tempDir: string;
}

export interface StorageTargetContext {
  readonly roots: StorageRoots;
  readonly policy: StorageHygienePolicy;
  readonly now: number;
  readonly deadlineAt: number;
  /** Prefixos (12 chars) dos tokens de sessões MCP vivas neste processo. */
  readonly liveSessionKeys: () => ReadonlySet<string>;
  /** Partições Chromium (`nexus-browser-…`) carregadas neste processo. */
  readonly livePartitionNames: () => ReadonlySet<string>;
  /** Projetos abertos (onde o Nexus grava `<projeto>/.nexus/`) e as missões vivas de cada um. */
  readonly workspaces: () => readonly StorageWorkspace[];
  /**
   * Resgate antes de apagar um HOME efêmero órfão (login feito no pane que
   * só existe ali). `false` mantém o overlay.
   */
  readonly rescueSessionOverlay?: (overlayDir: string) => boolean;
}

export interface StorageWorkspace {
  readonly root: string;
  /** Missões que não estão done/failed; `null` = leitura falhou (tudo conta como vivo). */
  readonly liveMissionIds: ReadonlySet<string> | null;
}

export interface StorageTarget {
  readonly id: string;
  readonly label: string;
  readonly run: (context: StorageTargetContext) => Promise<SweepOutcome>;
}

const BROWSER_PARTITION = /^nexus-browser-[0-9a-f]{64}(-personal)?$/;
/** Perfil "pessoal" guarda logins que o usuário escolheu manter: prazo 3×. */
const PERSONAL_PARTITION_IDLE_FACTOR = 3;
/** Subpastas por provider dentro de `ephemeral/` (contêineres, não sessões). */
const EPHEMERAL_CONTAINERS = new Set(['mcp-clients', 'agy']);
/** Temporários com nome fixo, reaproveitados entre sessões. */
const TEMP_STABLE = new Set(['nexus-mission-shims-v1']);
const TEMP_FOREIGN_PREFIXES = ['nexus-release-build-'];

async function listDirs(dir: string, match: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && match(entry.name)).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function isBareGitDir(dir: string): Promise<boolean> {
  try {
    const [head, objects] = await Promise.all([
      fs.promises.lstat(path.join(dir, 'HEAD')),
      fs.promises.lstat(path.join(dir, 'objects')),
    ]);
    return head.isFile() && objects.isDirectory();
  } catch {
    return false;
  }
}

/** Perfis Chromium por pane de navegador (`Partitions/nexus-browser-<sha256>`). */
const browserProfiles: StorageTarget = {
  id: 'browser-profiles',
  label: 'Perfis do navegador sem uso',
  run: async ({ roots, policy, now, deadlineAt, livePartitionNames }) => {
    const root = path.join(roots.userDataDir, 'Partitions');
    const live = livePartitionNames();
    const common = {
      root, now, deadlineAt, activityDepth: 1,
      isProtected: (name: string) => live.has(name),
    };
    return addSweeps(
      await sweepStaleChildren({ ...common, maxIdleMs: policy.browserPartitionMaxIdleMs,
        match: (name) => BROWSER_PARTITION.test(name) && !name.endsWith('-personal') }),
      await sweepStaleChildren({ ...common,
        maxIdleMs: policy.browserPartitionMaxIdleMs * PERSONAL_PARTITION_IDLE_FACTOR,
        match: (name) => BROWSER_PARTITION.test(name) && name.endsWith('-personal') }),
    );
  },
};

/** Mapas de orientação por escopo (`project-…` → `checkout-…` → `root-…`): cache reconstruível. */
const orientationMaps: StorageTarget = {
  id: 'orientation-maps',
  label: 'Mapas de orientação antigos',
  run: async ({ roots, policy, now, deadlineAt }) => {
    const root = path.join(roots.userDataDir, 'orientation-maps');
    const outcomes: SweepOutcome[] = [];
    for (const project of await listDirs(root, (name) => name.startsWith('project-'))) {
      for (const checkout of await listDirs(project, (name) => name.startsWith('checkout-'))) {
        outcomes.push(await sweepStaleChildren({
          root: checkout, now, deadlineAt, maxIdleMs: policy.orientationMaxIdleMs,
          activityDepth: 1, match: (name) => name.startsWith('root-'),
        }));
      }
    }
    await pruneEmptyDirs(root, 2);
    return addSweeps(...outcomes);
  },
};

/**
 * Snapshots de desfazer das CLIs estilo opencode (MiMo Code):
 * `provider-state/<cli>/<checkout>/snapshot/<projeto>/<hash-da-worktree>`,
 * um repositório Git nu por worktree — que some com a worktree e fica órfão.
 * Só sai pasta com forma de git nu (HEAD + objects), sem atividade no prazo.
 */
const providerSnapshots: StorageTarget = {
  id: 'provider-snapshots',
  label: 'Snapshots de desfazer das CLIs',
  run: async ({ roots, policy, now, deadlineAt }) => {
    const root = path.join(roots.userDataDir, 'provider-state');
    const outcomes: SweepOutcome[] = [];
    for (const adapter of await listDirs(root, () => true)) {
      for (const checkout of await listDirs(adapter, () => true)) {
        for (const project of await listDirs(path.join(checkout, 'snapshot'), () => true)) {
          const bare = new Set<string>();
          for (const candidate of await listDirs(project, () => true)) {
            if (await isBareGitDir(candidate)) bare.add(path.basename(candidate));
          }
          outcomes.push(await sweepStaleChildren({
            root: project, now, deadlineAt, maxIdleMs: policy.providerSnapshotMaxIdleMs,
            activityDepth: 2, match: (name) => bare.has(name),
          }));
        }
        await pruneEmptyDirs(path.join(checkout, 'snapshot'), 1);
      }
    }
    return addSweeps(...outcomes);
  },
};

/**
 * Caches npm/uv/XDG das CLIs e MCPs (`provider-cache/<cli>/<tipo>`): só com o
 * disco apertado — com folga, o cache quente vale mais que o espaço.
 */
const providerCaches: StorageTarget = {
  id: 'provider-cache',
  label: 'Caches de pacotes das CLIs',
  run: async ({ roots, policy, now, deadlineAt, liveSessionKeys }) => {
    if (policy.pressure === 'ok') return EMPTY_SWEEP;
    // Um MCP via npx roda de dentro do cache (`npm/_npx/<hash>`) sem mexer
    // nos mtimes: com sessão viva, nada sai.
    if (liveSessionKeys().size > 0) return EMPTY_SWEEP;
    const outcomes: SweepOutcome[] = [];
    for (const adapter of await listDirs(path.join(roots.userDataDir, 'provider-cache'), () => true)) {
      outcomes.push(await sweepStaleChildren({
        root: adapter, now, deadlineAt, maxIdleMs: policy.providerSnapshotMaxIdleMs,
        activityDepth: 2, match: () => true,
      }));
    }
    return addSweeps(...outcomes);
  },
};

/**
 * HOME efêmero (`~/.nexus/ephemeral/<token12>`) e configs MCP
 * (`~/.nexus/mcp-configs/<token12>[.settings].json`) de sessões que já
 * morreram sem o teardown (crash, kill). Os configs guardam bearer token: o
 * resto deles em disco é lixo e risco. Sessão viva neste processo nunca sai;
 * o prazo cobre a outra instância (dev × instalado) que divide o `~/.nexus`.
 */
const sessionArtifacts: StorageTarget = {
  id: 'session-files',
  label: 'Arquivos de sessões encerradas',
  run: async ({ roots, policy, now, deadlineAt, liveSessionKeys, rescueSessionOverlay }) => {
    const live = liveSessionKeys();
    const nexusHome = path.join(roots.homeDir, '.nexus');
    const keyOf = (name: string) => name.slice(0, 12);
    return addSweeps(
      await sweepStaleChildren({
        root: path.join(nexusHome, 'ephemeral'), now, deadlineAt,
        maxIdleMs: policy.sessionArtifactMaxIdleMs, activityDepth: 3,
        match: (name) => !EPHEMERAL_CONTAINERS.has(name) && !name.startsWith('.'),
        isProtected: (name) => live.has(keyOf(name)),
        // Login feito no pane que morreu sem teardown: volta ao perfil real
        // (só se for mais novo) antes de o overlay sair.
        beforeRemove: (_name, full) => rescueSessionOverlay?.(full) ?? true,
      }),
      await sweepStaleChildren({
        root: path.join(nexusHome, 'mcp-configs'), now, deadlineAt,
        maxIdleMs: policy.sessionArtifactMaxIdleMs, activityDepth: 0,
        match: (name) => name.endsWith('.json'),
        isProtected: (name) => live.has(keyOf(name)),
      }),
      await sweepStaleChildren({
        root: path.join(roots.userDataDir, 'briefs'), now, deadlineAt,
        maxIdleMs: policy.briefMaxIdleMs, activityDepth: 0,
        match: (name) => name.endsWith('.md'),
      }),
      await sweepStaleChildren({
        root: path.join(nexusHome, 'dropped'), now, deadlineAt,
        maxIdleMs: policy.droppedFilesMaxIdleMs, activityDepth: 1,
        match: (name) => !name.startsWith('.'),
      }),
    );
  },
};

/**
 * Caminhos (relativos, com `/`) rastreados pelo Git sob `prefixes` — o que
 * estiver versionado no projeto NUNCA é apagado. `null` = sem prova (Git
 * falhou ou config local insegura): o projeto é pulado nesta rodada.
 */
async function trackedPaths(root: string, prefixes: readonly string[]): Promise<ReadonlySet<string> | null> {
  const git = new AsyncProcessGitRunner();
  const inside = await git.run(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true, timeoutMs: 15_000 })
    .catch(() => null);
  if (!inside) return null;
  // Fora de um repositório não há o que versionar: nada a proteger.
  if (inside.status !== 0) return new Set();
  try {
    await assertSafeLocalGitConfigAsync(git, root);
    const listed = await git.run(root, ['ls-files', '-z', '--', ...prefixes], { timeoutMs: 30_000 });
    return new Set(listed.stdout.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Lixo do Nexus DENTRO dos projetos: anexos de missão (prints colados) e
 * caixas de correio de swarm de missões antigas. Só sai o que não está
 * versionado; o espelho em `~/.nexus/attachments` segue o mesmo prazo.
 */
const workspaceArtifacts: StorageTarget = {
  id: 'workspace-artifacts',
  label: 'Anexos e rascunhos de missões nos projetos',
  run: async ({ roots, policy, now, deadlineAt, workspaces }) => {
    const outcomes: SweepOutcome[] = [];
    const unique = [...new Map(workspaces().map((workspace) => [workspace.root, workspace])).values()];
    // Anexo não diz de que missão é: projeto com missão viva (ou sem leitura
    // das missões) não perde anexo nenhum.
    const anyLive = unique.some((workspace) => workspace.liveMissionIds === null || workspace.liveMissionIds.size > 0);
    for (const workspace of unique) {
      const live = workspace.liveMissionIds;
      if (Date.now() >= deadlineAt) break;
      const attachments = path.join(workspace.root, '.nexus', 'attachments', 'mission-context');
      const swarms = path.join(workspace.root, '.nexus', 'swarms');
      if (!await pathExists(attachments) && !await pathExists(swarms)) continue;
      const tracked = await trackedPaths(workspace.root, ['.nexus/attachments/mission-context', '.nexus/swarms']);
      if (!tracked) continue;
      const isTracked = (rel: string) => tracked.has(rel) ||
        [...tracked].some((file) => file.startsWith(`${rel}/`));
      if (live !== null && live.size === 0) {
        outcomes.push(await sweepStaleChildren({
          root: attachments, now, deadlineAt, maxIdleMs: policy.droppedFilesMaxIdleMs, activityDepth: 0,
          match: (name) => !name.startsWith('.'),
          isProtected: (name) => isTracked(`.nexus/attachments/mission-context/${name}`),
        }));
      }
      if (live !== null) {
        outcomes.push(await sweepStaleChildren({
          root: swarms, now, deadlineAt, maxIdleMs: policy.missionScratchMaxIdleMs, activityDepth: 3,
          match: (name) => name.startsWith('mission-'),
          isProtected: (name) => live.has(name) || isTracked(`.nexus/swarms/${name}`),
        }));
      }
    }
    // O espelho em ~/.nexus serve todos os projetos: com qualquer missão viva, fica.
    if (!anyLive) {
      outcomes.push(await sweepStaleChildren({
        root: path.join(roots.homeDir, '.nexus', 'attachments', 'mission-context'), now, deadlineAt,
        maxIdleMs: policy.droppedFilesMaxIdleMs, activityDepth: 0, match: (name) => !name.startsWith('.'),
      }));
    }
    return addSweeps(...outcomes);
  },
};

/** Temporários `nexus-*` do app que sobraram de crash/kill. */
const tempLeftovers: StorageTarget = {
  id: 'temp',
  label: 'Temporários abandonados',
  run: ({ roots, policy, now, deadlineAt }) => sweepStaleChildren({
    root: roots.tempDir, now, deadlineAt, maxIdleMs: policy.tempMaxIdleMs, activityDepth: 2,
    maxRemovals: 400,
    match: (name) => name.startsWith('nexus-') && !TEMP_STABLE.has(name) &&
      !TEMP_FOREIGN_PREFIXES.some((prefix) => name.startsWith(prefix)),
  }),
};

/** Cópias do runtime.sqlite3 de cada migração de esquema: só as mais novas ficam. */
const runtimeSchemaBackups: StorageTarget = {
  id: 'runtime-backups',
  label: 'Cópias de migração do banco',
  run: async ({ roots, policy }) => {
    const outcomes: SweepOutcome[] = [];
    const projects = path.join(roots.userDataDir, 'project-runtime', 'projects');
    for (const project of await listDirs(projects, (name) => name.startsWith('project-'))) {
      for (const checkout of await listDirs(project, (name) => name.startsWith('checkout-'))) {
        outcomes.push(await keepNewestFiles(path.join(checkout, 'backups'),
          (name) => name.startsWith('runtime-schema-') && name.endsWith('.sqlite3'),
          policy.runtimeSchemaBackupsKept));
      }
    }
    return addSweeps(...outcomes);
  },
};

/** Logs append-only sem rotação própria: teto com cauda preservada. */
const appendOnlyLogs: StorageTarget = {
  id: 'logs',
  label: 'Logs sem rotação',
  run: async ({ roots }) => {
    const MiB = 1024 * 1024;
    const caps: Array<readonly [string, number, number]> = [
      [path.join(roots.logsDir, 'update.log'), 2 * MiB, 512 * 1024],
      [path.join(roots.logsDir, 'jarvis-metrics.log'), 4 * MiB, MiB],
      [path.join(roots.userDataDir, 'shutdown-incidents.jsonl'), MiB, 256 * 1024],
    ];
    const outcomes: SweepOutcome[] = [];
    for (const [file, max, keep] of caps) {
      try {
        outcomes.push(await capAppendOnlyFile(file, max, keep));
      } catch {
        outcomes.push({ ...EMPTY_SWEEP, errors: 1 });
      }
    }
    return addSweeps(...outcomes);
  },
};

export const STORAGE_FILE_TARGETS: readonly StorageTarget[] = Object.freeze([
  browserProfiles,
  orientationMaps,
  providerSnapshots,
  providerCaches,
  sessionArtifacts,
  workspaceArtifacts,
  tempLeftovers,
  runtimeSchemaBackups,
  appendOnlyLogs,
]);

export interface StorageCategoryDefinition {
  readonly id: StorageCategoryId;
  readonly label: string;
  readonly managed: boolean;
  readonly paths: (roots: StorageRoots) => Promise<readonly string[]>;
}

const fixed = (...parts: Array<(roots: StorageRoots) => string>) =>
  async (roots: StorageRoots) => parts.map((part) => part(roots));

export const STORAGE_CATEGORIES: readonly StorageCategoryDefinition[] = Object.freeze([
  { id: 'agent-worktrees', label: 'Worktrees e runtime dos projetos', managed: true,
    paths: fixed((r) => path.join(r.userDataDir, 'project-runtime')) },
  { id: 'browser-profiles', label: 'Perfis do navegador', managed: true,
    paths: fixed((r) => path.join(r.userDataDir, 'Partitions')) },
  { id: 'provider-state', label: 'Conversas e estado das CLIs', managed: true,
    paths: fixed((r) => path.join(r.userDataDir, 'provider-state')) },
  { id: 'provider-cache', label: 'Caches de pacotes das CLIs', managed: true,
    paths: fixed((r) => path.join(r.userDataDir, 'provider-cache')) },
  { id: 'orientation-maps', label: 'Mapas de orientação', managed: true,
    paths: fixed((r) => path.join(r.userDataDir, 'orientation-maps')) },
  { id: 'chromium-cache', label: 'Cache do Chromium', managed: true,
    paths: fixed(
      (r) => path.join(r.userDataDir, 'Cache'),
      (r) => path.join(r.userDataDir, 'Code Cache'),
      (r) => path.join(r.userDataDir, 'GPUCache'),
      (r) => path.join(r.userDataDir, 'DawnGraphiteCache'),
      (r) => path.join(r.userDataDir, 'DawnWebGPUCache'),
      (r) => path.join(r.userDataDir, 'Shared Dictionary'),
    ) },
  { id: 'logs', label: 'Logs e diagnóstico', managed: true,
    paths: async (r) => [...new Set([path.join(r.userDataDir, 'logs'), r.logsDir])] },
  { id: 'agent-memory', label: 'Memória dos agentes', managed: false,
    paths: fixed((r) => path.join(r.userDataDir, 'agent-memory')) },
  { id: 'session-files', label: 'Arquivos de sessão e anexos', managed: true,
    paths: fixed(
      (r) => path.join(r.homeDir, '.nexus', 'ephemeral'),
      (r) => path.join(r.homeDir, '.nexus', 'mcp-configs'),
      (r) => path.join(r.homeDir, '.nexus', 'dropped'),
      (r) => path.join(r.homeDir, '.nexus', 'attachments'),
      (r) => path.join(r.userDataDir, 'briefs'),
    ) },
  { id: 'temp', label: 'Temporários', managed: true,
    paths: async (r) => {
      try {
        return (await fs.promises.readdir(r.tempDir))
          .filter((name) => name.startsWith('nexus-'))
          .map((name) => path.join(r.tempDir, name));
      } catch {
        return [];
      }
    } },
]);
