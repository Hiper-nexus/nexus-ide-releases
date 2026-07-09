/**
 * Wiring do fluxo C3 (follow-up 3ii) no padrão source-shape do repo
 * (ver click-wake-order.test.ts): propriedades estruturais que uma
 * regressão de merge quebraria silenciosamente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const finishSource = fs.readFileSync(
  path.join(__dirname, 'voice-finish-and-process.ts'),
  'utf-8',
);
const controllerSource = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

describe('guard Live-force-to-Classic (C3)', () => {
  it('a primeira fala pós-"Confirmo?" NUNCA vai pro provider Live', () => {
    const guardIdx = finishSource.indexOf(
      'const isPendingDelegationReply = peekPendingDelegation(Date.now()) !== null;',
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const providerCondIdx = finishSource.indexOf('!isPendingDelegationReply &&');
    expect(providerCondIdx).toBeGreaterThan(guardIdx);
    // O guard entra ANTES da política de resposta do provider.
    expect(providerCondIdx).toBeLessThan(
      finishSource.indexOf('shouldLetRealtimeProviderAnswer(transcript'),
    );
  });
});

describe('pendência sobrevive ao re-wake (follow-up 4a)', () => {
  it('beginListening NÃO limpa mais a pendência de delegação', () => {
    const beginIdx = controllerSource.indexOf('async function beginListening');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(controllerSource.slice(beginIdx)).not.toContain('clearPendingDelegation');
  });
});
