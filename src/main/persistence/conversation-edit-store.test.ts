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

describe('conversation-edit-store (F-1237, nexus.db real)', () => {
  const key = {
    scope: { installationId: 'i', projectId: 'p', checkoutId: 'c' },
    adapterId: 'claude',
    conversationId: 'conv-a',
    rootRealPath: '/repo',
  };

  const H = (c: string) => c.repeat(64);

  it('upsert idempotente guarda o conteúdo da última edição; a leitura é por conversa e raiz', async () => {
    const { getDb } = await import('./db');
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    expect(getDb()).not.toBeNull();

    expect(recordConversationEdits(key, new Map([['src/a.ts', H('1')], ['src/b.ts', H('2')]]), 1_000)).toBe(2);
    expect(recordConversationEdits(key, new Map([['src/a.ts', H('3')]]), 3_000)).toBe(1);
    expect(recordConversationEdits(key, new Map([['src/a.ts', H('4')]]), 2_000)).toBe(1); // atraso não sobrescreve
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
