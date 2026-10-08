import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MISSION_E2E_TEST,
  missionE2EEnvironment,
  missionE2EEnvironmentProblem,
  parseMissionE2EArgs,
} from './mission-e2e.mjs';

describe('F-971 — runner do E2E de missão', () => {
  it('aponta para o teste que existe e só roda com a chave explícita', () => {
    const source = fs.readFileSync(path.join(process.cwd(), MISSION_E2E_TEST), 'utf8');
    expect(source).toContain("process.env.NEXUS_MISSION_E2E === '1'");
    expect(missionE2EEnvironment({ PATH: '/usr/bin' })).toMatchObject({ NEXUS_MISSION_E2E: '1', PATH: '/usr/bin' });
  });

  it('o "Main" do E2E nunca herda a admissão, o shim ou o MCP de um pane do Nexus', () => {
    const env = missionE2EEnvironment({
      PATH: '/usr/bin', NODE_OPTIONS: '--require /x/preload.cjs', BASH_ENV: '/x/shell.bash', ZDOTDIR: '/x',
      NEXUS_HEAVY_JOB_BASE: '{}', NEXUS_HEAVY_LEASE: 'heavy-1', NEXUS_SHIM_ROOT: '/s', NEXUS_MCP_TOKEN: 't',
      NEXUS_GATE_TOKEN: 't', HOME: '/Users/x',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NEXUS_MISSION_E2E', 'PATH']);
  });

  it('recusa rodar dentro de um pane no macOS (o supervisor de PTY recusaria — falso vermelho)', () => {
    expect(missionE2EEnvironmentProblem({ NEXUS_PANE_ID: 'p' }, 'darwin')).toMatch(/fora de um pane/);
    expect(missionE2EEnvironmentProblem({}, 'darwin')).toBeNull();
    expect(missionE2EEnvironmentProblem({}, 'linux')).toBeNull();
    expect(missionE2EEnvironmentProblem({}, 'win32')).toMatch(/macOS e Linux/);
  });

  it('aceita só --receipt', () => {
    expect(parseMissionE2EArgs([])).toEqual({ receipt: null });
    expect(parseMissionE2EArgs(['--receipt', 'out/e2e.json']).receipt).toBe(path.resolve('out/e2e.json'));
    expect(() => parseMissionE2EArgs(['--skip'])).toThrow(/uso: mission-e2e/);
  });
});
