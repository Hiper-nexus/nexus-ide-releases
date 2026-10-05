import { describe, expect, it } from 'vitest';
import { CliPromptAutoResponder } from './cli-prompt-autoresponder-core';
import { cpuTimeMs } from '../../test/cpu-time';

describe('Worker prompt analysis', () => {
  it('reads an unchanged dense boot buffer without repeating costly text normalization', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('dense', 'codex', 0, { governed: false });
    responder.acceptAnalysis('dense', { buffer: 'é'.repeat(4096) }, 1);
    const run = () => {
      for (let index = 0; index < 1000; index++) responder.analysisSnapshot('dense', 1000);
    };
    expect(cpuTimeMs(run)).toBeLessThan(100);
    expect(responder.analysisSnapshot('dense', 1000)).toMatchObject({ verifying: false, defer: false, banner: false, force: null });
  });

  it('rechecks watch expiry even when the buffered banner is unchanged', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('migration', 'mimo-code', 0);
    responder.acceptAnalysis('migration', { buffer: 'Performing one time database migration, may take a few minutes...' }, 1);
    expect(responder.analysisSnapshot('migration', 1000)).toMatchObject({ defer: true, banner: true, force: null });
    expect(responder.analysisSnapshot('migration', 180001)).toMatchObject({ defer: false, banner: false, force: null });
  });
  it('uses changed text and drops the prior normalization on rebind', () => {
    const responder = new CliPromptAutoResponder();
    responder.bind('rebound', 'mimo-code', 0);
    responder.acceptAnalysis('rebound', { buffer: 'Performing one time database migration' }, 1);
    expect(responder.analysisSnapshot('rebound', 1000).banner).toBe(true);
    responder.acceptAnalysis('rebound', { buffer: 'ready' }, 1001);
    expect(responder.analysisSnapshot('rebound', 1002).banner).toBe(false);
    responder.acceptAnalysis('rebound', { buffer: 'Performing one time database migration' }, 1003);
    expect(responder.analysisSnapshot('rebound', 1004).banner).toBe(true);
    responder.bind('rebound', 'codex', 1005);
    expect(responder.analysisSnapshot('rebound', 1006)).toMatchObject({ defer: false, banner: false, force: null });
  });
});
