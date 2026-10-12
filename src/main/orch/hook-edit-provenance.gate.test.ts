// F-1242, ponta a ponta: PostToolUse pelo hook → nexus.db real → portão de
// regressão da retomada exata. Só a edição cujo conteúdo ainda está no disco é
// da conversa; quem reescreveu depois (outro agente; o formatador, se o Stop do
// turno não re-hasheou — F-1249) devolve o arquivo para "alheio", por mais
// perto que a escrita esteja no tempo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const userData = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nexus-f1242-db-'));
  return { app: { getPath: () => userData, getAppPath: () => process.cwd(), isPackaged: false } };
});

import type { SessionProviderConversation } from '../pty/pty-manager';
import {
  __resetRegressionGateForTests,
  runRegressionGate,
  type RegressionExec,
} from '../regression-gate/regression-gate';
import { ProcessGitRunner } from '../runtime/git-command';
import {
  copyProviderPaneSession,
  providerSessionHeldByOtherPane,
  saveProviderPaneSession,
} from '../persistence/provider-session-store';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  __resetHookEditProvenanceForTests,
  recordHookEditProvenance,
  recordedEditsForSession,
} from './hook-edit-provenance';

const HOUR = 3_600_000;
const roots: string[] = [];

afterEach(() => {
  __resetRegressionGateForTests();
  __resetHookEditProvenanceForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  const { closeDb } = await import('../persistence/db');
  closeDb();
  const { app } = await import('electron');
  fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
});

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function age(root: string, file: string, atMs: number): void {
  fs.utimesSync(path.join(root, file), new Date(atMs), new Date(atMs));
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1242-')));
  roots.push(root);
  const git = new ProcessGitRunner();
  write(root, 'src/c.ts', 'export const c = 3;\n');
  write(root, 'src/c.test.ts', "import { c } from './c';\n");
  write(root, 'package.json', JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
  write(root, 'node_modules/.bin/vitest', '#!/bin/sh\n');
  write(root, '.gitignore', 'node_modules\n');
  git.run(root, ['init', '-q']);
  git.run(root, ['add', '-A']);
  git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  return { root, scope: testProjectScope({ rootRealPath: root }) };
}

/** Vermelho só no checkout do pane; verde na worktree da base (F-246): a quebra é do diff. */
function failingOnlyAt(root: string, failing: readonly string[]) {
  return vi.fn<RegressionExec>(async (_file, args, options) => {
    const outFile = args.find((arg) => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    const files = args.filter((arg) => arg.endsWith('.test.ts'));
    const red = (file: string) => options.cwd === root && failing.includes(file);
    fs.writeFileSync(outFile, JSON.stringify({
      testResults: files.map((file) => ({
        name: path.join(options.cwd, file),
        status: red(file) ? 'failed' : 'passed',
        assertionResults: [red(file)
          ? { status: 'failed', fullName: 'c', failureMessages: ['vermelho'] }
          : { status: 'passed', fullName: 'ok' }],
      })),
    }));
    return { exitCode: files.some(red) ? 1 : 0, timedOut: false, stdout: '', stderr: '' };
  });
}

describe('F-1242: autoria pelo conteúdo registrado, não por janela de mtime', () => {
  async function editByConversation(root: string, scope: ReturnType<typeof testProjectScope>, content: string, atMs: number) {
    const conversation: SessionProviderConversation = {
      scope: { installationId: scope.installationId, projectId: scope.projectId, checkoutId: scope.checkoutId },
      adapterId: 'claude',
      paneId: 'pane-f1242',
      conversationId: 'conv-f1242',
      resumed: false,
    };
    write(root, 'src/c.ts', content);
    age(root, 'src/c.ts', atMs);
    // PostToolUse do Write, pelo bearer do próprio pane (1ª encarnação).
    const recorded = await recordHookEditProvenance({ sessionId: 'pty-first', scope }, 'tool-complete', {
      session_id: 'conv-f1242', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/c.ts') },
    }, { conversationOf: () => conversation, now: () => atMs });
    expect(recorded).toBe(1);
    return { ...conversation, resumed: true };
  }

  it('outro agente reescreve o arquivo 1 s depois: na retomada ele continua alheio', async () => {
    const { root, scope } = project();
    const editedAtMs = Date.now() - 20 * HOUR;
    const resumed = await editByConversation(root, scope, 'export const c = 30;\n', editedAtMs);
    write(root, 'src/c.ts', 'export const c = 31;\n'); // o outro agente, por cima
    age(root, 'src/c.ts', editedAtMs + 1_000);
    const startedAtMs = Date.now() - 1_000; // retomada exata: spawn novo, mesma conversa
    const recordedEdits = recordedEditsForSession('pty-resumed', root, { conversationOf: () => resumed });

    const result = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec: failingOnlyAt(root, ['src/c.test.ts']) });

    expect(result.status).not.toBe('failed');
    expect(result.failures).toEqual([]);
    expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
  });

  it('sem ninguém por cima, a edição registrada continua da conversa e bloqueia', async () => {
    const { root, scope } = project();
    const editedAtMs = Date.now() - 20 * HOUR;
    const resumed = await editByConversation(root, scope, 'export const c = 30;\n', editedAtMs);
    const startedAtMs = Date.now() - 1_000;
    const recordedEdits = recordedEditsForSession('pty-resumed', root, { conversationOf: () => resumed });

    const result = await runRegressionGate({ scope, startedAtMs, recordedEdits }, { exec: failingOnlyAt(root, ['src/c.test.ts']) });

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
  });
});

describe('F-1249: o formatador do PostToolUse termina depois do hash', () => {
  function turn(root: string, scope: ReturnType<typeof testProjectScope>) {
    const conversation: SessionProviderConversation = {
      scope: { installationId: scope.installationId, projectId: scope.projectId, checkoutId: scope.checkoutId },
      adapterId: 'claude',
      paneId: 'pane-f1249',
      conversationId: 'conv-f1249',
      resumed: false,
    };
    // Hooks do mesmo bearer (1ª encarnação do pane).
    const hook = (eventType: string, body: Record<string, unknown>, atMs: number) =>
      recordHookEditProvenance({ sessionId: 'pty-first', scope }, eventType, { session_id: 'conv-f1249', ...body },
        { conversationOf: () => conversation, now: () => atMs });
    const resumedGate = () => runRegressionGate({
      scope,
      startedAtMs: Date.now() - 1_000, // retomada exata: spawn novo, mesma conversa
      recordedEdits: recordedEditsForSession('pty-resumed', root, { conversationOf: () => ({ ...conversation, resumed: true }) }),
    }, { exec: failingOnlyAt(root, ['src/c.test.ts']) });
    return { hook, resumedGate };
  }

  async function writeThenFormat(root: string, hook: ReturnType<typeof turn>['hook'], editedAtMs: number) {
    write(root, 'src/c.ts', 'export const c = 30;\n');
    age(root, 'src/c.ts', editedAtMs);
    expect(await hook('tool-complete', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/c.ts') } }, editedAtMs)).toBe(1);
    // O prettier do usuário, hook PostToolUse paralelo, termina depois do hash.
    write(root, 'src/c.ts', 'export const c = 30; // formatado\n');
    age(root, 'src/c.ts', editedAtMs + 500);
  }

  it('o Stop do turno re-hasheia o que o turno gravou: na retomada o arquivo formatado é do pane', async () => {
    const { root, scope } = project();
    const { hook, resumedGate } = turn(root, scope);
    const editedAtMs = Date.now() - 20 * HOUR;
    await writeThenFormat(root, hook, editedAtMs);
    expect(await hook('stop', {}, editedAtMs + 1_000)).toBe(1);

    const result = await resumedGate();

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
  });

  it('reescrita por OUTRO agente depois do Stop continua alheia, mesmo com um Stop seguinte da conversa', async () => {
    const { root, scope } = project();
    const { hook, resumedGate } = turn(root, scope);
    const editedAtMs = Date.now() - 20 * HOUR;
    await writeThenFormat(root, hook, editedAtMs);
    expect(await hook('stop', {}, editedAtMs + 1_000)).toBe(1);
    write(root, 'src/c.ts', 'export const c = 31;\n'); // o outro agente, por cima
    age(root, 'src/c.ts', editedAtMs + 2_000);
    // Turno seguinte sem edição: nada a reler.
    expect(await hook('stop', {}, editedAtMs + 3_000)).toBe(0);

    const result = await resumedGate();

    expect(result.status).not.toBe('failed');
    expect(result.failures).toEqual([]);
    expect(result.inheritedFailures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
  });
});

describe('F-1286: "Retomar" em pane novo continua a conversa — as edições registradas seguem com ela', () => {
  it('a cópia do vínculo deixa a linha do pane antigo; o pane novo que retoma a conversa ainda responde pelas edições dela', async () => {
    const { root, scope } = project();
    const editedAtMs = Date.now() - 20 * HOUR;
    const old: SessionProviderConversation = {
      scope: { installationId: scope.installationId, projectId: scope.projectId, checkoutId: scope.checkoutId },
      adapterId: 'claude',
      paneId: 'pane-f1286-antigo',
      conversationId: 'conv-f1286',
      resumed: false,
    };
    expect(saveProviderPaneSession(scope, old.paneId, 'claude', { key: 'session_id', id: 'conv-f1286' })).toBe(true);
    write(root, 'src/c.ts', 'export const c = 30;\n');
    age(root, 'src/c.ts', editedAtMs);
    expect(await recordHookEditProvenance({ sessionId: 'pty-antigo', scope }, 'tool-complete', {
      session_id: 'conv-f1286', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/c.ts') },
    }, { conversationOf: () => old, now: () => editedAtMs })).toBe(1);
    // Maestro "Retomar" num pane novo: o vínculo é COPIADO antes do spawn (pane-registry).
    expect(copyProviderPaneSession(scope, old.paneId, 'pane-f1286-novo', 'claude')).toBe(true);
    // A linha do pane antigo fica. Uma checagem de dono por provider_pane_sessions
    // (heldByOtherPane) tiraria do pane novo a autoria legítima da conversa.
    expect(providerSessionHeldByOtherPane('claude', 'conv-f1286', 'pane-f1286-novo')).toBe(true);
    const resumedInNewPane = { ...old, paneId: 'pane-f1286-novo', resumed: true };
    const recordedEdits = recordedEditsForSession('pty-novo', root, { conversationOf: () => resumedInNewPane });

    const result = await runRegressionGate(
      { scope, startedAtMs: Date.now() - 1_000, recordedEdits },
      { exec: failingOnlyAt(root, ['src/c.test.ts']) },
    );

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure) => failure.file)).toEqual(['src/c.test.ts']);
  });
});
