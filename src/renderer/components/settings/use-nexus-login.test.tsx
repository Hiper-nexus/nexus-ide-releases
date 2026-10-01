/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_PENDING_TTL_MS, type LoginResultEvent } from '../../../shared/auth-login';
import { useNexusLogin, waitingProviderOf, type NexusLogin } from './use-nexus-login';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let login!: NexusLogin;
let onCompleted: ReturnType<typeof vi.fn>;
let emitResult: (result: LoginResultEvent) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

function Probe() {
  login = useNexusLogin({ onCompleted: onCompleted as () => void });
  return null;
}

function installBridge(authLogin: () => Promise<{ ok: boolean; error?: string }>) {
  unsubscribe = vi.fn();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      app: {
        authLogin: vi.fn(authLogin),
        onAuthLoginResult: (cb: (result: LoginResultEvent) => void) => {
          emitResult = cb;
          return unsubscribe;
        },
      },
    },
  });
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
}

beforeEach(() => {
  vi.useFakeTimers();
  onCompleted = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
  vi.useRealTimers();
});

describe('useNexusLogin', () => {
  it('começa ocioso', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    expect(login.phase).toEqual({ kind: 'idle' });
  });

  it('navegador aberto não é login feito: fica esperando e não conclui sozinho', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    expect(login.phase).toEqual({ kind: 'waiting', provider: 'github' });
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('mostra "abrindo" enquanto o Main prepara o login e ignora o segundo clique', async () => {
    let finish!: (r: { ok: boolean }) => void;
    installBridge(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    let first!: Promise<void>;
    await act(async () => { first = login.start('github'); });
    expect(login.phase).toEqual({ kind: 'opening', provider: 'github', resuming: false });
    await act(async () => { await login.start('google'); });
    expect(window.nexus.app.authLogin).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true }); await first; });
    expect(login.phase.kind).toBe('waiting');
  });

  it('servidor recusou: mostra a mensagem do Main e permite tentar de novo', async () => {
    installBridge(async () => ({ ok: false, error: 'O login com GitHub ainda não está disponível no servidor do Nexus.' }));
    await mount();
    await act(async () => { await login.start('github'); });
    expect(login.phase).toEqual({
      kind: 'failed',
      provider: 'github',
      message: 'O login com GitHub ainda não está disponível no servidor do Nexus.',
    });
    expect(login.busy).toBe(false);
  });

  it('exceção do IPC nunca vaza o texto técnico para a pessoa', async () => {
    installBridge(async () => { throw new Error("Error invoking remote method 'auth:login': token=SEGREDO"); });
    await mount();
    await act(async () => { await login.start('google'); });
    expect(login.phase.kind).toBe('failed');
    expect(JSON.stringify(login.phase)).not.toContain('SEGREDO');
    expect(JSON.stringify(login.phase)).not.toContain('invoking');
  });

  it('deep link concluído: volta a ocioso e chama onCompleted uma vez', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { emitResult({ ok: true }); });
    expect(login.phase).toEqual({ kind: 'idle' });
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('falha do deep link só vale para quem iniciou o login (a outra instância ignora)', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { emitResult({ ok: false, error: 'Não foi possível concluir o login.' }); });
    expect(login.phase).toEqual({ kind: 'idle' });
  });

  it('link velho ou forjado (stale) não derruba a espera nem o prazo', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { emitResult({ ok: false, stale: true, error: 'Este link de login já foi usado ou expirou.' }); });
    expect(login.phase).toEqual({ kind: 'waiting', provider: 'github' });
    await act(async () => { vi.advanceTimersByTime(LOGIN_PENDING_TTL_MS + 1); });
    expect(login.phase.kind).toBe('failed');
  });

  it('"Abrir de novo" mantém a tela de espera (resuming) em vez de piscar os botões', async () => {
    let finish!: (r: { ok: boolean }) => void;
    let calls = 0;
    installBridge(() => (++calls === 1 ? Promise.resolve({ ok: true }) : new Promise(resolve => { finish = resolve; })));
    await mount();
    await act(async () => { await login.start('github'); });
    let again!: Promise<void>;
    await act(async () => { again = login.start('github'); });
    expect(login.phase).toEqual({ kind: 'opening', provider: 'github', resuming: true });
    expect(waitingProviderOf(login.phase)).toBe('github');
    await act(async () => { finish({ ok: true }); await again; });
    expect(login.phase).toEqual({ kind: 'waiting', provider: 'github' });
  });

  it('reabrir e falhar volta a "failed" com o motivo, não fica preso em "opening"', async () => {
    let calls = 0;
    installBridge(async () => (++calls === 1 ? { ok: true } : { ok: false, error: 'O login com GitHub ainda não está disponível no servidor do Nexus.' }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { await login.start('github'); });
    expect(login.phase.kind).toBe('failed');
  });

  it('o login concluído mostra "finishing" até a conta ser atualizada e só então volta a ocioso', async () => {
    installBridge(async () => ({ ok: true }));
    let finishRefresh!: () => void;
    onCompleted = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { emitResult({ ok: true }); });
    expect(login.phase).toEqual({ kind: 'finishing' });
    expect(login.busy).toBe(true);
    await act(async () => { finishRefresh(); await Promise.resolve(); });
    expect(login.phase).toEqual({ kind: 'idle' });
  });

  it('se atualizar a conta falhar depois do login, a pessoa vê o aviso (nada de rejeição muda)', async () => {
    installBridge(async () => ({ ok: true }));
    onCompleted = vi.fn(async () => { throw new Error('team.get rejected: token=SEGREDO'); });
    await mount();
    await act(async () => { await login.start('google'); });
    await act(async () => { emitResult({ ok: true }); await Promise.resolve(); await Promise.resolve(); });
    expect(login.phase.kind).toBe('failed');
    expect(JSON.stringify(login.phase)).not.toContain('SEGREDO');
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('desmontar durante "opening" não deixa o prazo de 10 minutos armado depois', async () => {
    let finish!: (r: { ok: boolean }) => void;
    installBridge(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    let pending!: Promise<void>;
    await act(async () => { pending = login.start('github'); });
    act(() => root.unmount());
    await act(async () => { finish({ ok: true }); await pending; });
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });

  it('deep link com falha: mostra o motivo mantendo o provedor para "tentar de novo"', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('google'); });
    await act(async () => { emitResult({ ok: false, error: 'Este link de login já foi usado ou expirou.' }); });
    expect(login.phase).toEqual({ kind: 'failed', provider: 'google', message: 'Este link de login já foi usado ou expirou.' });
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('sem resposta do navegador em 10 minutos: avisa que o prazo acabou', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { vi.advanceTimersByTime(LOGIN_PENDING_TTL_MS - 1); });
    expect(login.phase.kind).toBe('waiting');
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(login.phase).toEqual({ kind: 'failed', provider: 'github', message: expect.stringContaining('tempo') });
  });

  it('reset volta a ocioso e cancela o prazo pendente', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    await act(async () => { login.reset(); });
    expect(login.phase).toEqual({ kind: 'idle' });
    await act(async () => { vi.advanceTimersByTime(LOGIN_PENDING_TTL_MS + 1000); });
    expect(login.phase).toEqual({ kind: 'idle' });
  });

  it('desmontar solta a assinatura do evento e o prazo', async () => {
    installBridge(async () => ({ ok: true }));
    await mount();
    await act(async () => { await login.start('github'); });
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(host);
  });

  it('funciona com um bridge antigo sem onAuthLoginResult (não quebra a montagem)', async () => {
    Object.defineProperty(window, 'nexus', { configurable: true, value: { app: { authLogin: vi.fn(async () => ({ ok: true })) } } });
    await mount();
    await act(async () => { await login.start('github'); });
    expect(login.phase.kind).toBe('waiting');
  });
});
