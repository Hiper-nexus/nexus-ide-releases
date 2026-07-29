import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DembrandtExtractError,
  DEMBRANDT_PACKAGE,
  extractDesignSystemFromUrl,
  __test,
} from './dembrandt-extractor';

const tempDirs: string[] = [];

class FakeReadable extends EventEmitter {}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly pid: number;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  close(code: number | null): void {
    this.exitCode = code;
    this.emit('close', code);
  }
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('dembrandt-extractor', () => {
  it('builds pinned CLI args with optional flags and paths', () => {
    expect(
      __test.buildCliArgs({
        normalizedUrl: 'https://stripe.com/',
        paths: ['pricing', '/docs'],
        darkMode: true,
        mobile: true,
        wcag: false,
        workDir: '/tmp',
      }),
    ).toEqual([
      '-y',
      DEMBRANDT_PACKAGE,
      'https://stripe.com/',
      '--design-md',
      '/pricing',
      '/docs',
      '--dark-mode',
      '--mobile',
    ]);
    expect(__test.buildCliArgs({
      normalizedUrl: 'https://stripe.com/',
      paths: [],
      darkMode: false,
      mobile: false,
      wcag: false,
      workDir: '/tmp',
    })).not.toContain('--no-sandbox');
  });

  it('builds a child env allowlist that drops secrets', () => {
    const env = __test.buildDembrandtChildEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'sk-secret',
      NEXUS_VAULT_KEY: 'vault',
      DEMBRANDT_API_KEY: 'dmb',
      GITHUB_TOKEN: 'gh',
      npm_config_yes: 'false',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.npm_config_yes).toBe('true');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NEXUS_VAULT_KEY).toBeUndefined();
    expect(env.DEMBRANDT_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('finds DESIGN.md under nested output/', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dembrandt-find-'));
    tempDirs.push(workDir);
    const nested = path.join(workDir, 'output', 'stripe.com', 'run');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'DESIGN.md'), '# Tokens\n');
    expect(__test.findDesignMd(workDir)).toBe(path.join(nested, 'DESIGN.md'));
  });

  it('blocks private-network URLs before spawning the CLI', async () => {
    await expect(
      extractDesignSystemFromUrl({
        url: 'http://127.0.0.1:3000',
        assessUrl: async () => ({
          allowed: false,
          kind: 'private-network',
          reason: 'private-network access requires explicit confirmation',
          normalizedUrl: 'http://127.0.0.1:3000/',
        }),
        routeGuardedRunner: async () => {
          throw new Error('runner must not run');
        },
      }),
    ).rejects.toMatchObject({
      name: 'DembrandtExtractError',
      code: 'URL_BLOCKED',
    });
  });

  it('fails closed when no per-request network-guarded runner is injected', async () => {
    const assessUrl = vi.fn();

    await expect(
      extractDesignSystemFromUrl({
        url: 'https://example.com',
        assessUrl,
      }),
    ).rejects.toMatchObject({
      name: 'DembrandtExtractError',
      code: 'NETWORK_GUARD_UNAVAILABLE',
    });
    expect(assessUrl).not.toHaveBeenCalled();
  });

  it('returns DESIGN.md from the injectable runner after a public URL passes policy', async () => {
    const result = await extractDesignSystemFromUrl({
      url: 'stripe.com',
      assessUrl: async () => ({
        allowed: true,
        normalizedUrl: 'https://stripe.com/',
        targetKey: 'https://stripe.com/',
        addresses: ['1.2.3.4'],
        addressClasses: ['public'],
      }),
      routeGuardedRunner: async (request) => {
        expect(request.normalizedUrl).toBe('https://stripe.com/');
        expect(request.workDir).toMatch(/nexus-dembrandt-/);
        return { designMd: '---\nname: Stripe\n---\n\n## Colors\n' };
      },
    });

    expect(result.normalizedUrl).toBe('https://stripe.com/');
    expect(result.sourceUrl).toBe('stripe.com');
    expect(result.designMd).toContain('## Colors');
  });

  it('surfaces runner failures as DembrandtExtractError when thrown as such', async () => {
    await expect(
      extractDesignSystemFromUrl({
        url: 'https://example.com',
        assessUrl: async () => ({
          allowed: true,
          normalizedUrl: 'https://example.com/',
          targetKey: 'https://example.com/',
          addresses: ['1.2.3.4'],
          addressClasses: ['public'],
        }),
        routeGuardedRunner: async () => {
          throw new DembrandtExtractError('EXTRACTION_FAILED', 'boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });

  it('does not spawn npx when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnProcess = vi.fn();

    await expect(
      __test.runDembrandtCliRunner(
        {
          normalizedUrl: 'https://example.com/',
          paths: [],
          darkMode: false,
          mobile: false,
          wcag: false,
          workDir: '/tmp',
          signal: controller.signal,
        },
        {
          platform: 'darwin',
          spawnProcess,
          signalProcessGroup: vi.fn(),
          terminateWindowsTree: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('TERM→KILLs the detached POSIX process group and rejects only after teardown', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(41_001);
    const spawnProcess = vi.fn(() => child);
    const signalProcessGroup = vi.fn();
    const controller = new AbortController();
    let settled = false;

    const flight = __test.runDembrandtCliRunner(
      {
        normalizedUrl: 'https://example.com/',
        paths: [],
        darkMode: false,
        mobile: false,
        wcag: false,
        workDir: '/tmp',
        signal: controller.signal,
      },
      {
        platform: 'darwin',
        spawnProcess,
        signalProcessGroup,
        terminateWindowsTree: vi.fn(),
        timeoutMs: 60_000,
        terminationGraceMs: 25,
      },
    );
    void flight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    expect(spawnProcess).toHaveBeenCalledWith(
      'npx',
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
    controller.abort();
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_001, 'SIGTERM');

    // npx may exit before Chromium. The process-group teardown must still
    // finish before the public promise rejects and releases the temp cwd.
    child.close(null);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(25);
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_001, 'SIGKILL');
    await expect(flight).rejects.toMatchObject({ code: 'ABORTED' });
    expect(settled).toBe(true);
  });

  it('escalates a timeout through the whole POSIX process group', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(41_002);
    const signalProcessGroup = vi.fn();
    const flight = __test.runDembrandtCliRunner(
      {
        normalizedUrl: 'https://example.com/',
        paths: [],
        darkMode: false,
        mobile: false,
        wcag: false,
        workDir: '/tmp',
      },
      {
        platform: 'linux',
        spawnProcess: vi.fn(() => child),
        signalProcessGroup,
        terminateWindowsTree: vi.fn(),
        timeoutMs: 10,
        terminationGraceMs: 20,
      },
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_002, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(20);
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_002, 'SIGKILL');
    child.close(null);
    await expect(flight).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('still escalates to SIGKILL when the graceful POSIX signal fails', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(41_004);
    const signalProcessGroup = vi.fn(
      (_processGroupId: number, signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') {
          const error = new Error('temporary TERM failure') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      },
    );
    const controller = new AbortController();
    const flight = __test.runDembrandtCliRunner(
      {
        normalizedUrl: 'https://example.com/',
        paths: [],
        darkMode: false,
        mobile: false,
        wcag: false,
        workDir: '/tmp',
        signal: controller.signal,
      },
      {
        platform: 'linux',
        spawnProcess: vi.fn(() => child),
        signalProcessGroup,
        terminateWindowsTree: vi.fn(),
        timeoutMs: 60_000,
        terminationGraceMs: 20,
      },
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_004, 'SIGTERM');
    expect(signalProcessGroup).toHaveBeenCalledWith(-41_004, 'SIGKILL');
    child.close(null);
    await expect(flight).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('uses taskkill tree mode on Windows and waits for it before rejecting', async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess(41_003);
    let finishTreeKill: (() => void) | undefined;
    const terminateWindowsTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTreeKill = resolve;
        }),
    );
    const controller = new AbortController();
    let settled = false;
    const flight = __test.runDembrandtCliRunner(
      {
        normalizedUrl: 'https://example.com/',
        paths: [],
        darkMode: false,
        mobile: false,
        wcag: false,
        workDir: '/tmp',
        signal: controller.signal,
      },
      {
        platform: 'win32',
        spawnProcess: vi.fn(() => child),
        signalProcessGroup: vi.fn(),
        terminateWindowsTree,
        timeoutMs: 60_000,
        terminationGraceMs: 20,
      },
    );
    void flight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(terminateWindowsTree).toHaveBeenCalledWith(41_003);
    expect(settled).toBe(false);

    finishTreeKill?.();
    await expect(flight).rejects.toMatchObject({ code: 'ABORTED' });
    expect(settled).toBe(true);
  });

  it('invokes Windows taskkill with a fixed executable, argv, and no shell', async () => {
    const killer = new FakeChildProcess(51_003);
    const spawnTaskkill = vi.fn(() => killer);
    const flight = __test.terminateWindowsProcessTree(
      41_003,
      spawnTaskkill,
      'C:\\Windows',
    );

    expect(spawnTaskkill).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '41003', '/T', '/F'],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      }),
    );
    killer.close(0);
    await expect(flight).resolves.toBeUndefined();
  });
});
