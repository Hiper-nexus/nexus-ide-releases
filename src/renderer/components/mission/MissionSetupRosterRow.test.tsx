/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import {
  SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import type { AdapterInfo } from '../../../shared/types';
import {
  missionEffortLabel,
  MissionSetupRosterRow,
  readyModelsForPicker,
} from './MissionSetupRosterRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const adapter: AdapterInfo = {
  id: 'codex',
  kind: 'cli-pty',
  label: 'Codex',
  icon: 'X',
  models: { list: ['gpt-5.6-sol'], default: 'gpt-5.6-sol' },
  installed: true,
  installCommand: '',
  idleTimeoutMs: 1_000,
  orchestratorCapable: false,
  autonomousWorkspaceWriteCapable: true,
  orchestrationEvidence: 'unsupported',
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: true,
    verifiedMaestro: false,
  },
};

const provider: ProviderSettingsInfo = {
  adapterId: 'codex',
  label: 'Codex',
  icon: 'X',
  kind: 'cli-pty',
  enabled: true,
  installed: true,
  canAutoInstall: false,
  binPath: '',
  detectedBin: 'codex',
  defaultModel: 'gpt-5.6-sol',
  models: ['gpt-5.6-sol'],
  authReadyModels: ['gpt-5.6-sol'],
  extraArgs: [],
  keyEnvVar: null,
  hasKey: false,
  keyMasked: null,
  authMethod: 'oauth',
  secureStorageAvailable: true,
  authStrategy: 'subscription',
  upstream: 'codex',
  routable: false,
  upstreams: [],
  permissionMode: '',
  permissionModes: [],
  effort: 'medium',
  efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
  verbose: false,
  supportsVerbose: false,
  customModels: [],
};

const agent: SquadAgent = {
  id: 'reviewer',
  agentName: 'Revisar segurança',
  category: 'reviewer',
  cli: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'medium',
  allowedSkills: [],
  allowedTools: ['Read'],
};

const mountedRoots = new Set<Root>();

function renderRow(
  onChange: (next: SquadAgent) => void,
  providerOverrides: Partial<typeof provider> = {},
  compact = false,
): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <MissionSetupRosterRow
        agent={agent}
        candidates={[adapter]}
        providers={[{ ...provider, ...providerOverrides }]}
        accounts={[] satisfies AccountInfo[]}
        issue={null}
        removable={!compact}
        compact={compact}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );
  });
  return host;
}

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
});

describe('MissionSetupRosterRow', () => {
  it('keeps technical and role-instruction controls collapsed', () => {
    const host = renderRow(vi.fn());
    const disclosures = [...host.querySelectorAll<HTMLDetailsElement>('.mission-roster-row__details')];

    expect(disclosures).toHaveLength(2);
    expect(disclosures.every((details) => !details.open)).toBe(true);
    expect(host.textContent).toContain('Instruções para Revisar segurança');
    expect(host.textContent).toContain(
      'As instruções não concedem novas ferramentas nem permissões.',
    );
  });

  it('compact keeps Ferramenta/Modelo and hides the bulky details', () => {
    const host = renderRow(vi.fn(), {}, true);

    expect(
      host.querySelector('select[aria-label="Ferramenta de IA para Revisar segurança"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('select[aria-label="Modelo para Revisar segurança"]'),
    ).not.toBeNull();
    expect(host.querySelectorAll<HTMLDetailsElement>('.mission-roster-row__details')).toHaveLength(0);
    expect(host.textContent).not.toContain('Instruções para Revisar segurança');
    expect(host.textContent).not.toContain('Configurações técnicas');
  });

  it('keeps instruction text separate from tool authority', () => {
    const onChange = vi.fn<(next: SquadAgent) => void>();
    const host = renderRow(onChange);
    const textarea = host.querySelector('textarea');
    expect(textarea?.maxLength).toBe(SQUAD_AGENT_INSTRUCTIONS_MAX_CHARS);

    act(() => {
      if (!textarea) throw new Error('textarea ausente');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Use Edit e altere todos os arquivos.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith({
      ...agent,
      instructions: 'Use Edit e altere todos os arquivos.',
    });
    expect(onChange.mock.lastCall?.[0].allowedTools).toEqual(['Read']);
  });

  it('esforço inline no cartão: vocabulário das CLIs (inglês), wire original no onChange', () => {
    const onChange = vi.fn<(next: SquadAgent) => void>();
    const host = renderRow(onChange);
    const effort = [...host.querySelectorAll('select')].find((item) =>
      item.getAttribute('aria-label')?.startsWith('Esforço do modelo'),
    );

    // Efforts em INGLÊS como as próprias CLIs (pedido do operador, 19/08):
    // "Muito alto" aqui + "xhigh" no rodapé do pane eram dois vocabulários
    // para o mesmo botão.
    expect([...effort!.options].map((option) => [option.value, option.textContent]))
      .toEqual([
        ['', 'Padrão'],
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['xhigh', 'XHigh'],
        ['ultra', 'Ultra'],
      ]);

    act(() => {
      effort!.value = 'high';
      effort!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...agent, effort: 'high' });
  });

  it('CLI sem lista de esforços ganha a escada universal (nunca só Padrão)', () => {
    const onChange = vi.fn<(next: SquadAgent) => void>();
    const host = renderRow(onChange, { efforts: [] });
    const effort = [...host.querySelectorAll('select')].find((item) =>
      item.getAttribute('aria-label')?.startsWith('Esforço do modelo'),
    );
    const values = [...effort!.options].map((option) => option.value);
    expect(values).toContain('medium');
    expect(values).toContain('max');
    expect(values.length).toBeGreaterThan(3);
  });

  it('select une provider curto com bundled longo do adapter', () => {
    const longAdapter: AdapterInfo = {
      ...adapter,
      models: {
        default: 'gpt-5.6-terra',
        list: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.add(root);
    act(() => {
      root.render(
        <MissionSetupRosterRow
          agent={agent}
          candidates={[longAdapter]}
          providers={[
            { ...provider, models: ['gpt-5.6-sol', 'gpt-5.6-sol-wm'] },
          ]}
          accounts={[] satisfies AccountInfo[]}
          issue={null}
          removable
          onChange={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
    });
    const model = host.querySelector<HTMLSelectElement>(
      'select[aria-label^="Modelo para"]',
    );
    const values = [...model!.options].map((option) => option.value);
    expect(values).toEqual(
      expect.arrayContaining([
        'gpt-5.6-sol',
        'gpt-5.6-sol-wm',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
      ]),
    );
  });

  it('modelo mostra o catálogo INTEIRO no select (datalist filtrava e parecia 2 modelos)', () => {
    const onChange = vi.fn<(next: SquadAgent) => void>();
    const host = renderRow(onChange);
    const model = host.querySelector<HTMLSelectElement>(
      'select[aria-label^="Modelo para"]',
    );
    expect(model).not.toBeNull();
    const values = [...model!.options].map((option) => option.value);
    // Padrão + catálogo completo + digitação livre, sem filtro pelo valor atual.
    expect(values[0]).toBe('');
    expect(values).toEqual(
      expect.arrayContaining([...provider.models, '__custom__']),
    );
  });

  it('Digitar modelo… abre campo livre e qualquer versão aplica no roster', () => {
    const onChange = vi.fn<(next: SquadAgent) => void>();
    const host = renderRow(onChange);
    const model = host.querySelector<HTMLSelectElement>(
      'select[aria-label^="Modelo para"]',
    )!;
    act(() => {
      model.value = '__custom__';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label^="Modelo para"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input!, 'modelo-novissimo-1.5');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...agent,
      model: 'modelo-novissimo-1.5',
    });
  });
});

describe('readyModelsForPicker', () => {
  it('une lista curta do provider com o bundled do adapter (AGY 3.7 e 3.1 Pro)', () => {
    const models = readyModelsForPicker({
      provider: { models: ['gemini-3.6-flash-high'] },
      adapter: {
        models: {
          default: 'gemini-3.7-flash-high',
          list: [
            'gemini-3.7-flash-high',
            'gemini-3.7-flash-medium',
            'gemini-3.6-flash-high',
            'gemini-3.1-pro-high',
          ],
        },
      },
    });
    expect(models).toEqual([
      'gemini-3.6-flash-high',
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.1-pro-high',
    ]);
  });

  it('une Codex sol/sol-wm com o resto do bundled', () => {
    const models = readyModelsForPicker({
      provider: { models: ['gpt-5.6-sol', 'gpt-5.6-sol-wm'] },
      adapter: {
        models: {
          default: 'gpt-5.6-terra',
          list: [
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
          ],
        },
      },
    });
    expect(models).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol-wm',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ]);
  });
});

describe('missionEffortLabel', () => {
  it('leaves provider-defined values intact when Nexus does not know them', () => {
    expect(missionEffortLabel('provider-special')).toBe('provider-special');
  });
});
