import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import client from './client.cjs';
import { TEST_SPKI, TEST_THUMBPRINT, startTestAgent, type TestAgent } from './test-fixtures/agent-harness';

const HOOK = path.join(__dirname, 'client.cjs');
const savedEnv = { ...process.env };

function useAgent(testAgent: TestAgent) {
  process.env.NEXUS_WINDOWS_SIGNER_DIR = testAgent.directory;
  process.env.NEXUS_WINDOWS_SIGNER_CHECKOUT = testAgent.checkout;
  process.env.NEXUS_WINDOWS_SIGNER_TIMESTAMP = 'http://timestamp.sectigo.com';
}

function outFile(testAgent: TestAgent, name: string): string {
  const file = path.join(testAgent.checkout, 'out', 'NexusIDE-win32-x64', name);
  writeFileSync(file, 'MZ');
  return file;
}

afterEach(() => {
  process.env = { ...savedEnv };
  process.exitCode = undefined;
});

describe('hook do @electron/windows-sign', () => {
  it('assina pelo agente vivo, sem processo de PIN', async () => {
    const testAgent = await startTestAgent();
    useAgent(testAgent);
    const file = outFile(testAgent, 'nexus-ide.exe');
    await client(file);
    expect(readFileSync(file, 'utf8')).toBe('MZSIGNED');
    await client.verifyFile(file);
    expect(testAgent.engineLog().filter((line) => line === 'UNLOCK')).toHaveLength(1);
    await client.stopAgent(testAgent.directory);
    await testAgent.stopped;
  });

  it('falha recusada fica registrada e marca o processo com saída 1', async () => {
    const testAgent = await startTestAgent();
    useAgent(testAgent);
    const script = outFile(testAgent, 'install.ps1');
    const before = client.failures().length;
    await expect(client(script)).rejects.toThrow(/only \.exe, \.dll and \.node/u);
    expect(client.failures().slice(before)).toEqual([{ file: script, error: expect.stringMatching(/install\.ps1/u) }]);
    expect(process.exitCode).toBe(1);
    await client.stopAgent(testAgent.directory);
    await testAgent.stopped;
  });

  it('sem agente vivo, falha em vez de abrir janela de PIN no meio do build', async () => {
    process.env.NEXUS_WINDOWS_SIGNER_DIR = mkdtempSync(path.join(os.tmpdir(), 'nexus-signer-none-'));
    await expect(client(path.join(os.tmpdir(), 'x.exe'))).rejects.toThrow(/no YubiKey signing agent is running/u);
  });

  // O signtool falso do Squirrel roda `sign({ hookModulePath, files })` num node
  // à parte e o sign-with-hook.js engole o erro: a saída 1 é o que para o Squirrel.
  it('no signtool falso do Squirrel, recusa vira saída 1 e sucesso vira saída 0', async () => {
    const testAgent = await startTestAgent();
    useAgent(testAgent);
    // Assíncrono: o agente de teste mora neste processo e precisa do laço livre.
    const run = (file: string) => new Promise<number | null>((resolve) => {
      spawn(process.execPath, [
        '-e',
        "require('@electron/windows-sign').sign({ hookModulePath: process.argv[1], files: [process.argv[2]] })",
        HOOK,
        file,
      ], { env: process.env, stdio: 'ignore' }).on('exit', resolve);
    });
    const good = outFile(testAgent, 'Update.exe');
    expect(await run(good)).toBe(0);
    expect(readFileSync(good, 'utf8')).toBe('MZSIGNED');
    expect(await run(path.join(os.homedir(), 'fora-do-build.exe'))).toBe(1);
    await client.stopAgent(testAgent.directory);
    await testAgent.stopped;
  }, 30_000);
});

describe('ensureAgent', () => {
  it('reaproveita o agente destrancado: nenhum PIN no segundo build', async () => {
    const testAgent = await startTestAgent();
    const logs: string[] = [];
    const status = await client.ensureAgent({
      thumbprint: TEST_THUMBPRINT,
      spkiSha256: TEST_SPKI,
      hours: 24,
      directory: testAgent.directory,
      log: (message) => logs.push(message),
    });
    expect(status).toMatchObject({ started: false, unlocked: true, thumbprint: TEST_THUMBPRINT });
    expect(logs).toEqual([]);
    expect(testAgent.engineLog().filter((line) => line === 'UNLOCK')).toHaveLength(1);
    await client.stopAgent(testAgent.directory);
    await testAgent.stopped;
  });

  it('agente perto de vencer é trocado por um novo (que pede o PIN)', async () => {
    const testAgent = await startTestAgent();
    const logs: string[] = [];
    // O novo agente sai antes do PIN: o motor real não acha o certificado de teste na loja.
    await expect(client.ensureAgent({
      thumbprint: TEST_THUMBPRINT,
      spkiSha256: TEST_SPKI,
      hours: 24,
      directory: testAgent.directory,
      now: () => Date.now() + 24 * 3_600_000 - client.MIN_REMAINING_MS + 60_000,
      log: (message) => logs.push(message),
    })).rejects.toThrow();
    expect(await testAgent.stopped).toBe('stop requested');
    expect(logs).toEqual([expect.stringMatching(/Digite o PIN do YubiKey na janela do Windows.*24 h/u)]);
  }, 60_000);

  it('o processo destacado responde FAILED com o motivo, sem chegar ao cartão', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nexus-signer-launch-'));
    await expect(client.ensureAgent({
      thumbprint: 'nao-e-thumbprint',
      spkiSha256: TEST_SPKI,
      hours: 24,
      directory,
      log: () => undefined,
    })).rejects.toThrow(/--thumbprint must be 40 uppercase hex characters/u);
  }, 30_000);
});
