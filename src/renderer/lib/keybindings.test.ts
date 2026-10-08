// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência: os casos de `when` e "última regra vence" de apps/web/src/keybindings.test.ts (T3 Code, MIT).
// Suíte do Nexus escrita para os comandos do Nexus; padrões congelados contra App.tsx/catálogo; IME, AltGraph, campo editável, terminal-first, reservadas e conflito por literal oposto são casos do Nexus.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
  commandShortcutLabel,
  compileKeybindingRules,
  effectiveKeybindingMap,
  focusContext,
  formatBinding,
  KEYBINDING_COMMANDS,
  keybindingConflicts,
  parseWhenExpression,
  resolveShortcutCommand,
  terminalInUse,
  validateBinding,
  type KeyPlatform,
  type KeybindingOverrides,
  type ShortcutContext,
  type ShortcutEventLike,
} from './keybindings';
import { SHORTCUTS } from './shortcuts';
import legacyOracle from './__fixtures__/legacy-app-shortcuts.json';

function key(
  value: string,
  modifiers: Partial<ShortcutEventLike> = {},
): ShortcutEventLike {
  return {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

const WORKSPACE: Partial<ShortcutContext> = {
  hasWorkspace: true,
  paneFocused: true,
  projectOverview: true,
};

function resolve(
  event: ShortcutEventLike,
  platform: KeyPlatform,
  context: Partial<ShortcutContext> = WORKSPACE,
  overrides?: KeybindingOverrides,
) {
  return resolveShortcutCommand(
    event,
    compileKeybindingRules(overrides, platform),
    context,
    platform,
  );
}

function setPlatform(platform: KeyPlatform | undefined): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: platform ? { platform } : undefined,
  });
}

afterEach(() => setPlatform(undefined));

/** Comandos que não existiam: só podem ocupar células que o App deixava vazias. */
const NEW_COMMANDS = new Set(['file-picker', 'content-search']);

/** O que App.tsx faz com o resultado: o pane do dígito precisa existir. */
function dispatched(
  hit: ReturnType<typeof resolveShortcutCommand>,
  panes: number,
): string | null {
  if (!hit) return null;
  if (hit.command !== 'focus-pane-n') return hit.command;
  return (hit.index ?? 99) < panes ? `focus-pane-n:${hit.index}` : null;
}

/**
 * Compara cada célula do oráculo com o resolver atual. `terminalInUse` diz se
 * o terminal selecionado está em uso (à vista ou com o foco do teclado);
 * `expectedNow` nomeia a mudança deliberada de uma célula.
 */
function oracleDivergences(
  platform: KeyPlatform,
  terminalInUse: (ctx: (typeof legacyOracle.contexts)[number]) => boolean,
  /** O que a célula passa a fazer de propósito (padrão: o mesmo que antes). */
  expectedNow: (
    expected: string | null,
    ctx: (typeof legacyOracle.contexts)[number],
    mods: number,
  ) => string | null = (expected) => expected,
): string[] {
  const results = legacyOracle.results as Record<string, string>;
  const divergences: string[] = [];
  legacyOracle.contexts.forEach((ctx, ctxIndex) => {
    for (const keyValue of legacyOracle.keys) {
      for (let mods = 0; mods < 16; mods += 1) {
        const event = key(keyValue, {
          metaKey: Boolean(mods & 1),
          ctrlKey: Boolean(mods & 2),
          altKey: Boolean(mods & 4),
          shiftKey: Boolean(mods & 8),
        });
        const expected = expectedNow(
          results[`${ctxIndex}|${mods}|${keyValue}`] ?? null,
          ctx,
          mods,
        );
        const actual = dispatched(
          resolve(event, platform, {
            ...ctx,
            terminalInUse: terminalInUse(ctx),
            terminalFocus: false,
            editableFocus: false,
          }),
          legacyOracle.panes,
        );
        const same =
          expected !== null
            ? actual === expected
            : actual === null || NEW_COMMANDS.has(actual);
        if (!same) {
          divergences.push(
            `${JSON.stringify(ctx)} mods=${mods} key=${keyValue}: antes ${expected}, agora ${actual}`,
          );
        }
      }
    }
  });
  return divergences;
}

describe('padrões', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'fazem exatamente o que o onKey de App.tsx @ 53116f0d8 fazia (%s)',
    (platform) => {
      expect(legacyOracle.base).toBe('53116f0d8');
      expect(legacyOracle.cases).toBe(
        legacyOracle.contexts.length * legacyOracle.keys.length * 16,
      );
      // Com o terminal selecionado em uso (Terminais à vista ou foco no xterm),
      // nenhuma célula muda — o palco continua no ⇧⌘F.
      expect(
        oracleDivergences(platform, (ctx) => ctx.paneFocused).slice(0, 20),
      ).toEqual([]);
    },
  );

  it.each(['darwin', 'linux', 'win32'] as const)(
    'fora dos terminais só o palco cede o ⇧⌘F à busca no conteúdo (%s)',
    (platform) => {
      // F-1003: no Início/Projeto/Quadro o terminal selecionado não está à
      // vista; o atalho abria o palco e arrastava o operador para Terminais.
      // As outras ~10 mil células seguem idênticas ao App antigo.
      expect(
        oracleDivergences(
          platform,
          () => false,
          // A busca é atalho novo e estrito (⌘⇧F ou Ctrl+⇧F, bits 9/10); as
          // variantes antigas só do palco (com ⌥, ou ⌘+Ctrl) ficam sem ação.
          (expected, ctx, mods) =>
            expected === 'stage-focus'
              ? ctx.hasWorkspace && (mods === 9 || mods === 10)
                ? 'content-search'
                : null
              : expected,
        ).slice(0, 20),
      ).toEqual([]);
    },
  );

  it('as combinações exibidas (Mod = ⌘ no mac, Ctrl nos demais)', () => {
    expect(effectiveKeybindingMap({}, 'linux')).toEqual({
      'command-palette': ['Mod+K'],
      'file-picker': ['Mod+P'],
      'content-search': ['Mod+Shift+F'],
      'attention-inbox': ['Mod+J'],
      'mission-new': ['Mod+N'],
      'task-board': ['Mod+B'],
      'project-overview': ['Mod+G'],
      settings: ['Mod+Comma'],
      'operator-profile': ['Mod+Shift+O'],
      'bug-report': ['Mod+Shift+B'],
      cheatsheet: ['Mod+Slash'],
      'focus-pane-n': ['Mod+1'],
      'split-right': ['Mod+D'],
      'split-down': ['Mod+Shift+D'],
      'stage-focus': ['Mod+Shift+F'],
      'close-pane': ['Mod+W'],
    });
  });

  it('todo padrão é válido, não reservado, e todo `when` compila', () => {
    for (const def of KEYBINDING_COMMANDS) {
      for (const binding of def.defaults) {
        expect(validateBinding(def.id, binding, 'darwin')).toEqual({
          ok: true,
          value: binding,
        });
      }
      if (def.when) expect(parseWhenExpression(def.when)).not.toBeNull();
    }
  });

  it('os padrões não conflitam entre si (palco × busca no conteúdo se excluem)', () => {
    for (const def of KEYBINDING_COMMANDS) {
      for (const binding of def.defaults) {
        expect(keybindingConflicts(def.id, binding, {}, 'darwin')).toEqual([]);
      }
    }
  });

  it('o rótulo do padrão é o mesmo do catálogo (cheatsheet, paleta)', () => {
    for (const entry of SHORTCUTS) {
      const command = KEYBINDING_COMMANDS.find((def) => def.id === entry.id);
      if (!command) continue;
      expect(commandShortcutLabel(command.id), entry.id).toBe(entry.keys);
    }
  });

  it('no mac o rótulo segue a ordem ⌃⌥⇧⌘ do formatShortcut', () => {
    setPlatform('darwin');
    expect(formatBinding('Mod+Shift+D')).toBe('⇧⌘D');
    expect(formatBinding('Mod+Comma')).toBe('⌘,');
    expect(formatBinding('Mod+1', 'focus-pane-n')).toBe('⌘1-9');
    expect(formatBinding('Mod+1', 'focus-pane-n', 7)).toBe('⌘7');
  });
});

describe('resolver', () => {
  it('Mod aceita ⌘ e Ctrl nas duas plataformas, como o App sempre aceitou', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(resolve(key('k', { metaKey: true }), platform)?.command).toBe(
        'command-palette',
      );
      expect(resolve(key('k', { ctrlKey: true }), platform)?.command).toBe(
        'command-palette',
      );
    }
    // Atalho novo e atalho remapeado: Mod também casa com os dois.
    expect(resolve(key('p', { ctrlKey: true }), 'darwin')?.command).toBe(
      'file-picker',
    );
    expect(resolve(key('p', { metaKey: true }), 'linux')?.command).toBe(
      'file-picker',
    );
    expect(
      resolve(
        key('m', { ctrlKey: true, altKey: true, code: 'KeyM' }),
        'darwin',
        WORKSPACE,
        { 'mission-new': ['Mod+Alt+M'] },
      )?.command,
    ).toBe('mission-new');
  });

  it('respeita o `when`: sem projeto, Mod+K não é atalho', () => {
    expect(
      resolve(key('k', { ctrlKey: true }), 'linux', { hasWorkspace: false }),
    ).toBeNull();
    expect(
      resolve(key('n', { ctrlKey: true }), 'linux', { hasWorkspace: false })?.command,
    ).toBe('mission-new');
  });

  it('Mod+Shift+F com o terminal selecionado em uso é o palco; fora dele, busca', () => {
    const chord = key('F', { ctrlKey: true, shiftKey: true });
    expect(
      resolve(chord, 'linux', { ...WORKSPACE, paneFocused: true, terminalInUse: true })
        ?.command,
    ).toBe('stage-focus');
    // Terminal selecionado mas fora de vista (Início): busca, não palco.
    expect(
      resolve(chord, 'linux', { ...WORKSPACE, paneFocused: true, terminalInUse: false })
        ?.command,
    ).toBe('content-search');
    expect(
      resolve(chord, 'linux', { ...WORKSPACE, paneFocused: false })?.command,
    ).toBe('content-search');
  });

  it('terminalInUse: selecionado E (Terminais à vista OU foco no xterm)', () => {
    expect(terminalInUse({ paneFocused: true, terminalView: true, terminalFocus: false })).toBe(true);
    expect(terminalInUse({ paneFocused: true, terminalView: false, terminalFocus: true })).toBe(true);
    expect(terminalInUse({ paneFocused: true, terminalView: false, terminalFocus: false })).toBe(false);
    expect(terminalInUse({ paneFocused: false, terminalView: true, terminalFocus: true })).toBe(false);
  });

  it('a linha de dígito devolve o índice da tecla apertada', () => {
    expect(resolve(key('7', { metaKey: true }), 'darwin')).toEqual({
      command: 'focus-pane-n',
      index: 6,
    });
  });

  it('override vence o padrão que divide a mesma combinação', () => {
    const overrides = { 'mission-new': ['Mod+K'] };
    expect(
      resolve(key('k', { ctrlKey: true }), 'linux', WORKSPACE, overrides)?.command,
    ).toBe('mission-new');
    // E o padrão antigo do comando remapeado deixa de valer.
    expect(
      resolve(key('n', { ctrlKey: true }), 'linux', WORKSPACE, overrides),
    ).toBeNull();
  });

  it('override inválido é ignorado; [] tira o atalho', () => {
    expect(
      effectiveKeybindingMap({ 'task-board': ['banana', 'Mod+Alt+B'] }, 'linux')[
        'task-board'
      ],
    ).toEqual(['Mod+Alt+B']);
    expect(
      resolve(key('b', { ctrlKey: true }), 'linux', WORKSPACE, {
        'task-board': [],
      }),
    ).toBeNull();
  });

  it('IME compondo nunca dispara atalho', () => {
    expect(
      resolve(key('k', { ctrlKey: true, isComposing: true }), 'linux'),
    ).toBeNull();
    expect(resolve(key('k', { ctrlKey: true, keyCode: 229 }), 'linux')).toBeNull();
  });

  it('AltGr (ABNT2/intl) é texto, não atalho', () => {
    const overrides = { cheatsheet: ['Mod+Alt+Slash'] };
    // Ctrl+Alt na tecla física da barra: com AltGr é caractere do layout.
    const physicalSlash = key('/', { ctrlKey: true, altKey: true, code: 'Slash' });
    expect(
      resolve(
        { ...physicalSlash, getModifierState: (name) => name === 'AltGraph' },
        'win32',
        WORKSPACE,
        overrides,
      ),
    ).toBeNull();
    expect(
      resolve(
        { ...physicalSlash, getModifierState: () => false },
        'win32',
        WORKSPACE,
        overrides,
      )?.command,
    ).toBe('cheatsheet');
    // ABNT2 real: AltGr+Q digita "/" — nunca é Mod+Alt+Slash.
    expect(
      resolve(
        key('/', { ctrlKey: true, altKey: true, code: 'KeyQ' }),
        'win32',
        WORKSPACE,
        overrides,
      ),
    ).toBeNull();
  });

  it('campo editável: a edição de texto nativa não vira atalho', () => {
    const overrides = { 'close-pane': ['Mod+Backspace'] };
    const chord = key('Backspace', { ctrlKey: true });
    expect(resolve(chord, 'linux', WORKSPACE, overrides)?.command).toBe(
      'close-pane',
    );
    expect(
      resolve(chord, 'linux', { ...WORKSPACE, editableFocus: true }, overrides),
    ).toBeNull();
    // Mod+K continua valendo dentro de um campo (a paleta abre de qualquer lugar).
    expect(
      resolve(key('k', { ctrlKey: true }), 'linux', {
        ...WORKSPACE,
        editableFocus: true,
      })?.command,
    ).toBe('command-palette');
  });

  it('terminal focado recebe a tecla: o que o xterm consumiu não é atalho', () => {
    expect(
      resolve(key('d', { ctrlKey: true, defaultPrevented: true }), 'linux'),
    ).toBeNull();
    expect(resolve(key('d', { ctrlKey: true }), 'linux')?.command).toBe(
      'split-right',
    );
  });

  it('focusContext separa o textarea do xterm de um campo do app', () => {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    xterm.append(helper);
    const field = document.createElement('input');
    document.body.append(xterm, field);
    expect(focusContext(helper)).toEqual({
      terminalFocus: true,
      editableFocus: false,
    });
    expect(focusContext(field)).toEqual({
      terminalFocus: false,
      editableFocus: true,
    });
    xterm.remove();
    field.remove();
  });
});

describe('gravação e validação', () => {
  it('recusa combinação inválida, sem ⌘/Ctrl ou reservada', () => {
    expect(validateBinding('mission-new', 'K', 'linux').ok).toBe(false);
    expect(validateBinding('mission-new', 'Mod+Banana', 'linux').ok).toBe(false);
    expect(validateBinding('mission-new', 'Alt+K', 'darwin').ok).toBe(false);
    expect(validateBinding('mission-new', 'DoubleTap+Shift', 'linux').ok).toBe(
      false,
    );
    expect(validateBinding('mission-new', 'Mod+C', 'darwin')).toEqual({
      ok: false,
      error: 'Reservado: copiar.',
    });
    expect(validateBinding('mission-new', 'Ctrl+Tab', 'darwin').ok).toBe(false);
    expect(validateBinding('focus-pane-n', 'Mod+K', 'linux').ok).toBe(false);
    expect(validateBinding('focus-pane-n', 'Mod+Alt+7', 'linux')).toEqual({
      ok: true,
      value: 'Mod+Alt+1',
    });
  });

  it('captura do teclado: modificador sozinho e IME esperam; ⌘ vira Mod', () => {
    expect(bindingFromEvent('mission-new', key('Meta', { metaKey: true }), 'darwin')).toBeNull();
    expect(
      bindingFromEvent('mission-new', key('m', { metaKey: true, isComposing: true }), 'darwin'),
    ).toBeNull();
    expect(
      bindingFromEvent(
        'mission-new',
        key('M', { metaKey: true, shiftKey: true, code: 'KeyM' }),
        'darwin',
      ),
    ).toEqual({ ok: true, value: 'Mod+Shift+M' });
    expect(
      bindingFromEvent('mission-new', key('m', { ctrlKey: true, code: 'KeyM' }), 'linux'),
    ).toEqual({ ok: true, value: 'Mod+M' });
  });

  it('acusa conflito com outro comando no mesmo contexto', () => {
    expect(keybindingConflicts('mission-new', 'Mod+K', {}, 'linux')).toEqual([
      'command-palette',
    ]);
    // A linha 1–9 ocupa os nove dígitos.
    expect(keybindingConflicts('mission-new', 'Mod+5', {}, 'linux')).toEqual([
      'focus-pane-n',
    ]);
    // Mod casa com ⌘ e Ctrl: no mac, Ctrl+K já é da paleta.
    expect(keybindingConflicts('mission-new', 'Ctrl+K', {}, 'darwin')).toEqual([
      'command-palette',
    ]);
    // Variantes antigas contam: Mod+Shift+W sempre fechou o terminal…
    expect(keybindingConflicts('mission-new', 'Mod+Shift+W', {}, 'linux')).toEqual([
      'close-pane',
    ]);
    // …até o fechar ser remapeado.
    expect(
      keybindingConflicts('mission-new', 'Mod+Shift+W', { 'close-pane': ['Mod+Alt+W'] }, 'linux'),
    ).toEqual([]);
    // Override conta: Mod+K liberado quando a paleta mudou de tecla.
    expect(
      keybindingConflicts('mission-new', 'Mod+K', { 'command-palette': ['Mod+Alt+K'] }, 'linux'),
    ).toEqual([]);
  });
});
