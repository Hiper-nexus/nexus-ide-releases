import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetPathResolverForTests, resolveCliBinary, resolveSpawnBinary, warmCliBinaryVersions } from '../path-resolver';
import { describe, expect, it } from 'vitest';
import {
  CliAutoUpdateQueue, CliUpdateLease, caskReceiptArtifactKinds, caskReceiptPath, cliVersionCheck,
  cliVersionCheckUpToDate, isSafeAutomaticCliRecipe, isVersionedCliInstall,
  selectAutomaticCliUpdateRecipe, shouldOfferAutoCliConsent,
} from './cli-auto-update';

describe('automatic CLI updates', () => {
  it.skipIf(process.platform === 'win32')('F-790: updates the same newer npm installation selected for the pane', async () => {
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
      const options = { processPath: oldDir, effectivePath: [oldDir, newDir].join(path.delimiter), home };
      // F-764: as versões são sondadas fora do Main; o aquecimento vem antes da escolha.
      await warmCliBinaryVersions({ commands: ['codex'], ...options });
      const selected = resolveCliBinary('codex', options)!;
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

  it('keeps Claude-derived provider spawns out of a Claude update lease', async () => {
    const lease = new CliUpdateLease();
    expect(lease.acquire('claude')).toBe(true);
    let entered = false;
    const pending = lease.acquireSpawnPermit('deepseek').then((release) => { entered = true; return release; });
    await Promise.resolve();
    expect(entered).toBe(false);
    lease.release('claude');
    const release = await pending;
    expect(lease.acquire('glm')).toBe(false);
    release();
    expect(lease.acquire('glm-flash')).toBe(true);
    expect(lease.isHeld('muse-claude')).toBe(true);
    lease.release('longcat');
    expect(lease.acquire('claude')).toBe(true);
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

describe('F-1395: no boot, analisar e atualizar todas as CLIs', () => {
  const hour = 60 * 60_000;

  it('(a) o passe de boot percorre TODAS as candidatas checadas há 3 h, em série', async () => {
    const now = 100 * hour;
    const queue = new CliAutoUpdateQueue({ claude: now - 3 * hour, codex: now - 3 * hour, muse: now - 3 * hour });
    const ran: string[] = [];
    let inFlight = 0;
    const attempted = await queue.runAll(['claude', 'codex', 'muse', 'kimi'], now, () => false, async (id) => {
      inFlight++;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      ran.push(id);
      inFlight--;
      return id !== 'kimi';
    });
    expect(ran).toEqual(['claude', 'codex', 'muse', 'kimi']);
    expect(attempted).toEqual(ran);
    // O tick diário não as repete; a falha (kimi) volta só na retentativa.
    expect(queue.next(['claude', 'codex', 'muse', 'kimi'], now + 10 * 60_000, () => false)).toBeNull();
  });

  it('(d) a checada há < 30 min não repete no boot; uma CLI que falha não para o passe', async () => {
    const now = 100 * hour;
    const queue = new CliAutoUpdateQueue({ claude: now - 10 * 60_000, codex: now - 31 * 60_000 });
    const ran: string[] = [];
    await queue.runAll(['claude', 'codex', 'grok'], now, () => false, async (id) => {
      ran.push(id);
      if (id === 'codex') throw new Error('offline');
      return true;
    });
    expect(ran).toEqual(['codex', 'grok']);
  });

  it('(b) brew upgrade --cask do Caskroom gravável é aceito; .pkg/sudo continua manual', () => {
    const muse = {
      adapterId: 'muse', platform: 'darwin' as const,
      binPath: '/opt/homebrew/bin/muse',
      realBinPath: '/opt/homebrew/Caskroom/muse-code/1.4.6-R6000.1/muse-aarch64-macos',
      userHome: '/Users/operator', isRunnerResolvable: () => true, isTargetWritable: () => true,
    };
    // Recibo real do muse-code 1.4.6 nesta máquina (só binary + zap).
    const receipt = JSON.stringify({ uninstall_artifacts: [
      { binary: ['muse-aarch64-macos', { target: 'muse' }] },
      { zap: [{ trash: ['~/.config/muse', '~/.local/share/muse'] }] },
    ] });
    // B1: recibo só-binary mas manifesto-alvo com pkg/postflight → manual
    expect(selectAutomaticCliUpdateRecipe({
      ...muse,
      caskArtifactKinds: ['binary', 'zap'],
      caskTargetArtifactKinds: ['binary', 'pkg', 'postflight', 'zap'],
    })).toBeNull();
    // B1: manifesto só binary → aceita; env tem HOMEBREW_NO_SUDO=1 além de SUDO_ASKPASS
    expect(selectAutomaticCliUpdateRecipe({
      ...muse,
      caskArtifactKinds: ['binary', 'zap'],
      caskTargetArtifactKinds: ['binary', 'zap'],
    })).toMatchObject({
      kind: 'argv', runner: '/opt/homebrew/bin/brew',
      argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'muse-code'],
      env: { SUDO_ASKPASS: '/usr/bin/false', HOMEBREW_NO_SUDO: '1' },
    });
    // B1: sem prova completa dos artefatos da versão-alvo → manual (fail-closed)
    expect(selectAutomaticCliUpdateRecipe({
      ...muse,
      caskArtifactKinds: ['binary', 'zap'],
      caskTargetArtifactKinds: null,
    })).toBeNull();
    expect(caskReceiptPath(muse.realBinPath)).toBe('/opt/homebrew/Caskroom/muse-code/.metadata/INSTALL_RECEIPT.json');
    expect(caskReceiptArtifactKinds(receipt)).toEqual(['binary', 'zap']);
    expect(selectAutomaticCliUpdateRecipe({ ...muse, caskArtifactKinds: ['pkg', 'uninstall'] })).toBeNull();
    expect(selectAutomaticCliUpdateRecipe({ ...muse, caskArtifactKinds: null })).toBeNull();
    expect(selectAutomaticCliUpdateRecipe(muse)).toBeNull();
    expect(selectAutomaticCliUpdateRecipe({ ...muse, caskArtifactKinds: ['binary'], isTargetWritable: () => false })).toBeNull();
    expect(caskReceiptArtifactKinds('{')).toBeNull();
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['brew', 'install', '--cask', 'muse-code'], runner: 'brew', runnerHint: '' })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'muse-code', '--force'], runner: '/opt/homebrew/bin/brew', runnerHint: '' })).toBe(false);
    expect(isSafeAutomaticCliRecipe({ kind: 'argv', argv: ['sudo', '/opt/homebrew/bin/brew', 'upgrade', '--cask', 'muse-code'], runner: 'sudo', runnerHint: '' })).toBe(false);
    // codex e claude-code pelo cask seguem a mesma regra.
    expect(selectAutomaticCliUpdateRecipe({
      ...muse, adapterId: 'claude', binPath: '/opt/homebrew/bin/claude',
      realBinPath: '/opt/homebrew/Caskroom/claude-code/2.1.296/claude', caskArtifactKinds: ['binary'],
    })).toMatchObject({ argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'claude-code'] });
  });

  it('(c) só instalação versionada (claude, devin, grok) atualiza com pane vivo', () => {
    const home = '/Users/operator';    expect(isVersionedCliInstall('claude', `${home}/.local/bin/claude`, `${home}/.local/share/claude/versions/2.1.296`)).toBe(true);
    expect(isVersionedCliInstall('devin', `${home}/.local/bin/devin`, `${home}/.local/share/devin/cli/_versions/3000.11.3/bin/devin`)).toBe(true);
    expect(isVersionedCliInstall('grok', `${home}/.grok/bin/grok`, `${home}/.grok/bin/grok-1.0.50`)).toBe(true);
    // npm, brew, cask e o kimi nativo trocam no lugar: esperam o último pane.
    expect(isVersionedCliInstall('codex', '/opt/homebrew/bin/codex', '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe(false);
    expect(isVersionedCliInstall('claude', '/usr/local/bin/claude', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(false);
    expect(isVersionedCliInstall('kimi', `${home}/.kimi-code/bin/kimi`, `${home}/.kimi-code/bin/kimi`)).toBe(false);
    expect(isVersionedCliInstall('muse', '/opt/homebrew/bin/muse', '/opt/homebrew/Caskroom/muse-code/1.4.6/muse-aarch64-macos')).toBe(false);
    expect(isVersionedCliInstall('grok', `${home}/.grok/bin/grok-1.0.50`, `${home}/.grok/bin/grok-1.0.50`)).toBe(false);
  });
});

describe('F-1397: checagem barata de versão antes de instalar', () => {
  it('receita npm gera `npm view <pkg> version`; brew formula/cask gera `brew outdated --json=v2`', () => {
    expect(cliVersionCheck({
      kind: 'argv', argv: ['npm', 'install', '-g', '--prefix', '/opt/homebrew', '@openai/codex'],
      runner: 'npm', runnerHint: '',
    })).toEqual({ kind: 'npm', name: '@openai/codex', argv: ['npm', 'view', '@openai/codex', 'version'] });
    expect(cliVersionCheck({
      kind: 'argv', argv: ['/opt/homebrew/bin/brew', 'upgrade', 'opencode'],
      runner: '/opt/homebrew/bin/brew', runnerHint: '',
    })).toEqual({ kind: 'brew', name: 'opencode', argv: ['/opt/homebrew/bin/brew', 'outdated', '--json=v2', 'opencode'] });
    expect(cliVersionCheck({
      kind: 'argv', argv: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'muse-code'],
      runner: '/opt/homebrew/bin/brew', runnerHint: '',
    })).toEqual({ kind: 'brew', name: 'muse-code', argv: ['/opt/homebrew/bin/brew', 'outdated', '--json=v2', '--cask', 'muse-code'] });
    // Script e updater próprio (claude update, kimi upgrade, uv) não têm checagem
    // barata: já são no-op quando em dia, seguem o caminho atual.
    expect(cliVersionCheck({
      kind: 'argv', argv: ['/Users/operator/.local/bin/claude', 'update'],
      runner: '/Users/operator/.local/bin/claude', runnerHint: '',
    })).toBeNull();
    expect(cliVersionCheck({
      kind: 'script', scriptUrl: 'https://cli.devin.ai/install.sh', runner: 'bash', runnerHint: '',
      automaticUpdate: true,
    })).toBeNull();
    expect(cliVersionCheck({
      kind: 'argv',
      argv: ['uv', 'tool', 'install', '--force', '--python', 'python3.12', '--with', 'pip', 'aider-chat@latest'],
      runner: 'uv', runnerHint: '',
    })).toBeNull();
  });

  it('npm em dia → true; desatualizado → false; resposta ilegível → null (instala)', () => {
    const check = { kind: 'npm' as const, name: '@openai/codex', argv: [] };
    expect(cliVersionCheckUpToDate(check, '0.160.0', '0.160.0\n')).toBe(true);
    expect(cliVersionCheckUpToDate(check, '0.146.0', '0.160.0')).toBe(false);
    // `claude --version` costuma trazer texto junto do número: compara o token.
    expect(cliVersionCheckUpToDate(check, '2.1.296 (Claude Code)', '2.1.296')).toBe(true);
    expect(cliVersionCheckUpToDate(check, '1.0.0', '')).toBeNull();
    expect(cliVersionCheckUpToDate(check, '1.0.0', 'npm ERR! network')).toBeNull();
    expect(cliVersionCheckUpToDate(check, '(sem versão legível)', '1.0.0')).toBeNull();
  });

  it('brew: fora da lista de outdated = em dia; na lista = desatualizado; JSON ruim = null', () => {
    const formula = { kind: 'brew' as const, name: 'opencode', argv: [] };
    // Casing REAL do `brew outdated --json=v2` nesta máquina: minúsculas.
    expect(cliVersionCheckUpToDate(formula, '1.0.0', '{"formulae":[],"casks":[]}')).toBe(true);
    expect(cliVersionCheckUpToDate(formula, '1.0.0',
      '{"formulae":[{"name":"opencode","installed_version":"1.0.0","current_version":"1.1.0"}],"casks":[]}')).toBe(false);
    const cask = { kind: 'brew' as const, name: 'muse-code', argv: [] };
    expect(cliVersionCheckUpToDate(cask, '1.4.6', '{"formulae":[],"casks":[{"name":"muse-code"}]}')).toBe(false);
    // Tolerância a chaves capitalizadas (formatos antigos/alternativos).
    expect(cliVersionCheckUpToDate(formula, '1.0.0',
      '{"Formula":[{"name":"opencode"}],"Casks":[]}')).toBe(false);
    expect(cliVersionCheckUpToDate(cask, '1.4.6', '{"Formula":[],"Casks":[{"name":"muse-code"}]}')).toBe(false);
    expect(cliVersionCheckUpToDate(formula, '1.0.0', 'Error: undefined method `outdated\'')).toBeNull();
  });

  it('npm: a checagem consulta o mesmo registry fixado na receita do install', () => {
    expect(cliVersionCheck({
      kind: 'argv',
      argv: ['npm', 'install', '-g', '--registry=https://registry.npmjs.org/', '@minimax-ai/code'],
      runner: 'npm', runnerHint: '',
    })).toEqual({
      kind: 'npm', name: '@minimax-ai/code',
      argv: ['npm', 'view', '@minimax-ai/code', 'version', '--registry=https://registry.npmjs.org/'],
    });
  });
});

describe('F-1397: spawn durante atualização versionada não espera o lease', () => {
  it('permit do claude versionado sai na hora; o de instalação no lugar espera o fim', async () => {
    const lease = new CliUpdateLease();
    // claude versionado: o binário novo vai para outro diretório; o pane nasce já.
    expect(lease.acquire('claude', 'manual', true)).toBe(true);
    const claudeRelease = await lease.acquireSpawnPermit('claude');
    claudeRelease();
    lease.release('claude');
    // codex (npm, troca no lugar): o spawn espera o update acabar.
    expect(lease.acquire('codex')).toBe(true);
    let entered = false;
    const codexPermit = lease.acquireSpawnPermit('codex').then((release) => { entered = true; return release; });
    await Promise.resolve();
    expect(entered).toBe(false);
    lease.release('codex');
    (await codexPermit)();
  });

  it('spawnSafe dispensa a exclusão de spawn em voo; a atualização comum não dispensa', async () => {
    const lease = new CliUpdateLease();
    const heldPane = await lease.acquireSpawnPermit('claude');
    expect(lease.acquire('claude')).toBe(false);
    expect(lease.isSpawning('claude')).toBe(true);
    expect(lease.acquire('claude', 'manual', true)).toBe(true);
    heldPane();
    lease.release('claude');
    expect(lease.isSpawning('claude')).toBe(false);
  });
});
