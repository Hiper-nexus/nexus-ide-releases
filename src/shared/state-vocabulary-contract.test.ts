/**
 * Contrato: um estado, uma palavra — em toda superfície.
 *
 * A auditoria de UI (23/08) achou TRÊS mapas paralelos para o mesmo enum de
 * pane e a palavra "Pronto" significando duas coisas na mesma tela (missão
 * entregue × agente parado), com a mesma cor. Este arquivo trava a decisão:
 * a fonte é única e as palavras não colidem.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { paneSessionView } from './pane-session-view';
import { MISSION_LIFECYCLE_LABELS } from '../renderer/lib/mission-lifecycle-copy';

const SRC = path.resolve(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

describe('vocabulário de estado tem UMA fonte', () => {
  it('nenhum componente declara seu próprio mapa de PaneSessionState', () => {
    // Um mapa local é como o produto passa a falar dois idiomas: o de
    // ProjectOverview trazia `idle: "Idle"`, em inglês, contra a fonte.
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith(path.join('shared', 'pane-session-view.ts')))
      .filter((file) =>
        /Record<\s*PaneSessionState\s*,\s*string\s*>/u.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe('uma palavra, um significado', () => {
  it('"Pronto" é da ENTREGA — agente parado não usa a mesma palavra', () => {
    expect(MISSION_LIFECYCLE_LABELS.completed).toBe('Pronto');
    expect(paneSessionView('idle').chip).not.toBe('Pronto');
  });

  it('trabalho em curso usa a MESMA palavra na missão e no agente', () => {
    expect(MISSION_LIFECYCLE_LABELS.running).toBe('Trabalhando');
    expect(paneSessionView('busy').chip).toBe('Trabalhando');
  });

  it('nenhum chip de pane colide com outro rótulo de ciclo de missão', () => {
    const missionWords = new Set(
      Object.entries(MISSION_LIFECYCLE_LABELS)
        .filter(([state]) => state !== 'running')
        .map(([, label]) => label),
    );
    for (const state of ['idle', 'busy', 'spawning', 'exited', 'hibernated'] as const) {
      expect(missionWords.has(paneSessionView(state).chip)).toBe(false);
    }
  });
});
