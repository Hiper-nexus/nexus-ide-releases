// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: resolveProviderCompatibility
// de apps/server/src/provider/providerCompatibility.ts sem Effect/Schema e sem o
// eixo t3CodeRange; as faixas são a política mais nova de cada driver em
// model-manifest.json `compatibility[]`, indexadas pelo BINÁRIO da CLI (o
// `claude` também serve glm/deepseek/longcat/muse-claude); mensagens em pt-BR;
// só `broken` e `unsupported` viram aviso, e aviso nunca bloqueia o spawn.
import path from 'node:path';
import { satisfiesSemverRange } from '../../shared/semver-range';
import { claudeModelVersionWarning } from './claude-model-profiles';

export type CliCompatibilityStatus = 'supported' | 'graceful' | 'unsupported' | 'broken' | 'unknown';

interface CliCompatibilityPolicy {
  readonly bin: string;
  readonly label: string;
  readonly recommendedRange: string;
  readonly ranges: readonly { readonly range: string; readonly status: CliCompatibilityStatus }[];
}

export const CLI_COMPATIBILITY_POLICIES: readonly CliCompatibilityPolicy[] = [
  {
    bin: 'codex',
    label: 'Codex',
    recommendedRange: '>=0.159.0',
    ranges: [
      { range: '>=0.156.0', status: 'supported' },
      { range: '>=0.149.0 <0.156.0', status: 'unsupported' },
      { range: '<0.149.0', status: 'broken' },
    ],
  },
  {
    bin: 'claude',
    label: 'Claude Code',
    recommendedRange: '>=2.1.280',
    ranges: [
      { range: '>=2.1.280', status: 'supported' },
      { range: '>=2.1.111 <2.1.280', status: 'graceful' },
      { range: '<2.1.111', status: 'unsupported' },
    ],
  },
  {
    bin: 'grok',
    label: 'Grok',
    recommendedRange: '>=1.0.13',
    ranges: [
      { range: '>=1.0.13', status: 'supported' },
      { range: '<1.0.13', status: 'broken' },
    ],
  },
  {
    bin: 'opencode',
    label: 'OpenCode',
    recommendedRange: '>=2.0.18',
    ranges: [
      { range: '>=2.0.18', status: 'supported' },
      { range: '>=2.0.0 <2.0.18', status: 'unsupported' },
      { range: '>=1.14.19 <2.0.0', status: 'graceful' },
      { range: '<1.14.19', status: 'broken' },
    ],
  },
  {
    bin: 'cursor-agent',
    label: 'Cursor',
    recommendedRange: '>=2026.05.09',
    ranges: [
      { range: '>=2026.05.09', status: 'supported' },
      { range: '<2026.05.09', status: 'unknown' },
    ],
  },
];

/** Comando sem diretório nem extensão do Windows (`/x/claude.exe` → `claude`). */
export function cliCommandName(bin: string): string {
  return path.basename(bin.trim().replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat|com)$/iu, '');
}

/**
 * Versão comparável: o Cursor cola um hash na data e o ACP do Google um
 * prefixo. Fora isso (prerelease, texto livre) a versão fica desconhecida.
 */
export function stableCliVersion(command: string, version: string | null | undefined): string | null {
  const unprefixed = version?.trim().replace(/^v/u, '');
  if (!unprefixed) return null;
  const stable =
    command === 'cursor-agent'
      ? unprefixed.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/u, '$1')
      : command === 'agy'
        ? unprefixed.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/u, '$1')
        : unprefixed;
  return /^\d+\.\d+\.\d+$/u.test(stable) ? stable : null;
}

export interface CliCompatibilityAdvisory {
  readonly status: CliCompatibilityStatus;
  readonly recommendedRange: string;
  /** Texto para o operador; só em `broken` e `unsupported`. */
  readonly message?: string;
}

export function resolveCliCompatibility(
  bin: string,
  version: string | null | undefined,
): CliCompatibilityAdvisory | undefined {
  const command = cliCommandName(bin);
  const policy = CLI_COMPATIBILITY_POLICIES.find((entry) => entry.bin === command);
  if (!policy) return undefined;
  const stable = stableCliVersion(command, version);
  const status = stable
    ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ?? 'unknown')
    : 'unknown';
  const message =
    status === 'broken'
      ? `${policy.label} ${stable} tem incompatibilidade conhecida com o Nexus. ` +
        `Atualize para ${policy.recommendedRange}; o pane abre assim mesmo.`
      : status === 'unsupported'
        ? `${policy.label} ${stable} está fora da faixa suportada. ` +
          `Recomendado: ${policy.recommendedRange}; o pane abre assim mesmo.`
        : undefined;
  return { status, recommendedRange: policy.recommendedRange, ...(message ? { message } : {}) };
}

/**
 * Avisos de versão para o spawn e para o painel de providers: faixa da CLI e,
 * no `claude`, a versão mínima do modelo escolhido. Nunca bloqueia.
 */
export function cliVersionWarnings(input: {
  readonly bin: string;
  readonly version: string | null | undefined;
  readonly model?: string | null;
}): string[] {
  const warnings: string[] = [];
  const compatibility = resolveCliCompatibility(input.bin, input.version)?.message;
  if (compatibility) warnings.push(compatibility);
  if (cliCommandName(input.bin) === 'claude') {
    const model = claudeModelVersionWarning(input.model, input.version);
    if (model) warnings.push(model);
  }
  return warnings;
}
