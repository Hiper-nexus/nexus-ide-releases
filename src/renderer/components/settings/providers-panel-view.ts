import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';

/** Top-level Providers hub tabs (ADE libre hierarchy). */
export type ProvidersHubTab = 'clis' | 'login' | 'remote';

export const PROVIDERS_HUB_TABS: readonly ProvidersHubTab[] = [
  'clis',
  'login',
  'remote',
] as const;

export function isRemoteProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'api-provider';
}

export function isLocalCliProvider(provider: ProviderSettingsInfo): boolean {
  return provider.kind === 'cli-pty';
}

/**
 * CLIs with a real login path (OAuth/device/subscription or a declared
 * terminal command). API-key-only tools stay on CLIs / Remotos.
 */
export function isExternalLoginProvider(provider: ProviderSettingsInfo): boolean {
  if (!isLocalCliProvider(provider)) return false;
  if (provider.loginCommand) return true;
  if (
    provider.authMethod === 'oauth' ||
    provider.authMethod === 'device_code' ||
    provider.authMethod === 'subscription'
  ) {
    return true;
  }
  return (
    provider.authStrategy === 'subscription' ||
    provider.authStrategy === 'login-needed'
  );
}

export function countDetectedClis(
  providers: readonly ProviderSettingsInfo[],
): number {
  return providers.filter((p) => isLocalCliProvider(p) && p.installed).length;
}

/** Toolbar counter label for the active tab. */
export function tabDetectedLabel(
  tab: ProvidersHubTab,
  providers: readonly ProviderSettingsInfo[],
  visibleCount: number,
): string {
  if (tab === 'remote') {
    return `${visibleCount} remoto${visibleCount === 1 ? '' : 's'}`;
  }
  if (tab === 'login') {
    const n = providers.filter(
      (p) => isExternalLoginProvider(p) && p.installed,
    ).length;
    return `${n} com login detectado${n === 1 ? '' : 's'}`;
  }
  const n = countDetectedClis(providers);
  const catalogSize = providers.filter(isLocalCliProvider).length;
  return `${catalogSize} CLI${catalogSize === 1 ? '' : 's'} no catálogo · ${n} detectada${n === 1 ? '' : 's'}`;
}

export function filterProvidersForTab(
  providers: readonly ProviderSettingsInfo[],
  tab: ProvidersHubTab,
  options: { readonly showAbsent: boolean } = { showAbsent: false },
): ProviderSettingsInfo[] {
  if (tab === 'remote') {
    return providers.filter(isRemoteProvider).sort(compareProvidersForDisplay);
  }
  if (tab === 'login') {
    return providers
      .filter(isExternalLoginProvider)
      .filter((p) => options.showAbsent || p.installed)
      .sort(compareProvidersForDisplay);
  }
  return providers
    .filter(isLocalCliProvider)
    .filter((p) => options.showAbsent || p.installed)
    .sort(compareProvidersForDisplay);
}

function compareProvidersForDisplay(
  a: ProviderSettingsInfo,
  b: ProviderSettingsInfo,
): number {
  if (a.installed !== b.installed) return a.installed ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.label.localeCompare(b.label, 'pt');
}

/**
 * Model readiness chip: ready catalog entries vs listed models.
 * api-only / deprecated count as not ready for auto-routing.
 */
export function modelCountLabel(provider: ProviderSettingsInfo): string {
  const total = Math.max(0, provider.models.length);
  if (total === 0) return '0/0';
  const blocked = provider.models.filter((model) => {
    const availability = provider.modelInfo?.[model]?.availability;
    return availability === 'api-only' || availability === 'deprecated';
  }).length;
  const ready = Math.max(0, total - blocked);
  return `${ready}/${total}`;
}

/**
 * Conta com credencial morta (refresh falhou) num provider que se diz
 * conectado: a linha não pode continuar "conectado".
 */
export interface ProviderAccountHealth {
  readonly needsRelogin?: boolean;
  readonly authState?: 'ok' | 'missing' | 'unknown' | 'checking';
}

export function providerStatusLabel(
  provider: ProviderSettingsInfo,
  health?: ProviderAccountHealth,
): {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'muted' | 'danger';
} {
  if (!provider.installed && isLocalCliProvider(provider)) {
    return { label: 'não instalada', tone: 'warn' };
  }
  if (!provider.enabled) return { label: 'desligada', tone: 'muted' };
  if (provider.authStrategy === 'api-key') {
    if (provider.credentialReadiness === 'invalid-credential') return { label: 'chave inválida', tone: 'danger' };
    if (provider.credentialReadiness === 'no-credential') return { label: 'sem chave', tone: 'warn' };
    if (provider.credentialReadiness === 'unknown') return { label: 'chave não verificada', tone: 'muted' };
  }
  if (health?.authState === 'ok') return { label: 'conectado', tone: 'ok' };
  if (health?.authState === 'unknown') return { label: 'não verificado', tone: 'muted' };
  if (health?.authState === 'checking') return { label: 'verificando…', tone: 'muted' };
  if (health?.authState === 'missing') return { label: 'precisa login', tone: 'warn' };
  if (provider.authStrategy === 'login-needed') {
    return { label: 'precisa login', tone: 'warn' };
  }
  if (health?.needsRelogin) {
    return { label: 'sessão expirada', tone: 'danger' };
  }
  return { label: 'conectado', tone: 'ok' };
}

/**
 * Faixa de estados do detalhe (DESIGN.md §12): instalação, sessão e
 * credencial são fatos distintos — a disponibilidade fica no toggle ao lado.
 */
export interface ProviderStateChip {
  readonly id: 'install' | 'session' | 'credential';
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'muted' | 'danger' | 'live';
}

export function providerStateChips(
  provider: ProviderSettingsInfo,
  health?: ProviderAccountHealth,
): ProviderStateChip[] {
  const chips: ProviderStateChip[] = [];
  if (isLocalCliProvider(provider)) {
    chips.push({
      id: 'install',
      label: provider.installed ? 'instalada' : 'não instalada',
      tone: provider.installed ? 'ok' : 'warn',
    });
  }
  if (
    provider.installed &&
    provider.enabled &&
    (isExternalLoginProvider(provider) || health?.authState !== undefined)
  ) {
    const status = providerStatusLabel(provider, health);
    chips.push({ id: 'session', label: status.label, tone: status.tone });
  }
  if (provider.keyEnvVar || provider.hasKey) {
    chips.push({
      id: 'credential',
      label: provider.authStrategy === 'api-key' && provider.credentialReadiness === 'invalid-credential' ? 'chave inválida' : provider.hasKey ? 'chave configurada' : 'sem chave',
      tone: provider.authStrategy === 'api-key' && provider.credentialReadiness === 'invalid-credential' ? 'danger' : provider.hasKey ? 'ok' : 'warn',
    });
  }
  return chips;
}

export type ProviderRowCta =
  | { readonly kind: 'login'; readonly label: string }
  | { readonly kind: 'verify'; readonly label: string }
  | { readonly kind: 'key'; readonly label: string }
  | { readonly kind: 'install'; readonly label: string };

/** One operator action per row — or none when there is nothing to do. */
export function providerRowCta(
  provider: ProviderSettingsInfo,
  health?: ProviderAccountHealth,
): ProviderRowCta | null {
  if (!provider.installed && isLocalCliProvider(provider)) {
    return provider.canAutoInstall
      ? { kind: 'install', label: 'Instalar' }
      : null;
  }
  if (!provider.enabled) return null;
  if (provider.authStrategy === 'api-key' && provider.credentialReadiness === 'invalid-credential') return { kind: 'key', label: 'Trocar chave' };
  if (health?.authState === 'ok') return null;
  if (health?.authState === 'checking') return null;
  if (health?.authState === 'unknown') return { kind: 'verify', label: 'Verificar sessão' };
  if (health?.authState === 'missing' || provider.authStrategy === 'login-needed') {
    if (provider.loginCommand) return { kind: 'login', label: 'Entrar' };
    if (provider.keyEnvVar) return { kind: 'key', label: 'Colar chave' };
  }
  // Linha "conectada" com sessão morta: o CTA some se depender só do
  // provider — a conta avisa que o re-login é pelo mesmo terminal de login.
  if (health?.needsRelogin && provider.loginCommand) {
    return { kind: 'login', label: 'Entrar novamente' };
  }
  if (
    !isLocalCliProvider(provider) &&
    provider.keyEnvVar &&
    !provider.hasKey
  ) {
    return { kind: 'key', label: 'Colar chave' };
  }
  return null;
}

/** Operação visível no hub de CLIs: login, instalar, atualizar, reexaminar. */
export type ProviderOpKind =
  | 'install'
  | 'update'
  | 'terminal-install'
  | 'login'
  | 'rescan';

export type ProviderOpPhase = 'running' | 'ok' | 'err';

export interface ProviderOpFeedback {
  readonly title: string;
  readonly detail: string;
  readonly rowLabel: string;
  readonly tone: 'live' | 'ok' | 'danger' | 'info';
}

/**
 * Copy operacional para o strip do detalhe e o LED da lista. Sem isso o
 * operador clica "Atualizar CLI" / "Adicionar conta" e a tela não responde
 * (F-598).
 */
export function providerOpFeedback(
  kind: ProviderOpKind,
  phase: ProviderOpPhase,
  label: string,
  error?: string,
  update?: { readonly changed?: boolean; readonly version?: string },
): ProviderOpFeedback {
  const name = label.trim() || 'CLI';
  if (phase === 'running') {
    if (kind === 'install') {
      return {
        title: `Instalando ${name}…`,
        detail: 'Confirme o diálogo do sistema se aparecer. A receita oficial está rodando.',
        rowLabel: 'instalando…',
        tone: 'live',
      };
    }
    if (kind === 'update') {
      return {
        title: `Atualizando ${name}…`,
        detail: 'Confirme o diálogo do sistema se aparecer. A CLI continua nesta tela até terminar.',
        rowLabel: 'atualizando…',
        tone: 'live',
      };
    }
    if (kind === 'terminal-install') {
      return {
        title: `Abrindo o pane de instalação de ${name}…`,
        detail: 'O comando oficial vai para um terminal. Esta tela permanece aberta.',
        rowLabel: 'instalando…',
        tone: 'live',
      };
    }
    if (kind === 'login') {
      return {
        title: `Login de ${name} em andamento…`,
        detail: 'A CLI abre o próprio fluxo (Google etc.). Esta tela avisa quando a sessão for comprovada.',
        rowLabel: 'entrando…',
        tone: 'live',
      };
    }
    return {
      title: 'Reexaminando CLIs no PATH…',
      detail: 'Descoberta de binários, sessão e catálogo de modelos.',
      rowLabel: 'examinando…',
      tone: 'live',
    };
  }
  if (phase === 'ok') {
    if (kind === 'install') {
      return {
        title: `${name} instalada.`,
        detail: 'PATH reexaminado. Já pode logar ou abrir um pane.',
        rowLabel: 'instalada',
        tone: 'ok',
      };
    }
    if (kind === 'update') {
      if (!update?.version?.trim()) {
        return {
          title: `${name}: atualização sem versão verificada.`,
          detail: 'O comando terminou, mas não há prova da versão que o próximo pane usará.',
          rowLabel: 'não verificada',
          tone: 'info',
        };
      }
      if (update?.changed === false) {
        return {
          title: `${name} continua na versão ${update.version}.`,
          detail: 'Nenhuma versão nova foi aplicada à CLI usada pelos panes.',
          rowLabel: 'sem mudança',
          tone: 'info',
        };
      }
      if (update.changed === undefined) {
        return {
          title: `${name} verificada na versão ${update.version}.`,
          detail: 'O comando terminou e a versão em uso foi lida; a versão anterior não estava disponível para comparação.',
          rowLabel: 'verificada',
          tone: 'info',
        };
      }
      return {
        title: `${name} atualizada para ${update.version}.`,
        detail: 'Versão da CLI usada pelos panes verificada após a atualização.',
        rowLabel: 'atualizada',
        tone: 'ok',
      };
    }
    if (kind === 'terminal-install') {
      return {
        title: `Instalação de ${name} no terminal.`,
        detail: `O pane “Instalar ${name}” recebeu o comando. Acompanhe a saída lá; esta tela fica.`,
        rowLabel: 'no terminal',
        tone: 'info',
      };
    }
    if (kind === 'login') {
      return {
        title: `Terminal de login de ${name} aberto.`,
        detail: 'Siga as instruções no pane de login. O Nexus só grava a conta quando a sessão nova for comprovada.',
        rowLabel: 'login aberto',
        tone: 'info',
      };
    }
    return {
      title: 'Catálogo reexaminado.',
      detail: 'Detecção, sessão e modelos foram relidos nesta máquina.',
      rowLabel: 'ok',
      tone: 'ok',
    };
  }
  return {
    title: error?.trim() || `Não concluiu: ${name}.`,
    detail: 'Tente de novo. O diálogo nativo mostra o comando exato quando a receita é automática.',
    rowLabel: 'falhou',
    tone: 'danger',
  };
}

export function pickDefaultSelection(
  providers: readonly ProviderSettingsInfo[],
  preferredId: string | null,
): string | null {
  if (preferredId && providers.some((p) => p.adapterId === preferredId)) {
    return preferredId;
  }
  const firstInstalled = providers.find((p) => p.installed);
  return firstInstalled?.adapterId ?? providers[0]?.adapterId ?? null;
}

/** Safe value for a <select> when models list is empty or stale. */
export function selectModelValue(provider: ProviderSettingsInfo): string {
  if (provider.models.includes(provider.defaultModel)) {
    return provider.defaultModel;
  }
  return provider.models[0] ?? '';
}
