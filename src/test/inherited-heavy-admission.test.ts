import { describe, expect, it } from 'vitest';
import { stripInheritedHeavyAdmission, withoutHeavyCommandPreload } from './inherited-heavy-admission';

const APP = '/Applications/NexusIDE.app/Contents/Resources/heavy-command';

describe('F-1216 — admissão heavy herdada do pane', () => {
  it('limpa o ambiente que um pane de agente exporta e preserva o resto', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/op',
      NEXUS_PANE_ID: 'pane-1',
      NEXUS_GATE_TOKEN: 'pane-token',
      NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command',
      NEXUS_HEAVY_JOB_BASE: '{"file":"/usr/bin/perl","args":["heavy-job"]}',
      NEXUS_HEAVY_DIR: APP,
      NEXUS_HEAVY_ZDOTDIR: '/Users/op/.nexus/ephemeral/x/heavy-zsh-AbC',
      NEXUS_HEAVY_ORIG_ZDOTDIR: '/Users/op',
      NEXUS_HEAVY_LEASE: 'lease',
      BASH_ENV: `${APP}/shell.bash`,
      ZDOTDIR: '/Users/op/.nexus/ephemeral/x/heavy-zsh-AbC',
      NODE_OPTIONS: `--max-old-space-size=4096 --require "${APP}/preload.cjs"`,
    };
    stripInheritedHeavyAdmission(env);
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/op',
      NEXUS_PANE_ID: 'pane-1',
      ZDOTDIR: '/Users/op',
      NODE_OPTIONS: '--max-old-space-size=4096',
    });
  });

  it('reconhece o guard pelo caminho mesmo sem NEXUS_HEAVY_DIR', () => {
    const env: NodeJS.ProcessEnv = { BASH_ENV: `${APP}/shell.bash`, ZDOTDIR: '/tmp/heavy-zsh-Q1', NODE_OPTIONS: `-r ${APP}/preload.cjs` };
    stripInheritedHeavyAdmission(env);
    expect(env).toEqual({});
  });

  it('não toca em BASH_ENV, ZDOTDIR e NODE_OPTIONS do próprio operador', () => {
    const env: NodeJS.ProcessEnv = { BASH_ENV: '/Users/op/.bashenv', ZDOTDIR: '/Users/op/.config/zsh', NODE_OPTIONS: '--require ./tracing.cjs' };
    stripInheritedHeavyAdmission(env);
    expect(env).toEqual({ BASH_ENV: '/Users/op/.bashenv', ZDOTDIR: '/Users/op/.config/zsh', NODE_OPTIONS: '--require ./tracing.cjs' });
  });

  it('remove só o preload heavy de NODE_OPTIONS, em todas as grafias do --require', () => {
    const spaced = '/Users/op/Library/Application Support/x/heavy-command/preload.cjs';
    expect(withoutHeavyCommandPreload(`--require ${JSON.stringify(spaced)} --enable-source-maps`)).toBe('--enable-source-maps');
    expect(withoutHeavyCommandPreload(`--require=${APP}/preload.cjs -r ./keep.cjs`)).toBe('-r ./keep.cjs');
    expect(withoutHeavyCommandPreload('--require "/keep me/a.cjs"')).toBe('--require "/keep me/a.cjs"');
    expect(withoutHeavyCommandPreload(`--require ${APP}/preload.cjs`)).toBeUndefined();
    expect(withoutHeavyCommandPreload('  ')).toBeUndefined();
  });
});
