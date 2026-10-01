import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeProviderState, providerStateEnvFor } from './provider-state-env';

const adapters = ['droid', 'cursor', 'copilot', 'amp', 'goose', 'pi', 'prime-agent', 'hermes', 'command-code'];
afterEach(() => vi.restoreAllMocks());

describe('providerStateEnvFor', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('isolates every adapter and checkout on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const p = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? 'C:\\Users\\operator' : '/users/operator';
    const userDataDir = p.join(home, 'Nexus Data');
    const roots = new Set<string>();
    for (const adapter of adapters) {
      for (const checkoutId of ['checkout-a', 'checkout-b']) {
        const plan = providerStateEnvFor(adapter, { home, userDataDir, checkoutId })!;
        expect(plan.stateRoot).toBe(p.join(userDataDir, 'provider-state', adapter, checkoutId));
        roots.add(plan.stateRoot);
        for (const value of Object.values(plan.env)) {
          expect(p.relative(plan.stateRoot, value)).not.toMatch(/^\.\./);
          expect(p.isAbsolute(value)).toBe(true);
        }
        if (plan.homeOverlay) {
          expect(plan.homeOverlay.targetDir.startsWith(plan.stateRoot + p.sep)).toBe(true);
          for (const file of plan.homeOverlay.link) {
            expect(p.isAbsolute(file)).toBe(false);
            expect(file).not.toMatch(/sessions|chats|projects|state\.db|threads|history|\.\./);
          }
        }
      }
    }
    expect(roots.size).toBe(18);
  });

  it.each([
    ['amp', 'XDG_DATA_HOME'], ['goose', 'GOOSE_PATH_ROOT'],
    ['pi', 'PI_CODING_AGENT_SESSION_DIR'], ['prime-agent', 'PRIME_AGENT_SESSION_DIR'],
    ['copilot', 'COPILOT_HOME'], ['hermes', 'HERMES_HOME'],
  ])('uses the native relocation contract for %s', (adapter, key) => {
    const plan = providerStateEnvFor(adapter, { home: '/users/operator', userDataDir: '/data', checkoutId: 'a', platform: 'linux' })!;
    expect(plan.env[key]).toBeTruthy();
    expect(plan.env.HOME).toBeUndefined();
  });

  it.each(['droid', 'cursor', 'command-code'])('uses a private HOME with selected files for %s', (adapter) => {
    const plan = providerStateEnvFor(adapter, { home: 'C:\\Users\\operator', userDataDir: 'D:\\Nexus', checkoutId: 'a', platform: 'win32' })!;
    expect(plan.env.HOME).toBe(plan.homeOverlay?.targetDir);
    expect(plan.env.USERPROFILE).toBe(plan.env.HOME);
    expect(plan.env.LOCALAPPDATA).toBe(path.win32.join(plan.env.HOME, 'AppData', 'Local'));
    expect(plan.homeOverlay?.sourceDir).toBe('C:\\Users\\operator');
    expect(plan.homeOverlay?.link.length).toBeGreaterThan(0);
  });

  it('keeps native profile credentials separate from sessions and does not share mutable plans', () => {
    const options = { home: '/users/operator', userDataDir: '/data', checkoutId: 'a', platform: 'linux' as const };
    const copilot = providerStateEnvFor('copilot', options)!;
    expect(copilot.homeOverlay).toEqual({
      sourceDir: '/users/operator/.copilot', targetDir: '/data/provider-state/copilot/a/.copilot',
      link: ['config.json', 'mcp-config.json'],
    });
    expect(copilot.env.COPILOT_HOME).toBe(copilot.homeOverlay!.targetDir);
    copilot.homeOverlay!.link.push('session-state');
    expect(providerStateEnvFor('copilot', options)!.homeOverlay!.link).not.toContain('session-state');
    const hermes = providerStateEnvFor('hermes', options)!;
    expect(hermes.env.HERMES_HOME).toBe(hermes.homeOverlay!.targetDir);
    expect(hermes.homeOverlay!.link).toEqual(['auth.json', '.env', 'config.yaml']);
    expect(providerStateEnvFor('pi', options)!.env.PI_CODING_AGENT_SESSION_DIR).toBe('/data/provider-state/pi/a/sessions');
    expect(providerStateEnvFor('prime-agent', options)!.env.PRIME_AGENT_SESSION_DIR).toBe('/data/provider-state/prime-agent/a/sessions');
  });

  it.each(['', '..', '../a', 'a/b', 'a\\b', 'a:stream', 'a\n', 'a'.repeat(129)])('rejects invalid checkout identity %j', (checkoutId) => {
    expect(() => providerStateEnvFor('pi', { home: '/home', userDataDir: '/data', checkoutId, platform: 'linux' })).toThrow();
  });

  it('rejects relative roots and leaves unrelated adapters alone', () => {
    expect(() => providerStateEnvFor('pi', { home: '/home', userDataDir: 'relative', checkoutId: 'a', platform: 'linux' })).toThrow();
    expect(providerStateEnvFor('codex', { home: '/home', userDataDir: '/data', checkoutId: 'a' })).toBeNull();
  });
});

describe('materializeProviderState', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-state-materialize-'));
    const home = path.join(root, 'native');
    const userDataDir = path.join(root, 'userData');
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    fs.mkdirSync(userDataDir);
    fs.writeFileSync(path.join(home, '.factory', 'auth.json'), '{"fixture":true}');
    const plan = providerStateEnvFor('droid', { home, userDataDir, checkoutId: 'checkout-a' })!;
    return { root, home, userDataDir, plan };
  }

  it.each(['native', 'win32'])('links selected files, preserves local replacements and never imports conversations (%s)', (mode) => {
    const f = fixture();
    const nativeAuth = path.join(f.home, '.factory', 'auth.json');
    const targetAuth = path.join(f.plan.env.HOME, '.factory', 'auth.json');
    fs.mkdirSync(path.join(f.home, '.factory', 'sessions'));
    fs.writeFileSync(path.join(f.home, '.factory', 'sessions', 'old.jsonl'), 'native');
    if (mode === 'win32') vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      expect(materializeProviderState(f.plan, f.userDataDir)).toEqual([fs.realpathSync(nativeAuth)]);
      expect(fs.statSync(targetAuth).ino).toBe(fs.statSync(nativeAuth).ino);
      if (mode === 'win32') expect(fs.lstatSync(targetAuth).isSymbolicLink()).toBe(false);
      expect(materializeProviderState(f.plan, f.userDataDir)).toEqual([fs.realpathSync(nativeAuth)]);
      expect(fs.existsSync(path.join(f.plan.env.HOME, '.factory', 'sessions'))).toBe(false);
      // An atomic auth refresh must survive the next launch.
      fs.writeFileSync(targetAuth + '.tmp', 'fresh private login');
      fs.renameSync(targetAuth + '.tmp', targetAuth);
      expect(materializeProviderState(f.plan, f.userDataDir)).toEqual([]);
      expect(fs.readFileSync(targetAuth, 'utf8')).toBe('fresh private login');
      expect(fs.readFileSync(nativeAuth, 'utf8')).toBe('{"fixture":true}');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(['ancestor', 'profile', 'auth', 'sibling', 'source-directory'])('rejects redirected %s before writing outside checkout state', (attack) => {
    const f = fixture();
    try {
      if (attack === 'ancestor') {
        fs.symlinkSync(f.home, path.join(f.userDataDir, 'provider-state'), 'junction');
      } else if (attack === 'source-directory') {
        fs.rmSync(path.join(f.home, '.factory', 'auth.json'));
        fs.mkdirSync(path.join(f.home, '.factory', 'auth.json'));
      } else {
        materializeProviderState(f.plan, f.userDataDir);
        const target = path.join(f.plan.env.HOME, '.factory', ...(attack === 'profile' ? [] : ['auth.json']));
        fs.rmSync(target, { recursive: true, force: true });
        // F-716: a irmã com o mesmo prefixo (native → native2) não é o perfil.
        const redirect = attack === 'sibling' ? `${f.home}2` : f.home;
        fs.mkdirSync(redirect, { recursive: true });
        fs.symlinkSync(redirect, target, 'junction');
      }
      expect(() => materializeProviderState(f.plan, f.userDataDir)).toThrow(/Provider/);
      expect(fs.existsSync(path.join(f.home, 'droid'))).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails closed rather than copying a Windows credential across volumes', () => {
    const f = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' }); });
    try {
      expect(() => materializeProviderState(f.plan, f.userDataDir)).toThrow('cross-volume');
      expect(fs.existsSync(path.join(f.plan.env.HOME, '.factory', 'auth.json'))).toBe(false);
    } finally {
      link.mockRestore();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
