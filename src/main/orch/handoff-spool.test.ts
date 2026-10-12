import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';

const traceHarness = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../observability/main-trace', () => ({
  trace: (event: Record<string, unknown>) => {
    traceHarness.events.push(event);
  },
}));

import {
  createHandoffSpoolSession,
  handoffSpoolRoot,
  HANDOFF_SPOOL_ARTIFACT_KIND,
  ingestHandoffSpoolNow,
  resetHandoffSpoolForTests,
  startHandoffSpool,
  stopHandoffSpool,
  type HandoffSpoolSession,
  type HandoffSpoolStores,
  type HandoffSpoolSubmitInput,
} from './handoff-spool';
import { HANDOFF_SPOOL_WRITER_JS, HANDOFF_SPOOL_MAX_ENTRY_BYTES } from './handoff-spool-entry';
import { beginHandoffSubmitInFlight, resetHandoffSubmitInFlightForTests } from './handoff-submit-inflight';
import { handoffRawPayloadSha256 } from './handoff-payload-identity';
import { HOOK_SCRIPT } from './hooks-gen';
import { MINIMAX_NEXUS_MCP_BRIDGE_SCRIPT } from './cli-mcp-session-minimax';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  armAutoCloseOnHandoff,
  disarmAutoCloseOnHandoff,
  scheduleAutoCloseAfterHandoff,
} from './pane-close-scopes';

/**
 * F-795 (B5 da Missão Terminais): com o Main preso, o F-768 perdeu o handoff
 * para erro de transporte MCP + timeout do shim, o F-777 para ECONNRESET +
 * timeout, e o `blocked` do DeepSeek nem saiu (o hook fail-closed bloqueava
 * tudo). Aqui o Main está INALCANÇÁVEL de verdade (porta fechada, servidor que
 * aceita e não responde, shim sem ninguém lendo) e nada pode se perder.
 */

const execFileAsync = promisify(execFile);
const SHIM = path.resolve(__dirname, '../../../resources/mission-shims/nx-shim.cjs');
const scope = testProjectScope({ rootRealPath: '/repo/checkout' });

let temp: string;
let root: string;
let session: HandoffSpoolSession;
let handoffs: Handoff[];
let missions: Map<string, unknown>;
let delivered: Handoff[];
let failNextSubmit: boolean;
let submittedInputs: HandoffSpoolSubmitInput[];

function stores(): HandoffSpoolStores {
  return {
    missions: { get: (id) => missions.get(id) ?? null },
    handoffs: {
      list: ({ missionId, sessionIds }) => handoffs.filter((handoff) =>
        (missionId === undefined || handoff.missionId === missionId) &&
        (!sessionIds || (handoff.sessionId !== undefined && sessionIds.includes(handoff.sessionId)))),
      submit: (input: HandoffSpoolSubmitInput) => {
        submittedInputs.push(input);
        if (failNextSubmit) {
          failNextSubmit = false;
          throw new Error('database is locked');
        }
        const handoff = {
          id: `handoff-${handoffs.length + 1}`,
          ...input,
          artifacts: [...input.artifacts],
          claimTrust: 'untrusted',
          evidenceIds: [],
          evidenceTrust: 'unverified',
          delivered: false,
          deliveryState: 'queued',
          createdAt: Date.now(),
        } as Handoff;
        handoffs.push(handoff);
        return handoff;
      },
    },
  };
}

function start(options: { bootDelayMs?: number } = {}): void {
  startHandoffSpool({
    root,
    deps: { getStores: () => stores(), deliver: (handoff) => { delivered.push(handoff); } },
    bootDelayMs: options.bootDelayMs ?? 600_000,
    watch: false,
  });
}

function openSession(): HandoffSpoolSession {
  const created = createHandoffSpoolSession({
    scope, missionId: 'mission-a', workerIncarnationId: 'incarnation-1',
    agentLabel: 'Writer F-768', providerId: 'codex',
  });
  if (!created) throw new Error('spool não configurado');
  created.bindSession('session-w');
  return created;
}

type SpoolWriter = (
  env: Record<string, string | undefined>,
  transport: string,
  payload: unknown,
  requestId?: string,
) => { entryId: string } | null;

/** O snippet EXATO que o hook e a ponte embutem. */
function snippetWriter(): SpoolWriter {
  const factory = new Function('crypto', 'fs', 'path', 'Buffer', 'process',
    `${HANDOFF_SPOOL_WRITER_JS}\nreturn nexusSpoolHandoff;`);
  return factory(crypto, fs, path, Buffer, process) as SpoolWriter;
}

const PAYLOAD = {
  status: 'success',
  summary: 'Memória volta a gravar: retenção no aceite, fila de retry persistida e 156 testes verdes.',
  artifacts: [{ kind: 'patch', path: '/tmp/f768.patch' }],
  evidenceIds: ['ev-1'],
  filesModified: ['src/main/memory/trusted-memory.ts'],
  accomplished: ['retenção compartilhada'],
};

function entries(dir = session.dir): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
}

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  traceHarness.events.length = 0;
  resetHandoffSpoolForTests();
  resetHandoffSubmitInFlightForTests();
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-spool-')));
  root = handoffSpoolRoot(path.join(temp, 'userData'));
  handoffs = [];
  delivered = [];
  missions = new Map([['mission-a', { id: 'mission-a' }]]);
  failNextSubmit = false;
  submittedInputs = [];
  start();
  session = openSession();
});

afterEach(async () => {
  await resetHandoffSpoolForTests();
  vi.restoreAllMocks();
  resetHandoffSubmitInFlightForTests();
  fs.rmSync(temp, { recursive: true, force: true });
});

function pauseClaimedRead() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const open = fs.promises.open.bind(fs.promises);
  let paused = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).startsWith(path.join(root, 'processing') + path.sep)) {
      for (const method of ['read', 'readFile'] as const) {
        const actual = handle[method].bind(handle);
        handle[method] = (async (...readArgs: unknown[]) => {
          if (!paused) { paused = true; enter(); await gate; }
          return Reflect.apply(actual, handle, readArgs);
        }) as typeof handle.read & typeof handle.readFile;
      }
    }
    return handle;
  });
  return { entered, release };
}

describe('F-883: lifetime físico e leitura limitada do spool', () => {
  it('revokes old callbacks immediately and waits for its paused FD before stop settles', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    const gate = pauseClaimedRead();
    const flight = ingestHandoffSpoolNow();
    await gate.entered;
    let settled = false;
    const stop = Promise.resolve(stopHandoffSpool()).then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeRead = settled;
    gate.release();
    await flight;
    await stop;
    expect(settledBeforeRead).toBe(false);
    expect(submittedInputs).toEqual([]);
    expect(delivered).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'processing'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, 'ingested'))).toEqual([]);
    start();
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs).toHaveLength(1);
  });

  it('same-root reconfiguration never uses retired dependencies and ingests once with the new owner', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    const gate = pauseClaimedRead();
    const old = ingestHandoffSpoolNow();
    await gate.entered;
    const oldStores = stores;
    const newSubmits: HandoffSpoolSubmitInput[] = [];
    startHandoffSpool({ root, watch: false, bootDelayMs: 600_000, deps: {
      getStores: () => ({ ...oldStores(), handoffs: { ...oldStores().handoffs, submit: input => {
        newSubmits.push(input); return oldStores().handoffs.submit(input);
      } } }), deliver: handoff => { delivered.push(handoff); },
    } });
    const next = ingestHandoffSpoolNow();
    gate.release();
    await old;
    await next;
    expect(submittedInputs).toHaveLength(1);
    expect(newSubmits).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('stop drains an already-started asynchronous delivery before stores may close', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const delivery = new Promise<void>(resolve => { release = resolve; });
    startHandoffSpool({ root, watch: false, bootDelayMs: 600_000, deps: {
      getStores: () => stores(), deliver: () => { enter(); return delivery; },
    } });
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    const flight = ingestHandoffSpoolNow();
    await entered;
    let stopped = false;
    const stop = Promise.resolve(stopHandoffSpool()).then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledBeforeDelivery = stopped;
    release(); await flight; await stop;
    expect(settledBeforeDelivery).toBe(false);
    expect(handoffs).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('a private FIFO entry settles without waiting for a writer', async () => {
    const name = `${Date.now()}-${crypto.randomUUID()}.json`;
    await execFileAsync('/usr/bin/mkfifo', [path.join(session.dir, name)]);
    const claimed = path.join(root, 'processing', `${session.spoolId}--${name}`);
    let entered!: () => void;
    const opened = new Promise<void>(resolve => { entered = resolve; });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((...args) => { if (String(args[0]) === claimed) entered(); return open(...args); });
    let settled = false;
    const flight = ingestHandoffSpoolNow().then(report => { settled = true; return report; });
    await opened;
    await new Promise(resolve => setTimeout(resolve, 100));
    const beforeRescue = settled;
    const rescue = !beforeRescue ? fs.openSync(claimed, fs.constants.O_RDWR | fs.constants.O_NONBLOCK) : null;
    try { await flight; } finally { if (rescue !== null) fs.closeSync(rescue); }
    expect(beforeRescue).toBe(true);
    expect(submittedInputs).toEqual([]);
  });

  it('bounds a growing entry after stat instead of consuming its whole new size', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(path.join(root, 'processing') + path.sep)) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs: unknown[]) => {
          const result = await Reflect.apply(stat, handle, statArgs);
          fs.appendFileSync(String(args[0]), 'x'.repeat(HANDOFF_SPOOL_MAX_ENTRY_BYTES));
          return result;
        }) as typeof handle.stat;
      }
      return handle;
    });
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ quarantined: 1 });
    const reason = fs.readdirSync(path.join(root, 'quarantine')).find(name => name.endsWith('.reason.json'))!;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'quarantine', reason), 'utf8')).reason).toBe('entry-too-large');
    expect(submittedInputs).toEqual([]);
  });

  it('reads a signed entry completely across short FD reads', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    const open = fs.promises.open.bind(fs.promises);
    let reads = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(path.join(root, 'processing') + path.sep)) {
        const read = handle.read.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          reads++; return read(buffer, offset, Math.min(length, 17), position);
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(reads).toBeGreaterThan(1);
    expect(handoffs[0]?.summary).toContain(PAYLOAD.summary);
  });
});

describe('spool de handoff: sessão (F-795)', () => {
  it('nasce com diretório 0700 só do agente, vínculo 0600 fora dele e chave por sessão no env', () => {
    expect(fs.statSync(session.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    const binding = path.join(root, 'bindings', `${session.spoolId}.json`);
    expect(fs.statSync(binding).mode & 0o777).toBe(0o600);
    expect(binding.startsWith(`${session.dir}${path.sep}`)).toBe(false);
    expect(session.env).toEqual({
      NEXUS_HANDOFF_SPOOL_DIR: session.dir,
      NEXUS_HANDOFF_SPOOL_ID: session.spoolId,
      NEXUS_HANDOFF_SPOOL_KEY: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(session.writePaths).toEqual([session.dir]);
    const stored = JSON.parse(fs.readFileSync(binding, 'utf8'));
    expect(stored).toMatchObject({ missionId: 'mission-a', sessionId: 'session-w', agentLabel: 'Writer F-768' });
  });

  it('reinício do servidor MCP no mesmo processo mantém as sessões vivas', async () => {
    start(); // mesma raiz: só troca as dependências
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    session.dispose();
    await vi.waitFor(() => expect(fs.existsSync(session.dir)).toBe(false), { timeout: 3_000 });
    expect(handoffs).toHaveLength(1);
  });

  it('rótulo do agente segue o contrato do handoff (sem controle, até 256)', () => {
    const odd = createHandoffSpoolSession({
      scope, missionId: 'mission-a', agentLabel: `Writer\u0007 ${'x'.repeat(400)}`,
    })!;
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'bindings', `${odd.spoolId}.json`), 'utf8'));
    expect(stored.agentLabel).toMatch(/^Writer +x+$/);
    expect(stored.agentLabel).toHaveLength(256);
    odd.discard();
  });

  it('sem spool configurado nenhum spawn ganha spool', () => {
    stopHandoffSpool();
    expect(createHandoffSpoolSession({ scope, missionId: 'mission-a', agentLabel: 'x' })).toBeNull();
  });
});

describe('spool de handoff: ingestão no Main (F-795)', () => {
  it('ingere UMA vez, com atribuição do Main, marcado como spool e sem evidência confiável', async () => {
    const written = snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    expect(written).not.toBeNull();
    const [name] = entries();
    expect(fs.statSync(path.join(session.dir, name)).mode & 0o777).toBe(0o600);

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1, quarantined: 0 });
    expect(handoffs).toHaveLength(1);
    const [handoff] = handoffs;
    expect(handoff).toMatchObject({
      missionId: 'mission-a', sessionId: 'session-w', workerIncarnationId: 'incarnation-1',
      fromAgent: 'Writer F-768', status: 'success', evidenceTrust: 'unverified',
    });
    expect(handoff.summary).toMatch(/^\[via spool \d{2}:\d{2}\] Memória volta a gravar/);
    expect(handoff.artifacts).toEqual(expect.arrayContaining([
      { kind: 'patch', path: '/tmp/f768.patch' },
      { kind: 'context.accomplished', payload: ['retenção compartilhada'] },
      expect.objectContaining({
        kind: HANDOFF_SPOOL_ARTIFACT_KIND,
        payload: expect.objectContaining({
          entryId: written!.entryId, transport: 'gate-hook',
          declaredEvidenceIds: ['ev-1'], declaredFilesModified: ['src/main/memory/trusted-memory.ts'],
          rawPayloadSha256: handoffRawPayloadSha256(PAYLOAD),
        }),
      }),
    ]));
    // Evidência declarada no spool nunca é resolvida como confiável.
    expect(submittedInputs[0]).not.toHaveProperty('evidenceIds');
    expect(delivered.map((entry) => entry.id)).toEqual([handoff.id]);
    expect(entries()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'ingested', `${written!.entryId}.json`))).toBe(true);
    expect(traceHarness.events).toContainEqual(expect.objectContaining({
      kind: 'handoff-spool-ingested', entryId: written!.entryId, handoffId: handoff.id,
    }));

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0 });
    expect(handoffs).toHaveLength(1);
  });

  it('F-1310: artifacts em objeto são embrulhados na ingestão, não quarentenados', async () => {
    const findings = [{ area: 'routing', severity: 'high' }];
    snippetWriter()(session.env, 'gate-hook', { ...PAYLOAD, artifacts: { findings } });

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1, quarantined: 0 });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.artifacts).toEqual(
      expect.arrayContaining([
        { kind: 'nexus.workerArtifacts', payload: { findings } },
      ]),
    );
  });

  it('retomada depois de o Main cair no meio da ingestão não duplica (dedupe pelo entryId)', async () => {
    const written = snippetWriter()(session.env, 'mcp-bridge', PAYLOAD)!;
    const [name] = entries();
    // Estado de queda: reivindicada e gravada no banco, sem recibo.
    fs.mkdirSync(path.join(root, 'processing'), { recursive: true });
    fs.renameSync(path.join(session.dir, name), path.join(root, 'processing', `${session.spoolId}--${name}`));
    handoffs.push({
      id: 'handoff-ja-gravado', missionId: 'mission-a', sessionId: 'session-w', status: 'success',
      summary: 'x', artifacts: [{ kind: HANDOFF_SPOOL_ARTIFACT_KIND, payload: { entryId: written.entryId } }],
      claimTrust: 'untrusted', evidenceIds: [], evidenceTrust: 'unverified', delivered: false,
      deliveryState: 'queued', createdAt: 1,
    } as Handoff);

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, duplicates: 1 });
    expect(handoffs).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, 'processing'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'ingested', `${written.entryId}.json`))).toBe(true);
  });

  it('a cópia do spool não duplica o handoff que o transporte original conseguiu gravar', async () => {
    snippetWriter()(session.env, 'mission-shim', PAYLOAD, crypto.randomUUID());
    handoffs.push({
      id: 'handoff-original', missionId: 'mission-a', sessionId: 'session-w', status: 'success',
      summary: 'x', artifacts: [], claimTrust: 'untrusted', evidenceIds: [], evidenceTrust: 'nexus-trusted',
      delivered: false, deliveryState: 'queued', createdAt: 1,
      mcpProvenance: { rawPayloadSha256: handoffRawPayloadSha256(PAYLOAD) },
    } as unknown as Handoff);
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, duplicates: 1 });
    expect(handoffs).toHaveLength(1);
    expect(entries()).toEqual([]);
  });

  it('adia a sessão enquanto um submit dela está em voo e entrega quando ele termina', async () => {
    const release = beginHandoffSubmitInFlight('session-w');
    snippetWriter()(session.env, 'mcp-bridge', PAYLOAD);
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, deferred: 1 });
    expect(entries()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(handoffs).toHaveLength(1), { timeout: 3_000 });
    expect(entries()).toEqual([]);
  });

  it('entrada adulterada, fora do contrato ou com status sintético vai para a quarentena com o motivo', async () => {
    const write = snippetWriter();
    write(session.env, 'gate-hook', PAYLOAD);
    const [tampered] = entries();
    const entry = JSON.parse(fs.readFileSync(path.join(session.dir, tampered), 'utf8'));
    entry.payload = JSON.stringify({ ...PAYLOAD, status: 'failed' });
    fs.writeFileSync(path.join(session.dir, tampered), JSON.stringify(entry));
    write(session.env, 'gate-hook', { ...PAYLOAD, status: 'progress' });
    write({ ...session.env, NEXUS_HANDOFF_SPOOL_KEY: 'f'.repeat(64) }, 'gate-hook', PAYLOAD);
    fs.writeFileSync(path.join(session.dir, `0000000000001-${crypto.randomUUID()}.json`), '{não é json');

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, quarantined: 4 });
    expect(handoffs).toEqual([]);
    const reasons = fs.readdirSync(path.join(root, 'quarantine'))
      .filter((name) => name.endsWith('.reason.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(root, 'quarantine', name), 'utf8')).reason)
      .sort();
    expect(reasons).toEqual(['entry-mac-invalid', 'entry-mac-invalid', 'entry-not-json', 'payload-status-invalid']);
    // Nada é apagado: a quarentena guarda as quatro entradas.
    expect(fs.readdirSync(path.join(root, 'quarantine')).filter((name) => !name.endsWith('.reason.json'))).toHaveLength(4);
  });

  it('nunca segue link simbólico nem físico plantado no diretório do agente', async () => {
    const outside = path.join(temp, 'segredo.json');
    fs.writeFileSync(outside, '{"segredo":true}');
    fs.symlinkSync(outside, path.join(session.dir, `0000000000001-${crypto.randomUUID()}.json`));
    fs.linkSync(outside, path.join(session.dir, `0000000000002-${crypto.randomUUID()}.json`));
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, quarantined: 2 });
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"segredo":true}');
    expect(handoffs).toEqual([]);
  });

  it('missão apagada ou vínculo ausente: quarentena, nunca descarte', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    missions.delete('mission-a');
    const orphan = path.join(root, 'sessions', crypto.randomUUID());
    fs.mkdirSync(orphan, { mode: 0o700 });
    fs.writeFileSync(path.join(orphan, `0000000000003-${crypto.randomUUID()}.json`), '{}');
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ quarantined: 2 });
    const reasons = fs.readdirSync(path.join(root, 'quarantine'))
      .filter((name) => name.endsWith('.reason.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(root, 'quarantine', name), 'utf8')).reason)
      .sort();
    expect(reasons).toEqual(['binding-missing', 'mission-missing']);
  });

  it('falha transitória do banco devolve a entrada para a fila e a próxima passada entrega', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    failNextSubmit = true;
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 0, failed: 1 });
    expect(entries()).toHaveLength(1);
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs).toHaveLength(1);
  });

  it('fim da sessão: última passada e o diretório some vazio; spawn que falhou apaga na hora', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    session.dispose();
    await vi.waitFor(() => {
      expect(fs.existsSync(session.dir)).toBe(false);
      expect(fs.existsSync(path.join(root, 'bindings', `${session.spoolId}.json`))).toBe(false);
    }, { timeout: 3_000 });
    expect(handoffs).toHaveLength(1);

    const failed = openSession();
    failed.discard();
    expect(fs.existsSync(failed.dir)).toBe(false);
    expect(fs.existsSync(path.join(root, 'bindings', `${failed.spoolId}.json`))).toBe(false);
  });

  it('boot: o que um Main travado/fechado deixou no spool entra na primeira passada', async () => {
    snippetWriter()(session.env, 'gate-hook', PAYLOAD);
    stopHandoffSpool(); // o app fecha: nada é apagado do disco
    expect(entries()).toHaveLength(1);
    resetHandoffSpoolForTests();
    start({ bootDelayMs: 0 });
    await vi.waitFor(() => expect(handoffs).toHaveLength(1), { timeout: 3_000 });
    expect(handoffs[0]).toMatchObject({ sessionId: 'session-w', fromAgent: 'Writer F-768' });
  });
});

describe('Main inalcançável: o lado do agente guarda o handoff (F-795)', () => {
  function shimRoot(): Record<string, string> {
    const shim = path.join(temp, 'shim');
    for (const dir of ['requests', 'responses', 'state']) fs.mkdirSync(path.join(shim, dir), { recursive: true, mode: 0o700 });
    return {
      NEXUS_SHIM_ROOT: shim,
      NEXUS_SHIM_CAPABILITY_ID: crypto.randomUUID(),
      NEXUS_SHIM_SECRET: crypto.randomBytes(32).toString('hex'),
      NEXUS_SHIM_RESPONSE_TIMEOUT_MS: '200',
    };
  }

  it('shim nx: sem ninguém lendo o pedido, guarda no spool, tira o pedido da fila e diz "guardado"', async () => {
    const shimEnv = shimRoot();
    const result = await execFileAsync(process.execPath, [
      SHIM, 'mail', 'send', '--status', 'success', '--summary', PAYLOAD.summary,
    ], { env: { PATH: process.env.PATH ?? '', ...shimEnv, ...session.env } });
    const response = JSON.parse(result.stdout);
    expect(response).toMatchObject({ ok: true, spooled: true, spoolEntryId: expect.any(String) });
    expect(response.message).toContain('não reenvie');
    expect(fs.readdirSync(path.join(shimEnv.NEXUS_SHIM_ROOT, 'requests'))).toEqual([]);

    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs[0].artifacts).toContainEqual(expect.objectContaining({
      kind: HANDOFF_SPOOL_ARTIFACT_KIND,
      payload: expect.objectContaining({ transport: 'mission-shim', requestId: expect.any(String) }),
    }));
    // Mesmo payload do caminho MCP do shim: o dedupe enxerga o original.
    expect(handoffs[0].artifacts).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        rawPayloadSha256: handoffRawPayloadSha256({ status: 'success', summary: PAYLOAD.summary }),
      }),
    }));
  });

  it('shim nx sem spool mantém a resposta antiga de timeout (nada inventado)', async () => {
    const result = await execFileAsync(process.execPath, [
      SHIM, 'mail', 'send', '--status', 'success', '--summary', PAYLOAD.summary,
    ], { env: { PATH: process.env.PATH ?? '', ...shimRoot() } }).catch((error: { stdout: string }) => error);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: 'shim_response_timeout' });
  });

  async function runBridge(env: Record<string, string>, message: object): Promise<Record<string, any>> {
    const bridge = path.join(temp, 'nexus-mcp-bridge.cjs');
    fs.writeFileSync(bridge, MINIMAX_NEXUS_MCP_BRIDGE_SCRIPT);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bridge], {
        env: { PATH: process.env.PATH ?? '', ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(out.split('\n').filter(Boolean)[0])));
      child.stdin.end(`${JSON.stringify(message)}\n`);
    });
  }

  const submitCall = {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'nexus_handoff_submit', arguments: PAYLOAD },
  };

  it('ponte stdio: porta fechada (Main fora) responde "guardado" e o Main ingere', async () => {
    const port = await closedPort();
    const reply = await runBridge({
      NEXUS_MCP_URL: `http://127.0.0.1:${port}/mcp`, NEXUS_MCP_TOKEN: 'tok', ...session.env,
    }, submitCall);
    expect(reply.id).toBe(9);
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ ok: true, spooled: true });
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs[0].summary).toContain('[via spool');
  });

  it('ponte stdio: 5xx do Main vira spool; 401 (autoridade) continua erro e não grava nada', async () => {
    let status = 503;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"error":"x"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const env = {
      NEXUS_MCP_URL: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/mcp`,
      NEXUS_MCP_TOKEN: 'tok', ...session.env,
    };
    try {
      const spooled = await runBridge(env, submitCall);
      expect(JSON.parse(spooled.result.content[0].text)).toMatchObject({ spooled: true });
      status = 401;
      const denied = await runBridge(env, submitCall);
      expect(denied.error).toMatchObject({ message: expect.stringContaining('HTTP 401') });
      expect(entries()).toHaveLength(1);
      // Outra tool nunca vai para o spool.
      status = 503;
      const other = await runBridge(env, { ...submitCall, params: { name: 'nexus_pane_list', arguments: {} } });
      expect(other.error).toBeDefined();
      expect(entries()).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  async function runHook(env: Record<string, string>, input: object): Promise<{ status: number | null; stderr: string }> {
    const hook = path.join(temp, 'nexus-gate.mjs');
    fs.writeFileSync(hook, HOOK_SCRIPT, { mode: 0o700 });
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [hook, 'pretool'], {
        env: { PATH: process.env.PATH ?? '', HOME: temp, NEXUS_GATE_TOKEN: 'tok', ...env },
        timeout: 20_000,
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (status) => resolve({ status, stderr }));
      child.stdin?.end(JSON.stringify(input));
    });
  }

  it('hook do gate com o Main fora: handoff vai para o spool e o agente ouve "guardado"', async () => {
    const port = await closedPort();
    const result = await runHook({
      NEXUS_GATE_URL: `http://127.0.0.1:${port}/gate`, ...session.env,
    }, { tool_name: 'mcp__nexus__nexus_handoff_submit', tool_input: { status: 'blocked', summary: 'Gate do Nexus inalcançável; plano pronto para retomada.' } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('handoff guardado em disco');
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs[0]).toMatchObject({ status: 'blocked', fromAgent: 'Writer F-768' });
  });

  it('hook do gate com o Main TRAVADO (aceita conexão e não responde): mesma degradação', async () => {
    const sockets: net.Socket[] = [];
    const hung = net.createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(hung.address() as net.AddressInfo).port}/gate`;
    try {
      const read = await runHook({ NEXUS_GATE_URL: url },
        { tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } });
      expect(read.status).toBe(0);
      const handoff = await runHook({ NEXUS_GATE_URL: url, ...session.env },
        { tool_name: 'mcp__nexus__nexus_handoff_submit', tool_input: PAYLOAD });
      expect(handoff.status).toBe(2);
      expect(entries()).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      hung.close();
    }
  }, 30_000);
});

describe('F-1409: success ingerido do spool fecha o worker armado', () => {
  async function ingestWithAutoClose(status: string, arm: boolean): Promise<ReturnType<typeof vi.fn>> {
    const close = vi.fn(async () => true);
    disarmAutoCloseOnHandoff('session-w', 'pane-w');
    if (arm) armAutoCloseOnHandoff('session-w', 'pane-w');
    // Mesma ligação do mcp-server: o braço decide, a fila do Maestro não.
    startHandoffSpool({ root, watch: false, bootDelayMs: 600_000, deps: {
      getStores: () => stores(),
      deliver: (handoff) => { delivered.push(handoff); },
      afterIngest: (handoff) => scheduleAutoCloseAfterHandoff(
        handoff.sessionId, handoff.status, () => 'pane-w', close),
    } });
    snippetWriter()(session.env, 'gate-hook', { ...PAYLOAD, status });
    await expect(ingestHandoffSpoolNow()).resolves.toMatchObject({ ingested: 1 });
    expect(handoffs[0]).toMatchObject({ status, deliveryState: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return close;
  }

  it('success na fila do Maestro (queued) fecha o pane armado', async () => {
    const close = await ingestWithAutoClose('success', true);
    expect(close).toHaveBeenCalledWith('pane-w', 'session-w');
  });

  it('partial mantém o pane aberto para diagnóstico', async () => {
    const close = await ingestWithAutoClose('partial', true);
    expect(close).not.toHaveBeenCalled();
    disarmAutoCloseOnHandoff('session-w', 'pane-w');
  });

  it('sem braço (autoCloseOnHandoff:false / pane do operador) success não fecha', async () => {
    const close = await ingestWithAutoClose('success', false);
    expect(close).not.toHaveBeenCalled();
  });
});
