import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storageHygienePolicyFor } from './hygiene-policy';
import { STORAGE_CATEGORIES, STORAGE_FILE_TARGETS, type StorageTargetContext } from './storage-targets';

const DAY = 24 * 60 * 60_000;
const FUTURE = Date.now() + 400 * DAY;
const HEX = 'a'.repeat(64);

let base: string;
let roots: StorageTargetContext['roots'];

function write(file: string, body = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function touchRecent(target: string): void {
  const at = new Date(FUTURE - 60_000);
  fs.utimesSync(target, at, at);
}

function context(overrides: Partial<StorageTargetContext> = {}): StorageTargetContext {
  return {
    roots,
    policy: storageHygienePolicyFor('ok'),
    now: FUTURE,
    deadlineAt: Date.now() + 60_000,
    liveSessionKeys: () => new Set(),
    livePartitionNames: () => new Set(),
    workspaces: () => [],
    ...overrides,
  };
}

async function run(id: string, overrides: Partial<StorageTargetContext> = {}) {
  const target = STORAGE_FILE_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`alvo ${id} ausente`);
  return target.run(context(overrides));
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-targets-test-')));
  roots = {
    userDataDir: path.join(base, 'userData'),
    logsDir: path.join(base, 'logs'),
    homeDir: path.join(base, 'home'),
    tempDir: path.join(base, 'tmp'),
  };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('perfis do navegador', () => {
  it('remove partição parada; carregada, recente, de outro tipo e pessoal dentro do prazo 3× ficam', async () => {
    // Tudo nasce agora; a rodada acontece 30 dias depois (prazo comum: 21 d; pessoal: 63 d).
    const now = Date.now() + 30 * DAY;
    const partitions = path.join(roots.userDataDir, 'Partitions');
    const name = (digit: string, suffix = '') => `nexus-browser-${digit.repeat(64)}${suffix}`;
    write(path.join(partitions, name('a'), 'Cookies'));
    write(path.join(partitions, name('b'), 'Cookies'));
    const recent = write(path.join(partitions, name('c'), 'Cookies'));
    fs.utimesSync(recent, new Date(now - 60_000), new Date(now - 60_000));
    write(path.join(partitions, `nexus-mimo-quota-${HEX}`, 'Cookies'));
    write(path.join(partitions, name('d', '-personal'), 'Cookies'));
    const outcome = await run('browser-profiles', {
      now,
      livePartitionNames: () => new Set([name('b')]),
    });
    expect(outcome.removed).toBe(1);
    expect(fs.readdirSync(partitions).sort()).toEqual(
      [name('b'), name('c'), name('d', '-personal'), `nexus-mimo-quota-${HEX}`].sort());
    // Passado o prazo 3×, a pessoal também sai.
    expect((await run('browser-profiles', {
      now: Date.now() + 70 * DAY,
      livePartitionNames: () => new Set([name('b')]),
    })).removed).toBe(2);
    expect(fs.readdirSync(partitions).sort()).toEqual([name('b'), `nexus-mimo-quota-${HEX}`].sort());
  });
});

describe('arquivos de sessão', () => {
  it('sessão viva, contêineres por provider e recentes ficam; órfãos (com token) saem', async () => {
    const nexus = path.join(roots.homeDir, '.nexus');
    write(path.join(nexus, 'ephemeral', 'aaaaaaaaaaaa', '.claude', 'settings.json'));
    write(path.join(nexus, 'ephemeral', 'bbbbbbbbbbbb', '.claude', 'settings.json'));
    write(path.join(nexus, 'ephemeral', 'mcp-clients', 'x.json'));
    write(path.join(nexus, 'mcp-configs', 'aaaaaaaaaaaa.json'), '{"token":"vivo"}');
    write(path.join(nexus, 'mcp-configs', 'cccccccccccc.json'), '{"token":"velho"}');
    write(path.join(nexus, 'mcp-configs', 'cccccccccccc.settings.json'), '{}');
    write(path.join(roots.userDataDir, 'briefs', 'b1.md'));
    write(path.join(nexus, 'dropped', 'print.png'));
    const rescued: string[] = [];
    const outcome = await run('session-files', {
      liveSessionKeys: () => new Set(['aaaaaaaaaaaa']),
      rescueSessionOverlay: (overlay) => { rescued.push(path.basename(overlay)); return true; },
    });
    expect(outcome.removed).toBe(5);
    // O resgate de login roda antes de cada HOME efêmero sair (e só nos que saem).
    expect(rescued).toEqual(['bbbbbbbbbbbb']);
    expect(fs.readdirSync(path.join(nexus, 'ephemeral')).sort()).toEqual(['aaaaaaaaaaaa', 'mcp-clients']);
    expect(fs.readdirSync(path.join(nexus, 'mcp-configs'))).toEqual(['aaaaaaaaaaaa.json']);
    expect(fs.readdirSync(path.join(roots.userDataDir, 'briefs'))).toEqual([]);
  });
});

describe('snapshots das CLIs', () => {
  it('só git nu (HEAD + objects) parado sai; outra pasta no lugar fica', async () => {
    const project = path.join(roots.userDataDir, 'provider-state', 'mimo-code', 'checkout-1', 'snapshot', 'proj');
    write(path.join(project, 'w1', 'HEAD'), 'ref: refs/heads/main');
    fs.mkdirSync(path.join(project, 'w1', 'objects', 'ab'), { recursive: true });
    write(path.join(project, 'w2', 'HEAD'), 'ref: refs/heads/main');
    fs.mkdirSync(path.join(project, 'w2', 'objects'), { recursive: true });
    touchRecent(path.join(project, 'w2', 'objects'));
    write(path.join(project, 'notes', 'conversa.jsonl'));
    const outcome = await run('provider-snapshots');
    expect(outcome.removed).toBe(1);
    expect(fs.readdirSync(project).sort()).toEqual(['notes', 'w2']);
  });
});

describe('lixo do Nexus dentro dos projetos', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

  it('anexos e swarms antigos saem; o que está versionado no projeto fica', async () => {
    const project = path.join(base, 'projeto');
    write(path.join(project, 'README.md'), '# p');
    git(project, 'init', '-q', '-b', 'main');
    git(project, '-c', 'user.name=x', '-c', 'user.email=x@example.test', 'add', '.');
    const attachments = path.join(project, '.nexus', 'attachments', 'mission-context');
    write(path.join(attachments, 'versionado.png'));
    write(path.join(project, '.nexus', 'swarms', 'mission-tracked', 'transcript', 't.jsonl'));
    git(project, 'add', '.nexus');
    git(project, '-c', 'user.name=x', '-c', 'user.email=x@example.test', 'commit', '-qm', 'init');
    write(path.join(attachments, 'print-velho.png'));
    write(path.join(project, '.nexus', 'swarms', 'mission-old', 'inbox', 'a.json'));
    write(path.join(project, '.nexus', 'swarms', 'nao-missao', 'x'));
    write(path.join(roots.homeDir, '.nexus', 'attachments', 'mission-context', 'espelho.png'));
    // Projeto fora do Git: nada a proteger.
    const loose = path.join(base, 'solto');
    write(path.join(loose, '.nexus', 'attachments', 'mission-context', 'print.png'));
    const none = new Set<string>();
    const outcome = await run('workspace-artifacts', { workspaces: () => [
      { root: project, liveMissionIds: none }, { root: loose, liveMissionIds: none }, { root: project, liveMissionIds: none },
    ] });
    expect(outcome.removed).toBe(4);
    expect(fs.readdirSync(attachments)).toEqual(['versionado.png']);
    expect(fs.readdirSync(path.join(project, '.nexus', 'swarms')).sort()).toEqual(['mission-tracked', 'nao-missao']);
    expect(fs.readdirSync(path.join(loose, '.nexus', 'attachments', 'mission-context'))).toEqual([]);
    expect(fs.readdirSync(path.join(roots.homeDir, '.nexus', 'attachments', 'mission-context'))).toEqual([]);
    // Nenhum arquivo versionado sumiu.
    expect(git(project, 'diff', '--name-only').toString()).toBe('');
  });
});

describe('lixo do Nexus dentro dos projetos: missões vivas', () => {
  it('swarm de missão viva fica; com missão viva no projeto nenhum anexo sai; sem leitura, nada sai', async () => {
    const project = path.join(base, 'vivo');
    write(path.join(project, '.nexus', 'swarms', 'mission-viva', 'inbox', 'a.json'));
    write(path.join(project, '.nexus', 'swarms', 'mission-morta', 'inbox', 'a.json'));
    write(path.join(project, '.nexus', 'attachments', 'mission-context', 'print.png'));
    write(path.join(roots.homeDir, '.nexus', 'attachments', 'mission-context', 'espelho.png'));
    const live = await run('workspace-artifacts', {
      workspaces: () => [{ root: project, liveMissionIds: new Set(['mission-viva']) }],
    });
    expect(live.removed).toBe(1);
    expect(fs.readdirSync(path.join(project, '.nexus', 'swarms'))).toEqual(['mission-viva']);
    expect(fs.readdirSync(path.join(project, '.nexus', 'attachments', 'mission-context'))).toEqual(['print.png']);
    expect(fs.readdirSync(path.join(roots.homeDir, '.nexus', 'attachments', 'mission-context'))).toEqual(['espelho.png']);
    const unknown = await run('workspace-artifacts', { workspaces: () => [{ root: project, liveMissionIds: null }] });
    expect(unknown.removed).toBe(0);
  });
});

describe('temporários', () => {
  it('só `nexus-*` parado sai; nome estável e build de release ficam', async () => {
    for (const name of ['nexus-cow-abc', 'nexus-mission-shims-v1', 'nexus-release-build-xyz', 'codex-resume-1', 'nexus-fresh-1']) {
      write(path.join(roots.tempDir, name, 'f'));
    }
    touchRecent(path.join(roots.tempDir, 'nexus-fresh-1', 'f'));
    const outcome = await run('temp');
    expect(outcome.removed).toBe(1);
    expect(fs.readdirSync(roots.tempDir).sort()).toEqual(
      ['codex-resume-1', 'nexus-fresh-1', 'nexus-mission-shims-v1', 'nexus-release-build-xyz']);
  });
});

describe('cópias de migração e logs', () => {
  it('mantém as N cópias mais novas por checkout', async () => {
    const backups = path.join(roots.userDataDir, 'project-runtime', 'projects', 'project-1', 'checkout-1', 'backups');
    for (let index = 0; index < 5; index += 1) {
      const file = write(path.join(backups, `runtime-schema-${index}-to-${index + 1}.sqlite3`));
      const at = new Date(Date.now() - (5 - index) * DAY);
      fs.utimesSync(file, at, at);
    }
    const outcome = await run('runtime-backups');
    expect(outcome.removed).toBe(2);
    expect(fs.readdirSync(backups).sort()).toEqual([2, 3, 4].map((index) => `runtime-schema-${index}-to-${index + 1}.sqlite3`));
  });

  it('logs sem rotação ganham teto', async () => {
    write(path.join(roots.logsDir, 'update.log'), 'linha\n'.repeat(600_000));
    const outcome = await run('logs');
    expect(outcome.freedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(fs.statSync(path.join(roots.logsDir, 'update.log')).size).toBeLessThanOrEqual(512 * 1024);
  });

  it('caches de pacotes só saem com o disco apertado', async () => {
    write(path.join(roots.userDataDir, 'provider-cache', 'claude', 'npm', '_cacache', 'x'));
    expect((await run('provider-cache')).removed).toBe(0);
    // Com sessão viva (MCP via npx rodando do cache), nada sai.
    expect((await run('provider-cache', {
      policy: storageHygienePolicyFor('low'), liveSessionKeys: () => new Set(['aaaaaaaaaaaa']),
    })).removed).toBe(0);
    expect((await run('provider-cache', { policy: storageHygienePolicyFor('low') })).removed).toBe(1);
  });
});

describe('categorias medidas', () => {
  it('cada categoria resolve caminhos dentro das raízes do Nexus', async () => {
    write(path.join(roots.tempDir, 'nexus-a', 'f'));
    write(path.join(roots.tempDir, 'outro', 'f'));
    for (const category of STORAGE_CATEGORIES) {
      for (const target of await category.paths(roots)) {
        expect([roots.userDataDir, roots.logsDir, roots.homeDir, roots.tempDir]
          .some((root) => target.startsWith(root)), `${category.id}: ${target}`).toBe(true);
      }
    }
    const temp = STORAGE_CATEGORIES.find((category) => category.id === 'temp')!;
    expect(await temp.paths(roots)).toEqual([path.join(roots.tempDir, 'nexus-a')]);
  });
});
