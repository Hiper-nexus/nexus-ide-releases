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
    const disclosures = [...host.querySelectorAll('details')];

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
    expect(host.querySelectorAll('details')).toHaveLength(0);
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
        list: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
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
  it('une lista curta do provider com o bundled do adapter, mais forte primeiro (AGY)', () => {
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
    // Mesma régua do "+ Pane": Pro acima dos Flash, depois geração e esforço.
    expect(models).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.7-flash-high',
      'gemini-3.6-flash-high',
      'gemini-3.7-flash-medium',
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
          ],
        },
      },
    });
    expect(models).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol-wm',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });
});

describe('missionEffortLabel', () => {
  it('leaves provider-defined values intact when Nexus does not know them', () => {
    expect(missionEffortLabel('provider-special')).toBe('provider-special');
  });
});

describe('MissionSetupRosterRow: cartão do papel na Equipe', () => {
  function renderCard(options: {
    removable: boolean;
    issue?: string | null;
    onRemove?: () => void;
  }): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mountedRoots.add(root);
    act(() => {
      root.render(
        <MissionSetupRosterRow
          agent={agent}
          candidates={[adapter]}
          providers={[provider]}
          accounts={[] satisfies AccountInfo[]}
          issue={options.issue ?? null}
          removable={options.removable}
          onChange={vi.fn()}
          onRemove={options.onRemove ?? vi.fn()}
        />,
      );
    });
    return host;
  }

  it('remover é um botão de ícone: nome acessível, dica no hover e nenhum texto visível', () => {
    const onRemove = vi.fn();
    const host = renderCard({ removable: true, onRemove });
    const remove = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Remover Revisar segurança"]',
    );

    expect(remove).not.toBeNull();
    expect(remove!.textContent).toBe('');
    expect(remove!.querySelector('svg')).not.toBeNull();
    expect(remove!.title).toBe('Remover Revisar segurança');

    act(() => remove!.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('sem removable não há botão: a coordenação única não sai da equipe', () => {
    const host = renderCard({ removable: false });

    expect(host.querySelector('.mission-roster-row__remove')).toBeNull();
    expect(host.querySelector('button[aria-label^="Remover"]')).toBeNull();
  });

  it('a ordem de foco segue a leitura: Ferramenta, Modelo, Esforço, Remover e só então os detalhes', () => {
    const host = renderCard({ removable: true });
    const order = [...host.querySelectorAll('select, button, summary')].map(
      (element) => element.getAttribute('aria-label') ?? element.textContent,
    );

    expect(order).toEqual([
      'Ferramenta de IA para Revisar segurança',
      'Modelo para Revisar segurança',
      'Esforço do modelo para Revisar segurança',
      'Remover Revisar segurança',
      'Instruções para Revisar segurança',
      'Configurações técnicas de Revisar segurança',
    ]);
  });

  it('o estado fica no cabeçalho do cartão: Pronto sem problema, Precisa de ajuste com o motivo', () => {
    const ready = renderCard({ removable: true });
    const readyRow = ready.querySelector('.mission-roster-row')!;
    expect(readyRow.getAttribute('data-state')).toBe('ready');
    expect(readyRow.querySelector('.mission-roster-row__summary .mission-roster-row__status')?.textContent)
      .toBe('Pronto');

    const blocked = renderCard({
      removable: true,
      issue: 'Ferramenta desligada nas configurações.',
    });
    const blockedRow = blocked.querySelector('.mission-roster-row')!;
    expect(blockedRow.getAttribute('data-state')).toBe('needs-attention');
    expect(blockedRow.querySelector('.mission-roster-row__status')?.textContent)
      .toBe('Precisa de ajuste');
    expect(blockedRow.querySelector('[role="status"].mission-setup__inline-error')?.textContent)
      .toBe('Ferramenta desligada nas configurações.');
  });

  it('o motivo do problema descreve o select de Ferramenta; sem problema não há descrição', () => {
    const ready = renderCard({ removable: true });
    expect(
      ready.querySelector('select[aria-label^="Ferramenta"]')?.hasAttribute('aria-describedby'),
    ).toBe(false);

    const blocked = renderCard({
      removable: true,
      issue: 'Ferramenta desligada nas configurações. Religue ou troque a ferramenta.',
    });
    const tool = blocked.querySelector('select[aria-label^="Ferramenta"]')!;
    const reason = blocked.querySelector('.mission-setup__inline-error')!;
    expect(reason.id).not.toBe('');
    expect(tool.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('a opção de digitar outro modelo é texto claro, sem emoji como ícone', () => {
    const host = renderCard({ removable: true });
    const model = host.querySelector<HTMLSelectElement>('select[aria-label^="Modelo para"]')!;
    const custom = [...model.options].find((option) => option.value === '__custom__');

    expect(custom?.textContent).toBe('Digitar outro modelo…');
    expect(
      [...model.options].some((option) => /\p{Extended_Pictographic}/u.test(option.textContent ?? '')),
    ).toBe(false);
  });

  it('Instruções e Configurações técnicas ficam juntas, recolhidas, num bloco abaixo dos controles', () => {
    const host = renderCard({ removable: true });
    const more = host.querySelector('.mission-roster-row__more');
    const controls = host.querySelector('.mission-roster-row__controls');

    expect(more).not.toBeNull();
    expect([...more!.children].map((child) => child.tagName)).toEqual(['DETAILS', 'DETAILS']);
    expect([...more!.querySelectorAll('details')].every((details) => !details.open)).toBe(true);
    expect(
      controls!.compareDocumentPosition(more!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
