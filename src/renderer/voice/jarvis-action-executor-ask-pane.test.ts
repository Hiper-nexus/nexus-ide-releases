import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ask_pane safety path', () => {
  it('routes model-authored pane writes through confirmed/audited MCP', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'jarvis-action-executor.ts'),
      'utf8',
    );
    const branch = source.slice(source.indexOf("action.type === 'ask_pane'"));
    // A pergunta vai por `nexus_pane_ask` (digita, espera o pane ficar ocioso e
    // devolve só o texto novo): a Jarvis narra a RESPOSTA, não "mandei".
    expect(branch).toContain("tool: 'nexus_pane_ask'");
    expect(branch).toContain('executeViaMcp(');
    expect(branch).not.toContain('writeToPane(');
  });
});

describe('ask_pane: resumo e fala honestos', () => {
  it('respondeu, ainda trabalhando ou one-shot: nunca "ok" genérico', async () => {
    const { paneAskSummary, paneAskNarration } = await import('./jarvis-action-executor');
    const answered = { ok: true, summary: 'nexus_pane_ask ok', output: { ok: true, state: 'idle', answer: '3 testes passaram' } };
    expect(paneAskSummary(answered)).toContain('respondeu');
    expect(paneAskNarration(answered)).toBe('3 testes passaram');

    const busy = { ok: true, summary: 'nexus_pane_ask ok', output: { ok: false, state: 'timeout', answer: '(o pane não produziu texto novo dentro do prazo)' } };
    expect(paneAskSummary(busy)).toContain('ainda não respondeu');
    expect(paneAskNarration(busy)).not.toContain('(o pane');

    const oneShot = { ok: true, summary: 'nexus_pane_ask ok', output: { ok: false, state: 'oneshot', answer: 'x' } };
    expect(paneAskSummary(oneShot)).toContain('one-shot');

    const failed = { ok: false, summary: 'pane não encontrado' };
    expect(paneAskSummary(failed)).toBe('pane não encontrado');
    expect(paneAskNarration(failed)).toBeNull();
  });
});
