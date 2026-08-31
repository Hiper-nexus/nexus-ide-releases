import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserWindow, WebContents } from 'electron';
import { RENDERER_PROTOCOL_ENTRY_URL } from './renderer-protocol';
import { bindTrustedMainWindow } from './security/trusted-ipc';

// Sender vivo e confiável: mesma receita do window-security.test.ts — sem
// o bind o guard isLiveTrustedMainWindowSender recusa antes de validar nada.
function trustedSender() {
  const frame = {};
  const sender = {
    mainFrame: frame,
    getURL: () => RENDERER_PROTOCOL_ENTRY_URL,
    isDestroyed: () => false,
    isCrashed: () => false,
    once: () => {},
  } as unknown as WebContents;
  const window = {
    webContents: sender,
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  bindTrustedMainWindow(window, RENDERER_PROTOCOL_ENTRY_URL);
  return { sender, senderFrame: frame } as never;
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/app' },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  session: {},
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn() },
}));

vi.mock('./pty/pty-manager', () => ({ killSessionsFor: vi.fn() }));
vi.mock('./runtime-process-inventory', () => ({
  liveRuntimeProcessSummary: vi.fn(() => ({ total: 0, busy: 0 })),
  sealRuntimeProcessAdmissionForShutdown: vi.fn(),
}));
vi.mock('./agent-runtime/agent-runtime-bridge', () => ({
  handleRenderProcessGone: vi.fn(),
}));
vi.mock('./macos-activation-policy', () => ({
  applyMacOSDockIcon: vi.fn(),
  ensureRegularMacOSActivation: vi.fn(),
  reassertMacOSDockPresence: vi.fn(),
}));

import { handleOpenTerminalPathRequest } from './window';

describe('handleOpenTerminalPathRequest — caminho clicável do terminal', () => {
  // Arquivo real dentro do home (alvo válido) e fora (tmpdir do SO).
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.homedir(), '.nexus-term-path-test-'));
    outsideDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-term-path-'));
    writeFileSync(path.join(homeDir, 'evidence.md'), 'x', 'utf8');
    writeFileSync(path.join(outsideDir, 'system.log'), 'x', 'utf8');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('recusa caminho relativo — só absoluto', async () => {
    const r = await handleOpenTerminalPathRequest(trustedSender(), 'relative/file.md');
    expect(r.ok).toBe(false);
  });

  it('recusa traversal com ..', async () => {
    const r = await handleOpenTerminalPathRequest(
      trustedSender(),
      '/tmp/../etc/passwd',
    );
    expect(r.ok).toBe(false);
  });

  it('recusa caminho inexistente sem tocar o shell', async () => {
    const r = await handleOpenTerminalPathRequest(
      trustedSender(),
      path.join(homeDir, 'nao-existe.md'),
    );
    expect(r.ok).toBe(false);
    const { shell } = await import('electron');
    expect(shell.openPath).not.toHaveBeenCalledWith(
      path.join(homeDir, 'nao-existe.md'),
    );
  });

  it('recusa caminho EXISTENTE fora do home (tmpdir do SO)', async () => {
    const r = await handleOpenTerminalPathRequest(
      trustedSender(),
      path.join(outsideDir, 'system.log'),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('home');
  });

  it('abre arquivo real dentro do home', async () => {
    const target = path.join(homeDir, 'evidence.md');
    const r = await handleOpenTerminalPathRequest(trustedSender(), target);
    expect(r.ok).toBe(true);
    const { shell } = await import('electron');
    expect(shell.openPath).toHaveBeenCalledWith(target);
  });

  it('abre diretório dentro do home', async () => {
    const r = await handleOpenTerminalPathRequest(trustedSender(), homeDir);
    expect(r.ok).toBe(true);
  });

  it('não-string e payload gigante são recusados', async () => {
    expect((await handleOpenTerminalPathRequest(trustedSender(), 42 as never)).ok).toBe(
      false,
    );
    expect(
      (await handleOpenTerminalPathRequest(trustedSender(), '/' + 'a'.repeat(5_000))).ok,
    ).toBe(false);
  });
});
