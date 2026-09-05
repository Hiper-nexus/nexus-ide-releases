/** Real Electron regression: an opened xterm in a hidden view must still spawn.
 * NEXUS_CDP_PORT=9237 NEXUS_E2E_WORKSPACE=/private/tmp/nexus-engine-proof node scripts/spikes/e2e-hidden-pane-spawn.mjs
 * Requires an already running DEV instance and the explicitly named test workspace.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workspace = process.env.NEXUS_E2E_WORKSPACE;
if (!workspace) throw new Error('Set NEXUS_E2E_WORKSPACE to an isolated test project.');
const session = 'nexus-hidden-pane-e2e';
const browser = (...args) => run('agent-browser', ['--session', session, ...args], { maxBuffer: 1024 * 1024 });
await browser('connect', process.env.NEXUS_CDP_PORT ?? '9237');
const expression = `(async () => {
  const loadedModule = (path) => import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === path).at(-1)?.name ?? path);
  const { useWorkspaceStore: workspaces } = await loadedModule('/src/renderer/state/workspace-store.ts');
  if (workspaces.getState().current?.path !== ${JSON.stringify(workspace)}) throw new Error('Wrong workspace: test refused.');
  const { useLayoutStore: layout } = await loadedModule('/src/renderer/state/layout-store.ts');
  const { useProductNavigationStore: navigation } = await loadedModule('/src/renderer/state/product-navigation-store.ts');
  const { waitForSession } = await loadedModule('/src/renderer/terminal/terminal-host.ts');
  const previous = navigation.getState().destination;
  const previousSettingsReturn = navigation.getState().settingsReturnDestination;
  navigation.getState().openTaskBoard();
  const paneId = layout.getState().addShellPane();
  if (!paneId) throw new Error('No test pane created.');
  try {
    let pane;
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      pane = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes(paneId))?.closest('.pane');
      if (pane?.querySelector('.xterm')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const geometry = { hidden: Boolean(pane?.closest('[hidden]')), xtermOpened: Boolean(pane?.querySelector('.xterm')), width: pane?.clientWidth, height: pane?.clientHeight };
    const started = Date.now();
    const sessionId = await waitForSession(paneId, 1800);
    return { passed: geometry.hidden && geometry.xtermOpened && geometry.width === 0 && geometry.height === 0 && Boolean(sessionId), paneId, sessionId, elapsedMs: Date.now() - started, geometry };
  } finally {
    layout.getState().close(paneId, 'hidden-spawn-e2e');
    if (navigation.getState().destination.kind === 'task-board') navigation.setState({ destination: previous, settingsReturnDestination: previousSettingsReturn });
  }
})()`;
const { stdout } = await browser('eval', expression);
const result = JSON.parse(stdout);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.passed ? 0 : 1;
