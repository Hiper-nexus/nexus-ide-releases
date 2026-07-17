import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { OmpAuthPushEvent } from '../../shared/omp-auth-types';
import {
  OmpLoginFlow,
  extractOAuthUrl,
  parseAuthBrokerList,
} from './omp-auth';
import type { OmpChildLike } from './omp-rpc-service';

/**
 * Testes da lógica de login OAuth do omp com um processo FAKE
 * (EventEmitter): nenhum spawn real, nenhum segredo — o stdout do login só
 * carrega a URL de autorização (o token vai direto para o cofre do omp).
 */

class FakeLoginProcess implements OmpChildLike {
  private readonly emitter = new EventEmitter();
  readonly kills: string[] = [];
  pid = 5150;
  stdin = null;

  stdout = {
    on: (event: 'data', cb: (chunk: Buffer | string) => void) => {
      this.emitter.on(`stdout:${event}`, cb);
      return this;
    },
  };

  stderr = {
    on: (event: 'data', cb: (chunk: Buffer | string) => void) => {
      this.emitter.on(`stderr:${event}`, cb);
      return this;
    },
  };

  on(event: 'exit' | 'error', cb: (arg: never) => void): this {
    this.emitter.on(event, cb as (...args: unknown[]) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  emitStdout(raw: string): void {
    this.emitter.emit('stdout:data', raw);
  }

  emitStderr(raw: string): void {
    this.emitter.emit('stderr:data', raw);
  }

  exit(code: number | null): void {
    this.emitter.emit('exit', code);
  }

  fail(err: Error): void {
    this.emitter.emit('error', err);
  }
}

interface Harness {
  proc: FakeLoginProcess;
  flow: OmpLoginFlow;
  events: OmpAuthPushEvent[];
  spawnArgs: string[];
}

function createHarness(
  overrides: { loginTimeoutMs?: number; providerId?: string } = {},
): Harness {
  const proc = new FakeLoginProcess();
  const events: OmpAuthPushEvent[] = [];
  const spawnArgs: string[] = [];
  const flow = new OmpLoginFlow(
    {
      flowId: 'flow-1',
      providerId: overrides.providerId ?? 'anthropic',
      binPath: '/usr/local/bin/omp',
    },
    {
      onEvent: (event) => {
        events.push(event);
      },
      spawnImpl: (_bin, args) => {
        spawnArgs.push(...args);
        return proc;
      },
      env: { PATH: '/usr/bin' },
      cwd: '/tmp',
      loginTimeoutMs: overrides.loginTimeoutMs ?? 5_000,
    },
  );
  return { proc, flow, events, spawnArgs };
}

describe('parseAuthBrokerList', () => {
  it('valida a saída de `omp auth-broker list --json`', () => {
    const entries = parseAuthBrokerList([
      { id: 'anthropic', name: 'Anthropic (Claude Pro/Max)' },
      { id: 'openai-codex', name: 'OpenAI Codex (ChatGPT)' },
    ]);
    expect(entries).toEqual([
      { id: 'anthropic', name: 'Anthropic (Claude Pro/Max)' },
      { id: 'openai-codex', name: 'OpenAI Codex (ChatGPT)' },
    ]);
  });

  it('rejeita lixo: não-array, campos errados, entradas vazias', () => {
    expect(() => parseAuthBrokerList('anthropic')).toThrow();
    expect(() => parseAuthBrokerList({ id: 'anthropic' })).toThrow();
    expect(() => parseAuthBrokerList([{ id: 'anthropic' }])).toThrow();
    expect(() => parseAuthBrokerList([{ id: '', name: 'x' }])).toThrow();
    expect(() => parseAuthBrokerList(null)).toThrow();
  });

  it('lista vazia é válida', () => {
    expect(parseAuthBrokerList([])).toEqual([]);
  });
});

describe('extractOAuthUrl', () => {
  it('extrai a URL https da linha seguinte a "Open this URL"', () => {
    const text =
      'Open this URL in your browser:\nhttps://claude.ai/oauth/authorize?code_challenge=abc';
    expect(extractOAuthUrl(text)).toBe(
      'https://claude.ai/oauth/authorize?code_challenge=abc',
    );
  });

  it('robusto a variações: pega a primeira https de qualquer texto', () => {
    expect(extractOAuthUrl('veja https://example.com/auth e confirme')).toBe(
      'https://example.com/auth',
    );
  });

  it('sem https → null (http não é OAuth de verdade aqui)', () => {
    expect(extractOAuthUrl('Open this URL in your browser:')).toBeNull();
    expect(extractOAuthUrl('http://inseguro.example/auth')).toBeNull();
  });
});

describe('OmpLoginFlow', () => {
  it('spawna `omp auth-broker login <id>` com stdin em pipe (nunca fechado)', () => {
    const { spawnArgs } = createHarness({ providerId: 'openai-codex' });
    expect(spawnArgs).toEqual(['auth-broker', 'login', 'openai-codex']);
  });

  it('awaiting-auth na 1ª URL https do stdout, done no exit 0', () => {
    const { proc, events } = createHarness();
    proc.emitStdout('Open this URL in your browser:\n');
    // URL pode chegar em chunk separado — o buffer por linha resolve.
    proc.emitStdout('https://claude.ai/oauth/authorize?state=xyz\n');
    expect(events).toEqual([
      {
        phase: 'awaiting-auth',
        providerId: 'anthropic',
        url: 'https://claude.ai/oauth/authorize?state=xyz',
      },
    ]);
    proc.exit(0);
    expect(events).toEqual([
      {
        phase: 'awaiting-auth',
        providerId: 'anthropic',
        url: 'https://claude.ai/oauth/authorize?state=xyz',
      },
      { phase: 'done', providerId: 'anthropic' },
    ]);
  });

  it('só emite awaiting-auth uma vez (URLs repetidas são ignoradas)', () => {
    const { proc, events } = createHarness();
    proc.emitStdout('https://example.com/auth1\nhttps://example.com/auth2\n');
    proc.exit(0);
    expect(events.filter((e) => e.phase === 'awaiting-auth')).toHaveLength(1);
    expect(events[0]).toMatchObject({ url: 'https://example.com/auth1' });
  });

  it('exit ≠ 0 → error com o código e o tail de diagnóstico', () => {
    const { proc, events } = createHarness();
    proc.emitStdout('browser did not open\n');
    proc.emitStderr('oauth callback timeout\n');
    proc.exit(1);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.phase).toBe('error');
    if (event.phase === 'error') {
      expect(event.message).toContain('código 1');
      expect(event.message).toContain('browser did not open');
    }
  });

  it('erro de spawn (evento error do processo) → error', () => {
    const { proc, events } = createHarness();
    proc.fail(new Error('ENOENT'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'error',
      providerId: 'anthropic',
    });
  });

  it('timeout → mata o filho e encerra como error', async () => {
    const { proc, events } = createHarness({ loginTimeoutMs: 30 });
    await vi.waitFor(() => {
      expect(events.some((e) => e.phase === 'error')).toBe(true);
    });
    expect(proc.kills).toContain('SIGTERM');
    const event = events.find((e) => e.phase === 'error');
    if (event?.phase === 'error') {
      expect(event.message).toContain('expirou');
    }
    // Exit tardio (após o kill) não emite nada mais.
    const total = events.length;
    proc.exit(null);
    expect(events).toHaveLength(total);
  });

  it('cancel: kill + error "cancelado", e exit posterior é ignorado', () => {
    const harness = createHarness();
    harness.flow.cancel();
    expect(harness.proc.kills).toEqual(['SIGTERM']);
    expect(harness.events).toEqual([
      {
        phase: 'error',
        providerId: 'anthropic',
        message: 'Login cancelado pelo usuário.',
      },
    ]);
    harness.proc.exit(null);
    expect(harness.events).toHaveLength(1);
  });
});
