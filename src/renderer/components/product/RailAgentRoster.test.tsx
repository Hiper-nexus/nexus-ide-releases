/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel, PaneSessionState } from '../../../shared/types';
import { groupRosterFleets } from '../../lib/agent-roster';
import { RailAgentRoster, type RailAgentRosterProps } from './RailAgentRoster';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function agent(patch: Partial<PaneModel> & { id: string }): PaneModel {
  return { kind: 'cli-agent', title: '', adapterId: 'claude', ...patch };
}

const PANES: PaneModel[] = [
  agent({
    id: 'orq',
    role: 'orchestrator',
    agentName: 'Maestro',
    model: 'claude-opus-4-1',
    paneNumber: 1,
    title: 'Claude · Coordenar a entrega',
  }),
  agent({
    id: 'fe',
    agentName: 'Frontend',
    adapterId: 'codex',
    model: 'gpt-5.6-luna-medium',
    paneNumber: 2,
    title: 'GPT · Corrigir histórico omitido ao mudar de aba',
  }),
  agent({
    id: 'be',
    adapterId: 'grok',
    paneNumber: 3,
    title: 'Grok · t-7bcf00cf9aa6faa9c4b738fc',
  }),
];

function fleetFor(states: Record<string, PaneSessionState>) {
  return groupRosterFleets(PANES, {}, { states: new Map(Object.entries(states)) })
    .all;
}

function render(
  states: Record<string, PaneSessionState>,
  patch: Partial<RailAgentRosterProps> = {},
) {
  const props: RailAgentRosterProps = {
    fleet: fleetFor(states),
    scopeLabel: 'nesta missão',
    expanded: false,
    onToggle: vi.fn(),
    onFocusAgent: vi.fn(),
    adapterMeta: new Map([
      ['claude', { label: 'Claude', icon: '◆' }],
      ['codex', { label: 'Codex', icon: '◇' }],
    ]),
    ...patch,
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(<RailAgentRoster {...props} />));
  return { host, props };
}

const rows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('.workspace-rail__agent-item')];

describe('RailAgentRoster', () => {
  it('diz "N trabalhando agora" na linha do bloco, sem precisar abrir nada', () => {
    const { host } = render({ orq: 'busy', fe: 'busy', be: 'idle' });

    const toggle = host.querySelector('.workspace-rail__agents-toggle')!;
    expect(toggle.textContent).toContain('2 trabalhando agora');
    expect(toggle.textContent).toContain('3 agentes');
    expect(toggle.getAttribute('aria-label')).toBe(
      '3 agentes nesta missão, 2 trabalhando agora, em paralelo',
    );
    expect(host.querySelector('.workspace-rail__agents-block')!.hasAttribute('data-working')).toBe(
      true,
    );
  });

  it('o nome acessível do botão contém todo o texto que ele mostra (rótulo no nome)', () => {
    // O aria-label substitui o texto visível: quem comanda por voz "Terminais"
    // ou "em paralelo" precisa achar essas palavras no nome.
    const withHeading = render(
      { orq: 'busy', fe: 'busy', be: 'idle' },
      { heading: 'Terminais', scopeLabel: 'nos terminais' },
    ).host;
    const toggle = withHeading.querySelector('.workspace-rail__agents-toggle')!;
    const label = toggle.getAttribute('aria-label')!;
    expect(label).toBe('Terminais: 3 agentes, 2 trabalhando agora, em paralelo');
    for (const visible of ['Terminais', '2 trabalhando agora', 'em paralelo', '3 agentes']) {
      expect(toggle.textContent, visible).toContain(visible);
      expect(label, visible).toContain(visible);
    }

    const idle = render({ orq: 'idle', fe: 'idle', be: 'idle' }).host;
    expect(
      idle.querySelector('.workspace-rail__agents-toggle')!.getAttribute('aria-label'),
    ).toBe('3 agentes nesta missão, aguardando');
  });

  it('marca "em paralelo" só a partir de dois trabalhando', () => {
    const two = render({ orq: 'busy', fe: 'busy', be: 'idle' }).host;
    expect(two.querySelector('.workspace-rail__live-tag')?.textContent).toBe('em paralelo');
    expect(
      two.querySelector('.workspace-rail__agents-block')!.hasAttribute('data-parallel'),
    ).toBe(true);

    const one = render({ orq: 'busy', fe: 'idle', be: 'idle' }).host;
    expect(one.querySelector('.workspace-rail__live-tag')).toBeNull();
    expect(
      one.querySelector('.workspace-rail__agents-block')!.hasAttribute('data-parallel'),
    ).toBe(false);
    expect(one.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
      '1 trabalhando agora',
    );
  });

  it('recolhido, os agentes que trabalham continuam à vista e os parados saem', () => {
    const { host } = render({ orq: 'busy', fe: 'idle', be: 'exited' }, { expanded: false });

    expect(rows(host).map((row) => row.dataset.paneId)).toEqual(['orq']);
    expect(rows(host)[0]!.dataset.agentState).toBe('working');
  });

  it('aberto, lista todos na ordem do layout e deixa os parados em tom secundário', () => {
    const { host } = render({ orq: 'busy', fe: 'idle', be: 'exited' }, { expanded: true });

    expect(rows(host).map((row) => row.dataset.paneId)).toEqual(['orq', 'fe', 'be']);
    expect(rows(host).map((row) => row.dataset.agentState)).toEqual([
      'working',
      'waiting',
      'stopped',
    ]);
    expect(host.querySelectorAll('[data-agent-state="working"]')).toHaveLength(1);
  });

  it('cada linha diz quem é, a CLI com o modelo, o estado em palavra e a tarefa', () => {
    const { host } = render({ orq: 'busy', fe: 'busy', be: 'idle' }, { expanded: true });
    const frontend = rows(host)[1]!;

    expect(frontend.querySelector('.workspace-rail__agent-name')!.textContent).toBe('Frontend');
    expect(frontend.querySelector('.workspace-rail__agent-adapter')!.textContent).toBe(
      'GPT 5.6 Luna',
    );
    expect(frontend.querySelector('.workspace-rail__agent-state')!.textContent).toBe('Trabalhando');
    expect(frontend.querySelector('.workspace-rail__agent-task')!.textContent).toBe(
      'Corrigir histórico omitido ao mudar de aba',
    );
    expect(
      frontend.querySelector('.workspace-rail__agent-btn')!.getAttribute('aria-label'),
    ).toBe(
      'Frontend, GPT 5.6 Luna · Medium. Trabalhando. Corrigir histórico omitido ao mudar de aba',
    );
  });

  it('o nome do orquestrador leva a coroa e o do worker sem nome vira "Pane N"', () => {
    const { host } = render({ orq: 'busy', fe: 'idle', be: 'idle' }, { expanded: true });

    expect(rows(host)[0]!.querySelector('.workspace-rail__agent-crown')).not.toBeNull();
    expect(rows(host)[1]!.querySelector('.workspace-rail__agent-crown')).toBeNull();
    expect(rows(host)[2]!.querySelector('.workspace-rail__agent-name')!.textContent).toBe('Pane 3');
  });

  it('não mostra id técnico no lugar da tarefa (pasta da worktree do Codex/Grok)', () => {
    const { host } = render({ orq: 'busy', fe: 'busy', be: 'busy' }, { expanded: true });
    const pane3 = rows(host)[2]!;

    expect(pane3.querySelector('.workspace-rail__agent-task')).toBeNull();
    expect(host.textContent).not.toContain('t-7bcf00cf');
  });

  it('logo da LLM com o rótulo do adapter', () => {
    const { host } = render({ orq: 'busy', fe: 'idle', be: 'idle' }, { expanded: true });

    expect(rows(host)[0]!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'Logo Claude',
    );
    // Adapter sem metadado cai no id.
    expect(rows(host)[2]!.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'Logo grok',
    );
  });

  it('sem ninguém trabalhando, a linha diz por quê em vez de "0 trabalhando"', () => {
    const waiting = render({ orq: 'idle', fe: 'idle', be: 'idle' }).host;
    expect(waiting.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
      '3 agentes · aguardando',
    );
    expect(waiting.querySelector('.workspace-rail__live-dot')).toBeNull();
    expect(waiting.querySelector('.workspace-rail__agents-block')!.hasAttribute('data-working')).toBe(
      false,
    );
    expect(waiting.querySelector('.workspace-rail__agents-list')).toBeNull();

    const stopped = render({ orq: 'exited', fe: 'hibernated', be: 'exited' }).host;
    expect(stopped.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
      '3 agentes · parados',
    );
  });

  it('o recolher usa aria-expanded e avisa o chamador sem acionar a linha da missão', () => {
    const onToggle = vi.fn();
    const outer = vi.fn();
    const { host } = render({ orq: 'busy', fe: 'idle', be: 'idle' }, { onToggle });
    // O React escuta no contêiner da raiz; quem prova que o clique não subiu é
    // um ouvinte acima dele.
    document.body.addEventListener('click', outer);
    const toggle = host.querySelector<HTMLButtonElement>('.workspace-rail__agents-toggle')!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    document.body.removeEventListener('click', outer);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('clicar numa linha foca aquele pane e não borbulha', () => {
    const onFocusAgent = vi.fn();
    const outer = vi.fn();
    const { host } = render(
      { orq: 'busy', fe: 'busy', be: 'idle' },
      { expanded: true, onFocusAgent },
    );
    document.body.addEventListener('click', outer);

    act(() => rows(host)[1]!.querySelector<HTMLButtonElement>('button')!.click());
    document.body.removeEventListener('click', outer);

    expect(onFocusAgent).toHaveBeenCalledWith('fe');
    expect(outer).not.toHaveBeenCalled();
  });

  it('o tooltip da linha reúne nome, CLI, estado, tarefa e o número do pane', () => {
    const { host } = render({ orq: 'busy', fe: 'busy', be: 'idle' }, { expanded: true });

    expect(rows(host)[1]!.querySelector('button')!.title).toBe(
      [
        'Focar Frontend',
        'GPT 5.6 Luna · Medium',
        'Trabalhando · Corrigir histórico omitido ao mudar de aba',
        'Pane 2',
      ].join('\n'),
    );
  });

  it('frota vazia não desenha nada', () => {
    const { host } = render({}, { fleet: groupRosterFleets([], {}, { states: new Map() }).all });
    expect(host.querySelector('.workspace-rail__agents-block')).toBeNull();
  });
});
