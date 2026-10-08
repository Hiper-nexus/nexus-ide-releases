#!/usr/bin/env node
/**
 * Oráculo dos atalhos globais ANTERIORES ao resolver configurável.
 *
 * Executa o handler `onKey` de src/renderer/App.tsx no commit-base (o texto
 * real, tirado com `git show`), com stores falsos que só anotam a ação, sobre
 * uma matriz de teclas × modificadores × contextos. O resultado vira
 * src/renderer/lib/__fixtures__/legacy-app-shortcuts.json, que
 * keybindings.test.ts usa para exigir que os padrões novos façam exatamente
 * o que o App fazia (só comandos novos podem ocupar células antes vazias).
 *
 * Uso: node scripts/gen-legacy-shortcuts-oracle.mjs [commit]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? '53116f0d8';
const OUT = 'src/renderer/lib/__fixtures__/legacy-app-shortcuts.json';

const app = execFileSync('git', ['show', `${BASE}:src/renderer/App.tsx`], {
  encoding: 'utf8',
});
const start = app.indexOf('    const onKey = (event: KeyboardEvent) => {');
const end = app.indexOf("    window.addEventListener('keydown', onKey);", start);
if (start < 0 || end < 0) throw new Error(`handler onKey não encontrado em ${BASE}`);
const handlerTs = app.slice(start, end);
// Única sintaxe TS do trecho: a anotação do parâmetro (outra quebraria o
// `new Function` abaixo com SyntaxError — falha alta, nunca oráculo errado).
const handlerJs = handlerTs.replace('(event: KeyboardEvent)', '(event)');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const PANES = ['pane-0', 'pane-1', 'pane-2'];
let outcome = null;
let context = null;
const record = (command) => {
  outcome ??= command;
};

const navigation = {
  openSettings: (section) =>
    record(section === 'account' ? 'operator-profile' : 'settings'),
  openTaskBoard: () => record('task-board'),
  openProject: () => record('project-overview'),
  openNewMission: () => record('mission-new'),
  openTerminal: () => undefined,
  openMission: () => undefined,
  showMissionTerminals: () => undefined,
};
const layout = {
  get root() {
    return 'root';
  },
  get focusedPaneId() {
    return context.paneFocused ? 'pane-0' : null;
  },
  focus: (paneId) => record(`focus-pane-n:${PANES.indexOf(paneId)}`),
  split: (_paneId, direction) =>
    record(direction === 'row' ? 'split-right' : 'split-down'),
  toggleStageFocus: () => record('stage-focus'),
};
const env = {
  useAccessStore: { getState: () => ({ canUseApp: true }) },
  useConfirmStore: { getState: () => ({ pending: null }) },
  document: { querySelector: () => null },
  useProductNavigationStore: { getState: () => navigation },
  useBugReportDialogStore: { getState: () => ({ open: () => record('bug-report') }) },
  useWorkspaceStore: {
    getState: () => ({ current: context.hasWorkspace ? { path: '/w' } : null }),
  },
  // Lido a cada tecla (o handler fecha sobre o objeto, não sobre o valor).
  productFlags: new Proxy(
    {},
    {
      get: (_target, flag) =>
        flag === 'ui.projectOverview' && !context.projectOverview ? false : undefined,
    },
  ),
  FEATURE_FLAG_IDS: { uiProjectOverview: 'ui.projectOverview' },
  useAttentionInboxStore: {
    getState: () => ({
      setOpen: () => undefined,
      toggle: () => record('attention-inbox'),
    }),
  },
  useCommandPaletteStore: {
    getState: () => ({
      toggle: () => record('command-palette'),
      close: () => undefined,
    }),
  },
  useCheatsheetStore: { getState: () => ({ toggle: () => record('cheatsheet') }) },
  useLayoutStore: { getState: () => layout },
  listPanes: () => PANES.map((id) => ({ id })),
  attentionMissionIdForPane: () => null,
  requestPaneClose: () => record('close-pane'),
};
const names = Object.keys(env);
const onKey = new Function(
  ...names,
  `${handlerJs}\nreturn onKey;`,
)(...names.map((name) => env[name]));

const KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ',', '<', '/', '?', '.', ';', '[', ']', '-', '=',
  'Tab', 'Enter', 'Escape', 'Backspace', 'ArrowLeft', ' ',
  // mac ⌥ compõe: ⌥D = ∂, ⌥F = ƒ, ⌥W = ∑, ⌥K = ˚
  '∂', 'ƒ', '∑', '˚', 'ç',
];
const CONTEXTS = [];
for (const hasWorkspace of [false, true]) {
  for (const paneFocused of [false, true]) {
    for (const projectOverview of [false, true]) {
      CONTEXTS.push({ hasWorkspace, paneFocused, projectOverview });
    }
  }
}

const results = {};
let cases = 0;
CONTEXTS.forEach((ctx, ctxIndex) => {
  context = ctx;
  for (const key of KEYS) {
    for (let mods = 0; mods < 16; mods += 1) {
      outcome = null;
      let prevented = false;
      const event = {
        key,
        metaKey: Boolean(mods & 1),
        ctrlKey: Boolean(mods & 2),
        altKey: Boolean(mods & 4),
        shiftKey: Boolean(mods & 8),
        preventDefault: () => {
          prevented = true;
        },
      };
      onKey(event);
      cases += 1;
      if (outcome !== null || prevented) {
        results[`${ctxIndex}|${mods}|${key}`] = prevented
          ? outcome
          : `${outcome}!not-prevented`;
      }
    }
  }
});

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      base: BASE,
      source: 'src/renderer/App.tsx (onKey)',
      appSha256: sha256(app),
      handlerSha256: sha256(handlerTs),
      modsBits: { meta: 1, ctrl: 2, alt: 4, shift: 8 },
      panes: PANES.length,
      keys: KEYS,
      contexts: CONTEXTS,
      cases,
      results,
    },
    null,
    1,
  )}\n`,
);
console.log(`oráculo ${BASE}: ${cases} casos, ${Object.keys(results).length} com ação → ${OUT}`);
