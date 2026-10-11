import { describe, expect, it, vi } from 'vitest';
import {
  isWslRuntimeUsable,
  planWslRuntime,
  wslCredentialSlot,
  wrapSpawnForWsl,
  linuxCommandName,
  createWslDistroLister,
  WSL_DISTRO_LIST_TTL_MS,
  wslDistroFromEnv,
} from './wsl-runtime';

describe('WSL runtime backend (first cut)', () => {
  it('plans wsl.exe argv with distro, cwd and quoted command', () => {
    const plan = planWslRuntime({
      distro: 'Ubuntu',
      hostCwd: 'C:\\Users\\me\\project',
      command: ['npm', 'test', '--', 'file name.ts'],
    });
    expect(plan.argv.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/Users/me/project']);
    expect(plan.argv[4]).toBe('--exec');
    expect(plan.argv.slice(5, 7)).toEqual(['bash', '-lc']);
    expect(plan.argv[7]).toBe("npm test -- 'file name.ts'");
    expect(plan.credentialSlot).toBe('wsl:Ubuntu');
    expect(plan.windowsUncCwd).toContain('wsl.localhost\\Ubuntu');
  });

  it('encodes requested env into the bash command', () => {
    const plan = planWslRuntime({
      distro: 'Ubuntu',
      hostCwd: '/tmp',
      command: ['git', 'status'],
      env: { TOKEN: "a'b;rm", PATH_EXTRA: '/opt/bin' },
    });
    expect(plan.argv.at(-1)).toBe(
      "export TOKEN='a'\\''b;rm'; export PATH_EXTRA=/opt/bin; git status",
    );
  });

  it('rejects an unsafe env name instead of ignoring it', () => {
    expect(() =>
      planWslRuntime({
        distro: 'Ubuntu',
        hostCwd: '/tmp',
        command: ['ls'],
        env: { 'BAD NAME': 'x' },
      }),
    ).toThrow(/env name is not safe/);
  });

  it('rejects a UNC path whose distro is not the selected one', () => {
    expect(() =>
      planWslRuntime({
        distro: 'Debian',
        hostCwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app',
        command: ['git', 'status'],
      }),
    ).toThrow(/Ubuntu does not match selected distro Debian/);
  });

  it('accepts Ubuntu and a lowercase ubuntu UNC as the same distro', () => {
    const plan = planWslRuntime({
      distro: 'Ubuntu',
      hostCwd: '\\\\wsl.localhost\\ubuntu\\home\\me\\app',
      command: ['git', 'status'],
    });
    expect(plan.distro).toBe('Ubuntu');
    expect(plan.linuxCwd).toBe('/home/me/app');
  });

  it('maps WSL UNC host cwd to a Linux path inside the distro', () => {
    const plan = planWslRuntime({
      distro: 'Debian',
      hostCwd: '\\\\wsl.localhost\\Debian\\home\\me\\app',
      command: ['git', 'status'],
    });
    expect(plan.linuxCwd).toBe('/home/me/app');
  });

  it('credential slot is a safe identifier per distro', () => {
    expect(wslCredentialSlot('Ubuntu-22.04')).toBe('wsl:Ubuntu-22.04');
    expect(() => wslCredentialSlot('')).toThrow(/required/);
    expect(() => wslCredentialSlot('bad/name')).toThrow(/safe credential slot/);
  });

  it('refuses empty command or distro', () => {
    expect(() =>
      planWslRuntime({ distro: 'U', hostCwd: '/tmp', command: [] }),
    ).toThrow(/command is required/);
    expect(() =>
      planWslRuntime({ distro: '  ', hostCwd: '/tmp', command: ['ls'] }),
    ).toThrow(/distro is required/);
  });

  it('usability: WSL env without distro is not usable; with distro it is', () => {
    const env = { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv;
    expect(isWslRuntimeUsable(null, env)).toMatchObject({
      available: false,
      reason: 'wsl-present-distro-missing',
    });
    expect(isWslRuntimeUsable('Ubuntu', env)).toMatchObject({
      available: true,
      distroSlot: 'wsl:Ubuntu',
    });
    expect(isWslRuntimeUsable('Ubuntu', {} as NodeJS.ProcessEnv)).toMatchObject({
      available: false,
      reason: 'not-windows',
    });
  });

  it('treats a validated distro as proof on a Windows host without WSL env', () => {
    const env = {
      SystemRoot: 'C:\\Windows',
      OS: 'Windows_NT',
    } as NodeJS.ProcessEnv;
    expect(isWslRuntimeUsable('Ubuntu', env)).toMatchObject({
      available: true,
      reason: 'windows-host-listed-distro',
      distroSlot: 'wsl:Ubuntu',
    });
    expect(isWslRuntimeUsable(null, env)).toMatchObject({
      available: false,
      reason: 'windows-host-wsl-unverified',
      distroSlot: null,
    });
    expect(isWslRuntimeUsable('bad/name', env)).toMatchObject({
      available: false,
      reason: 'wsl-distro-name-unsafe',
      distroSlot: null,
    });
  });
});

describe('wrapSpawnForWsl (F-1168 B5)', () => {
  it('wraps the spawn as wsl.exe when a distro is set', () => {
    const wrapped = wrapSpawnForWsl({
      file: '/bin/bash',
      args: ['-lc', 'npm test'],
      cwd: 'C:\\work\\app',
      distro: 'Ubuntu',
    });
    expect(wrapped.file).toBe('wsl.exe');
    expect(wrapped.args[0]).toBe('-d');
    expect(wrapped.args[1]).toBe('Ubuntu');
    expect(wrapped.args).toContain('--exec');
  });

  it('leaves the spawn intact when no distro is set', () => {
    const wrapped = wrapSpawnForWsl({
      file: '/bin/bash',
      args: ['-lc', 'ls'],
      cwd: '/tmp',
      distro: null,
    });
    expect(wrapped.file).toBe('/bin/bash');
    expect(wrapped.args).toEqual(['-lc', 'ls']);
  });

  it('o .cmd/.exe resolvido no Windows vira o nome do binário Linux dentro da distro', () => {
    const wrapped = wrapSpawnForWsl({
      file: 'C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--model', 'opus'],
      cwd: 'C:\\work\\app',
      distro: 'Ubuntu',
    });
    expect(wrapped.args.at(-1)).toBe('claude --model opus');
    expect(wrapped.args.join(' ')).not.toContain('.cmd');
    expect(linuxCommandName('D:\\tools\\codex.EXE')).toBe('codex');
    expect(linuxCommandName('claude')).toBe('claude');
  });

  it('variáveis da sessão atravessam por WSLENV, nunca pelo argv', () => {
    const wrapped = wrapSpawnForWsl({
      file: 'claude',
      args: [],
      cwd: 'C:\\work',
      distro: 'Ubuntu',
      forwardEnvNames: ['NEXUS_SESSION_TOKEN', 'ANTHROPIC_API_KEY', 'bad-name', 'WSLENV', 'PATH', 'Path', 'HOME', 'NEXUS_WSL_DISTRO'],
      currentWslEnv: 'USERPROFILE/p',
    });
    expect(wrapped.env).toEqual({ WSLENV: 'USERPROFILE/p:NEXUS_SESSION_TOKEN:ANTHROPIC_API_KEY' });
    expect(wrapped.args.join(' ')).not.toMatch(/NEXUS_SESSION_TOKEN|ANTHROPIC_API_KEY/);
  });

  it('sem distro não mexe no ambiente', () => {
    expect(wrapSpawnForWsl({ file: 'x', args: [], cwd: '/', distro: null }).env).toEqual({});
  });

  it('wslDistroFromEnv reads NEXUS_WSL_DISTRO', () => {
    expect(wslDistroFromEnv({ NEXUS_WSL_DISTRO: 'Debian' })).toBe('Debian');
    expect(wslDistroFromEnv({ NEXUS_WSL_DISTRO: '  ' })).toBeNull();
    expect(wslDistroFromEnv({})).toBeNull();
  });
});

describe('createWslDistroLister (F-1168 B6)', () => {
  it('cacheia por 30 s, compartilha o pedido em voo e não guarda erro', async () => {
    let clock = 0;
    const outputs: (string | null)[] = [null, 'U\0b\0u\0n\0t\0u\0\r\nDebian\r\n'];
    const run = vi.fn(async () => (outputs.length ? outputs.shift()! : 'Outra\n'));
    const list = createWslDistroLister({ platform: 'win32', run, now: () => clock });
    expect(await list()).toEqual([]);
    const [a, b] = await Promise.all([list(), list()]);
    expect(a).toEqual(['Ubuntu', 'Debian']);
    expect(b).toEqual(['Ubuntu', 'Debian']);
    expect(run).toHaveBeenCalledTimes(2);
    clock += WSL_DISTRO_LIST_TTL_MS - 1;
    expect(await list()).toEqual(['Ubuntu', 'Debian']);
    expect(run).toHaveBeenCalledTimes(2);
    clock += 2;
    expect(await list()).toEqual(['Outra']);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('fora do Windows não executa nada', async () => {
    const run = vi.fn(async () => 'x');
    expect(await createWslDistroLister({ platform: 'darwin', run })()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
