/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NexusLogin, LoginPhase } from '../settings/use-nexus-login';
import { AccessAccountCard, type AccessAccountCardProps } from './AccessAccountCard';
import { DEFAULT_CHECKOUT_CHOICE } from '../billing/CheckoutChoices';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function login(phase: LoginPhase = { kind: 'idle' }): NexusLogin {
  return { phase, busy: phase.kind === 'opening' || phase.kind === 'finishing', start: vi.fn(async () => {}), reset: vi.fn() };
}

function props(over: Partial<AccessAccountCardProps> = {}): AccessAccountCardProps {
  return {
    email: null,
    primary: 'login',
    login: login(),
    offerTrial: true,
    proPrice: 'R$ 59,99/mês',
    proFeatures: ['Failover multi-conta avançado', 'Squads na nuvem'],
    checkoutBusy: false,
    canRetry: false,
    retrying: false,
    actionError: null,
    onCheckout: vi.fn(),
    checkoutChoice: DEFAULT_CHECKOUT_CHOICE,
    onCheckoutChoice: vi.fn(),
    onPortal: vi.fn(),
    onRetry: vi.fn(),
    canRedeem: true,
    redeemBusy: false,
    redeemSucceeded: false,
    redeemError: null,
    onRedeem: vi.fn(),
    ...over,
  };
}

async function render(p: AccessAccountCardProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AccessAccountCard {...p} />));
  return host;
}

const button = (el: HTMLElement, label: string | RegExp) =>
  [...el.querySelectorAll('button')].find(b => typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''))!;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('AccessAccountCard', () => {
  it('sem conta: GitHub é a ação principal, Google e planos não competem', async () => {
    const el = await render(props());
    const marked = el.querySelectorAll('[data-access-initial-focus]');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe('Entrar com GitHub');
    expect(button(el, 'Entrar com Google').classList.contains('access-btn--primary')).toBe(false);
    expect(button(el, 'Assinar Pro').classList.contains('access-btn--primary')).toBe(false);
  });

  it('oferece o teste de 15 dias só a quem ainda não entrou', async () => {
    const signedOut = await render(props({ offerTrial: true }));
    expect(signedOut.textContent).toContain('Teste de 15 dias');
    act(() => root!.unmount());
    signedOut.remove();
    const signedIn = await render(props({ offerTrial: false, email: 'a@b.dev', primary: 'checkout' }));
    expect(signedIn.textContent).not.toContain('Teste de 15 dias');
  });

  it('teste acabado e logado: Assinar Pro é a principal e leva o foco inicial', async () => {
    const el = await render(props({ email: 'a@b.dev', offerTrial: false, primary: 'checkout' }));
    expect(el.textContent).toContain('Conectado como a@b.dev');
    const cta = button(el, 'Assinar Pro');
    expect(cta.classList.contains('access-btn--primary')).toBe(true);
    expect(el.querySelector('[data-access-initial-focus]')).toBe(cta);
    expect(button(el, 'Entrar com GitHub').classList.contains('access-btn--primary')).toBe(false);
  });

  it('acesso suspenso: o portal de cobrança é a principal', async () => {
    const onPortal = vi.fn();
    const el = await render(props({ email: 'a@b.dev', offerTrial: false, primary: 'portal', onPortal }));
    const portal = button(el, 'Gerenciar assinatura');
    expect(el.querySelector('[data-access-initial-focus]')).toBe(portal);
    await act(async () => portal.click());
    expect(onPortal).toHaveBeenCalledTimes(1);
  });

  it('verificação indisponível: "Tentar novamente" vem primeiro e é a principal', async () => {
    const onRetry = vi.fn();
    const el = await render(props({ primary: 'retry', canRetry: true, onRetry }));
    const retry = button(el, 'Tentar novamente');
    expect(retry.classList.contains('access-btn--primary')).toBe(true);
    expect(el.querySelector('[data-access-initial-focus]')).toBe(retry);
    expect(retry.compareDocumentPosition(button(el, 'Entrar com GitHub')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('só oferece "Tentar novamente" quando há o que repetir', async () => {
    const el = await render(props({ canRetry: false }));
    expect(el.textContent).not.toContain('Tentar novamente');
  });

  it('clicar num provedor inicia o login daquele provedor', async () => {
    const l = login();
    const el = await render(props({ login: l }));
    await act(async () => button(el, 'Entrar com Google').click());
    expect(l.start).toHaveBeenCalledWith('google');
  });

  it('abrindo: desabilita os provedores e diz qual está abrindo', async () => {
    const el = await render(props({ login: login({ kind: 'opening', provider: 'github', resuming: false }) }));
    expect(button(el, 'Abrindo GitHub…').disabled).toBe(true);
    expect(button(el, 'Entrar com Google').disabled).toBe(true);
  });

  it('esperando o navegador: explica o que fazer e oferece reabrir ou trocar de método', async () => {
    const l = login({ kind: 'waiting', provider: 'google' });
    const el = await render(props({ login: l }));
    const status = el.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Continue no navegador');
    expect(status.textContent).toContain('Google');
    expect(el.textContent).not.toContain('Entrar com GitHub');
    await act(async () => button(el, 'Abrir de novo').click());
    expect(l.start).toHaveBeenCalledWith('google');
    await act(async () => button(el, 'Escolher outro método').click());
    expect(l.reset).toHaveBeenCalledTimes(1);
  });

  it('esperando: o foco vai para o aviso, para quem usa teclado ou leitor de tela', async () => {
    const el = await render(props({ login: login({ kind: 'waiting', provider: 'github' }) }));
    expect(document.activeElement).toBe(el.querySelector('.access-wait'));
  });

  it('falha: mostra o motivo em alerta e mantém os provedores para tentar de novo', async () => {
    const el = await render(props({
      login: login({ kind: 'failed', provider: 'github', message: 'O login com GitHub ainda não está disponível no servidor do Nexus.' }),
    }));
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('ainda não está disponível');
    expect(button(el, 'Entrar com GitHub').disabled).toBe(false);
  });

  it('"Tenho um código" expande para o campo e envia o resgate', async () => {
    const onRedeem = vi.fn();
    const el = await render(props({ onRedeem }));
    expect(el.querySelector('.license-code input')).toBeNull();
    await act(async () => button(el, 'Tenho um código').click());
    const input = el.querySelector<HTMLInputElement>('.license-code input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'NEXUS-AAAA-BBBB-CCCC');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(el, 'Ativar').click());
    expect(onRedeem).toHaveBeenCalledWith('NEXUS-AAAA-BBBB-CCCC');
  });

  it('sem conta logada, o campo explica que o resgate precisa de login', async () => {
    const el = await render(props({ canRedeem: false }));
    await act(async () => button(el, 'Tenho um código').click());
    expect(el.textContent).toContain('Entre na sua conta para resgatar um código.');
    expect(button(el, 'Ativar').disabled).toBe(true);
  });

  it('erro e sucesso do resgate aparecem junto do campo', async () => {
    const el = await render(props({ redeemError: 'Código inválido, expirado ou já utilizado.' }));
    await act(async () => button(el, 'Tenho um código').click());
    expect(el.querySelector('.license-code [role="alert"]')!.textContent).toContain('Código inválido');
    act(() => root!.unmount());
    const ok = await render(props({ redeemSucceeded: true, email: 'a@b.dev' }));
    await act(async () => button(ok, 'Tenho um código').click());
    expect(ok.querySelector('.license-code [role="status"]')!.textContent).toContain('Licença ativada');
  });

  it('erro de checkout aparece junto dos planos, sem texto técnico', async () => {
    const el = await render(props({ actionError: 'Não foi possível abrir o checkout. Tente novamente.' }));
    expect(el.querySelector('aside [role="alert"]')!.textContent).toContain('checkout');
  });

  it('checkout em andamento desabilita Assinar Pro e troca o rótulo', async () => {
    const el = await render(props({ checkoutBusy: true }));
    const cta = button(el, 'Abrindo…');
    expect(cta.disabled).toBe(true);
  });

  it('mostra preço, promoção e recursos vindos de PLANS, nunca inventados aqui', async () => {
    const el = await render(props({ promotion: 'Preço promocional' }));
    expect(el.querySelector('.access-plans__price')!.textContent).toContain('R$ 59,99/mês');
    expect(el.textContent).toContain('Preço promocional');
    expect(el.textContent).toContain('Failover multi-conta avançado · Squads na nuvem');
  });

  it('marcas dos provedores são decorativas: o botão se nomeia em texto', async () => {
    const el = await render(props());
    for (const svg of el.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('"Abrir de novo" mantém a tela de espera (resuming), com os botões desabilitados', async () => {
    const el = await render(props({ login: login({ kind: 'opening', provider: 'github', resuming: true }) }));
    expect(el.querySelector('.access-wait')).not.toBeNull();
    expect(el.textContent).not.toContain('Entrar com GitHub');
    expect(button(el, 'Abrindo…').disabled).toBe(true);
    expect(button(el, 'Escolher outro método').disabled).toBe(true);
  });

  it('login confirmado: avisa que o acesso está sendo atualizado e trava os provedores', async () => {
    const el = await render(props({ login: login({ kind: 'finishing' }) }));
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Atualizando seu acesso');
    expect(button(el, 'Entrar com GitHub').disabled).toBe(true);
    expect(button(el, 'Entrar com Google').disabled).toBe(true);
  });

  it('não herda estilos de outras telas: sem a classe account__plan-cta', async () => {
    const el = await render(props({ primary: 'checkout', email: 'a@b.dev', offerTrial: false }));
    expect(el.querySelector('.account__plan-cta')).toBeNull();
  });

  it('abrir → falhar devolve o foco ao CTA que ficou desabilitado durante a abertura', async () => {
    const opening = props({ login: login({ kind: 'opening', provider: 'github', resuming: false }) });
    const el = await render(opening);
    await act(async () => root!.render(
      <AccessAccountCard {...opening} login={login({ kind: 'failed', provider: 'github', message: 'O login com GitHub ainda não está disponível.' })} />,
    ));
    expect(document.activeElement).toBe(el.querySelector('[data-access-initial-focus]'));
  });

  describe('foco ao sair da espera', () => {
    it('quando o aviso some, o foco volta ao CTA em vez de cair no body', async () => {
      const waiting = props({ login: login({ kind: 'waiting', provider: 'github' }) });
      const el = await render(waiting);
      await act(async () => root!.render(<AccessAccountCard {...waiting} login={login()} />));
      expect(document.activeElement).toBe(el.querySelector('[data-access-initial-focus]'));
    });
  });
});
