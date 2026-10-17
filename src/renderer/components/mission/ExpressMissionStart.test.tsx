/** @vitest-environment jsdom */
// Início (Expresso): atalho de enviar, validação no campo, anexos visíveis,
// exemplos com "Desfazer" e a ação ancorada no dock. O Tiptap é o real.
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterInfo } from '../../../shared/types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { DEFAULT_ORCH_SETTINGS } from '../../../shared/settings-types';
import { suggestMissionLaneFromGoal } from '../../../shared/mission-intent';
import {
  beginPendingAttachment,
  failPendingAttachment,
  finishPendingAttachment,
  useMissionAttachmentPresentation,
} from '../../state/mission-attachment-presentation';
import {
  createEmptyMissionSetupDraft,
  type MissionSetupDraft,
} from '../../state/mission-setup-store';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import { formatShortcut } from '../../lib/platform';
import { ExpressMissionStart } from './ExpressMissionStart';
import { buildRecommendedMissionRoster, type MissionTeamInventory } from './TeamStep';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = { path: '/projects/confeitaria', name: 'confeitaria', lastOpenedAt: 1 };

function adapter(id: string, label: string): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label,
    icon: label[0]!,
    models: { list: ['m1'], default: 'm1' },
    installed: true,
    installCommand: '',
    idleTimeoutMs: 1_000,
    orchestratorCapable: id === 'claude',
    taskHandoffCapable: true,
    missionControlCapable: true,
    autonomousWorkspaceWriteCapable: true,
    orchestrationEvidence: id === 'claude' ? 'verified' : 'unsupported',
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: true,
      verifiedMaestro: id === 'claude',
    },
  } as AdapterInfo;
}

function provider(item: AdapterInfo): ProviderSettingsInfo {
  return {
    adapterId: item.id,
    label: item.label,
    icon: item.icon,
    kind: item.kind,
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: item.id,
    defaultModel: item.models.default,
    models: [...item.models.list],
    authReadyModels: [...item.models.list],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: item.id,
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  } as ProviderSettingsInfo;
}

const CLAUDE = adapter('claude', 'Claude');
const CODEX = adapter('codex', 'Codex');
const PROVIDERS = [provider(CLAUDE), provider(CODEX)];
const SETTINGS = {
  ...DEFAULT_ORCH_SETTINGS,
  defaultAdapterId: 'claude',
  defaultModel: 'm1',
  squadCliPolicy: 'operator-choice',
} as typeof DEFAULT_ORCH_SETTINGS;

function inventory(ready = true): MissionTeamInventory {
  return {
    status: 'ready',
    adapters: ready ? [CLAUDE, CODEX] : [],
    providers: ready ? PROVIDERS : [],
    accounts: [],
    settings: SETTINGS,
    readiness: missionRuntimeReadiness(ready ? [CLAUDE, CODEX] : [], ready ? PROVIDERS : []),
    error: null,
  };
}

const roots: Root[] = [];
const geometry = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  // O Tiptap real roda no jsdom; ele só não tem geometria.
  for (const [name, value] of [
    ['getClientRects', () => []],
    ['getBoundingClientRect', () => new DOMRect()],
  ] as const) {
    geometry.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  useMissionAttachmentPresentation.setState({
    presentation: new Map(),
    pending: [],
  });
  for (const [name, descriptor] of geometry) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  geometry.clear();
});

type Props = ComponentProps<typeof ExpressMissionStart>;

interface HostOptions {
  draft?: Partial<MissionSetupDraft>;
  props?: Partial<Props>;
  onStart?: () => void;
  ready?: boolean;
}

function Host({ draft: initial, props, onStart, ready = true }: HostOptions) {
  const inv = inventory(ready);
  const [draft, setDraft] = useState<MissionSetupDraft>(() => ({
    ...createEmptyMissionSetupDraft(),
    roster:
      buildRecommendedMissionRoster({
        objective: 'x',
        lane: 'standard',
        readiness: inv.readiness,
        providers: inv.providers,
        accounts: inv.accounts,
        settings: inv.settings,
      }) ?? [],
    ...initial,
  }));
  return (
    <ExpressMissionStart
      workspace={WORKSPACE}
      draft={draft}
      draftFieldsDisabled={false}
      suppressHeadingAutofocus={false}
      pickingWorkspace={false}
      workspaceActionError={null}
      inventoryReady={ready}
      inventoryLoading={false}
      busy={false}
      error={null}
      directAnswer={null}
      onDismissDirectAnswer={() => undefined}
      onStartMissionAnyway={() => undefined}
      onPickWorkspace={() => undefined}
      onObjectiveChange={(objective) => setDraft((current) => ({ ...current, objective }))}
      onAcceptanceChange={(acceptance) => setDraft((current) => ({ ...current, acceptance }))}
      onContextPathsChange={(contextPaths) => setDraft((current) => ({ ...current, contextPaths: [...contextPaths] }))}
      onStart={onStart ?? (() => undefined)}
      onAdvanced={() => undefined}
      onConnectProvider={() => undefined}
      inventory={inv}
      onRosterChange={(roster) => setDraft((current) => ({ ...current, roster: [...roster] }))}
      {...props}
    />
  );
}

function render(options: HostOptions = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Host {...options} />));
  return host;
}

type EditorElement = HTMLElement & { editor: Editor };

function editorOf(host: HTMLElement): EditorElement {
  const field = host.querySelector<EditorElement>('[role="textbox"]');
  if (!field?.editor) throw new Error('editor não encontrado');
  return field;
}

function typeInto(field: EditorElement, text: string): void {
  act(() => {
    field.editor.commands.setContent(`<p>${text}</p>`, { emitUpdate: true });
  });
}

function pressModEnter(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(name));
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

describe('ExpressMissionStart — atalho de enviar', () => {
  it('⌘/Ctrl+Enter no pedido inicia uma vez e não quebra a linha', () => {
    const onStart = vi.fn();
    const host = render({ onStart, draft: { objective: 'Crie uma página de contato' } });
    const field = editorOf(host);
    const before = field.editor.getText();

    const meta = pressModEnter(field);
    expect(meta.defaultPrevented).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(field.editor.getText()).toBe(before);

    pressModEnter(field, { metaKey: false, ctrlKey: true });
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('Enter puro e Shift+Enter não iniciam a missão', () => {
    const onStart = vi.fn();
    const host = render({ onStart, draft: { objective: 'Crie uma página de contato' } });
    const field = editorOf(host);
    for (const init of [{}, { shiftKey: true }]) {
      act(() => {
        field.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
        );
      });
    }
    expect(onStart).not.toHaveBeenCalled();
  });

  it('não inicia durante a composição do IME nem com o início em andamento', () => {
    const onStart = vi.fn();
    const composing = render({ onStart, draft: { objective: 'Crie uma página' } });
    pressModEnter(editorOf(composing), { isComposing: true });
    expect(onStart).not.toHaveBeenCalled();

    const busy = render({ onStart, props: { busy: true }, draft: { objective: 'Crie uma página' } });
    pressModEnter(editorOf(busy));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('mostra o atalho ao lado do botão de iniciar', () => {
    const host = render();
    const dock = host.querySelector('.mission-setup__step-dock');
    expect(dock?.textContent).toContain(formatShortcut('mod', 'enter'));
    expect(button(host, 'Iniciar criação').getAttribute('aria-keyshortcuts')).toContain('Enter');
  });
});

describe('ExpressMissionStart — validação do pedido', () => {
  it('pedido vazio: explica no campo, marca aria-invalid, foca e não inicia', () => {
    const onStart = vi.fn();
    const host = render({ onStart });
    act(() => button(host, 'Iniciar criação').click());

    const field = editorOf(host);
    const error = host.querySelector<HTMLElement>('#express-objective-error');
    expect(onStart).not.toHaveBeenCalled();
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toMatch(/escreva/i);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain('express-objective-error');
    expect(document.activeElement).toBe(field);

    typeInto(field, 'Quero um site');
    expect(host.querySelector('#express-objective-error')).toBeNull();
    expect(field.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('sem pasta o clique segue para escolher a pasta, mesmo sem pedido', () => {
    const onStart = vi.fn();
    const host = render({ onStart, props: { workspace: null } });
    act(() => button(host, 'Escolher pasta para iniciar').click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe('ExpressMissionStart — anexos e exemplos', () => {
  it('os anexos ficam visíveis, fora de qualquer bloco recolhível, e dizem o que aceitam', () => {
    const host = render();
    const picker = host.querySelector('.mission-attachment-picker');
    expect(picker).not.toBeNull();
    expect(picker!.closest('details')).toBeNull();
    expect(picker!.textContent).toMatch(/imagem/i);
    expect(picker!.textContent).toMatch(/áudio/i);
  });

  it('exemplos: preenchem o vazio, trocam o texto digitado e deixam desfazer', () => {
    const host = render();
    const field = editorOf(host);
    act(() => button(host, 'Criar uma tela').click());
    expect(field.editor.getText()).toMatch(/página de contato/);
    expect(host.textContent).not.toContain('Desfazer');

    typeInto(field, 'meu texto escrito à mão');
    act(() => button(host, 'Corrigir algo').click());
    expect(field.editor.getText()).toMatch(/botão de enviar/);
    act(() => button(host, 'Desfazer').click());
    expect(field.editor.getText()).toBe('meu texto escrito à mão');
    expect(host.textContent).not.toContain('Desfazer');
  });

  it('trocar de um exemplo para outro ainda deixa desfazer para o texto original', () => {
    const host = render();
    const field = editorOf(host);
    typeInto(field, 'meu texto escrito à mão');
    act(() => button(host, 'Criar uma tela').click());
    act(() => button(host, 'Publicar').click());
    expect(field.editor.getText()).toMatch(/publique o site/);
    act(() => button(host, 'Desfazer').click());
    expect(field.editor.getText()).toBe('meu texto escrito à mão');
  });

  it('cada exemplo vira a lane certa (o de entender o projeto é só leitura)', () => {
    const host = render();
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.mission-setup__example')];
    expect(chips.length).toBeLessThanOrEqual(4);
    const lanes = new Map(
      chips.map((chip) => {
        act(() => chip.click());
        return [chip.textContent?.trim(), suggestMissionLaneFromGoal(editorOf(host).editor.getText())];
      }),
    );
    expect(lanes.get('Entender o projeto')).toBe('consult');
  });
});

describe('ExpressMissionStart — ação ancorada e pré-requisitos', () => {
  it('o botão de iniciar mora no dock, fora da área que rola', () => {
    const host = render();
    const cta = button(host, 'Iniciar criação');
    expect(cta.type).toBe('submit');
    expect(cta.closest('.mission-setup__step-dock')).not.toBeNull();
    expect(cta.closest('.mission-setup__step-scroll')).toBeNull();
    // O formulário continua sendo o pai de ambos: Enter em campo de uma linha
    // e o clique no dock chegam ao mesmo onSubmit.
    expect(cta.form).toBe(host.querySelector('form'));
  });

  it('sem ferramenta de IA o aviso e a ação de conectar ficam no dock', () => {
    const onConnectProvider = vi.fn();
    const host = render({ ready: false, props: { onConnectProvider } });
    const notice = host.querySelector('#express-provider-block');
    expect(notice?.closest('.mission-setup__step-dock')).not.toBeNull();
    expect(notice?.textContent).toContain('Falta conectar uma ferramenta de IA');
    act(() => button(notice as HTMLElement, 'Conectar uma ferramenta de IA').click());
    expect(onConnectProvider).toHaveBeenCalledTimes(1);
  });

  it('o ditado fala em "pedido", o mesmo nome do campo', () => {
    const host = render();
    expect(button(host, 'Ditar pedido').type).toBe('button');
    expect(host.textContent).not.toContain('Ditar objetivo');
  });

  it('⌘/Ctrl+Enter sem pasta escolhida segue para escolher a pasta; com pasta e sem pedido explica', () => {
    const noFolder = vi.fn();
    const semPasta = render({ onStart: noFolder, props: { workspace: null } });
    pressModEnter(editorOf(semPasta));
    expect(noFolder).toHaveBeenCalledTimes(1);

    const emptyStart = vi.fn();
    const semPedido = render({ onStart: emptyStart });
    pressModEnter(editorOf(semPedido));
    expect(emptyStart).not.toHaveBeenCalled();
    expect(semPedido.querySelector('#express-objective-error')).not.toBeNull();
  });
});

describe('ExpressMissionStart — teclado e contexto da ação', () => {
  it('Enter no critério de pronto não inicia a missão (só ⌘/Ctrl+Enter e o botão)', () => {
    const onStart = vi.fn();
    const host = render({ onStart, draft: { objective: 'Crie uma página de contato' } });
    const acceptance = host.querySelector<HTMLInputElement>('#express-acceptance')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      acceptance.dispatchEvent(enter);
    });
    // preventDefault no keydown é o que impede o envio implícito do formulário.
    expect(enter.defaultPrevented).toBe(true);
    expect(onStart).not.toHaveBeenCalled();

    pressModEnter(acceptance);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('clicar no rótulo "Seu pedido" foca o editor (o rótulo aponta para um contenteditable)', () => {
    const host = render();
    const label = host.querySelector<HTMLLabelElement>('#express-objective-label')!;
    expect(document.activeElement).not.toBe(editorOf(host));
    act(() => label.click());
    expect(document.activeElement).toBe(editorOf(host));
  });

  it('o dock diz onde e com quem a missão vai trabalhar, e o que fazer sem pasta', () => {
    const host = render();
    const note = host.querySelector('.mission-setup__dock-note')!;
    expect(note.textContent).toContain(WORKSPACE.name);
    expect(note.textContent).toMatch(/\d+ agentes/);
    expect(note.textContent).toMatch(/Claude/);

    const semPasta = render({ props: { workspace: null } });
    expect(semPasta.querySelector('.mission-setup__dock-note')?.textContent).toContain(
      'Escolha a pasta do projeto',
    );
  });

  it('com a criação em andamento: botão desabilitado, aria-busy no formulário e aviso à tecnologia assistiva', () => {
    const host = render({ props: { busy: true } });
    expect(button(host, 'Iniciando criação').disabled).toBe(true);
    expect(host.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.mission-setup__step-dock [role="status"]:not(.mission-setup__undo)')?.textContent).toContain(
      'Preparando a missão',
    );
  });
});

describe('ExpressMissionStart — anexo a caminho segura o início', () => {
  it('clique, submit e ⌘/Ctrl+Enter esperam a cópia: o dock explica e o botão solta sozinho', () => {
    const onStart = vi.fn();
    const host = render({
      onStart,
      draft: { objective: 'Crie uma página de contato' },
    });
    let pendingId = '';
    act(() => {
      pendingId = beginPendingAttachment('imagem.png');
    });

    const start = button(host, 'Iniciar criação');
    const note = host.querySelector<HTMLElement>(
      '.mission-setup__dock-note',
    )!;
    expect(start.disabled).toBe(true);
    expect(note.textContent).toContain('Aguarde: anexando imagem.png');
    // A própria nota é a região viva — nenhum aviso sr-only duplicado.
    expect(note.getAttribute('role')).toBe('status');
    expect(
      host.querySelectorAll('.mission-setup__step-dock [role="status"]'),
    ).toHaveLength(1);

    pressModEnter(editorOf(host));
    const form = host.querySelector('form')!;
    act(() => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onStart).not.toHaveBeenCalled();

    act(() => finishPendingAttachment(pendingId));
    const released = button(host, 'Iniciar criação');
    expect(released.disabled).toBe(false);
    expect(
      host.querySelector('.mission-setup__dock-note')?.textContent,
    ).not.toContain('Aguarde');
    act(() => released.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('vários anexos a caminho contam o total; com falha o início não trava', () => {
    const onStart = vi.fn();
    const host = render({
      onStart,
      draft: { objective: 'Crie uma página' },
    });
    act(() => {
      beginPendingAttachment('imagem.png');
      beginPendingAttachment('audio.m4a');
      failPendingAttachment(
        beginPendingAttachment('doc.pdf'),
        'Sem espaço em disco.',
      );
    });
    expect(button(host, 'Iniciar criação').disabled).toBe(true);
    expect(
      host.querySelector('.mission-setup__dock-note')?.textContent,
    ).toContain('Aguarde: anexando 2 arquivos');

    // Falha não trava: restam só erros, o início segue e o aviso é dispensável.
    act(() => {
      useMissionAttachmentPresentation.setState((state) => ({
        pending: state.pending.filter((item) => item.error !== undefined),
      }));
    });
    const start = button(host, 'Iniciar criação');
    expect(start.disabled).toBe(false);
    expect(host.textContent).toContain('Sem espaço em disco.');
    act(() => start.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('com a criação já em voo o dock fala da missão, não do anexo', () => {
    const host = render({
      props: { busy: true },
      draft: { objective: 'Crie uma página' },
    });
    act(() => {
      beginPendingAttachment('imagem.png');
    });
    expect(
      host.querySelector('.mission-setup__dock-note')?.textContent,
    ).toContain('Preparando a missão');
    expect(button(host, 'Iniciando criação').disabled).toBe(true);
  });
});

describe('ExpressMissionStart — ordem do Tab e anexos acessíveis', () => {
  it('o editor é o primeiro controle do formulário e o botão de iniciar o último do dock', () => {
    const host = render();
    const editor = editorOf(host);
    const dictation = button(host, 'Ditar pedido');
    const firstExample = host.querySelector<HTMLElement>('.mission-setup__example')!;
    const cta = button(host, 'Iniciar criação');
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // Quem chega pelo teclado cai no campo, não no microfone; o ditado e os
    // exemplos vêm depois, e a ação principal fecha o formulário.
    expect(before(editor, dictation)).toBe(true);
    expect(before(dictation, firstExample)).toBe(true);
    expect(before(firstExample, cta)).toBe(true);
    const controls = [...host.querySelectorAll<HTMLElement>('button, a[href], input, select, summary, [tabindex="0"]')]
      .filter((node) => node.tabIndex >= 0 && !(node as HTMLButtonElement).disabled);
    expect(controls.at(-1)).toBe(cta);
  });

  it('o campo de arquivo escondido sai do Tab e a zona de soltar tem nome', () => {
    const host = render();
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(fileInput.tabIndex).toBe(-1);
    const zone = host.querySelector<HTMLElement>('.mission-attachment-picker__drop')!;
    expect(zone.getAttribute('role')).toBe('group');
    expect(zone.getAttribute('aria-label')).toMatch(/anexar arquivos/i);
  });
});

