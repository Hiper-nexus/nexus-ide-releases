// QLT-07 (harvest T3 Code @ 26285ab, ideia da regra `no-rpc-permission-bypass`;
// código escrito aqui, sem copiar o upstream).
//
// No Main, todo canal IPC novo passa por `handleTrusted`/`onTrusted`
// (`src/main/security/trusted-ipc.ts`): só a janela principal registrada, no
// frame principal e na origem esperada, chega ao handler. `ipcMain.handle`/
// `ipcMain.on` cru aceita qualquer WebContents — aba do navegador, subframe,
// janela auxiliar. No preload, `ipcRenderer` cru só existe nas pontes do
// `contextBridge`.
//
// O que já existia cru fica em RAW_IPC_ALLOWLIST com o motivo e o TETO de
// chamadas cruas do arquivo: chamada nova acima do teto é erro, e o teste da
// regra exige o teto igual à contagem real (migrar um canal baixa o teto).

import path from 'node:path';

// Map, não objeto: `Object.prototype.hasOwnProperty.call(...)` chegava aqui
// com o nome `hasOwnProperty` e achava o método herdado do objeto.
const RAW_METHODS = new Map([
  [
    'ipcMain',
    new Set(['handle', 'handleOnce', 'on', 'once', 'addListener', 'prependListener', 'prependOnceListener']),
  ],
  [
    'ipcRenderer',
    new Set([
      'invoke',
      'send',
      'sendSync',
      'sendToHost',
      'postMessage',
      'on',
      'once',
      'addListener',
      'prependListener',
      'prependOnceListener',
    ]),
  ],
]);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const LEGACY_MAIN =
  'legado anterior ao QLT-07: a autoridade sai do `event.sender` dentro de cada handler ' +
  '(escopo do workspace do renderer, sessão dona do PTY) ou o canal não tem guarda; ' +
  'migrar para `handleTrusted`/`onTrusted` canal a canal e baixar o teto.';
const PRELOAD_BRIDGE =
  'ponte do preload: o `contextBridge` expõe ao renderer só as funções daqui; é o único lugar com `ipcRenderer`.';

/**
 * Arquivo (relativo à raiz do repo) → teto de chamadas cruas e por quê.
 * Só diminui: arquivo novo usa `handleTrusted`/`onTrusted`.
 */
export const RAW_IPC_ALLOWLIST = {
  // Os próprios wrappers.
  'src/main/security/trusted-ipc.ts': { max: 2, reason: 'é o wrapper `handleTrusted`/`onTrusted`.' },
  'src/main/runtime/git-ipc-guard.ts': {
    max: 1,
    reason: 'é o wrapper `onIpcGuarded` (proteção contra falha de git); quem chama decide a autoridade.',
  },
  // Pontes do preload.
  'src/preload/preload.ts': { max: 436, reason: PRELOAD_BRIDGE },
  'src/preload/integrations-bridge.ts': { max: 33, reason: PRELOAD_BRIDGE },
  'src/preload/pet-preload.ts': { max: 19, reason: `${PRELOAD_BRIDGE} Janela do pet, inclusive a sonda de cursor.` },
  'src/preload/browser-preload.ts': { max: 5, reason: `${PRELOAD_BRIDGE} Páginas das abas do navegador.` },
  // Remetentes que não são só a janela principal, ou guarda com resposta própria.
  'src/main/pet/pet-window.ts': {
    max: 14,
    reason: 'a janela do pet também chama (nunca é registrada como principal); `fromTrustedWindow` aceita as duas.',
  },
  'src/main/window.ts': {
    max: 4,
    reason: 'checa `isLiveTrustedMainWindowSender` dentro do handler para responder `{ ok: false }` em vez de lançar.',
  },
  // Legado do Main.
  'src/main/adapters/adapter-ipc.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/adapters/auth-probe.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/agent-hooks/hook-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/agents/agent-lifecycle-service.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/browser/browser-manager.ts': { max: 21, reason: LEGACY_MAIN },
  'src/main/context/context-draft-ipc.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/context/orientation/orientation-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/design/design-ipc.ts': { max: 8, reason: LEGACY_MAIN },
  'src/main/discovery/discovery-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/eval/eval-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/gamification/gamification-ipc.ts': { max: 6, reason: LEGACY_MAIN },
  'src/main/integrations/integrations-ipc.ts': { max: 31, reason: LEGACY_MAIN },
  'src/main/jarvis/mcp-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/jev/jev-ipc.ts': { max: 6, reason: LEGACY_MAIN },
  'src/main/media/media-ipc.ts': { max: 8, reason: LEGACY_MAIN },
  'src/main/memory/memory-ipc.ts': { max: 6, reason: LEGACY_MAIN },
  'src/main/observability/main-heartbeat-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/ops/ops-ipc.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/orch/cost-ipc.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/orch/mission-event-ipc.ts': { max: 4, reason: LEGACY_MAIN },
  'src/main/orch/orch-ipc.ts': { max: 46, reason: LEGACY_MAIN },
  'src/main/orch/pane-pipe-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/orch/token-speed-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/persistence/account-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/persistence/billing-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/persistence/files-ipc.ts': { max: 9, reason: LEGACY_MAIN },
  'src/main/persistence/layout-ipc.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/persistence/provider-config-store.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/persistence/settings-store.ts': { max: 5, reason: LEGACY_MAIN },
  'src/main/persistence/workspace-store.ts': { max: 6, reason: LEGACY_MAIN },
  'src/main/product-wave-ipc.ts': { max: 22, reason: LEGACY_MAIN },
  'src/main/pty/pty-ipc.ts': { max: 5, reason: LEGACY_MAIN },
  'src/main/quota/quota-service.ts': { max: 2, reason: LEGACY_MAIN },
  'src/main/remote/relay/companion-relay-ipc.ts': { max: 3, reason: LEGACY_MAIN },
  'src/main/remote/remote-ipc.ts': { max: 12, reason: LEGACY_MAIN },
  'src/main/search/search-mixer-ipc.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/terminal/terminal-block-actions-ipc.ts': { max: 5, reason: LEGACY_MAIN },
  'src/main/usage/usage-service.ts': { max: 1, reason: LEGACY_MAIN },
  'src/main/vision/ipc-bridge.ts': { max: 9, reason: LEGACY_MAIN },
  'src/main/voice/voice-ipc.ts': { max: 24, reason: LEGACY_MAIN },
};

export const NO_RAW_IPC_MESSAGE =
  'IPC cru fora dos wrappers: no Main use `handleTrusted`/`onTrusted` (src/main/security/trusted-ipc.ts); ' +
  '`ipcRenderer` só nas pontes do preload. Exceção vai para RAW_IPC_ALLOWLIST com motivo.';

/** `ipcMain.handle(...)`, `electron.ipcMain.on(...)`, `ipcRenderer.invoke(...)`. */
export function rawIpcCall(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  const target = callee.object;
  const name =
    target.type === 'Identifier'
      ? target.name
      : target.type === 'MemberExpression' && !target.computed
        ? target.property.name
        : null;
  return Boolean(name && RAW_METHODS.get(name)?.has(callee.property.name));
}

export function repoRelative(filename, cwd) {
  const relative = path.isAbsolute(filename) ? path.relative(cwd, filename) : filename;
  return relative.split(path.sep).join('/');
}

const noRawIpc = {
  meta: {
    type: 'problem',
    docs: {
      description: 'IPC do Electron só pelos wrappers confiáveis (handleTrusted/onTrusted) e pelas pontes do preload.',
    },
    // A configuração do repo não passa opção; o teste passa outra lista para
    // provar que o teto de cada arquivo é exato.
    schema: [
      {
        type: 'object',
        properties: { allowlist: { type: 'object' } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const file = repoRelative(context.filename, context.cwd);
    // Só o app: `scripts/` (verificações que sobem um Electron próprio) e testes ficam de fora.
    if (!file.startsWith('src/') || TEST_FILE_PATTERN.test(file)) return {};
    const allowlist = context.options[0]?.allowlist ?? RAW_IPC_ALLOWLIST;
    const max = allowlist[file]?.max ?? 0;
    let seen = 0;
    return {
      CallExpression(node) {
        if (!rawIpcCall(node)) return;
        seen += 1;
        if (seen > max) context.report({ node, message: NO_RAW_IPC_MESSAGE });
      },
    };
  },
};

export default noRawIpc;
