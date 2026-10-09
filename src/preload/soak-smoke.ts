import type { NexusApi } from '../shared/types';
import type { FunctionalSmokeResult } from '../shared/smoke-types';
import { SOAK_CHANNELS, SOAK_DOM_REQUEST, SOAK_DOM_REPLY, SOAK_POLICY, soakNonce, parseSoakCycle, type SoakCycle } from '../shared/soak-smoke';
import { runFunctionalSmokeProbes } from './functional-smoke';

export interface SoakUi {
  open(): Promise<{ paneId: string; sessionId: string }>;
  view(paneId: string, marker: string, sequence: number): Promise<{ frames: number; renderedMarker: boolean; scroll: boolean; resize: boolean; rendererHosts: number }>;
  close(paneId: string): Promise<void>;
}

interface SmokeIpc {
  on(channel: string, handler: (event: unknown, raw: unknown) => void): unknown;
  removeListener(channel: string, handler: (event: unknown, raw: unknown) => void): unknown;
  send(channel: string, value: unknown): void;
}
/** Electron 43.7.4 documents getHeapStatistics in sandboxed preload, in KiB.
 * https://github.com/electron/electron/blob/v43.7.4/docs/api/process.md */
export function installSoakPreload(ipc: SmokeIpc, api: NexusApi, processInfo: {
  pid: number; isMainFrame?: boolean; versions: { electron?: string }; getHeapStatistics(): { usedHeapSize: number };
}): void {
  let started = false;
  ipc.on(SOAK_CHANNELS.run, (_event, raw) => {
    if (started || processInfo.isMainFrame !== true || !raw || typeof raw !== 'object' || Object.keys(raw).length !== 2) return;
    const { nonce, workspacePath } = raw as { nonce: unknown; workspacePath: unknown };
    if (!soakNonce.safeParse(nonce).success || typeof nonce !== 'string' || typeof workspacePath !== 'string' || !workspacePath.startsWith('/') || workspacePath.length > 4096) return;
    started = true;
    const controller = new AbortController();
    let request = 0;
    let uiPending: { request: number; resolve(value: unknown): void; reject(error: Error): void } | null = null;
    let ackPending: { sequence: number; resolve(done: boolean): void; reject(error: Error): void } | null = null;
    const onReply = (event: Event): void => {
      const value = (event as CustomEvent).detail;
      if (!uiPending || !value || typeof value !== 'object' || value.nonce !== nonce || value.request !== uiPending.request) return;
      const pending = uiPending; uiPending = null;
      if (value.ok === true) pending.resolve(value.value); else pending.reject(new Error('soak UI request failed'));
    };
    const onAck = (_event: unknown, value: unknown): void => {
      if (!ackPending || !value || typeof value !== 'object') return;
      const ack = value as { nonce?: unknown; sequence?: unknown; done?: unknown };
      if (ack.nonce !== nonce || ack.sequence !== ackPending.sequence || typeof ack.done !== 'boolean') return;
      const pending = ackPending; ackPending = null; pending.resolve(ack.done);
    };
    const onStop = (_event: unknown, value: unknown): void => {
      if (!value || typeof value !== 'object' || (value as { nonce?: unknown }).nonce !== nonce) return;
      controller.abort(); const pending = ackPending; ackPending = null; pending?.reject(new Error('soak stopped'));
      // Do not settle an in-flight UI spawn early. Its eventual reply is
      // drained and its pane closed by runSoakActivity before stopped ACK.
    };
    const uiRequest = (operation: string, fields: object = {}): Promise<unknown> => new Promise((resolve, reject) => {
      if (uiPending) { reject(new Error('overlapping soak UI request')); return; }
      uiPending = { request: request++, resolve, reject };
      window.dispatchEvent(new CustomEvent(SOAK_DOM_REQUEST, { detail: { nonce, request: uiPending.request, operation, ...fields } }));
    });
    window.addEventListener(SOAK_DOM_REPLY, onReply); ipc.on(SOAK_CHANNELS.ack, onAck); ipc.on(SOAK_CHANNELS.stop, onStop);
    const ui: SoakUi = {
      async open() {
        const value = await uiRequest('open') as { paneId?: unknown; sessionId?: unknown } | null;
        if (!value || typeof value.paneId !== 'string' || !value.paneId || value.paneId.length > 256 || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) throw new Error('invalid soak UI session');
        return { paneId: value.paneId, sessionId: value.sessionId };
      },
      async view(paneId, marker, sequence) { return await uiRequest('view', { paneId, marker, sequence }) as Awaited<ReturnType<SoakUi['view']>>; },
      async close(paneId) { await uiRequest('close', { paneId }); },
    };
    void runSoakActivity(api, { nonce, workspacePath }, {
      ui, signal: controller.signal, rendererPid: processInfo.pid, electronVersion: processInfo.versions.electron ?? '',
      heap: () => processInfo.getHeapStatistics().usedHeapSize,
      sendCycle: value => new Promise((resolve, reject) => {
        if (ackPending || controller.signal.aborted) { reject(new Error('soak cycle cancelled/overlapping')); return; }
        ackPending = { sequence: value.sequence, resolve, reject }; ipc.send(SOAK_CHANNELS.cycle, value);
      }),
      stopped: async sessionIds => { ipc.send(SOAK_CHANNELS.stopped, { nonce, sessionIds }); },
      finalFunctional: () => runFunctionalSmokeProbes(api, workspacePath),
      done: async result => { ipc.send(SOAK_CHANNELS.done, { nonce, result }); },
    }).catch(() => ipc.send(SOAK_CHANNELS.failed, { nonce })).finally(() => {
      window.removeEventListener(SOAK_DOM_REPLY, onReply); ipc.removeListener(SOAK_CHANNELS.ack, onAck); ipc.removeListener(SOAK_CHANNELS.stop, onStop);
    });
  });
}
/** Sole activity flight. Main owns physical termination; UI close alone never proves it. */
export async function runSoakActivity(api: Pick<NexusApi, 'workspace' | 'files' | 'product' | 'pty'>,
  input: { nonce: string; workspacePath: string }, deps: {
    ui: SoakUi; signal: AbortSignal; sendCycle(cycle: SoakCycle): Promise<boolean>;
    stopped(sessionIds: string[]): Promise<void>; heap(): number; rendererPid: number; electronVersion: string;
    finalFunctional(): Promise<FunctionalSmokeResult>; done(result: FunctionalSmokeResult): Promise<void>;
    delay?(ms: number): Promise<void>;
  }): Promise<void> {
  const held = new Set<string>();
  const check = (): void => { if (deps.signal.aborted) throw new Error('soak activity cancelled'); };
  const delay = deps.delay ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let completed = false;
  try {
    for (let sequence = 0; sequence < SOAK_POLICY.maxSamples; sequence++) {
      check();
      const workspace = await api.workspace.get(); check();
      if (workspace.current?.path !== input.workspacePath) throw new Error('soak workspace changed');
      const file = await api.files.read('smoke.txt'); check();
      if (!file.ok || file.content !== 'nexus-functional-smoke\n') throw new Error('soak workspace read failed');
      const search = await api.product.searchQuery({ text: 'smoke', limit: 5 }); check();
      if (!search || typeof search !== 'object') throw new Error('soak local search failed');
      const pane = await deps.ui.open(); held.add(pane.sessionId);
      let unsubscribe: (() => void) | null = null;
      try {
        check();
        const left = `SOAK_${input.nonce}_${sequence}`, marker = `${left}_DONE`;
        let output = '';
        unsubscribe = api.pty.onData(pane.sessionId, data => { output = (output + data).slice(-128 * 1024); });
        api.pty.resize(pane.sessionId, 88 + sequence % 2 * 8, 24, { assert: true });
        // The joined marker is absent from the typed command: terminal echo
        // cannot stand in for actual shell execution. Produce scrollback too.
        // Keep startup input below the canonical tty line limit, while the
        // same 96 executed lines still prove real rendered scrollback.
        const command = `i=0; while [ "$i" -lt 96 ]; do printf 'soak-output-${sequence}-%s\\n' "$i"; i=$((i+1)); done; printf '%s%s\\n' '${left}' '_DONE'\r`;
        if (!await api.pty.writeConfirmed(pane.sessionId, command)) throw new Error('soak write refused');
        check();
        for (let waited = 0; !output.includes(marker) && waited < 5000; waited += 50) { await delay(50); check(); }
        if (!output.includes(marker)) throw new Error('soak executed marker missing');
        const view = await deps.ui.view(pane.paneId, marker, sequence); check();
        const value = parseSoakCycle({ nonce: input.nonce, sequence, ...pane, rendererPid: deps.rendererPid,
          electronVersion: deps.electronVersion, heapUsedKiB: deps.heap(), rendererHosts: view.rendererHosts,
          activity: { writeConfirmed: true, executedMarker: true, renderedMarker: view.renderedMarker,
            frames: view.frames, scroll: view.scroll, resize: view.resize, workspaceRead: true, search: true } });
        if (!value) throw new Error('soak renderer metrics/activity unavailable');
        const done = await deps.sendCycle(value); check();
        held.delete(pane.sessionId); // ACK exists only after Main physical proof.
        if (done) { completed = true; break; }
      } finally { unsubscribe?.(); await deps.ui.close(pane.paneId); }
      await delay(SOAK_POLICY.intervalMs); check();
    }
    if (!completed) throw new Error('soak activity count exhausted');
    check();
    const result = await deps.finalFunctional(); check();
    if (!result.ok) throw new Error('soak final functional probes failed');
    await deps.done(result);
  } catch (error) {
    await deps.stopped([...held]); // Includes a spawn that finished after cancellation.
    throw error;
  }
}
