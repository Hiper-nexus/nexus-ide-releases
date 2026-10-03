import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetPathResolverForTests, resolveCliBinary, resolveSpawnBinary } from '../path-resolver';
import { describe, expect, it } from 'vitest';
import { CliAutoUpdateQueue, CliUpdateLease, isSafeAutomaticCliRecipe, selectAutomaticCliUpdateRecipe, shouldOfferAutoCliConsent } from './cli-auto-update';

describe('automatic CLI updates', () => {
  it.skipIf(process.platform === 'win32')('F-790: updates the same newer npm installation selected for the pane', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cli-update-')));
    try {
      const oldDir = path.join(home, 'homebrew', 'bin');
      const prefix = path.join(home, '.npm-global');
      const newDir = path.join(prefix, 'bin');
      const entry = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(newDir, { recursive: true });
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'codex'), '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
      fs.writeFileSync(entry, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
      const launcher = path.join(newDir, 'codex'); fs.symlinkSync(entry, launcher);
      const selected = resolveCliBinary('codex', { processPath: oldDir, effectivePath: [oldDir, newDir].join(path.delimiter), home })!;
      expect(resolveSpawnBinary('codex', selected.binPath)?.binPath).toBe(launcher);
      expect(selectAutomaticCliUpdateRecipe({
        adapterId: 'codex', platform: 'darwin', binPath: selected.binPath,
        realBinPath: fs.realpathSync(selected.binPath), userHome: home,
        isRunnerResolvable: () => true, isTargetWritable: () => true,
      })).toMatchObject({ kind: 'argv', argv: ['npm', 'install', '-g', '--prefix', prefix, '@openai/codex'] });
    } finally {
      __resetPathResolverForTests(); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects a due idle CLI without letting an active Claude pane block Codex', () => {
    const queue = new CliAutoUpdateQueue({ claude: 0, codex: 0 });
    const now = 30 * 60 * 60_000;
    expect(queue.next(['claude', 'codex'], now, (id) => id === 'claude')).toBe('codex');
    queue.markAttempt('codex', now);
    expect(queue.next(['claude', 'codex'], now, () => false)).toBe('claude');
    queue.markAttempt('claude', now);
    expect(queue.next(['claude', 'codex'], now, () => false)).toBeNull();
  });

  it('does not run scripts, WinGet, or privileged update recipes unattended', () => {
    expect(isSafeAutomaticCliRecipe({ kind: 'script', scriptUrl: 'https://claude.ai/install.sh', runner: 'bash', runnerHint: '' })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'powershell-script', scriptUrl: 'https://example.test/setup.ps1', runner: 'powershell', runnerHint: '' })).toBe(false);
    // F-749: só o canal oficial que a tabela marca entra, e só por HTTPS.
    expect(isSafeAutomaticCliRecipe({ kind: 'powershell-script', scriptUrl: 'https://static.devin.ai/cli/setup.ps1', runner: 'powershell', runnerHint: '', automaticUpdate: true })).toBe(true);
    expect(isSafeAutomaticCliRecipe({ kind: 'script', scriptUrl: 'http://cli.devin.ai/install.sh', runner: 'bash', runnerHint: '', automaticUpdate: true })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['winget', 'upgrade', 'Anthropic.ClaudeCode'], runner: 'winget', runnerHint: '' })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['sudo', 'npm', 'install'], runner: 'sudo', runnerHint: '' })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['/Users/operator/.local/bin/claude', 'update'], runner: '/Users/operator/.local/bin/claude', runnerHint: '' })).toBe(true);
  });

  it('targets the effective native Claude launcher only when it is user-owned', () => {
    const base = {
      adapterId: 'claude', platform: 'darwin' as const,
      binPath: '/Users/operator/.local/bin/claude',
      realBinPath: '/Users/operator/.local/share/claude/versions/2.1.278',
      userHome: '/Users/operator', isRunnerResolvable: () => true,
      isTargetWritable: () => true,
    };
    expect(selectAutomaticCliUpdateRecipe(base)).toMatchObject({
      kind: 'argv', argv: ['/Users/operator/.local/bin/claude', 'update'],
    });
    expect(selectAutomaticCliUpdateRecipe({
      ...base, binPath: '/usr/local/bin/claude', realBinPath: '/usr/local/lib/claude',
    })).toBeNull();
    expect(selectAutomaticCliUpdateRecipe({ ...base, isTargetWritable: () => false })).toBeNull();
  });

  it('skips WinGet during background passes', () => {
    expect(selectAutomaticCliUpdateRecipe({
      adapterId: 'claude', platform: 'win32',
      binPath: 'C:\\Users\\operator\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe',
      realBinPath: 'C:\\Users\\operator\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_abc\\claude.exe',
      userHome: 'C:\\Users\\operator', isRunnerResolvable: () => true,
      isTargetWritable: () => true,
    })).toBeNull();
  });

  it('F-749: o script oficial do Devin entra na atualização diária, no Mac e no Windows', () => {
    // 02/10: "ideal o Nexus todo dia atualizar todas as CLIs por padrão" — o
    // Devin era a CLI que ficava para trás (canal oficial = script).
    expect(selectAutomaticCliUpdateRecipe({
      adapterId: 'devin', platform: 'darwin',
      binPath: '/Users/operator/.local/bin/devin',
      realBinPath: '/Users/operator/.local/share/devin/cli/_versions/1.0.0/devin',
      installationDistribution: 'curl-bash',
      userHome: '/Users/operator', isRunnerResolvable: () => true,
      isTargetWritable: () => true,
    })).toMatchObject({
      kind: 'script', scriptUrl: 'https://cli.devin.ai/install.sh', automaticUpdate: true,
    });
    expect(selectAutomaticCliUpdateRecipe({
      adapterId: 'devin', platform: 'win32',
      binPath: 'C:\\Users\\operator\\AppData\\Local\\devin\\cli\\bin\\devin.exe',
      realBinPath: 'C:\\Users\\operator\\AppData\\Local\\devin\\cli\\bin\\devin.exe',
      windowsLocalAppData: 'C:\\Users\\operator\\AppData\\Local',
      installationDistribution: 'irm-iex',
      userHome: 'C:\\Users\\operator', isRunnerResolvable: () => true,
      isTargetWritable: () => true,
    })).toMatchObject({
      kind: 'powershell-script',
      scriptUrl: 'https://static.devin.ai/cli/setup.ps1',
      replacesLocalAppDataExecutable: 'devin/cli/bin/devin.exe',
      automaticUpdate: true,
    });
    // Instalação que o Nexus não reconhece continua manual.
    expect(selectAutomaticCliUpdateRecipe({
      adapterId: 'devin', platform: 'win32',
      binPath: 'D:\\tools\\devin.exe', realBinPath: 'D:\\tools\\devin.exe',
      windowsLocalAppData: 'C:\\Users\\operator\\AppData\\Local',
      userHome: 'C:\\Users\\operator', isRunnerResolvable: () => true,
      isTargetWritable: () => true,
    })).toBeNull();
  });

  it('keeps a failed operation due for a later retry and gates overlapping passes', async () => {
    const queue = new CliAutoUpdateQueue();
    const now = Date.now();
    let release!: () => void;
    const started = queue.runOne(['claude'], now, () => false, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return false;
    });
    expect(await queue.runOne(['claude'], now, () => false, async () => true)).toBeNull();
    release();
    expect(await started).toBe('claude');
    expect(queue.next(['claude', 'codex'], now + 10 * 60_000, () => false)).toBe('codex');
    expect(queue.next(['claude'], now + 61 * 60_000, () => false)).toBe('claude');
  });

  it('defers a declined consent for seven days and then offers it again', () => {
    const declined = { enabled: false, askAgainAt: 7 * 24 * 60 * 60_000 };
    expect(shouldOfferAutoCliConsent(declined, 6 * 24 * 60 * 60_000)).toBe(false);
    expect(shouldOfferAutoCliConsent(declined, 7 * 24 * 60 * 60_000)).toBe(true);
    expect(shouldOfferAutoCliConsent({ enabled: true }, 9 * 24 * 60 * 60_000)).toBe(false);
  });

  it('prevents manual and automatic updates from holding the same adapter at once', () => {
    const lease = new CliUpdateLease();
    expect(lease.acquire('claude')).toBe(true);
    expect(lease.acquire('claude')).toBe(false);
    expect(lease.acquire('codex')).toBe(false);
    lease.release('claude');
    expect(lease.acquire('claude')).toBe(true);
  });

  it('holds a spawn permit across installer release until the pane is registered', async () => {
    const gate = new CliUpdateLease();
    expect(gate.acquire('claude')).toBe(true);
    const pending = gate.acquireSpawnPermit('claude');
    gate.release('claude');
    expect(gate.acquire('claude')).toBe(false);
    const releaseSpawn = await pending;
    releaseSpawn();
    expect(gate.acquire('claude')).toBe(true);
  });

  it('keeps automatic and manual install attempts out of provisioning', () => {
    const gate = new CliUpdateLease();
    expect(gate.beginProvisioning()).toBe(true);
    expect(gate.acquire('claude')).toBe(false);
    expect(gate.acquire('claude', 'provisioning')).toBe(true);
    expect(gate.acquire('codex', 'provisioning')).toBe(false);
    gate.release('claude');
    gate.endProvisioning();
    expect(gate.acquire('codex')).toBe(true);
  });

  it('does not overlap automatic consent and first-run provisioning dialogs', () => {
    const gate = new CliUpdateLease();
    expect(gate.beginAutoConsent()).toBe(true);
    expect(gate.beginProvisioning()).toBe(false);
    gate.endAutoConsent();
    expect(gate.beginProvisioning()).toBe(true);
    expect(gate.beginAutoConsent()).toBe(false);
  });

  it('backs off after a transient thrown error without blocking other CLIs', async () => {
    const queue = new CliAutoUpdateQueue();
    const now = 30 * 60 * 60_000;
    await expect(queue.runOne(['claude'], now, () => false, async () => {
      throw new Error('offline');
    })).rejects.toThrow('offline');
    expect(queue.next(['claude', 'codex'], now + 60_000, () => false)).toBe('codex');
  });
});
