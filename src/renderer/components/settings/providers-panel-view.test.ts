import { describe, expect, it } from 'vitest';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import {
  countDetectedClis,
  filterProvidersForTab,
  isExternalLoginProvider,
  modelCountLabel,
  pickDefaultSelection,
  providerOpFeedback,
  providerRowCta,
  providerStateChips,
  providerStatusLabel,
  selectModelValue,
  tabDetectedLabel,
} from './providers-panel-view';

function provider(
  partial: Partial<ProviderSettingsInfo> &
    Pick<ProviderSettingsInfo, 'adapterId' | 'label' | 'kind'>,
): ProviderSettingsInfo {
  return {
    icon: '◆',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: partial.adapterId,
    defaultModel: `${partial.adapterId}-default`,
    models: [`${partial.adapterId}-default`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'cli',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'anthropic',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...partial,
  };
}

describe('providers-panel-view', () => {
  const claude = provider({
    adapterId: 'claude',
    label: 'Claude',
    kind: 'cli-pty',
    installed: true,
    canAutoInstall: false,
    models: ['a', 'b', 'c'],
    authStrategy: 'subscription',
  });
  const shellLike = provider({
    adapterId: 'shell',
    label: 'Shell',
    kind: 'cli-pty',
    installed: true,
    canAutoInstall: false,
    authStrategy: 'api-key',
    authMethod: 'cli',
  });
  const missing = provider({
    adapterId: 'kimi',
    label: 'Kimi',
    kind: 'cli-pty',
    installed: false,
    authStrategy: 'login-needed',
  });
  const glm = provider({
    adapterId: 'glm',
    label: 'GLM',
    kind: 'api-provider',
    installed: true,
    canAutoInstall: false,
  });

  it('counts only installed local CLIs', () => {
    expect(countDetectedClis([claude, missing, glm, shellLike])).toBe(2);
  });

  it('does not treat every local CLI as external-login', () => {
    expect(isExternalLoginProvider(claude)).toBe(true);
    expect(isExternalLoginProvider(shellLike)).toBe(false);
    expect(isExternalLoginProvider(glm)).toBe(false);
    expect(
      isExternalLoginProvider(
        provider({
          adapterId: 'codex',
          label: 'Codex',
          kind: 'cli-pty',
          authMethod: 'api_key',
          authStrategy: 'api-key',
          loginCommand: 'codex login',
        }),
      ),
    ).toBe(true);
  });

  it('hides absent CLIs by default and shows them when asked', () => {
    const hidden = filterProvidersForTab([claude, missing, glm], 'clis', {
      showAbsent: false,
    });
    expect(hidden.map((p) => p.adapterId)).toEqual(['claude']);

    const shown = filterProvidersForTab([claude, missing, glm], 'clis', {
      showAbsent: true,
    });
    expect(shown.map((p) => p.adapterId)).toEqual(['claude', 'kimi']);
  });

  it('isolates remote/API providers on their own tab', () => {
    const remotes = filterProvidersForTab([claude, missing, glm], 'remote');
    expect(remotes.map((p) => p.adapterId)).toEqual(['glm']);
  });

  it('login tab only lists subscription/oauth/login-needed CLIs', () => {
    const login = filterProvidersForTab(
      [claude, shellLike, missing, glm],
      'login',
      { showAbsent: true },
    );
    expect(login.map((p) => p.adapterId).sort()).toEqual(['claude', 'kimi']);
  });

  it('formats model readiness, status chips and select value', () => {
    expect(modelCountLabel(claude)).toBe('3/3');
    expect(providerStatusLabel(claude)).toEqual({
      label: 'conectado',
      tone: 'ok',
    });
    expect(providerStatusLabel(missing)).toEqual({
      label: 'não instalada',
      tone: 'warn',
    });
    expect(
      providerStatusLabel({ ...claude, authStrategy: 'login-needed' }),
    ).toEqual({ label: 'precisa login', tone: 'warn' });
    expect(providerStatusLabel({ ...claude, enabled: false })).toEqual({
      label: 'desligada',
      tone: 'muted',
    });
    // defaultModel "claude-default" is not in models ['a','b','c'] → first model
    expect(selectModelValue(claude)).toBe('a');
    expect(
      selectModelValue({
        ...claude,
        defaultModel: 'b',
        models: ['a', 'b'],
      }),
    ).toBe('b');
    expect(selectModelValue({ ...claude, models: [], defaultModel: 'x' })).toBe(
      '',
    );
  });

  it('labels detected counts per tab context', () => {
    const all = [claude, shellLike, missing, glm];
    expect(tabDetectedLabel('clis', all, 2)).toBe(
      '3 CLIs no catálogo · 2 detectadas',
    );
    expect(tabDetectedLabel('login', all, 1)).toBe('1 com login detectado');
    expect(tabDetectedLabel('remote', all, 1)).toBe('1 remoto');
  });

  it('picks a stable default selection preferring installed providers', () => {
    expect(pickDefaultSelection([missing, claude], null)).toBe('claude');
    expect(pickDefaultSelection([missing, claude], 'kimi')).toBe('kimi');
  });

  it('offers one honest CTA per row', () => {
    expect(
      providerRowCta({
        ...claude,
        authStrategy: 'login-needed',
        loginCommand: 'claude auth login',
      }),
    ).toEqual({ kind: 'login', label: 'Entrar' });
    expect(
      providerRowCta({
        ...missing,
        canAutoInstall: true,
      }),
    ).toEqual({ kind: 'install', label: 'Instalar' });
    expect(
      providerRowCta({
        ...glm,
        keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
        hasKey: false,
      }),
    ).toEqual({ kind: 'key', label: 'Colar chave' });
    expect(providerRowCta(claude)).toBeNull();
  });

  it('asks to verify an unknown session before offering another login', () => {
    const cli = { ...claude, authStrategy: 'login-needed' as const, loginCommand: 'claude auth login' };
    expect(providerRowCta(cli, { authState: 'unknown' })).toEqual({
      kind: 'verify', label: 'Verificar sessão',
    });
    expect(providerRowCta(cli, { authState: 'checking' })).toBeNull();
  });

  it('separa instalação, sessão e credencial em chips de estado distintos', () => {
    // CLI ausente: só o fato de instalação — sessão/credencial não se aplicam.
    expect(providerStateChips(missing)).toEqual([
      { id: 'install', label: 'não instalada', tone: 'warn' },
    ]);
    // CLI instalada e ligada com login declarado: sessão vem do probe/conta.
    const chips = providerStateChips(claude, { authState: 'ok' });
    expect(chips).toContainEqual({
      id: 'install',
      label: 'instalada',
      tone: 'ok',
    });
    expect(chips).toContainEqual({
      id: 'session',
      label: 'conectado',
      tone: 'ok',
    });
    // Credencial só aparece quando o provider usa key de API.
    const keyed = providerStateChips(
      { ...glm, keyEnvVar: 'GLM_API_KEY', hasKey: false },
      { authState: 'unknown' },
    );
    expect(keyed).toContainEqual({
      id: 'credential',
      label: 'sem chave',
      tone: 'warn',
    });
    expect(
      providerStateChips({ ...glm, keyEnvVar: 'GLM_API_KEY', hasKey: true }),
    ).toContainEqual({ id: 'credential', label: 'chave configurada', tone: 'ok' });
    // Desligada não mente sessão: sem chip de sessão mesmo com probe ok.
    expect(
      providerStateChips({ ...claude, enabled: false }, { authState: 'ok' }),
    ).toEqual([{ id: 'install', label: 'instalada', tone: 'ok' }]);
  });

  it('linha conectada com sessão morta pede re-login, não finge saúde', () => {
    const connected = { ...claude, loginCommand: 'claude auth login' };
    expect(providerRowCta(connected)).toBeNull();
    expect(providerRowCta(connected, { needsRelogin: true })).toEqual({
      kind: 'login',
      label: 'Entrar novamente',
    });
    // Sem comando de login não há para onde levar: sem CTA.
    expect(
      providerRowCta(claude, { needsRelogin: true }),
    ).toBeNull();
    expect(providerStatusLabel(connected, { needsRelogin: true })).toEqual({
      label: 'sessão expirada',
      tone: 'danger',
    });
    expect(providerStatusLabel(connected)).toEqual({
      label: 'conectado',
      tone: 'ok',
    });
  });
});

describe('providerOpFeedback — F-598', () => {
  it('diz o que está acontecendo enquanto a receita roda', () => {
    expect(providerOpFeedback('update', 'running', 'Antigravity (agy)')).toEqual({
      title: 'Atualizando Antigravity (agy)…',
      detail: 'Confirme o diálogo do sistema se aparecer. A CLI continua nesta tela até terminar.',
      rowLabel: 'atualizando…',
      tone: 'live',
    });
    expect(providerOpFeedback('login', 'running', 'Kimi').rowLabel).toBe('entrando…');
  });

  it('confirma sucesso sem fingir que o terminal já acabou o login', () => {
    const login = providerOpFeedback('login', 'ok', 'Kimi');
    expect(login.tone).toBe('info');
    expect(login.title).toContain('aberto');
    expect(providerOpFeedback('update', 'ok', 'Codex').tone).toBe('ok');
  });

  it('expõe o erro cru quando a receita falha', () => {
    const failed = providerOpFeedback('install', 'err', 'Muse', 'instalação cancelada');
    expect(failed.tone).toBe('danger');
    expect(failed.title).toBe('instalação cancelada');
  });
});
