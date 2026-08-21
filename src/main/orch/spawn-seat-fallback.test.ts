import { describe, expect, it } from 'vitest';
import { PreSpawnProbeError } from '../pty/pre-spawn-probe';
import {
  CREDENTIAL_FAILURE_CODES,
  isCredentialProbeFailure,
  settleSeatAfterCredentialFailure,
  seatSuccessorForFailedSeat,
} from './spawn-seat-fallback';

const deps = {
  preferred: ['cursor-agent', 'grok', 'deepseek'],
  isSpawnableCli: (cli: string) => cli !== 'agy',
  hasPresentAuth: (cli: string) => cli !== 'cursor-agent' && cli !== 'kimi',
};

describe('seatSuccessorForFailedSeat', () => {
  it('escolhe o primeiro elo spawnable com credencial present', () => {
    expect(seatSuccessorForFailedSeat({ failedCli: 'codex', deps })).toBe('grok');
  });

  it('pula CLI não-spawnable mesmo com credencial', () => {
    expect(
      seatSuccessorForFailedSeat({
        failedCli: 'cursor-agent',
        deps: { ...deps, isSpawnableCli: (cli) => cli !== 'grok' },
      }),
    ).toBe('deepseek');
  });

  it('retorna null quando nenhum elo senta', () => {
    expect(
      seatSuccessorForFailedSeat({
        failedCli: 'codex',
        deps: { ...deps, isSpawnableCli: () => false },
      }),
    ).toBeNull();
  });

  it('visited impinge ping-pong na cadeia', () => {
    expect(
      seatSuccessorForFailedSeat({
        failedCli: 'grok',
        deps,
        visited: new Set(['deepseek']),
      }),
    ).toBeNull();
  });
});

describe('settleSeatAfterCredentialFailure', () => {
  const credentialFailure = (adapterId: string) =>
    new PreSpawnProbeError({
      code: 'missing-credential',
      adapterId,
      hint: 'no-credential — remint silencioso',
    });

  it('primeiro candidato que passa no probe senta', async () => {
    const probed: string[] = [];
    const successor = await settleSeatAfterCredentialFailure({
      failedCli: 'cursor-agent',
      probe: async (cli) => {
        probed.push(cli);
        if (cli === 'grok') throw credentialFailure(cli);
      },
      deps,
    });
    expect(probed).toEqual(['grok', 'deepseek']);
    expect(successor).toBe('deepseek');
  });

  it('sem elo viável devolve null (falha original fica visível)', async () => {
    const successor = await settleSeatAfterCredentialFailure({
      failedCli: 'cursor-agent',
      probe: async (cli) => {
        throw credentialFailure(cli);
      },
      deps,
    });
    expect(successor).toBeNull();
  });

  it('erro não-credencial num candidato propaga fail-closed', async () => {
    await expect(
      settleSeatAfterCredentialFailure({
        failedCli: 'cursor-agent',
        probe: async (cli) => {
          if (cli === 'grok') {
            throw new PreSpawnProbeError({
              code: 'binary-missing',
              adapterId: cli,
              hint: 'CLI não instalado',
            });
          }
        },
        deps,
      }),
    ).rejects.toThrow('binary-missing');
  });
});

describe('isCredentialProbeFailure', () => {
  it('aceita a classe credencial e rejeita as demais', () => {
    expect(
      isCredentialProbeFailure(
        new PreSpawnProbeError({
          code: 'key-missing',
          adapterId: 'codex',
          hint: 'x',
        }),
      ),
    ).toBe(true);
    expect(
      isCredentialProbeFailure(
        new PreSpawnProbeError({
          code: 'binary-missing',
          adapterId: 'codex',
          hint: 'x',
        }),
      ),
    ).toBe(false);
    expect(isCredentialProbeFailure(new Error('boom'))).toBe(false);
    expect(CREDENTIAL_FAILURE_CODES.has('missing-credential')).toBe(true);
  });
});
