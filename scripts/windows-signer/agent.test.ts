import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import agent from './agent.cjs';
import { TEST_THUMBPRINT, makeCheckout, startTestAgent, type TestAgent } from './test-fixtures/agent-harness';

function ask(testAgent: TestAgent, payload: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const { token: realToken } = JSON.parse(readFileSync(path.join(testAgent.directory, 'agent.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(testAgent.info.pipe);
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...payload, token: token ?? realToken })}\n`));
    socket.on('data', (chunk) => { answer += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(answer)));
  });
}

function outFile(testAgent: TestAgent, name = 'nexus-ide.exe'): string {
  const file = path.join(testAgent.checkout, 'out', 'NexusIDE-win32-x64', name);
  writeFileSync(file, 'MZ');
  return file;
}

describe('agent hours', () => {
  it('vale 24 h por padrão, 0 = só este build, até uma semana', () => {
    expect(agent.parseAgentHours(undefined)).toBe(24);
    expect(agent.parseAgentHours('')).toBe(24);
    expect(agent.parseAgentHours('0')).toBe(0);
    expect(agent.parseAgentHours(' 12 ')).toBe(12);
    expect(agent.parseAgentHours('168')).toBe(168);
    for (const bad of ['169', '-1', '1.5', 'semana', '1e3']) {
      expect(() => agent.parseAgentHours(bad)).toThrow(/NEXUS_WINDOWS_SIGNER_HOURS/u);
    }
  });
});

describe('what the agent agrees to sign', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-signer-policy-'));
  const checkout = makeCheckout(root);
  const squirrel = path.join(root, 'SquirrelTemp');
  mkdirSync(path.join(squirrel, 'tempb', 'lib', 'net45'), { recursive: true });
  const outExe = path.join(checkout, 'out', 'NexusIDE-win32-x64', 'nexus-ide.exe');
  writeFileSync(outExe, 'MZ');
  const squirrelStub = path.join(squirrel, 'tempb', 'lib', 'net45', 'nexus-ide_ExecutionStub.exe');
  writeFileSync(squirrelStub, 'MZ');
  const base = { checkoutRoot: checkout, thumbprint: TEST_THUMBPRINT, temporaryRoots: [squirrel] };

  it('assina executável do out\\ de um checkout que fixa este certificado e da SquirrelTemp', () => {
    expect(agent.resolveSignableFile({ ...base, file: outExe })).toBe(realpathSync.native(outExe));
    expect(agent.resolveSignableFile({ ...base, file: squirrelStub }))
      .toBe(realpathSync.native(squirrelStub));
  });

  it('recusa checkout que fixa outro certificado', () => {
    expect(() => agent.resolveSignableFile({ ...base, thumbprint: '0'.repeat(40), file: outExe }))
      .toThrow(/outside the build folders/u);
  });

  it('recusa o que não é .exe, .dll ou .node, caminho relativo e arquivo ausente', () => {
    const script = path.join(checkout, 'out', 'NexusIDE-win32-x64', 'install.ps1');
    writeFileSync(script, '#');
    expect(() => agent.resolveSignableFile({ ...base, file: script })).toThrow(/only \.exe, \.dll and \.node/u);
    expect(() => agent.resolveSignableFile({ ...base, file: 'out\\nexus-ide.exe' })).toThrow(/absolute/u);
    expect(() => agent.resolveSignableFile({ ...base, file: path.join(checkout, 'out', 'nada.exe') }))
      .toThrow(/does not exist/u);
  });

  it('recusa arquivo fora das pastas de build, mesmo chegando por junction dentro do out\\', () => {
    const outside = path.join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, 'malware.exe');
    writeFileSync(victim, 'MZ');
    expect(() => agent.resolveSignableFile({ ...base, file: victim })).toThrow(/outside the build folders/u);
    const link = path.join(checkout, 'out', 'link');
    symlinkSync(outside, link, 'junction');
    expect(() => agent.resolveSignableFile({ ...base, file: path.join(link, 'malware.exe') }))
      .toThrow(/outside the build folders/u);
  });

  it('não aceita a própria pasta raiz nem um checkout inexistente', () => {
    expect(() => agent.resolveSignableFile({ ...base, checkoutRoot: path.join(root, 'nope'), file: outExe }))
      .toThrow(/outside the build folders/u);
  });
});

describe('signing agent', () => {
  it('abre o motor, confere o certificado e só então pede o PIN, uma vez', async () => {
    const testAgent = await startTestAgent();
    expect(testAgent.engineLog()).toEqual(['UNLOCK']);
    expect(testAgent.info.expiresAt).toBe(testAgent.info.startedAt + 24 * 3_600_000);
    const info = JSON.parse(readFileSync(path.join(testAgent.directory, 'agent.json'), 'utf8'));
    expect(info).toMatchObject({ schemaVersion: 1, thumbprint: TEST_THUMBPRINT, pid: process.pid });
    expect(info.token).toMatch(/^[a-f0-9]{64}$/u);
    await ask(testAgent, { op: 'stop' });
    await testAgent.stopped;
  });

  it('assina vários arquivos com o mesmo PIN, carimbo escolhido pelo build, e anota no diário', async () => {
    const testAgent = await startTestAgent();
    const first = outFile(testAgent, 'nexus-ide.exe');
    const second = outFile(testAgent, 'ffmpeg.dll');
    for (const file of [first, second]) {
      const answer = await ask(testAgent, {
        op: 'sign',
        file,
        checkoutRoot: testAgent.checkout,
        timestampServer: 'http://timestamp.sectigo.com',
      });
      expect(answer).toMatchObject({ ok: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    }
    expect(await ask(testAgent, { op: 'verify', file: first, checkoutRoot: testAgent.checkout })).toEqual({ ok: true });
    expect(testAgent.engineLog().filter((line) => line === 'UNLOCK')).toHaveLength(1);
    expect(testAgent.engineLog()).toContain(`SIGN ${realpathSync.native(first)} http://timestamp.sectigo.com`);
    const audit = readFileSync(path.join(testAgent.directory, 'signed.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(audit.map((entry) => path.basename(entry.file))).toEqual(['nexus-ide.exe', 'ffmpeg.dll']);
    await ask(testAgent, { op: 'stop' });
    await testAgent.stopped;
  });

  it('recusa token errado, carimbo que não é URL e arquivo fora do build sem chamar o motor', async () => {
    const testAgent = await startTestAgent();
    const file = outFile(testAgent);
    expect(await ask(testAgent, { op: 'sign', file, checkoutRoot: testAgent.checkout, timestampServer: 'http://t' }, 'f'.repeat(64)))
      .toEqual({ ok: false, error: 'unauthorized' });
    expect(await ask(testAgent, { op: 'sign', file, checkoutRoot: testAgent.checkout, timestampServer: '/tr evil' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/timestampServer/u) });
    expect(await ask(testAgent, { op: 'sign', file: path.join(os.homedir(), 'x.exe'), checkoutRoot: testAgent.checkout, timestampServer: 'http://t' }))
      .toMatchObject({ ok: false });
    expect(testAgent.engineLog()).toEqual(['UNLOCK']);
    await ask(testAgent, { op: 'stop' });
    await testAgent.stopped;
  });

  it('status prova o PIN em cache sem abrir janela e mostra o certificado', async () => {
    const testAgent = await startTestAgent({ hours: 168 });
    const status = await ask(testAgent, { op: 'status' });
    expect(status).toMatchObject({ ok: true, unlocked: true, thumbprint: TEST_THUMBPRINT, expiresAt: testAgent.info.startedAt + 168 * 3_600_000 });
    expect(testAgent.engineLog()).toEqual(['UNLOCK', 'PROBE']);
    await ask(testAgent, { op: 'stop' });
    await testAgent.stopped;
  });

  it('YubiKey que perdeu o PIN encerra o agente em vez de pedir PIN às escondidas', async () => {
    const testAgent = await startTestAgent({ lockAfter: 1 });
    const file = outFile(testAgent);
    const request = { op: 'sign', file, checkoutRoot: testAgent.checkout, timestampServer: 'http://t' };
    expect(await ask(testAgent, request)).toMatchObject({ ok: true });
    expect(await ask(testAgent, request)).toMatchObject({ ok: false, locked: true });
    expect(await testAgent.stopped).toMatch(/^locked/u);
    expect(() => readFileSync(path.join(testAgent.directory, 'agent.json'))).toThrow();
  });

  it('não pede PIN para um certificado que não é o fixado', async () => {
    await expect(startTestAgent({ expectedSpki: '0'.repeat(64) })).rejects.toThrow(/slot 9a/u);
    await expect(startTestAgent({ thumbprint: '0'.repeat(40) })).rejects.toThrow(/not 0000/u);
    await expect(startTestAgent({ hasPrivateKey: false })).rejects.toThrow(/private key/u);
  });

  it('modo por build não tem prazo: morre com o build', async () => {
    const testAgent = await startTestAgent({ hours: 0 });
    expect(testAgent.info.expiresAt).toBeNull();
    await ask(testAgent, { op: 'stop' });
    expect(await testAgent.stopped).toBe('stop requested');
  });
});

describe.runIf(process.platform === 'win32')('real engine (engine.cs no powershell.exe 5.1)', () => {
  it('compila e recusa um certificado que não está na loja, sem pedir PIN', async () => {
    const engine = agent.startEngine({ thumbprint: '0123456789ABCDEF0123456789ABCDEF01234567' });
    const first = await engine.first();
    expect(first.split(' ')[0]).toBe('FATAL');
    expect(agent.fromB64(first.split(' ')[1])).toMatch(/is not in Cert:\\CurrentUser\\My/u);
  }, 60_000);

  it('o script do powershell.exe não usa cmdlet nem drive de módulo', () => {
    expect(agent.ENGINE_BOOTSTRAP).not.toMatch(/Cert:|Add-Type|New-Object|Get-|Set-|Write-/u);
  });
});
