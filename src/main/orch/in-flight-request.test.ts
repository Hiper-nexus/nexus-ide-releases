import { afterEach, describe, expect, it } from 'vitest';
import {
  FAILOVER_HANDOFF_FOOTER,
  FAILOVER_HANDOFF_HEADER,
  MAX_IN_FLIGHT_REQUEST_CHARS,
  buildContinuityPack,
  buildCrossAccountResumeNote,
} from '../../shared/failover-handoff';
import {
  carryInFlightRequests,
  inFlightRequestOf,
  noteInFlightRequest,
  resetInFlightRequestsForTests,
} from './in-flight-request';

afterEach(() => resetInFlightRequestsForTests());

/** Texto longo com palavras (o corte nunca depende de um caractere único). */
function longText(label: string, chars: number): string {
  let text = '';
  for (let i = 0; text.length < chars; i += 1) text += `${label}-${i} `;
  return text.slice(0, chars).trim();
}

describe('F-1482: pedidos em voo por pane (memória do Main)', () => {
  it('lembra o último pedido entregue ao pane', () => {
    noteInFlightRequest('pane-a', '  Implementar o login  ');
    expect(inFlightRequestOf('pane-a')).toBe('Implementar o login');
    expect(inFlightRequestOf('pane-b')).toBeUndefined();
    expect(inFlightRequestOf(undefined)).toBeUndefined();
  });

  it('guarda os três mais recentes, sem repetir o mesmo, e devolve o MAIS RECENTE primeiro', () => {
    for (const request of ['brief', 'direção 1', 'handoff X', 'direção 1', 'direção 2']) {
      noteInFlightRequest('maestro', request);
    }
    expect(inFlightRequestOf('maestro')).toBe('Latest: direção 2 | Earlier: direção 1 | handoff X');
  });

  it('o pacote ou a nota do próprio failover não apagam o pedido real', () => {
    noteInFlightRequest('pane-a', 'Corrigir o build');
    noteInFlightRequest('pane-a', `${FAILOVER_HANDOFF_HEADER}\npack\n${FAILOVER_HANDOFF_FOOTER}`);
    noteInFlightRequest('pane-a', '   ');
    noteInFlightRequest(undefined, 'sem pane');
    expect(inFlightRequestOf('pane-a')).toBe('Corrigir o build');
  });

  it('o pane novo do respawn herda os pedidos do que parou (troca em cadeia A → B → C)', () => {
    noteInFlightRequest('old-pane', 'brief');
    noteInFlightRequest('old-pane', 'ajuste do Maestro');
    carryInFlightRequests('old-pane', 'new-pane');
    expect(inFlightRequestOf('new-pane')).toBe('Latest: ajuste do Maestro | Earlier: brief');
    carryInFlightRequests('new-pane', 'third-pane');
    expect(inFlightRequestOf('third-pane')).toBe(inFlightRequestOf('old-pane'));
  });
});

describe('F-1482 (revisão): a orientação mais recente nunca se perde', () => {
  it('brief de 2.000 caracteres + "ajuste: use API v2": o ajuste vai inteiro no pacote E na nota', () => {
    noteInFlightRequest('pane-a', longText('brief', 2_000));
    noteInFlightRequest('pane-a', 'ajuste: use API v2');
    const request = inFlightRequestOf('pane-a')!;
    expect(request.startsWith('Latest: ajuste: use API v2 | Earlier: brief-0')).toBe(true);
    expect(request.length).toBeLessThanOrEqual(MAX_IN_FLIGHT_REQUEST_CHARS);
    const pack = buildContinuityPack({
      fromAccountLabel: 'a@example.com', toAccountLabel: 'b@example.org', reason: 'quota', inFlightRequest: request,
    });
    expect(pack).toContain('finish it if it is not done): Latest: ajuste: use API v2 | Earlier: brief-0');
    const note = buildCrossAccountResumeNote({ toAccountLabel: 'b@example.org', inFlightRequest: request });
    expect(note).toContain('Request in flight: Latest: ajuste: use API v2');
  });

  it('o mais recente sozinho maior que o teto é cortado só no fim dele', () => {
    noteInFlightRequest('pane-a', longText('pedido', 3_000));
    const request = inFlightRequestOf('pane-a')!;
    expect(request.length).toBe(MAX_IN_FLIGHT_REQUEST_CHARS);
    expect(request.startsWith('pedido-0 pedido-1')).toBe(true);
    expect(request.endsWith('…')).toBe(true);
  });

  it('três pedidos longos: o mais recente inteiro; o anterior cortado; o mais antigo é o primeiro a sair', () => {
    const oldest = longText('antigo', 1_000);
    const middle = longText('meio', 1_000);
    const latest = longText('novo', 1_000);
    for (const request of [oldest, middle, latest]) noteInFlightRequest('pane-a', request);
    const request = inFlightRequestOf('pane-a')!;
    expect(request.startsWith(`Latest: ${latest} | Earlier: meio-0`)).toBe(true);
    expect(request).not.toContain(middle);
    expect(request).not.toContain('antigo-0');
    expect(request.length).toBeLessThanOrEqual(MAX_IN_FLIGHT_REQUEST_CHARS);
  });
});
