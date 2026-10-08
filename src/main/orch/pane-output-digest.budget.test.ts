// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência (T3 Code, MIT): só o método de
// packages/client-runtime/src/operations/commands.performance.test.ts (teto de
// bytes pinado e CI que falha), num teste do Nexus para o digest de `nexus_pane_read`: o
// "wire" aqui é o texto que vai para o contexto do orquestrador (tokens).

/**
 * QLT-01 — orçamento do digest de pane (F-digest / F-961).
 *
 * O orquestrador lê o tail de vários panes a cada decisão; cada caractere do
 * digest é token gasto. A janela sintética é o que uma TUI de agente deixa no
 * anel: 12 passos de conteúdo, cada um seguido de 15 quadros de status com
 * relógio, a caixa de input redesenhada e o spinner. Contagem pura de
 * caracteres e linhas. Como mudar um teto: docs/perf-budgets.md.
 *
 * Tetos (valor medido no commit que criou o orçamento entre parênteses):
 * - digestChars (742): texto que o Maestro recebe para esta janela.
 * - keptLines (26): linhas emitidas — os 12 passos e os resultados deles
 *   (24), UM status (o mais recente) e UMA cópia da caixa de input. Sem a
 *   deduplicação de quadros, cada rodada de status e cada caixa redesenhada
 *   voltaria para o contexto.
 */
import { describe, expect, it } from 'vitest';
import { digestPaneTail } from './pane-output-digest';

const BUDGET = {
  digestChars: 742,
  keptLines: 26,
} as const;

const STEPS = 12;
const FRAMES_PER_STEP = 15;

function agentWindow(): string {
  const lines: string[] = [];
  let seconds = 3;
  for (let step = 0; step < STEPS; step += 1) {
    lines.push(`⏺ Read(src/main/orch/module-${step}.ts)`);
    lines.push(`  ⎿  Read ${120 + step * 7} lines`);
    for (let frame = 0; frame < FRAMES_PER_STEP; frame += 1) {
      seconds += 1;
      lines.push(`✻ Working… (${seconds}s · ↑ ${seconds * 13} tokens · esc to interrupt)`);
      lines.push('╭──────────────────────────────────────────────╮');
      lines.push('│ > Try "refactor pane-output-digest"          │');
      lines.push('╰──────────────────────────────────────────────╯');
    }
  }
  return lines.join('\n');
}

describe('orçamento do digest de pane (QLT-01)', () => {
  it(`janela de TUI com ${STEPS} passos × ${FRAMES_PER_STEP} quadros cabe no teto de caracteres e linhas`, () => {
    const digest = digestPaneTail(agentWindow());
    const work = { digestChars: digest.text.length, keptLines: digest.keptLines };
    console.info('[perf-budget] pane-digest', JSON.stringify(work));

    // O orçamento só vale se o que decide a próxima ação continua lá.
    expect(digest.text).toContain(`⏺ Read(src/main/orch/module-${STEPS - 1}.ts)`);
    expect(digest.text).toContain(`esc to interrupt`);
    expect(digest.truncated).toBe(false);
    expect(work.digestChars).toBeLessThanOrEqual(BUDGET.digestChars);
    expect(work.keptLines).toBeLessThanOrEqual(BUDGET.keptLines);
  });
});
