import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('./db', () => ({ getDb: () => deps.db }));
import { copyProviderPaneSession, getProviderPaneSession, providerSessionAccountIsCompatible, saveProviderPaneSession } from './provider-session-store';
const scope = { version: 1 as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '/project', identitySource: 'manifest' as const };
afterEach(() => { deps.db?.close(); deps.db = null; });

it('retains ownership of root1 after the pane moves to root2 and refuses cross-account historical ingestion', () => {
  deps.db = new Database(':memory:');
  deps.db.exec(`CREATE TABLE provider_pane_sessions (
    installation_id TEXT, project_id TEXT, checkout_id TEXT, pane_id TEXT, adapter_id TEXT,
    session_key TEXT, session_id TEXT, transcript_path TEXT, updated_at INTEGER, account_id TEXT,
    PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id));
    CREATE TABLE provider_session_accounts (
    installation_id TEXT, project_id TEXT, checkout_id TEXT, adapter_id TEXT, session_id TEXT, account_id TEXT,
    PRIMARY KEY (installation_id, project_id, checkout_id, adapter_id, session_id));`);
  expect(saveProviderPaneSession(scope, 'pane-a', 'mimo-code', { key: 'session_id', id: 'root1' }, 'acct-a')).toBe(true);
  expect(saveProviderPaneSession(scope, 'pane-a', 'mimo-code', { key: 'session_id', id: 'root2' }, 'acct-a')).toBe(true);
  expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'root1', 'acct-b')).toBe(false);
  expect(saveProviderPaneSession(scope, 'pane-b', 'mimo-code', { key: 'session_id', id: 'root1' }, 'acct-b')).toBe(false);
  expect(getProviderPaneSession(scope, 'pane-a', 'mimo-code', 'acct-a')?.id).toBe('root2');
  expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'root1', 'acct-a')).toBe(true);
  const ownerA = 'native:' + 'a'.repeat(64); const ownerB = 'native:' + 'b'.repeat(64);
  expect(saveProviderPaneSession(scope, 'native-pane', 'mimo-code', { key: 'session_id', id: 'native-root' }, undefined, ownerA)).toBe(true);
  expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'native-root', undefined, ownerB)).toBe(false);
  expect(saveProviderPaneSession(scope, 'native-pane', 'mimo-code', { key: 'session_id', id: 'native-root' }, undefined, ownerB)).toBe(false);
  expect(providerSessionAccountIsCompatible(scope, 'mimo-code', 'native-root', undefined, ownerA)).toBe(true);
  expect(copyProviderPaneSession(scope, 'native-pane', 'native-copy-a', 'mimo-code', undefined, ownerA)).toBe(true);
  expect(getProviderPaneSession(scope, 'native-copy-a', 'mimo-code')?.id).toBe('native-root');
  expect(copyProviderPaneSession(scope, 'native-pane', 'native-copy-b', 'mimo-code', undefined, ownerB)).toBe(false);
  expect(getProviderPaneSession(scope, 'native-copy-b', 'mimo-code')).toBeNull();
});
