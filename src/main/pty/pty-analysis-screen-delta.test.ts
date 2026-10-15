import { describe, expect, it } from 'vitest';
import { SessionScreenBuffer } from '../detect/screen-buffer';
import { PtyAnalysisClient } from './pty-analysis-client';
import { PtyAnalysisCore } from './pty-analysis-core';
import type { AnalysisResult } from './pty-analysis-protocol';

/**
 * #3 da auditoria de velocidade: o worker não pode clonar os 256 KB de
 * screenText a cada 100 ms por pane. Só o texto NOVO atravessa o postMessage;
 * o Main mantém o espelho e `analysisClient.text()` segue devolvendo o mesmo
 * texto que a tela do worker (readSessionOutput, activeScreenText, Jev).
 */
const SESSION = 's';
const MAX_SCREEN_CHARS = 262_144;

function loop() {
  let now = 1_000;
  const results: AnalysisResult[] = [];
  let client!: PtyAnalysisClient;
  const core = new PtyAnalysisCore([], (result) => { results.push(result); client.accept(result); });
  client = new PtyAnalysisClient({ post: (record) => core.process(record), flow: () => {}, now: () => now });
  client.bind(SESSION, { adapterId: 'codex' });
  return {
    client, core, results,
    tick: (ms: number) => { now += ms; },
    /** Texto de tela que cruzou o postMessage (chars de string clonados). */
    clonedScreenChars: () => results.reduce((sum, r) => sum + (r.screenText?.length ?? 0) + (r.screenAppend?.length ?? 0), 0),
  };
}

/** Saída de TUI sintética: quadros ANSI de ~160 chars, escapes cortados no meio do chunk. */
function frame(index: number): string {
  return `\x1b[2K\x1b[1;32mstep ${index}\x1b[0m ${'·'.repeat(120)} \x1b[38;5;244mtok=${index * 7}\x1b[0m\r\n`;
}

describe('delta de screenText do worker de análise', () => {
  it('o espelho do Main é idêntico à tela do worker, inclusive passando do teto de 256 KB', async () => {
    const { client, tick } = loop();
    const reference = new SessionScreenBuffer();
    for (let i = 0; i < 4_000; i += 1) {
      // Corta o chunk no meio de um escape para exercitar o pendingRaw.
      const raw = frame(i);
      const cut = 3 + (i % 11);
      for (const part of [raw.slice(0, cut), raw.slice(cut)]) {
        client.data(SESSION, part);
        reference.append(SESSION, part);
      }
      tick(10);
    }
    expect(await client.barrier(SESSION)).toBe(true);
    const expected = reference.text(SESSION);
    expect(expected.length).toBe(MAX_SCREEN_CHARS);
    expect(client.text(SESSION)).toBe(expected);
  });

  it('com o fluxo parado, nada de tela atravessa o postMessage', async () => {
    const { client, tick, clonedScreenChars } = loop();
    client.data(SESSION, frame(1));
    tick(200);
    expect(await client.barrier(SESSION)).toBe(true);
    const before = clonedScreenChars();
    for (let i = 0; i < 20; i += 1) { tick(150); expect(await client.barrier(SESSION)).toBe(true); }
    expect(clonedScreenChars()).toBe(before);
    expect(client.text(SESSION)).toContain('step 1');
  });

  it('um novo bind recomeça o espelho do zero', async () => {
    const { client, tick } = loop();
    client.data(SESSION, 'primeira vida\n');
    tick(200);
    expect(await client.barrier(SESSION)).toBe(true);
    expect(client.text(SESSION)).toBe('primeira vida\n');
    client.bind(SESSION, { adapterId: 'codex' });
    client.data(SESSION, 'segunda vida\n');
    tick(200);
    expect(await client.barrier(SESSION)).toBe(true);
    expect(client.text(SESSION)).toBe('segunda vida\n');
  });

  it('fluxo de 6 panes a 100 chunks/s: chars clonados por segundo ficam perto do volume novo, não de 256 KB × 10/s', async () => {
    const PANES = 6;
    const SECONDS = 5;
    const panes = Array.from({ length: PANES }, () => loop());
    // Enche o teto de cada pane antes de medir (o caso caro do baseline).
    for (const pane of panes) {
      for (let i = 0; i < 2_000; i += 1) pane.client.data(SESSION, frame(i));
      pane.tick(200);
      await pane.client.barrier(SESSION);
    }
    const baseline = panes.map((pane) => pane.clonedScreenChars());
    let fresh = 0;
    for (let step = 0; step < SECONDS * 100; step += 1) {
      for (const pane of panes) {
        const raw = frame(step);
        fresh += raw.length;
        pane.client.data(SESSION, raw);
        pane.tick(10);
      }
    }
    for (const pane of panes) await pane.client.barrier(SESSION);
    const cloned = panes.reduce((sum, pane, index) => sum + pane.clonedScreenChars() - baseline[index], 0);
    const perSecond = Math.round(cloned / SECONDS);
    // eslint-disable-next-line no-console
    console.info('[perf-budget] pty-analysis screenText', JSON.stringify({ panes: PANES, seconds: SECONDS, freshCharsPerSecond: Math.round(fresh / SECONDS), clonedCharsPerSecond: perSecond }));
    // Antes: ~10 snapshots/s × 262 144 chars × 6 panes ≈ 15,7 M chars/s.
    expect(cloned).toBeLessThanOrEqual(fresh * 1.5);
    for (const pane of panes) expect(pane.client.text(SESSION).length).toBe(MAX_SCREEN_CHARS);
  });
});
