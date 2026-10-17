/** @vitest-environment jsdom */
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HIBERNATE_MIN_LIVE_HOSTS,
  shouldHibernateHost,
} from './terminal-host';
import {
  discardTerminalOutput,
  flushTerminalOutput,
  getQueuedChars,
  pauseTerminalOutput,
  resetTerminalOutputSchedulerForTests,
  resumeTerminalOutput,
  takeQueuedTerminalOutput,
  writeTerminalOutput,
} from './terminal-output-scheduler';

// Estes testes exercitam o parser/buffer REAL do xterm, não a pintura em canvas.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null, configurable: true });
});

describe('shouldHibernateHost — hibernação de pane oculto em grid grande', () => {
  const base = {
    liveHosts: HIBERNATE_MIN_LIVE_HOSTS,
    isPaneVisible: false,
    isParked: false,
    opened: true,
    disposed: false,
    hasSession: true,
    spawnPending: false,
  };

  it('grid grande + pane oculto spawned → hiberna', () => {
    expect(shouldHibernateHost(base)).toBe(true);
  });

  it('grid pequeno nunca hiberna (custo não paga o risco)', () => {
    expect(
      shouldHibernateHost({ ...base, liveHosts: HIBERNATE_MIN_LIVE_HOSTS - 1 }),
    ).toBe(false);
  });

  it('limiar cobre 2 projetos abertos (6-8 panes cada = 12-16 hosts num Mac 24 GB)', () => {
    // 16/10: o limiar antigo (24) nunca hibernava o projeto em background de
    // um Mac com 2 projetos abertos. Ele precisa ficar abaixo do piso de 12.
    expect(HIBERNATE_MIN_LIVE_HOSTS).toBeLessThanOrEqual(12);
    expect(shouldHibernateHost({ ...base, liveHosts: 12 })).toBe(true);
    expect(shouldHibernateHost({ ...base, liveHosts: 16 })).toBe(true);
  });

  it('workspace oculto no app visível não descarta o xterm de uma sessão viva', () => {
    expect(shouldHibernateHost({ ...base, isParked: true })).toBe(false);
  });

  it('pane visível, sem sessão, mid-spawn ou held → nunca hiberna', () => {
    expect(shouldHibernateHost({ ...base, isPaneVisible: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, hasSession: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, opened: false })).toBe(false);
    expect(shouldHibernateHost({ ...base, spawnPending: true })).toBe(false);
    expect(shouldHibernateHost({ ...base, disposed: true })).toBe(false);
  });
});

describe('hibernação com o xterm REAL — a cauda que o scheduler segura sobrevive', () => {
  const terminals: Terminal[] = [];
  afterEach(() => {
    for (const term of terminals.splice(0)) term.dispose();
    resetTerminalOutputSchedulerForTests();
  });

  function realTerminal(): { term: Terminal; serializer: SerializeAddon } {
    const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    terminals.push(term);
    return { term, serializer };
  }
  const parsed = (term: Terminal, data: string): Promise<void> =>
    new Promise((resolve) => term.write(data, resolve));
  const screen = (term: Terminal): string =>
    Array.from({ length: term.buffer.active.length }, (_, row) =>
      term.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');

  it('xterm parseia o write de forma assíncrona: drenar a cauda para um term que vai ser descartado a perde', async () => {
    const { term, serializer } = realTerminal();
    await parsed(term, 'BASE\r\n');
    writeTerminalOutput(term, 'CAUDA-NAO-PARSEADA', { foreground: false });
    pauseTerminalOutput(term);
    // O que a hibernação fazia: destravar e drenar para o xterm que seria descartado.
    // Precondição do desenho: o flush entrega ao write, que ainda não parseou nada.
    resumeTerminalOutput(term);
    flushTerminalOutput(term);
    expect(getQueuedChars(term)).toBe(0);
    const snapshot = serializer.serialize();
    expect(snapshot).toContain('BASE');
    expect(snapshot).not.toContain('CAUDA-NAO-PARSEADA');
    term.dispose();
    discardTerminalOutput(term);
  });

  it('tirar a cauda da fila como texto preserva a ordem: snapshot + cauda regravados num xterm novo', async () => {
    const { term, serializer } = realTerminal();
    await parsed(term, 'BASE\r\n');
    // Pane oculto: a saída de fundo fica parada no scheduler.
    writeTerminalOutput(term, 'CAUDA-NA-FILA', { foreground: false });
    pauseTerminalOutput(term);

    // O que a hibernação faz: cauda como texto, serializa o já parseado, descarta o xterm.
    const tail = takeQueuedTerminalOutput(term);
    const snapshot = serializer.serialize();
    term.dispose();
    discardTerminalOutput(term);
    expect(getQueuedChars(term)).toBe(0);
    expect(tail).toBe('CAUDA-NA-FILA');
    expect(snapshot).toContain('BASE');
    expect(snapshot).not.toContain('CAUDA-NA-FILA');

    // Reidratação: o snapshot entra primeiro e a saída retida depois.
    const { term: fresh } = realTerminal();
    await parsed(fresh, snapshot + tail);
    const restored = screen(fresh);
    expect(restored).toContain('BASE');
    expect(restored).toContain('CAUDA-NA-FILA');
    expect(restored.indexOf('BASE')).toBeLessThan(restored.indexOf('CAUDA-NA-FILA'));
  });
});
