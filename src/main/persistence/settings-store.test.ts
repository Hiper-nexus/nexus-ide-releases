import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler), on: () => {} },
  app: { getPath: () => '/nonexistent-nexus-test-home' },
}));

import { SETTINGS_CHANNELS } from '../../shared/settings-types';
import { getOrchSettings, replaceOrchSettings, resolveSettingsFile } from './settings-store';

const OPERATOR_FILE = path.join(os.homedir(), '.nexus', 'settings.json');

function operatorFileState(): string {
  try {
    const stat = fs.statSync(OPERATOR_FILE);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

describe('settings file isolation under test (F-932)', () => {
  it('points at the operator file only outside vitest', () => {
    expect(resolveSettingsFile({})).toBe(OPERATOR_FILE);
    const underTest = resolveSettingsFile({ VITEST: 'true' });
    expect(underTest.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(underTest)).toBe('settings.json');
    expect(underTest).not.toBe(OPERATOR_FILE);
  });

  it('a real write from a test never touches the operator settings', () => {
    const before = operatorFileState();
    const flipped = !getOrchSettings().leanCode;
    replaceOrchSettings({ leanCode: flipped });
    expect(getOrchSettings().leanCode).toBe(flipped);
    expect(operatorFileState()).toBe(before);
    const written = JSON.parse(fs.readFileSync(resolveSettingsFile(), 'utf8'));
    expect(written.orch.leanCode).toBe(flipped);
  });
});

it('F-932: mode and Cloudflare Account ID survive IPC save, another setting change and reload', async () => {
  const before = operatorFileState();
  const account = '0123456789abcdef0123456789abcdef';
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  const set = handlers.get(SETTINGS_CHANNELS.orchSet)!;
  const saved = set(null, { decisionModels: { mode: 'auto', cloudflareAccountId: account, clefModel: 'clef', visionEnabled: false } });
  expect(saved.decisionModels).toMatchObject({ mode: 'auto', cloudflareAccountId: account });
  set(null, { seniorMode: false });
  expect(JSON.parse(fs.readFileSync(resolveSettingsFile(), 'utf8')).orch.decisionModels).toMatchObject({ mode: 'auto', cloudflareAccountId: account });
  vi.resetModules();
  const reloaded = await import('./settings-store');
  reloaded.registerSettingsIpc();
  expect(reloaded.getOrchSettings().decisionModels).toMatchObject({ mode: 'auto', cloudflareAccountId: account });
  expect(operatorFileState()).toBe(before);
});

it('keeps valid Cloudflare settings when an unrelated legacy orchestration field is invalid', async () => {
  const wanted = { mode: 'auto', cloudflareAccountId: '0123456789abcdef0123456789abcdef', clefModel: 'clef', visionEnabled: false };
  const file = resolveSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(path.join(path.dirname(file), 'decision-models.json'), { force: true });
  fs.writeFileSync(file, JSON.stringify({ orch: { decisionModels: wanted, agentTransport: 'retired-transport' } }));
  vi.resetModules();
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  expect(store.getOrchSettings().decisionModels).toEqual(wanted);
});

it('keeps saved decision preferences when an older app rewrites the shared settings without that field', async () => {
  const wanted = { mode: 'auto', cloudflareAccountId: 'abcdef0123456789abcdef0123456789', clefModel: 'clef', visionEnabled: false };
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  handlers.get(SETTINGS_CHANNELS.orchSet)!(null, { decisionModels: wanted });
  const file = resolveSettingsFile();
  const older = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete older.orch.decisionModels;
  fs.writeFileSync(file, JSON.stringify(older));
  vi.resetModules();
  const reloaded = await import('./settings-store');
  reloaded.registerSettingsIpc();
  expect(reloaded.getOrchSettings().decisionModels).toEqual(wanted);
});

it('keeps explicit Jev vision opt-out even if the compatibility settings are replaced', async () => {
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  const wanted = { mode: 'auto', cloudflareAccountId: '0123456789abcdef0123456789abcdef', clefModel: 'clef', visionEnabled: true };
  const set = handlers.get(SETTINGS_CHANNELS.orchSet)!;
  set(null, { decisionModels: wanted });
  set(null, { decisionModels: { ...wanted, mode: 'jev' } });
  fs.writeFileSync(resolveSettingsFile(), JSON.stringify({ orch: { decisionModels: wanted } }));
  vi.resetModules();
  const reloaded = await import('./settings-store');
  reloaded.registerSettingsIpc();
  expect(reloaded.getOrchSettings().decisionModels).toMatchObject({ mode: 'jev', visionEnabled: false });
});

it('recovers saved decision preferences when the general settings file is unreadable JSON', async () => {
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  const wanted = { mode: 'auto', cloudflareAccountId: '0123456789abcdef0123456789abcdef', clefModel: 'clef', visionEnabled: false };
  handlers.get(SETTINGS_CHANNELS.orchSet)!(null, { decisionModels: wanted });
  fs.writeFileSync(resolveSettingsFile(), '{broken-json');
  vi.resetModules();
  const reloaded = await import('./settings-store');
  reloaded.registerSettingsIpc();
  expect(reloaded.getOrchSettings().decisionModels).toEqual(wanted);
});

it('does not restore stale Cloudflare egress consent if the authoritative preferences are corrupt', async () => {
  const wanted = { mode: 'auto', cloudflareAccountId: '0123456789abcdef0123456789abcdef', clefModel: 'clef', visionEnabled: true };
  const file = resolveSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ orch: { decisionModels: wanted } }));
  fs.writeFileSync(path.join(path.dirname(file), 'decision-models.json'), '{corrupt');
  vi.resetModules();
  const store = await import('./settings-store');
  store.registerSettingsIpc();
  expect(store.getOrchSettings().decisionModels).toMatchObject({ mode: 'jev', visionEnabled: false, cloudflareAccountId: wanted.cloudflareAccountId });
});

it('legacy saved vision consent still serves Clef but never authorizes OpenAI on upgrade', async () => {
  const file = resolveSettingsFile();
  const legacy = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: true };
  fs.writeFileSync(path.join(path.dirname(file), 'decision-models.json'), JSON.stringify(legacy));
  vi.resetModules();
  const store = await import('./settings-store'); store.registerSettingsIpc();
  const { resolveDecisionRoute } = await import('../decision-models/decision-routing');
  const loaded = store.getOrchSettings().decisionModels;
  const input = { surface: 'browserTool' as const, images: [{ content_type: 'image/png' as const, base64: 'synthetic' }] };
  expect(resolveDecisionRoute(input, loaded, { jev: true, clef: true, luna: true })?.provider).toBe('clef');
  expect(resolveDecisionRoute(input, loaded, { jev: true, clef: false, luna: true })).toBeNull();
  const set = handlers.get(SETTINGS_CHANNELS.orchSet)!;
  set(null, { decisionModels: { ...loaded, mode: 'luna' } });
  expect(resolveDecisionRoute(input, store.getOrchSettings().decisionModels, { jev: true, clef: true, luna: true })).toBeNull();
});

it('keeps the versioned OpenAI grant through IPC save and authoritative reload', async () => {
  const store = await import('./settings-store'); store.registerSettingsIpc();
  handlers.get(SETTINGS_CHANNELS.orchSet)!(null, { decisionModels: {
    mode: 'luna', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: true,
    visionConsent: { version: 1, recipients: ['luna'] },
  } });
  vi.resetModules();
  const reloaded = await import('./settings-store'); reloaded.registerSettingsIpc();
  const { resolveDecisionRoute } = await import('../decision-models/decision-routing');
  const loaded = reloaded.getOrchSettings().decisionModels;
  expect(loaded.visionConsent).toEqual({ version: 1, recipients: ['luna'] });
  expect(resolveDecisionRoute({ surface: 'browserTool', images: [{ content_type: 'image/png', base64: 'synthetic' }] }, loaded,
    { jev: false, clef: false, luna: true })?.provider).toBe('luna');
});
