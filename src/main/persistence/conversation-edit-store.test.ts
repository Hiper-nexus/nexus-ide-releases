import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1237-db-'));
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

afterAll(async () => {
  const { closeDb } = await import('./db');
  closeDb();
  fs.rmSync(userData, { recursive: true, force: true });
});

const key = {
  scope: { installationId: 'i', projectId: 'p', checkoutId: 'c' },
  adapterId: 'claude',
  conversationId: 'conv-a',
  rootRealPath: '/repo',
};

describe('conversation-edit-store (F-1237, nexus.db real)', () => {
  const H = (c: string) => c.repeat(64);

  it('upsert idempotente guarda o conteúdo da última edição; a leitura é por conversa e raiz', async () => {
    const { getDb } = await import('./db');
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    expect(getDb()).not.toBeNull();

    expect(recordConversationEdits(key, new Map([['src/a.ts', H('1')], ['src/b.ts', H('2')]]), 1_000)).toBe(2);
    expect(recordConversationEdits(key, new Map([['src/a.ts', H('3')]]), 3_000)).toBe(1);
    expect(recordConversationEdits(key, new Map([['src/a.ts', H('4')]]), 2_000)).toBe(0); // atraso não sobrescreve
    expect(listConversationEdits(key)).toEqual(new Map([['src/a.ts', H('3')], ['src/b.ts', H('2')]]));

    expect(listConversationEdits({ ...key, conversationId: 'conv-b' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, rootRealPath: '/outra-raiz' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, adapterId: 'codex' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, scope: { ...key.scope, checkoutId: 'outro' } })).toEqual(new Map());
  });

  it('caminho fora de forma e chave inválida não gravam (e não lançam)', async () => {
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    const other = { ...key, conversationId: 'conv-forma' };
    const bad = ['../fora.ts', '/abs.ts', 'a/../b.ts', 'a\\b.ts', '', 'a\u0000b'];
    expect(recordConversationEdits(other, new Map(bad.map((rel) => [rel, H('a')])), 1)).toBe(0);
    expect(recordConversationEdits(other, new Map([['src/a.ts', 'nao-e-sha256']]), 1)).toBe(0);
    expect(recordConversationEdits({ ...other, conversationId: '' }, new Map([['src/a.ts', H('a')]]), 1)).toBe(0);
    expect(recordConversationEdits(other, new Map([['src/a.ts', H('a')]]), Number.NaN)).toBe(0);
    expect(listConversationEdits(other)).toEqual(new Map());
    expect(recordConversationEdits(other, new Map([['src/a.ts', H('a')]]), 5, null)).toBe(0);
  });
});

describe('retenção e teto (F-1243, nexus.db real)', () => {
  const DAY = 24 * 3_600_000;
  const H = (c: string) => c.repeat(64);

  it('no boot, depois do SCHEMA, apaga a proveniência com mais de 30 dias', async () => {
    const { recordConversationEdits } = await import('./conversation-edit-store');
    const old = { ...key, conversationId: 'conv-retencao' };
    const now = Date.now();
    expect(recordConversationEdits(old, new Map([['src/velho.ts', H('1')]]), now - 31 * DAY)).toBe(1);
    expect(recordConversationEdits(old, new Map([['src/novo.ts', H('2')]]), now - 29 * DAY)).toBe(1);
    (await import('./db')).closeDb();

    vi.resetModules(); // novo boot do Main, mesmo nexus.db
    const fresh = await import('./conversation-edit-store');
    expect(fresh.listConversationEdits(old)).toEqual(new Map([['src/novo.ts', H('2')]]));
  });

  it('esquecer a conversa (forgetProviderSessionById) apaga as edições dela, em toda raiz', async () => {
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    const { forgetProviderSessionById } = await import('./provider-session-store');
    const gone = { ...key, conversationId: 'conv-esquecida' };
    const kept = { ...key, conversationId: 'conv-mantida' };
    const now = Date.now();
    expect(recordConversationEdits(gone, new Map([['src/a.ts', H('1')]]), now)).toBe(1);
    expect(recordConversationEdits({ ...gone, rootRealPath: '/outra-raiz' }, new Map([['src/b.ts', H('1')]]), now)).toBe(1);
    expect(recordConversationEdits(kept, new Map([['src/a.ts', H('2')]]), now)).toBe(1);

    forgetProviderSessionById(key.scope, 'claude', 'conv-esquecida');

    expect(listConversationEdits(gone)).toEqual(new Map());
    expect(listConversationEdits({ ...gone, rootRealPath: '/outra-raiz' })).toEqual(new Map());
    expect(listConversationEdits(kept)).toEqual(new Map([['src/a.ts', H('2')]]));
  });

  it('teto de linhas por conversa e raiz: caminho novo além do teto não grava; o que já existe atualiza', async () => {
    const { listConversationEdits, MAX_CONVERSATION_EDITS_READ, recordConversationEdits } = await import('./conversation-edit-store');
    const loop = { ...key, conversationId: 'conv-em-loop' };
    const many = new Map(Array.from({ length: MAX_CONVERSATION_EDITS_READ }, (_, i): [string, string] => [`src/f${i}.ts`, H('1')]));
    expect(recordConversationEdits(loop, many, 1_000)).toBe(MAX_CONVERSATION_EDITS_READ);

    expect(recordConversationEdits(loop, new Map([['src/mais-um.ts', H('2')]]), 2_000)).toBe(0);
    expect(recordConversationEdits(loop, new Map([['src/f0.ts', H('3')], ['src/mais-dois.ts', H('3')]]), 3_000)).toBe(1);

    const listed = listConversationEdits(loop);
    expect(listed.size).toBe(MAX_CONVERSATION_EDITS_READ);
    expect(listed.get('src/f0.ts')).toBe(H('3'));
    expect(listed.has('src/mais-um.ts')).toBe(false);
    // Outra conversa tem o próprio teto.
    expect(recordConversationEdits({ ...loop, conversationId: 'conv-outra' }, new Map([['src/mais-um.ts', H('2')]]), 2_000)).toBe(1);
  });
});

describe('providerSessionHeldByOtherPane (F-1241, nexus.db real)', () => {
  it('id gravado para outro pane é de outro; o do próprio pane, de outro adapter ou desconhecido, não', async () => {
    const { providerSessionHeldByOtherPane, saveProviderPaneSession } = await import('./provider-session-store');
    const scope = {
      version: 1 as const, installationId: 'i', projectId: 'p', checkoutId: 'c',
      rootRealPath: '/repo', identitySource: 'manifest' as const,
    };
    expect(saveProviderPaneSession(scope, 'pane-b', 'codex', { key: 'session_id', id: 'thread-b' })).toBe(true);
    // Escopo de execução e de coordenação podem diferir: a conversa é global.
    expect(saveProviderPaneSession({ ...scope, checkoutId: 'worktree' }, 'pane-c', 'codex', { key: 'session_id', id: 'thread-c' })).toBe(true);

    expect(providerSessionHeldByOtherPane('codex', 'thread-b', 'pane-a')).toBe(true);
    expect(providerSessionHeldByOtherPane('codex', 'thread-c', 'pane-a')).toBe(true);
    expect(providerSessionHeldByOtherPane('codex', 'thread-b', 'pane-b')).toBe(false);
    expect(providerSessionHeldByOtherPane('codex', 'thread-nova', 'pane-a')).toBe(false);
    expect(providerSessionHeldByOtherPane('claude', 'thread-b', 'pane-a')).toBe(false);
  });
});
