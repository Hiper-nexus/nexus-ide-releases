import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_ACCESS_QUARANTINE_MS,
  modelAccessQuarantine,
  quarantineRejectedModel,
  resetModelAccessQuarantineForTests,
  resolveModelQuarantineInstallationId,
  setModelQuarantineScopeResolver,
} from './model-access-quarantine';

beforeEach(() => resetModelAccessQuarantineForTests());

describe('quarentena de modelo recusado pelo provider (F-683)', () => {
  it('guarda o motivo pelo par CLI + modelo até vencer', () => {
    quarantineRejectedModel('opencode', 'opencode/deepseek-v4-flash', 'Model access is disabled', 1_000);
    expect(modelAccessQuarantine('opencode', 'OpenCode/DeepSeek-V4-Flash', 2_000)).toBe('Model access is disabled');
    expect(modelAccessQuarantine('opencode', 'opencode/outro', 2_000)).toBeNull();
    expect(modelAccessQuarantine('codex', 'opencode/deepseek-v4-flash', 2_000)).toBeNull();
    expect(modelAccessQuarantine('opencode', 'opencode/deepseek-v4-flash', 1_000 + MODEL_ACCESS_QUARANTINE_MS)).toBeNull();
  });

  it('pane sem modelo conhecido não entra em quarentena', () => {
    quarantineRejectedModel('opencode', undefined, 'x', 1_000);
    expect(modelAccessQuarantine('opencode', undefined, 1_000)).toBeNull();
  });

  it('recusa de acesso na conta A não pune B nem o login nativo (F-765)', () => {
    quarantineRejectedModel('codex', 'gpt-6.1-sol', 'chatgpt-model-unsupported', 1_000, MODEL_ACCESS_QUARANTINE_MS,
      { kind: 'access', accountId: 'account-a' });
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000, { accountId: 'account-a' })).toBe('chatgpt-model-unsupported');
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000, { accountId: 'account-b' })).toBeNull();
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000, { accountId: null })).toBeNull();
  });

  it('incompatibilidade pertence à instalação, não à conta, e vence (F-765)', () => {
    quarantineRejectedModel('codex', 'gpt-6.1-sol', 'model-unsupported', 1_000, 10_000,
      { kind: 'installation', installationId: 'codex-0.146', accountId: 'account-a' });
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000,
      { installationId: 'codex-0.146', accountId: 'account-b' })).toBe('model-unsupported');
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000,
      { installationId: 'codex-0.160', accountId: 'account-a' })).toBeNull();
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 11_000,
      { installationId: 'codex-0.146', accountId: 'account-a' })).toBeNull();
  });

  it('duas rejeições preservam os dois modelos recusados até vencer (F-765)', () => {
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) {
      quarantineRejectedModel('codex', model, 'model-unsupported', 1_000, 10_000,
        { kind: 'access', accountId: 'account-a' });
    }
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) {
      expect(modelAccessQuarantine('codex', model, 2_000, { accountId: 'account-a' })).toBe('model-unsupported');
      expect(modelAccessQuarantine('codex', model, 11_000, { accountId: 'account-a' })).toBeNull();
    }
  });

  it('consulta viva segue a conta e instalação do Main; override de conta mantém a instalação', () => {
    let accountId = 'account-a';
    let installationId = 'codex-0.146';
    setModelQuarantineScopeResolver(() => ({ accountId, installationId }));
    quarantineRejectedModel('codex', 'gpt-6.1-sol', 'access', 1_000);
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000)).toBe('access');
    accountId = 'account-b';
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000)).toBeNull();
    quarantineRejectedModel('codex', 'gpt-6-luna', 'installation', 1_000, 10_000,
      { kind: 'installation', accountId: 'account-a' });
    expect(modelAccessQuarantine('codex', 'gpt-6-luna', 2_000, { accountId: 'account-a' })).toBe('installation');
    installationId = 'codex-0.160';
    expect(modelAccessQuarantine('codex', 'gpt-6-luna', 2_000)).toBeNull();
  });

  it('incompatibilidade sem instalação provada não vira recusa global', async () => {
    quarantineRejectedModel('codex', 'gpt-6.1-sol', 'installation', 1_000, 10_000,
      { kind: 'installation' });
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000)).toBeNull();
    await expect(resolveModelQuarantineInstallationId('/missing/codex')).resolves.toBeNull();
    await expect(resolveModelQuarantineInstallationId('codex')).resolves.toBeNull();
  });

  it('instalação nova no mesmo caminho ou via wrapper npm não herda incompatibilidade', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-quarantine-'));
    try {
      const bin = path.join(directory, 'codex');
      const link = path.join(directory, 'codex-link');
      const manifest = path.join(directory, 'package.json');
      fs.writeFileSync(bin, 'old-executable');
      fs.writeFileSync(manifest, '{"version":"0.146.0"}');
      fs.symlinkSync(bin, link);
      const old = (await resolveModelQuarantineInstallationId(bin))!;
      expect(old).not.toBeNull();
      await expect(resolveModelQuarantineInstallationId(link)).resolves.toBe(old);
      quarantineRejectedModel('codex', 'gpt-6.1-sol', 'installation', 1_000, 10_000,
        { kind: 'installation', installationId: old });
      fs.writeFileSync(manifest, '{"version":"0.160.0"}');
      const updatedWrapper = (await resolveModelQuarantineInstallationId(bin))!;
      expect(updatedWrapper).not.toBe(old);
      expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', 2_000, { installationId: updatedWrapper })).toBeNull();
      fs.writeFileSync(bin, 'new-executable-with-different-length');
      await expect(resolveModelQuarantineInstallationId(bin)).resolves.not.toBe(updatedWrapper);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
