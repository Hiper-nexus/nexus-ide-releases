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

  it('upsert idempotente guarda a última edição; a leitura é por conversa e raiz', async () => {
    const { getDb } = await import('./db');
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    expect(getDb()).not.toBeNull();

    expect(recordConversationEdits(key, ['src/a.ts', 'src/b.ts', 'src/a.ts'], 1_000)).toBe(2);
    expect(recordConversationEdits(key, ['src/a.ts'], 3_000)).toBe(1);
    expect(recordConversationEdits(key, ['src/a.ts'], 2_000)).toBe(1); // atraso não rejuvenesce
    expect(listConversationEdits(key)).toEqual(new Map([['src/a.ts', 3_000], ['src/b.ts', 1_000]]));

    expect(listConversationEdits({ ...key, conversationId: 'conv-b' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, rootRealPath: '/outra-raiz' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, adapterId: 'codex' })).toEqual(new Map());
    expect(listConversationEdits({ ...key, scope: { ...key.scope, checkoutId: 'outro' } })).toEqual(new Map());
  });

  it('caminho fora de forma e chave inválida não gravam (e não lançam)', async () => {
    const { listConversationEdits, recordConversationEdits } = await import('./conversation-edit-store');
    const other = { ...key, conversationId: 'conv-forma' };
    expect(recordConversationEdits(other, ['../fora.ts', '/abs.ts', 'a/../b.ts', 'a\\b.ts', '', 'a\u0000b'], 1)).toBe(0);
    expect(recordConversationEdits({ ...other, conversationId: '' }, ['src/a.ts'], 1)).toBe(0);
    expect(recordConversationEdits(other, ['src/a.ts'], Number.NaN)).toBe(0);
    expect(listConversationEdits(other)).toEqual(new Map());
    expect(recordConversationEdits(other, ['src/a.ts'], 5, null)).toBe(0);
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
