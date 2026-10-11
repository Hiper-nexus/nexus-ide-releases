import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionProviderConversation } from '../pty/pty-manager';
import type { ConversationEditKey } from '../persistence/conversation-edit-store';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  __resetHookEditProvenanceForTests,
  confineEditedPath,
  extractEditedPaths,
  hookBodyMayCarryEdit,
  recordHookEditProvenance,
  recordedEditsForSession,
} from './hook-edit-provenance';

const dirs: string[] = [];

afterEach(() => {
  __resetHookEditProvenanceForTests();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function checkout(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1237-prov-')));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/x.ts'), 'export const x = 1;\n');
  return root;
}

const triple = { installationId: 'i', projectId: 'p', checkoutId: 'c' };
const claude = (conversationId: string | null, resumed = false): SessionProviderConversation =>
  ({ scope: triple, adapterId: 'claude', paneId: 'pane-a', conversationId, resumed });
/** Codex fresco: sem id no argv. Um objeto por sessão viva, como o do pty-manager. */
const codexFresh = (paneId = 'pane-a'): SessionProviderConversation =>
  Object.freeze({ scope: triple, adapterId: 'codex', paneId, conversationId: null, resumed: false });

function recorder() {
  const calls: Array<{ key: ConversationEditKey; paths: readonly string[]; at: number }> = [];
  const record = vi.fn((key: ConversationEditKey, paths: readonly string[], at: number) => {
    calls.push({ key, paths, at });
    return paths.length;
  });
  return { calls, record };
}

describe('extractEditedPaths (F-1237)', () => {
  it('família Claude: file_path de Edit/Write/MultiEdit e notebook_path de NotebookEdit', () => {
    expect(extractEditedPaths({ tool_name: 'Edit', tool_input: { file_path: '/r/src/a.ts', old_string: 'x' } })).toEqual(['/r/src/a.ts']);
    expect(extractEditedPaths({ tool_name: 'Write', tool_input: { file_path: '/r/b.md', content: '…' } })).toEqual(['/r/b.md']);
    expect(extractEditedPaths({ tool_name: 'MultiEdit', tool_input: { file_path: '/r/c.ts', edits: [] } })).toEqual(['/r/c.ts']);
    expect(extractEditedPaths({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/r/n.ipynb' } })).toEqual(['/r/n.ipynb']);
  });

  it('Codex apply_patch: os cabeçalhos do patch, em qualquer forma de tool_input', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-*** Add File: dentro-do-conteudo-nao-conta.ts',
      '+x',
      '*** Add File: src/new.ts',
      '+export {};',
      '*** Delete File: src/old.ts',
      '*** Update File: src/from.ts',
      '*** Move to: src/to.ts',
      '*** End Patch',
    ].join('\n');
    const expected = ['src/a.ts', 'src/new.ts', 'src/old.ts', 'src/from.ts', 'src/to.ts'];
    expect(extractEditedPaths({ tool_name: 'apply_patch', tool_input: { command: patch } })).toEqual(expected);
    expect(extractEditedPaths({ tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } })).toEqual(expected);
    expect(extractEditedPaths({ tool_name: 'apply_patch', tool_input: patch })).toEqual(expected);
  });

  it('leitura, shell e ferramenta desconhecida não são edição', () => {
    expect(extractEditedPaths({ tool_name: 'Read', tool_input: { file_path: '/r/a.ts' } })).toEqual([]);
    expect(extractEditedPaths({ tool_name: 'Bash', tool_input: { command: '*** Update File: a.ts' } })).toEqual([]);
    expect(extractEditedPaths({ tool_input: { file_path: '/r/a.ts' } })).toEqual([]);
  });

  it('corpo grande demais para o status só é lido quando o começo diz que é edição', () => {
    expect(hookBodyMayCarryEdit('{"session_id":"s","tool_name":"Write","tool_input":{')).toBe(true);
    expect(hookBodyMayCarryEdit('{"session_id":"s","tool_name": "apply_patch"')).toBe(true);
    expect(hookBodyMayCarryEdit('{"session_id":"s","tool_name":"Read","tool_input":{')).toBe(false);
  });
});

describe('confineEditedPath (F-1237)', () => {
  it('normaliza para o caminho relativo do diff; relativo resolve pelo cwd do CLI', () => {
    const root = checkout();
    expect(confineEditedPath(root, root, path.join(root, 'src/x.ts'))).toBe('src/x.ts');
    expect(confineEditedPath(root, path.join(root, 'src'), 'novo/y.ts')).toBe('src/novo/y.ts');
    expect(confineEditedPath(root, root, path.join(root, 'src/./../src/x.ts'))).toBe('src/x.ts');
  });

  it('(c) fora da raiz, pela escada de `..`, por symlink para fora, ou em .git/node_modules: descartado', () => {
    const root = checkout();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1237-out-')));
    dirs.push(outside);
    fs.symlinkSync(outside, path.join(root, 'link-out'));
    expect(confineEditedPath(root, root, path.join(outside, 'a.ts'))).toBeNull();
    expect(confineEditedPath(root, root, '../fora.ts')).toBeNull();
    expect(confineEditedPath(root, root, path.join(root, 'link-out/a.ts'))).toBeNull();
    expect(confineEditedPath(root, root, path.join(root, '.git/config'))).toBeNull();
    expect(confineEditedPath(root, root, path.join(root, 'node_modules/x/index.js'))).toBeNull();
    expect(confineEditedPath(root, root, 'src/a\nb.ts')).toBeNull();
  });
});

describe('recordHookEditProvenance (F-1237)', () => {
  it('grava o caminho da edição pela conversa do argv, na raiz de execução do pane', () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const n = recordHookEditProvenance(ctx, 'tool-complete', {
      session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') },
    }, { conversationOf: () => claude('conv-a'), record, now: () => 1_234 });

    expect(n).toBe(1);
    expect(calls).toEqual([{
      key: { scope: triple, adapterId: 'claude', conversationId: 'conv-a', rootRealPath: root },
      paths: ['src/x.ts'],
      at: 1_234,
    }]);
  });

  it('(c) outra conversa, caminho fora da raiz, evento que não é fim de tool ou sessão sem pane: nada gravado', () => {
    const root = checkout();
    const { record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const deps = { conversationOf: () => claude('conv-a'), record };
    const edit = (file: string, sessionId = 'conv-a') =>
      ({ session_id: sessionId, tool_name: 'Write', tool_input: { file_path: file } });

    // Corpo forjado com a conversa de outro agente: o pane só registra a dele.
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, 'src/x.ts'), 'conv-do-outro'), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('/etc/hosts'), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, '../fora.ts')), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-use', edit(path.join(root, 'src/x.ts')), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } }, deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, 'src/x.ts')), { ...deps, conversationOf: () => null })).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('sem id no argv (Codex fresco): a primeira conversa que o CLI anuncia no bearer fica fixada; outra é recusada', () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh();
    const deps = { conversationOf: () => conversation, record, heldByOtherPane: () => false };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };

    expect(recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', { session_id: 'thread-forjado', tool_name: 'apply_patch', tool_input: patch, cwd: root }, deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', { session_id: 'thread-1', tool_name: 'apply_patch', tool_input: patch, cwd: root }, deps)).toBe(1);
    expect(calls.map((call) => [call.key.adapterId, call.key.conversationId, call.paths])).toEqual([['codex', 'thread-1', ['src/x.ts']]]);
  });

  it('F-1241: só o SessionStart fixa a conversa; o tool-complete de um curl com hooks mudos, não', () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh();
    const deps = { conversationOf: () => conversation, record, heldByOtherPane: () => false };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });

    // O primeiro evento do canal é um tool-complete com o thread de outro pane.
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('thread-de-outro-pane'), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'user-submit', { session_id: 'thread-de-outro-pane' }, deps)).toBe(0);
    // O SessionStart do próprio CLI fixa; o resto do canal tem de concordar.
    expect(recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('thread-de-outro-pane'), deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('thread-1'), deps)).toBe(1);
    expect(calls.map((call) => call.key.conversationId)).toEqual(['thread-1']);
    // Kimi/Grok anunciam pelo evento `session`.
    const kimi = codexFresh('pane-kimi');
    const kimiDeps = { ...deps, conversationOf: () => kimi };
    expect(recordHookEditProvenance({ ...ctx, sessionId: 'pty-kimi' }, 'session', { session_id: 'kimi-1' }, kimiDeps)).toBe(0);
    expect(recordHookEditProvenance({ ...ctx, sessionId: 'pty-kimi' }, 'tool-complete', edit('kimi-1'), kimiDeps)).toBe(1);
  });

  it('F-1241: id que provider_pane_sessions já dá a outro pane não é fixado', () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh('pane-a');
    const heldByOtherPane = vi.fn((_conversation: SessionProviderConversation, claimed: string) => claimed === 'thread-do-pane-b');
    const deps = { conversationOf: () => conversation, record, heldByOtherPane };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });

    expect(recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-do-pane-b' }, deps)).toBe(0);
    expect(heldByOtherPane).toHaveBeenCalledWith(conversation, 'thread-do-pane-b');
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('thread-do-pane-b'), deps)).toBe(0);
    // O SessionStart legítimo, depois, ainda fixa o id próprio.
    expect(recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(recordHookEditProvenance(ctx, 'tool-complete', edit('thread-1'), deps)).toBe(1);
    expect(calls.map((call) => call.key.conversationId)).toEqual(['thread-1']);
  });

  it('F-1241: o pin vive com a sessão viva, sem despejo por volume de spawns', () => {
    const root = checkout();
    const { record } = recorder();
    const scope = testProjectScope({ rootRealPath: root });
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });
    const first = codexFresh('pane-0');
    const firstDeps = { conversationOf: () => first, record, heldByOtherPane: () => false };
    expect(recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'session-start', { session_id: 'thread-0' }, firstDeps)).toBe(0);
    for (let i = 1; i <= 1_100; i += 1) {
      const other = codexFresh(`pane-${i}`);
      recordHookEditProvenance({ sessionId: `pty-${i}`, scope }, 'session-start', { session_id: `thread-${i}` },
        { conversationOf: () => other, record, heldByOtherPane: () => false });
    }

    expect(recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'tool-complete', edit('thread-forjado'), firstDeps)).toBe(0);
    expect(recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'tool-complete', edit('thread-0'), firstDeps)).toBe(1);
  });

  it('falha do banco nunca derruba o hook', () => {
    const root = checkout();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const record = vi.fn(() => {
      throw new Error('SQLITE_BUSY');
    });
    expect(recordHookEditProvenance(ctx, 'tool-complete', {
      session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') },
    }, { conversationOf: () => claude('conv-a'), record })).toBe(0);
  });
});

describe('recordedEditsForSession (F-1237)', () => {
  it('só a retomada exata lê o registro da conversa, na mesma raiz', () => {
    const list = vi.fn((key: ConversationEditKey) =>
      new Map(key.conversationId === 'conv-a' && key.rootRealPath === '/r' ? [['src/x.ts', 1]] : []));

    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => claude('conv-a', true), list })).toEqual(new Map([['src/x.ts', 1]]));
    // Spawn fresco: tudo o que escreveu é posterior ao spawn — nada a ler.
    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => claude('conv-a', false), list })).toBeUndefined();
    expect(recordedEditsForSession('pty-1', '/outra', { conversationOf: () => claude('conv-a', true), list })).toBeUndefined();
    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => null, list })).toBeUndefined();
    expect(recordedEditsForSession(undefined, '/r', { conversationOf: () => claude('conv-a', true), list })).toBeUndefined();
  });
});
