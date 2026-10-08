// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos de
// apps/server/src/provider/providerCompatibility.test.ts (faixas do codex e do
// OpenCode 2) sem Effect e sem o eixo t3CodeRange, mais as versões instaladas
// nesta máquina em 07/10 e os formatos fora de semver (cursor, agy).
import { describe, expect, it } from 'vitest';
import {
  cliCommandName,
  cliVersionWarnings,
  resolveCliCompatibility,
  stableCliVersion,
} from './cli-compatibility';

describe('F-966: faixas de compatibilidade de versão da CLI', () => {
  it('codex abaixo de 0.149 é quebrado e o aviso traz a faixa recomendada', () => {
    const advisory = resolveCliCompatibility('codex', '0.148.0');
    expect(advisory?.status).toBe('broken');
    expect(advisory?.message).toMatch(/Codex 0\.148\.0 .*incompatibilidade conhecida.*>=0\.159\.0/);
    expect(advisory?.message).toMatch(/abre assim mesmo/);
  });

  it.each([
    ['codex', '0.161.0', 'supported'],
    ['codex', '0.150.2', 'unsupported'],
    ['claude', '2.1.283', 'supported'],
    ['claude', '2.1.200', 'graceful'],
    ['claude', '2.1.110', 'unsupported'],
    ['grok', '1.0.46', 'supported'],
    ['grok', '1.0.12', 'broken'],
    ['opencode', '2.0.20', 'supported'],
    ['opencode', '2.0.17', 'unsupported'],
    ['opencode', '1.99.0', 'graceful'],
    ['opencode', '1.14.18', 'broken'],
  ])('%s %s → %s', (bin, version, status) => {
    expect(resolveCliCompatibility(bin, version)?.status).toBe(status);
  });

  it('só broken e unsupported viram aviso', () => {
    expect(resolveCliCompatibility('claude', '2.1.200')?.message).toBeUndefined();
    expect(resolveCliCompatibility('codex', '0.161.0')?.message).toBeUndefined();
    expect(resolveCliCompatibility('opencode', '2.0.17')?.message).toMatch(/fora da faixa suportada/);
  });

  it('tolera versões fora de semver: cursor com hash, agy com prefixo, prerelease e lixo', () => {
    expect(stableCliVersion('cursor-agent', '2026.05.09-a1b2c3d')).toBe('2026.05.09');
    expect(resolveCliCompatibility('cursor-agent', '2026.05.09-a1b2c3d')?.status).toBe('supported');
    expect(resolveCliCompatibility('cursor-agent', '2026.04.30-a1b2c3d')?.status).toBe('unknown');
    expect(stableCliVersion('agy', 'agy_acp_server_1.3.1')).toBe('1.3.1');
    expect(resolveCliCompatibility('agy', '1.3.1')).toBeUndefined();
    expect(resolveCliCompatibility('codex', '0.160.0-alpha.2')?.status).toBe('unknown');
    expect(resolveCliCompatibility('codex', 'codex-cli dev')?.status).toBe('unknown');
    expect(resolveCliCompatibility('codex', null)?.status).toBe('unknown');
    expect(cliVersionWarnings({ bin: 'codex', version: 'garbage' })).toEqual([]);
  });

  it('a política segue o binário, inclusive caminho absoluto e .exe', () => {
    expect(cliCommandName('C:\\npm\\codex.cmd')).toBe('codex');
    expect(cliCommandName('/opt/homebrew/bin/grok')).toBe('grok');
    expect(resolveCliCompatibility('/usr/local/bin/codex', '0.148.0')?.status).toBe('broken');
    expect(resolveCliCompatibility('kimi', '1.0.0')).toBeUndefined();
  });

  it('claude: junta a faixa e a versão mínima do modelo; glm no binário claude também', () => {
    expect(cliVersionWarnings({ bin: 'claude', version: '2.1.283', model: 'claude-sonnet-5-5' }))
      .toEqual([expect.stringMatching(/v2\.1\.284/)]);
    expect(cliVersionWarnings({ bin: 'claude', version: '2.1.110', model: 'claude-opus-4-7' }))
      .toHaveLength(2);
    expect(cliVersionWarnings({ bin: 'claude', version: '2.1.293', model: 'claude-haiku-5-5' }))
      .toEqual([]);
    expect(cliVersionWarnings({ bin: 'codex', version: '0.161.0', model: 'claude-sonnet-5-5' }))
      .toEqual([]);
  });
});
