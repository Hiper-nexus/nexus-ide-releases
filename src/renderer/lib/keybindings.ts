// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: gramática e avaliação de `when` (packages/shared/src/keybindings.ts:115-121, 276-388; apps/web/src/keybindings.ts:72-92) e resolver "última regra vence" com overrides por último (apps/web/src/keybindings.ts:154-170; packages/shared/src/keybindings.ts:441-467) portados sobre o núcleo de teclas que o Nexus já tinha (src/shared/keybindings: parse/normalize/match/captura com Mod, ABNT e fallback físico); trava de AltGraph (packages/shared/src/keybindings.ts:105-110); conflito por `when` (settings/KeybindingsSettings.logic.ts:182-201) trocado por exclusão de literal oposto; comandos e padrões são os handlers globais do Nexus (App.tsx), em PT-BR; IME, campo editável, terminal-first e combinações reservadas são regras do Nexus.
import {
  canonicalizeParsedKeybinding,
  digitFromInput,
  formatKeybinding,
  getKeybindingConflictIdentity,
  keybindingFromInput,
  keybindingMatchesInput,
  normalizeKeybinding,
  parseKeybinding,
} from '../../shared/keybindings';
import { formatShortcut } from './platform';

/**
 * Atalhos globais configuráveis. Os padrões são os mesmos que App.tsx sempre
 * teve (o teste trava o mapa); Configurações › Atalhos grava overrides em
 * `ui.keybindings` (settings.json, validado no main).
 *
 * Mod = ⌘ no mac, Ctrl no Windows/Linux — estrito: Ctrl+K no mac não é Mod+K.
 * Terminal-first: o xterm vê a tecla antes do listener da janela; o que ele
 * consome (Ctrl+letra vira byte de controle para o TUI) chega com
 * `defaultPrevented` e nunca vira atalho do app.
 */

export type KeyPlatform = 'darwin' | 'win32' | 'linux';

export function keybindingPlatform(): KeyPlatform {
  const platform =
    typeof window === 'undefined' ? undefined : window.nexus?.platform;
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

export type KeybindingCommand =
  | 'command-palette'
  | 'file-picker'
  | 'content-search'
  | 'attention-inbox'
  | 'mission-new'
  | 'task-board'
  | 'project-overview'
  | 'settings'
  | 'operator-profile'
  | 'bug-report'
  | 'cheatsheet'
  | 'focus-pane-n'
  | 'split-right'
  | 'split-down'
  | 'stage-focus'
  | 'close-pane';

export interface KeybindingCommandDefinition {
  readonly id: KeybindingCommand;
  readonly label: string;
  readonly defaults: readonly string[];
  /** Quando vale: identificadores do contexto, `!`, `&&`, `||` e parênteses. */
  readonly when?: string;
  /** Uma linha só para 1–9: a combinação guarda o 1, o dígito apertado escolhe o alvo. */
  readonly digitIndex?: true;
}

export const KEYBINDING_COMMANDS: readonly KeybindingCommandDefinition[] = [
  { id: 'command-palette', label: 'Buscar terminais, missões e ações', defaults: ['Mod+K'], when: 'hasWorkspace' },
  { id: 'file-picker', label: 'Ir para um arquivo do projeto', defaults: ['Mod+P'], when: 'hasWorkspace' },
  { id: 'content-search', label: 'Buscar texto nos arquivos do projeto', defaults: ['Mod+Shift+F'], when: 'hasWorkspace && !terminalFocus' },
  { id: 'attention-inbox', label: 'Lista de atenção', defaults: ['Mod+J'], when: 'hasWorkspace' },
  { id: 'mission-new', label: 'Nova missão', defaults: ['Mod+N'] },
  { id: 'task-board', label: 'Quadro de tarefas', defaults: ['Mod+B'] },
  { id: 'project-overview', label: 'Visão geral do projeto', defaults: ['Mod+G'], when: 'hasWorkspace && projectOverview' },
  { id: 'settings', label: 'Configurações', defaults: ['Mod+Comma'] },
  { id: 'operator-profile', label: 'Perfil do Operador', defaults: ['Mod+Shift+O'] },
  { id: 'bug-report', label: 'Reportar um problema', defaults: ['Mod+Shift+B'] },
  { id: 'cheatsheet', label: 'Lista de atalhos', defaults: ['Mod+Slash'] },
  { id: 'focus-pane-n', label: 'Selecionar um terminal pelo número', defaults: ['Mod+1'], digitIndex: true },
  { id: 'split-right', label: 'Dividir o terminal à direita', defaults: ['Mod+D'], when: 'paneFocused' },
  { id: 'split-down', label: 'Dividir o terminal abaixo', defaults: ['Mod+Shift+D'], when: 'paneFocused' },
  // Divide Mod+Shift+F com a busca no conteúdo: dentro do terminal é o palco.
  { id: 'stage-focus', label: 'Palco: só o terminal selecionado', defaults: ['Mod+Shift+F'], when: 'paneFocused && terminalFocus' },
  { id: 'close-pane', label: 'Fechar o terminal selecionado', defaults: ['Mod+W'], when: 'paneFocused' },
];

const DEFINITIONS = new Map(KEYBINDING_COMMANDS.map((def) => [def.id, def]));

export function isKeybindingCommand(id: string): id is KeybindingCommand {
  return DEFINITIONS.has(id as KeybindingCommand);
}

export function keybindingDefinition(
  command: KeybindingCommand,
): KeybindingCommandDefinition {
  return DEFINITIONS.get(command)!;
}

/** Overrides persistidos: id → combinações (`[]` = sem atalho). */
export type KeybindingOverrides = Readonly<Record<string, readonly string[]>>;

export interface ShortcutContext {
  hasWorkspace: boolean;
  /** O layout tem um terminal selecionado. */
  paneFocused: boolean;
  /** O foco do teclado está dentro de um xterm. */
  terminalFocus: boolean;
  /** Campo de texto do app (fora do xterm) tem o foco. */
  editableFocus: boolean;
  projectOverview: boolean;
  [key: string]: boolean;
}

// ── `when` ────────────────────────────────────────────────────────────────

const MAX_WHEN_EXPRESSION_DEPTH = 64;

export type WhenNode =
  | { type: 'identifier'; name: string }
  | { type: 'not'; node: WhenNode }
  | { type: 'and'; left: WhenNode; right: WhenNode }
  | { type: 'or'; left: WhenNode; right: WhenNode };

type WhenToken =
  | { type: 'identifier'; value: string }
  | { type: 'not' }
  | { type: 'and' }
  | { type: 'or' }
  | { type: 'lparen' }
  | { type: 'rparen' };

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith('&&', index)) {
      tokens.push({ type: 'and' });
      index += 2;
      continue;
    }
    if (expression.startsWith('||', index)) {
      tokens.push({ type: 'or' });
      index += 2;
      continue;
    }
    if (current === '!') {
      tokens.push({ type: 'not' });
      index += 1;
      continue;
    }
    if (current === '(') {
      tokens.push({ type: 'lparen' });
      index += 1;
      continue;
    }
    if (current === ')') {
      tokens.push({ type: 'rparen' });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: 'identifier', value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseWhenExpression(expression: string): WhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): WhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === 'identifier') {
      index += 1;
      return { type: 'identifier', name: token.value };
    }

    if (token.type === 'lparen') {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== 'rparen') {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): WhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === 'not') {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: 'not', node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): WhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === 'and') {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: 'and', left, right };
    }

    return left;
  };

  const parseOr = (depth: number): WhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === 'or') {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: 'or', left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

function evaluateWhenNode(
  node: WhenNode,
  context: Partial<ShortcutContext>,
): boolean {
  switch (node.type) {
    case 'identifier':
      if (node.name === 'true') return true;
      if (node.name === 'false') return false;
      return Boolean(context[node.name]);
    case 'not':
      return !evaluateWhenNode(node.node, context);
    case 'and':
      return (
        evaluateWhenNode(node.left, context) &&
        evaluateWhenNode(node.right, context)
      );
    case 'or':
      return (
        evaluateWhenNode(node.left, context) ||
        evaluateWhenNode(node.right, context)
      );
  }
}

/** Literais do `&&` de topo: `a && !b` → a, ¬b. `||` não entra (vira opaco). */
function topLevelLiterals(node: WhenNode | null): Array<[string, boolean]> {
  if (!node) return [];
  if (node.type === 'and') {
    return [...topLevelLiterals(node.left), ...topLevelLiterals(node.right)];
  }
  if (node.type === 'identifier') return [[node.name, true]];
  if (node.type === 'not' && node.node.type === 'identifier') {
    return [[node.node.name, false]];
  }
  return [];
}

/**
 * Dois `when` podem valer ao mesmo tempo? Só não quando um exige `x` e o
 * outro `!x` — o caso de Mod+Shift+F (palco no terminal × busca fora dele).
 * ponytail: não resolve `||` nem implicações; na dúvida acusa conflito.
 */
function whenClausesOverlap(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  const a = topLevelLiterals(parseWhenExpression(left));
  const b = new Map(topLevelLiterals(parseWhenExpression(right)));
  return !a.some(([name, positive]) => b.get(name) === !positive);
}

// ── Combinações ───────────────────────────────────────────────────────────

const RESERVED: ReadonlyArray<readonly [binding: string, reason: string]> = [
  ['Mod+A', 'selecionar tudo'],
  ['Mod+C', 'copiar'],
  ['Mod+V', 'colar'],
  ['Mod+X', 'recortar'],
  ['Mod+Z', 'desfazer'],
  ['Mod+Shift+Z', 'refazer'],
  ['Mod+Y', 'refazer'],
  ['Mod+S', 'salvar no editor'],
  ['Mod+Q', 'sair do app'],
  ['Ctrl+Tab', 'circular terminais'],
  ['Ctrl+Shift+Tab', 'circular terminais'],
  ['Mod+Alt+ArrowLeft', 'aba anterior dos Terminais'],
  ['Mod+Alt+ArrowRight', 'próxima aba dos Terminais'],
  ['Mod+Shift+Space', 'falar com a assistente (atalho do sistema)'],
];

function missingModifierError(platform: KeyPlatform): string {
  return platform === 'darwin'
    ? `Inclua ${formatShortcut('mod')} ou ${formatShortcut('ctrl')} na combinação.`
    : 'Inclua Ctrl na combinação.';
}

export type BindingResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

/** Valida e canonicaliza uma combinação para `command`; mensagens em PT-BR. */
export function validateBinding(
  command: KeybindingCommand,
  raw: string,
  platform: KeyPlatform = keybindingPlatform(),
): BindingResult {
  const normalized = normalizeKeybinding(raw);
  const parsed = normalized.ok ? parseKeybinding(normalized.value) : null;
  if (!normalized.ok || !parsed || parsed.doubleTapModifier) {
    return {
      ok: false,
      error: `Combinação inválida. Use algo como ${formatShortcut('mod', 'shift', 'P')}.`,
    };
  }
  // Sem ⌘/Ctrl a tecla digita texto (Alt+letra é caractere no mac e AltGr no ABNT).
  if (!parsed.mod && !parsed.meta && !parsed.control) {
    return { ok: false, error: missingModifierError(platform) };
  }
  let value = normalized.value;
  if (keybindingDefinition(command).digitIndex) {
    if (!/^[1-9]$/.test(parsed.key)) {
      return { ok: false, error: 'Escolha um número de 1 a 9 com um modificador.' };
    }
    value = canonicalizeParsedKeybinding({ ...parsed, key: '1' });
  }
  const identity = getKeybindingConflictIdentity(value, platform);
  const reserved = RESERVED.find(
    ([binding]) => getKeybindingConflictIdentity(binding, platform) === identity,
  );
  if (reserved) {
    return { ok: false, error: `Reservado: ${reserved[1]}.` };
  }
  return { ok: true, value };
}

const TEXT_EDITING_KEYS = new Set([
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

const MODIFIER_ONLY_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS']);

export interface ShortcutEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  getModifierState?: (key: 'AltGraph') => boolean;
}

function isComposing(event: ShortcutEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/**
 * Gravação de atalho: `null` enquanto só há modificador apertado ou o IME
 * está compondo; senão a combinação validada (ou o erro dela).
 */
export function bindingFromEvent(
  command: KeybindingCommand,
  event: ShortcutEventLike,
  platform: KeyPlatform = keybindingPlatform(),
): BindingResult | null {
  if (isComposing(event) || MODIFIER_ONLY_KEYS.has(event.key)) return null;
  const captured = keybindingFromInput(event, platform);
  if (!captured.ok) {
    return {
      ok: false,
      error:
        !event.metaKey && !event.ctrlKey
          ? missingModifierError(platform)
          : 'Tecla não reconhecida. Tente outra combinação.',
    };
  }
  return validateBinding(command, captured.value, platform);
}

export function effectiveBindings(
  command: KeybindingCommand,
  overrides?: KeybindingOverrides,
  platform: KeyPlatform = keybindingPlatform(),
): string[] {
  const override = overrides?.[command];
  if (!Array.isArray(override)) return [...keybindingDefinition(command).defaults];
  const valid: string[] = [];
  for (const raw of override) {
    const result = validateBinding(command, raw, platform);
    if (result.ok && !valid.includes(result.value)) valid.push(result.value);
  }
  return valid;
}

/** O mapa efetivo inteiro — o que o teste de padrões congela. */
export function effectiveKeybindingMap(
  overrides?: KeybindingOverrides,
  platform: KeyPlatform = keybindingPlatform(),
): Record<KeybindingCommand, string[]> {
  return Object.fromEntries(
    KEYBINDING_COMMANDS.map((def) => [
      def.id,
      effectiveBindings(def.id, overrides, platform),
    ]),
  ) as Record<KeybindingCommand, string[]>;
}

function conflictIdentities(
  command: KeybindingCommand,
  binding: string,
  platform: KeyPlatform,
): string[] {
  const parsed = parseKeybinding(binding);
  if (!parsed || !keybindingDefinition(command).digitIndex) {
    return [getKeybindingConflictIdentity(binding, platform)];
  }
  return Array.from({ length: 9 }, (_, index) =>
    getKeybindingConflictIdentity(
      canonicalizeParsedKeybinding({ ...parsed, key: String(index + 1) }),
      platform,
    ),
  );
}

/** Outros comandos que disparariam com `binding` no mesmo contexto. */
export function keybindingConflicts(
  command: KeybindingCommand,
  binding: string,
  overrides?: KeybindingOverrides,
  platform: KeyPlatform = keybindingPlatform(),
): KeybindingCommand[] {
  const mine = conflictIdentities(command, binding, platform);
  const when = keybindingDefinition(command).when;
  return KEYBINDING_COMMANDS.filter(
    (other) =>
      other.id !== command &&
      whenClausesOverlap(when, other.when) &&
      effectiveBindings(other.id, overrides, platform).some((candidate) =>
        conflictIdentities(other.id, candidate, platform).some((identity) =>
          mine.includes(identity),
        ),
      ),
  ).map((other) => other.id);
}

/** Rótulo da combinação no idioma do catálogo (`formatShortcut`: ⇧⌘D / Ctrl+Shift+D). */
export function formatBinding(
  binding: string,
  command?: KeybindingCommand,
  /** Linha de dígito: o número de um alvo específico em vez de "1-9". */
  digit?: number,
): string {
  // Mesma fonte de plataforma que `formatShortcut` usa.
  const platform = keybindingPlatform();
  const parsed = parseKeybinding(binding);
  if (!parsed) return binding;
  const parts = formatKeybinding(binding, platform);
  const keyLabel =
    command && keybindingDefinition(command).digitIndex
      ? digit !== undefined
        ? String(digit)
        : '1-9'
      : (parts[parts.length - 1] ?? parsed.key);
  // Meta explícito fora do mac (tecla Windows/Super) não tem token no catálogo.
  if (parsed.meta && platform !== 'darwin') {
    return [...parts.slice(0, -1), keyLabel].join('+');
  }
  const tokens: string[] = [];
  if (parsed.mod || parsed.meta) tokens.push('mod');
  if (parsed.control) tokens.push('ctrl');
  if (parsed.alt) tokens.push('alt');
  if (parsed.shift) tokens.push('shift');
  return formatShortcut(...tokens, keyLabel);
}

/** Rótulo do atalho efetivo de um comando, ou null quando ficou sem atalho. */
export function commandShortcutLabel(
  command: KeybindingCommand,
  overrides?: KeybindingOverrides,
): string | null {
  const bindings = effectiveBindings(command, overrides);
  return bindings.length > 0
    ? bindings.map((binding) => formatBinding(binding, command)).join(' / ')
    : null;
}

// ── Resolver ──────────────────────────────────────────────────────────────

export interface ResolvedRule {
  readonly command: KeybindingCommand;
  readonly binding: string;
  readonly whenAst: WhenNode | null;
  readonly digitIndex: boolean;
}

let compiledFor: { overrides: unknown; platform: KeyPlatform; rules: ResolvedRule[] } | null =
  null;

/**
 * Regras compiladas: padrões primeiro, comandos remapeados no fim — o
 * resolver anda de trás para frente, então o override vence um padrão que
 * divida a mesma combinação.
 */
export function compileKeybindingRules(
  overrides?: KeybindingOverrides,
  platform: KeyPlatform = keybindingPlatform(),
): ResolvedRule[] {
  if (
    compiledFor &&
    compiledFor.overrides === overrides &&
    compiledFor.platform === platform
  ) {
    return compiledFor.rules;
  }
  const defaults: ResolvedRule[] = [];
  const custom: ResolvedRule[] = [];
  for (const def of KEYBINDING_COMMANDS) {
    const bucket = Array.isArray(overrides?.[def.id]) ? custom : defaults;
    for (const binding of effectiveBindings(def.id, overrides, platform)) {
      bucket.push({
        command: def.id,
        binding,
        whenAst: def.when ? parseWhenExpression(def.when) : null,
        digitIndex: def.digitIndex === true,
      });
    }
  }
  const rules = [...defaults, ...custom];
  compiledFor = { overrides, platform, rules };
  return rules;
}

export interface ResolvedShortcut {
  readonly command: KeybindingCommand;
  /** focus-pane-n: posição 0–8 do dígito apertado. */
  readonly index?: number;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  rules: readonly ResolvedRule[],
  context: Partial<ShortcutContext>,
  platform: KeyPlatform = keybindingPlatform(),
): ResolvedShortcut | null {
  // O terminal (ou outro dono) já consumiu: Ctrl+letra é do TUI.
  if (event.defaultPrevented) return null;
  if (isComposing(event)) return null;
  // AltGr (ABNT2, layouts europeus) chega como Ctrl+Alt e produz texto.
  if (
    platform !== 'darwin' &&
    event.getModifierState?.('AltGraph') &&
    !/^[a-z0-9]$/i.test(event.key)
  ) {
    return null;
  }
  // Num campo do app, digitar e andar no texto são do campo: sem ⌘/Ctrl é
  // caractere, e ⌘/Ctrl+setas/Backspace/Delete/Home/End editam a linha.
  if (
    context.editableFocus &&
    ((!event.metaKey && !event.ctrlKey) || TEXT_EDITING_KEYS.has(event.key))
  ) {
    return null;
  }

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (rule.whenAst && !evaluateWhenNode(rule.whenAst, context)) continue;
    if (rule.digitIndex) {
      const digit = digitFromInput(event, platform);
      const parsed = parseKeybinding(rule.binding);
      if (!digit || !parsed) continue;
      const candidate = canonicalizeParsedKeybinding({ ...parsed, key: digit });
      if (keybindingMatchesInput(candidate, event, platform)) {
        return { command: rule.command, index: Number(digit) - 1 };
      }
      continue;
    }
    if (keybindingMatchesInput(rule.binding, event, platform)) {
      return { command: rule.command };
    }
  }
  return null;
}

/** Contexto de foco a partir do alvo do evento (o resto vem dos stores). */
export function focusContext(target: EventTarget | null): {
  terminalFocus: boolean;
  editableFocus: boolean;
} {
  const element = target instanceof Element ? target : null;
  const terminalFocus = Boolean(element?.closest('.xterm'));
  return {
    terminalFocus,
    // O textarea do xterm é o terminal, não um campo do app.
    editableFocus:
      !terminalFocus &&
      Boolean(
        element?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
        ),
      ),
  };
}
