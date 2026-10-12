import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionProviderConversation } from '../pty/pty-manager';
import type { ConversationEditKey } from '../persistence/conversation-edit-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { RECORDED_EDIT_MAX_HASH_BYTES } from '../regression-gate/regression-gate';
import {
  __resetHookEditProvenanceForTests,
  MAX_QUEUED_EDIT_EVENTS_PER_SESSION,
  MAX_RECORDED_PATHS_PER_EVENT,
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
  const calls: Array<{ key: ConversationEditKey; paths: readonly string[]; hashes: readonly string[]; at: number }> = [];
  const record = vi.fn((key: ConversationEditKey, edits: ReadonlyMap<string, string>, at: number, _db?: unknown, _insertNew?: boolean) => {
    calls.push({ key, paths: [...edits.keys()], hashes: [...edits.values()], at });
    return edits.size;
  });
  return { calls, record };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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

  it('F-1284: ferramentas de edição do Kimi/Grok e afins (os nomes que o produto já trata como edição)', () => {
    expect(extractEditedPaths({ tool_name: 'str_replace', tool_input: { path: '/root/a.ts', old_str: 'x', new_str: 'y' } })).toEqual(['/root/a.ts']);
    expect(extractEditedPaths({ tool_name: 'write_file', tool_input: { file_path: '/root/b.ts', content: '…' } })).toEqual(['/root/b.ts']);
    expect(extractEditedPaths({ tool_name: 'write_file', tool_input: { path: '/root/b2.ts', content: '…' } })).toEqual(['/root/b2.ts']);
    expect(extractEditedPaths({ tool_name: 'edit_file', tool_input: { path: '/root/c.ts' } })).toEqual(['/root/c.ts']);
    expect(extractEditedPaths({ tool_name: 'write_to_file', tool_input: { TargetFile: '/root/d.ts', CodeContent: '…' } })).toEqual(['/root/d.ts']);
    expect(extractEditedPaths({ tool_name: 'replace_file_content', tool_input: { TargetFile: '/root/e.ts' } })).toEqual(['/root/e.ts']);
    expect(extractEditedPaths({ tool_name: 'multi_replace_file_content', tool_input: { TargetFile: '/root/f.ts' } })).toEqual(['/root/f.ts']);
    // Leitura com os mesmos campos continua fora.
    expect(extractEditedPaths({ tool_name: 'view_file', tool_input: { AbsolutePath: '/root/a.ts' } })).toEqual([]);
    expect(extractEditedPaths({ tool_name: 'read_file', tool_input: { path: '/root/a.ts' } })).toEqual([]);
    for (const tool of ['str_replace', 'write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
      expect(hookBodyMayCarryEdit(`{"session_id":"s","tool_name":"${tool}","tool_input":{`)).toBe(true);
    }
    expect(hookBodyMayCarryEdit('{"session_id":"s","tool_name":"read_file","tool_input":{')).toBe(false);
    // Nomes minúsculos do mapa do agent-hook-listener: escrita entra, leitura não.
    for (const tool of ['create', 'write', 'edit', 'patch']) {
      expect(extractEditedPaths({ tool_name: tool, tool_input: { path: `/root/${tool}.ts` } })).toEqual([`/root/${tool}.ts`]);
    }
    expect(extractEditedPaths({ tool_name: 'read', tool_input: { path: '/root/a.ts' } })).toEqual([]);
    expect(extractEditedPaths({ tool_name: 'view', tool_input: { path: '/root/a.ts' } })).toEqual([]);
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
  it('grava o caminho da edição pela conversa do argv, na raiz de execução do pane', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const n = await recordHookEditProvenance(ctx, 'tool-complete', {
      session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') },
    }, { conversationOf: () => claude('conv-a'), record, now: () => 1_234 });

    expect(n).toBe(1);
    expect(calls).toEqual([{
      key: { scope: triple, adapterId: 'claude', conversationId: 'conv-a', rootRealPath: root },
      paths: ['src/x.ts'],
      // F-1242: o conteúdo que a edição deixou no disco.
      hashes: [sha256('export const x = 1;\n')],
      at: 1_234,
    }]);
  });

  it('(c) outra conversa, caminho fora da raiz, evento que não é fim de tool ou sessão sem pane: nada gravado', async () => {
    const root = checkout();
    const { record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const deps = { conversationOf: () => claude('conv-a'), record };
    const edit = (file: string, sessionId = 'conv-a') =>
      ({ session_id: sessionId, tool_name: 'Write', tool_input: { file_path: file } });

    // Corpo forjado com a conversa de outro agente: o pane só registra a dele.
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, 'src/x.ts'), 'conv-do-outro'), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('/etc/hosts'), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, '../fora.ts')), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-use', edit(path.join(root, 'src/x.ts')), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } }, deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit(path.join(root, 'src/x.ts')), { ...deps, conversationOf: () => null })).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('sem id no argv (Codex fresco): a primeira conversa que o CLI anuncia no bearer fica fixada; outra é recusada', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh();
    const deps = { conversationOf: () => conversation, record, heldByOtherPane: () => false };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };

    expect(await recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', { session_id: 'thread-forjado', tool_name: 'apply_patch', tool_input: patch, cwd: root }, deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', { session_id: 'thread-1', tool_name: 'apply_patch', tool_input: patch, cwd: root }, deps)).toBe(1);
    expect(calls.map((call) => [call.key.adapterId, call.key.conversationId, call.paths])).toEqual([['codex', 'thread-1', ['src/x.ts']]]);
  });

  it('F-1241: só o SessionStart fixa a conversa; o tool-complete de um curl com hooks mudos, não', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh();
    const deps = { conversationOf: () => conversation, record, heldByOtherPane: () => false };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });

    // O primeiro evento do canal é um tool-complete com o thread de outro pane.
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('thread-de-outro-pane'), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'user-submit', { session_id: 'thread-de-outro-pane' }, deps)).toBe(0);
    // O SessionStart do próprio CLI fixa; o resto do canal tem de concordar.
    expect(await recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('thread-de-outro-pane'), deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('thread-1'), deps)).toBe(1);
    expect(calls.map((call) => call.key.conversationId)).toEqual(['thread-1']);
    // Kimi/Grok anunciam pelo evento `session`.
    const kimi = codexFresh('pane-kimi');
    const kimiDeps = { ...deps, conversationOf: () => kimi };
    expect(await recordHookEditProvenance({ ...ctx, sessionId: 'pty-kimi' }, 'session', { session_id: 'kimi-1' }, kimiDeps)).toBe(0);
    expect(await recordHookEditProvenance({ ...ctx, sessionId: 'pty-kimi' }, 'tool-complete', edit('kimi-1'), kimiDeps)).toBe(1);
  });

  it('F-1241: id que provider_pane_sessions já dá a outro pane não é fixado', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-codex', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = codexFresh('pane-a');
    const heldByOtherPane = vi.fn((_conversation: SessionProviderConversation, claimed: string) => claimed === 'thread-do-pane-b');
    const deps = { conversationOf: () => conversation, record, heldByOtherPane };
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });

    expect(await recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-do-pane-b' }, deps)).toBe(0);
    expect(heldByOtherPane).toHaveBeenCalledWith(conversation, 'thread-do-pane-b');
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('thread-do-pane-b'), deps)).toBe(0);
    // O SessionStart legítimo, depois, ainda fixa o id próprio.
    expect(await recordHookEditProvenance(ctx, 'session-start', { session_id: 'thread-1' }, deps)).toBe(0);
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit('thread-1'), deps)).toBe(1);
    expect(calls.map((call) => call.key.conversationId)).toEqual(['thread-1']);
  });

  it('F-1241: o pin vive com a sessão viva, sem despejo por volume de spawns', async () => {
    const root = checkout();
    const { record } = recorder();
    const scope = testProjectScope({ rootRealPath: root });
    const patch = { command: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' };
    const edit = (sessionId: string) => ({ session_id: sessionId, tool_name: 'apply_patch', tool_input: patch, cwd: root });
    const first = codexFresh('pane-0');
    const firstDeps = { conversationOf: () => first, record, heldByOtherPane: () => false };
    expect(await recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'session-start', { session_id: 'thread-0' }, firstDeps)).toBe(0);
    for (let i = 1; i <= 1_100; i += 1) {
      const other = codexFresh(`pane-${i}`);
      await recordHookEditProvenance({ sessionId: `pty-${i}`, scope }, 'session-start', { session_id: `thread-${i}` },
        { conversationOf: () => other, record, heldByOtherPane: () => false });
    }

    expect(await recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'tool-complete', edit('thread-forjado'), firstDeps)).toBe(0);
    expect(await recordHookEditProvenance({ sessionId: 'pty-0', scope }, 'tool-complete', edit('thread-0'), firstDeps)).toBe(1);
  });

  it('F-1242: arquivo sem prova de conteúdo (symlink, acima do teto, apagado) não é gravado', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const deps = { conversationOf: () => claude('conv-a'), record };
    fs.symlinkSync('x.ts', path.join(root, 'src/link.ts'));
    fs.writeFileSync(path.join(root, 'src/big.ts'), Buffer.alloc(RECORDED_EDIT_MAX_HASH_BYTES + 1, 0x61));
    const patch = ['*** Begin Patch', '*** Update File: src/link.ts', '*** Update File: src/big.ts',
      '*** Delete File: src/gone.ts', '*** Update File: src/x.ts', '*** End Patch'].join('\n');

    expect(await recordHookEditProvenance(ctx, 'tool-complete', {
      session_id: 'conv-a', tool_name: 'apply_patch', tool_input: { command: patch }, cwd: root,
    }, deps)).toBe(1);
    expect(calls.map((call) => call.paths)).toEqual([['src/x.ts']]);
  });

  it('F-1242: um evento de cada vez lê arquivos por sessão; fila cheia descarta na hora', async () => {
    const root = checkout();
    const { record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = claude('conv-a');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const hash = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await held;
      active -= 1;
      return 'a'.repeat(64);
    });
    const deps = { conversationOf: () => conversation, record, hash };
    const body = { session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } };

    const queued = Array.from({ length: MAX_QUEUED_EDIT_EVENTS_PER_SESSION }, () =>
      recordHookEditProvenance(ctx, 'tool-complete', body, deps));
    expect(await recordHookEditProvenance(ctx, 'tool-complete', body, deps)).toBe(0);
    release();

    expect(await Promise.all(queued)).toEqual(Array(MAX_QUEUED_EDIT_EVENTS_PER_SESSION).fill(1));
    expect(maxActive).toBe(1);
    // A fila esvaziou: o próximo evento grava de novo.
    expect(await recordHookEditProvenance(ctx, 'tool-complete', body, deps)).toBe(1);
  });

  it('F-1249: o Stop re-hasheia só o que o turno gravou, uma vez; Stop de outra conversa ou prompt novo não', async () => {
    const root = checkout();
    const { calls, record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = claude('conv-a');
    const deps = { conversationOf: () => conversation, record };
    const edit = { session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } };
    const event = (eventType: string, sessionId = 'conv-a') => recordHookEditProvenance(ctx, eventType, { session_id: sessionId }, deps);

    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit, deps)).toBe(1);
    fs.writeFileSync(path.join(root, 'src/x.ts'), 'formatado\n'); // o formatador, depois do hash
    expect(await event('stop', 'conv-do-outro')).toBe(0);
    expect(await event('stop')).toBe(1);
    expect(calls.at(-1)).toMatchObject({ paths: ['src/x.ts'], hashes: [sha256('formatado\n')] });
    expect(record.mock.calls.at(-1)![4]).toBe(false); // só atualiza a linha que o turno gravou
    expect(await event('stop')).toBe(0); // turno fechado: nada a reler

    // Turno interrompido (sem Stop): o prompt seguinte descarta o que ele gravou.
    expect(await recordHookEditProvenance(ctx, 'tool-complete', edit, deps)).toBe(1);
    expect(await event('user-submit')).toBe(0);
    expect(await event('stop')).toBe(0);
    expect(calls).toHaveLength(3);
  });

  // F-1363: o endpoint responde ao Stop sem esperar a fila (void). Um job do
  // turno que já acabou não pode ler o disco nem gravar depois do prompt seguinte.
  function heldTurn() {
    const root = checkout();
    fs.writeFileSync(path.join(root, 'src/y.ts'), 'lento\n');
    const persisted = new Map<string, string>();
    const record = vi.fn((_key: ConversationEditKey, edits: ReadonlyMap<string, string>, _at: number, _db?: unknown, insertNew = true) => {
      for (const [file, hash] of edits) if (insertNew || persisted.has(file)) persisted.set(file, hash);
      return edits.size;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const hashing = new Promise<void>((resolve) => { started = resolve; });
    let holdNext = true;
    const hash = vi.fn(async (dir: string, rel: string) => {
      if (rel === 'src/y.ts' && holdNext) {
        holdNext = false;
        started();
        await held;
      }
      return sha256(fs.readFileSync(path.join(dir, rel), 'utf8'));
    });
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = claude('conv-a');
    const deps = { conversationOf: () => conversation, record, hash };
    const edit = (file: string) => recordHookEditProvenance(ctx, 'tool-complete',
      { session_id: 'conv-a', tool_name: 'Write', tool_input: { file_path: path.join(root, file) } }, deps);
    const event = (eventType: string) => recordHookEditProvenance(ctx, eventType, { session_id: 'conv-a' }, deps);
    return { root, persisted, release, hashing, edit, event };
  }

  it('F-1363: Stop enfileirado de um turno encerrado não grava o que outro agente escreveu depois do prompt seguinte', async () => {
    const turn = heldTurn();
    expect(await turn.edit('src/x.ts')).toBe(1);
    const ownHash = turn.persisted.get('src/x.ts');
    const slow = turn.edit('src/y.ts');
    await turn.hashing;
    const stop = turn.event('stop'); // o endpoint já respondeu 200
    fs.writeFileSync(path.join(turn.root, 'src/x.ts'), 'OUTRO AGENTE DEPOIS DO STOP\n');
    expect(await turn.event('user-submit')).toBe(0);
    turn.release();
    await slow;
    const recorded = await stop;

    expect(turn.persisted.get('src/x.ts')).toBe(ownHash);
    expect(recorded).toBe(0);
  });

  it('F-1363: hash de edição do turno anterior, ainda na fila no prompt seguinte, não lê o disco do turno novo', async () => {
    const turn = heldTurn();
    const slow = turn.edit('src/y.ts');
    await turn.hashing;
    const late = turn.edit('src/x.ts');
    expect(await turn.event('user-submit')).toBe(0);
    fs.writeFileSync(path.join(turn.root, 'src/x.ts'), 'OUTRO AGENTE NO TURNO NOVO\n');
    turn.release();
    await slow;
    const recorded = await late;

    expect(turn.persisted.has('src/x.ts')).toBe(false);
    expect(recorded).toBe(0);
    // O turno novo grava de novo, normalmente.
    expect(await turn.edit('src/x.ts')).toBe(1);
    expect(turn.persisted.get('src/x.ts')).toBe(sha256('OUTRO AGENTE NO TURNO NOVO\n'));
  });

  it('F-1249: o Stop relê no máximo MAX_RECORDED_PATHS_PER_EVENT caminhos do turno', async () => {
    const root = checkout();
    const { record } = recorder();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const conversation = claude('conv-a');
    const hash = vi.fn(async () => 'a'.repeat(64));
    const deps = { conversationOf: () => conversation, record, hash };
    const patch = (from: number) => ['*** Begin Patch',
      ...Array.from({ length: MAX_RECORDED_PATHS_PER_EVENT }, (_, i) => `*** Add File: src/f${from + i}.ts`),
      '*** End Patch'].join('\n');
    for (const from of [0, 1_000]) {
      expect(await recordHookEditProvenance(ctx, 'tool-complete', {
        session_id: 'conv-a', tool_name: 'apply_patch', tool_input: { command: patch(from) }, cwd: root,
      }, deps)).toBe(MAX_RECORDED_PATHS_PER_EVENT);
    }
    hash.mockClear();

    expect(await recordHookEditProvenance(ctx, 'stop', { session_id: 'conv-a' }, deps)).toBe(MAX_RECORDED_PATHS_PER_EVENT);
    expect(hash).toHaveBeenCalledTimes(MAX_RECORDED_PATHS_PER_EVENT);
  });

  it('falha do banco nunca derruba o hook', async () => {
    const root = checkout();
    const ctx = { sessionId: 'pty-1', scope: testProjectScope({ rootRealPath: root }) };
    const record = vi.fn(() => {
      throw new Error('SQLITE_BUSY');
    });
    expect(await recordHookEditProvenance(ctx, 'tool-complete', {
      session_id: 'conv-a', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') },
    }, { conversationOf: () => claude('conv-a'), record })).toBe(0);
  });
});

describe('recordedEditsForSession (F-1237)', () => {
  it('só a retomada exata lê o registro da conversa, na mesma raiz', () => {
    const hash = 'a'.repeat(64);
    const list = vi.fn((key: ConversationEditKey) =>
      new Map<string, string>(key.conversationId === 'conv-a' && key.rootRealPath === '/r' ? [['src/x.ts', hash]] : []));

    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => claude('conv-a', true), list })).toEqual(new Map([['src/x.ts', hash]]));
    // Spawn fresco: tudo o que escreveu é posterior ao spawn — nada a ler.
    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => claude('conv-a', false), list })).toBeUndefined();
    expect(recordedEditsForSession('pty-1', '/outra', { conversationOf: () => claude('conv-a', true), list })).toBeUndefined();
    expect(recordedEditsForSession('pty-1', '/r', { conversationOf: () => null, list })).toBeUndefined();
    expect(recordedEditsForSession(undefined, '/r', { conversationOf: () => claude('conv-a', true), list })).toBeUndefined();
  });
});
