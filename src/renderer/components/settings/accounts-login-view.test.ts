import { describe, expect, it } from 'vitest';
import {
  LOGIN_CTA_BUSY,
  LOGIN_CTA_OPEN,
  LOGIN_CTA_SWITCH,
  accountsPanelView,
  authStatusLabel,
} from './accounts-login-view';

function view(patch: Partial<Parameters<typeof accountsPanelView>[0]> = {}) {
  return accountsPanelView({
    authState: 'ok',
    adapterLabel: 'Codex',
    isClaude: false,
    vaultCount: 0,
    standbyCount: 0,
    hasActiveVault: false,
    liveEmail: null,
    loginCommand: 'codex login',
    canSnapshot: true,
    busy: false,
    ...patch,
  });
}

describe('authStatusLabel', () => {
  it('nomeia o estado da CLI, nunca o app do Dock', () => {
    expect(authStatusLabel('ok')).toBe('conectado');
    expect(authStatusLabel('missing')).toBe('precisa login');
    expect(authStatusLabel('checking')).toBe('verificando…');
    expect(authStatusLabel(undefined)).toBe('não verificado');
  });
});

describe('accountsPanelView — precisa login (F-004)', () => {
  const missing = accountsPanelView({
    authState: 'missing',
    adapterLabel: 'Claude',
    isClaude: true,
    vaultCount: 0,
    standbyCount: 0,
    hasActiveVault: false,
    liveEmail: null,
    loginCommand: 'claude auth login',
    canSnapshot: true,
    busy: false,
  });

  it('mostra um CTA só e esconde vault/failover', () => {
    expect(missing.needsLogin).toBe(true);
    expect(missing.showLoginHero).toBe(true);
    expect(missing.loginCta).toBe(LOGIN_CTA_OPEN);
    expect(missing.showAddAnotherLogin).toBe(false);
    expect(missing.showSaveLoggedIn).toBe(false);
    expect(missing.showImplicitNative).toBe(false);
    expect(missing.showReserva).toBe(false);
    expect(missing.showReservaEmpty).toBe(false);
    expect(missing.showMultiChip).toBe(false);
    expect(missing.showActiveEmUsoPill).toBe(false);
    expect(missing.showSplitRoster).toBe(false);
  });

  it('diz que o app do Dock não conta e pede o login da CLI', () => {
    expect(missing.hint).toMatch(/não está logada/i);
    expect(missing.hint).toMatch(/Dock não conta/);
    expect(missing.hint).not.toMatch(/failover/i);
    expect(missing.hint).not.toMatch(/1ª conta/);
  });

  it('troca o CTA para Abrindo terminal… enquanto o PTY sobe', () => {
    const busy = accountsPanelView({
      authState: 'missing',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 0,
      standbyCount: 0,
      hasActiveVault: false,
      liveEmail: null,
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: true,
    });
    expect(busy.loginCta).toBe(LOGIN_CTA_BUSY);
    expect(busy.showLoginHero).toBe(true);
  });

  it('com contas no vault lista o que está salvo, sem Em uso', () => {
    const vaulted = accountsPanelView({
      authState: 'missing',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 2,
      standbyCount: 1,
      hasActiveVault: true,
      liveEmail: null,
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(vaulted.showFlatSavedRoster).toBe(true);
    expect(vaulted.showSplitRoster).toBe(false);
    expect(vaulted.showActiveEmUsoPill).toBe(false);
    expect(vaulted.showReserva).toBe(false);
    expect(vaulted.showReservaEmpty).toBe(false);
    expect(vaulted.hint).toMatch(/Contas salvas/);
  });

  it('auth unknown ainda oferece o login e lista o vault', () => {
    const unknown = accountsPanelView({
      authState: 'unknown',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 1,
      standbyCount: 0,
      hasActiveVault: true,
      liveEmail: null,
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(unknown.showLoginHero).toBe(true);
    expect(unknown.loginCta).toBe(LOGIN_CTA_OPEN);
    expect(unknown.showFlatSavedRoster).toBe(true);
    expect(unknown.showActiveEmUsoPill).toBe(false);
    expect(unknown.hint).toMatch(/não está logada|não deu para verificar/i);
  });

  it('enquanto verifica, ainda lista o vault (sem fingir sessão viva)', () => {
    const checking = accountsPanelView({
      authState: 'checking',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 1,
      standbyCount: 0,
      hasActiveVault: true,
      liveEmail: null,
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(checking.showFlatSavedRoster).toBe(true);
    expect(checking.showLoginHero).toBe(false);
    expect(checking.showActiveEmUsoPill).toBe(false);
    expect(checking.showImplicitNative).toBe(false);
  });
});

describe('accountsPanelView — logado', () => {
  it('mostra sessão nativa só com vault vazio e permite outra conta', () => {
    const logged = accountsPanelView({
      authState: 'ok',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 0,
      standbyCount: 0,
      hasActiveVault: false,
      liveEmail: 'dev@example.com',
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(logged.needsLogin).toBe(false);
    expect(logged.showLoginHero).toBe(false);
    expect(logged.showImplicitNative).toBe(true);
    expect(logged.showSaveLoggedIn).toBe(true);
    expect(logged.showAddAnotherLogin).toBe(true);
    expect(logged.loginCta).toBe(LOGIN_CTA_SWITCH);
    expect(logged.showActiveEmUsoPill).toBe(true);
    expect(logged.showReservaEmpty).toBe(false);
    expect(logged.showReserva).toBe(false);
  });

  it('com vault ativo separa em uso e reserva', () => {
    const logged = accountsPanelView({
      authState: 'ok',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 2,
      standbyCount: 1,
      hasActiveVault: true,
      liveEmail: 'dev@example.com',
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(logged.showSplitRoster).toBe(true);
    expect(logged.showFlatSavedRoster).toBe(false);
    expect(logged.showImplicitNative).toBe(false);
    expect(logged.showMultiChip).toBe(true);
  });

  it('logado sem conta ativa mostra a sessão nativa e a reserva', () => {
    const logged = accountsPanelView({
      authState: 'ok',
      adapterLabel: 'Claude',
      isClaude: true,
      vaultCount: 1,
      standbyCount: 1,
      hasActiveVault: false,
      liveEmail: 'dev@example.com',
      loginCommand: 'claude auth login',
      canSnapshot: true,
      busy: false,
    });
    expect(logged.showImplicitNative).toBe(true);
    expect(logged.showSplitRoster).toBe(false);
    expect(logged.showReserva).toBe(true);
    expect(logged.showActiveEmUsoPill).toBe(true);
  });
});

describe('accountsPanelView — cadastrar conta não depende de quantas já existem', () => {
  it('oferece o cadastro com 0, 1, 2 e 7 contas salvas', () => {
    for (const vaultCount of [0, 1, 2, 7]) {
      expect(view({ vaultCount, hasActiveVault: vaultCount > 0 }).showAddAnotherLogin)
        .toBe(true);
    }
  });

  it('oferece o cadastro enquanto a sonda ainda verifica — não é beco sem saída', () => {
    expect(view({ authState: 'checking' }).showAddAnotherLogin).toBe(true);
  });

  it('não duplica o botão quando o herói já oferece exatamente este login', () => {
    for (const authState of ['missing', 'unknown']) {
      const panel = view({ authState });
      expect(panel.showLoginHero).toBe(true);
      expect(panel.showAddAnotherLogin).toBe(false);
    }
  });

  it('CLI sem comando de login não finge um caminho de login', () => {
    const panel = view({ loginCommand: null });
    expect(panel.showAddAnotherLogin).toBe(false);
    expect(panel.loginCta).toBeNull();
  });

  it('diz a verdade sobre snapshot: sem ele, o login TROCA a sessão', () => {
    expect(view({ canSnapshot: true }).addAccountHint).toMatch(
      /guarda a conta atual antes da troca/i,
    );
    const semSnapshot = view({ canSnapshot: false }).addAccountHint;
    expect(semSnapshot).toMatch(/troca a sessão da ferramenta/i);
    expect(semSnapshot).toMatch(/API key/);
    expect(semSnapshot).not.toMatch(/isolad/i);
  });
});
