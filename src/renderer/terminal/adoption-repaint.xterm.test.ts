/** @vitest-environment jsdom */
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplayOutputFilter } from '../../shared/terminal-replay-sanitizer';
import {
  createAdoptionRepaintTape,
  repaintAdoptedFrame,
} from './adoption-repaint';

/**
 * DSK-01 — aceitação com o xterm REAL ligado como no app: `term.onData` é o
 * mesmo canal da digitação e vai direto para `pty.write` (terminal-host.ts).
 * Saída antiga com queries (DA1, DSR-CPR, DA2, DECRQM, OSC 11) reescrita num
 * xterm novo faz o xterm responder de novo — a resposta chega ao PTY como
 * lixo no prompt ou como tecla no TUI.
 */
const OLD_OUTPUT = 'hello\r\n\x1b[c\x1b[6n\x1b[>c\x1b[?2004$p\x1b]11;?\x07';

const terminals: Terminal[] = [];

// jsdom não tem matchMedia; o xterm aberto só o usa para seguir o DPR.
if (!window.matchMedia) {
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function wiredTerminal(): { term: Terminal; ptyWrite: ReturnType<typeof vi.fn> } {
  const term = new Terminal({ allowProposedApi: true });
  terminals.push(term);
  // Aberto num elemento, como no app: a resposta de cor (OSC 10-12) vem da
  // camada de browser do xterm, que só existe depois do open().
  const element = document.createElement('div');
  document.body.appendChild(element);
  term.open(element);
  const ptyWrite = vi.fn();
  term.onData((data) => ptyWrite('pty-adopted', data));
  return { term, ptyWrite };
}

/** Resolve depois que o parser do xterm consumiu tudo (respostas já saíram). */
function writeParsed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function firstLine(term: Terminal): string {
  return term.buffer.active.getLine(0)?.translateToString(true) ?? '';
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
});

describe('DSK-01 — repaint de adoção com xterm real', () => {
  it('controle: o mesmo texto cru faz o xterm real responder no PTY', async () => {
    // Prova que o harness não é vazio: sem sanitizar, as queries respondem.
    const { term, ptyWrite } = wiredTerminal();
    await writeParsed(term, OLD_OUTPUT);
    const replies = ptyWrite.mock.calls.map(([, data]) => data as string);
    expect(replies).toContain('\x1b[?1;2c'); // DA1
    expect(replies.some((reply) => /^\x1b\[\d+;\d+R$/.test(reply))).toBe(true); // CPR
    expect(replies.some((reply) => reply.startsWith('\x1b[>'))).toBe(true); // DA2
    expect(replies.some((reply) => reply.endsWith('$y'))).toBe(true); // DECRPM
    expect(replies.some((reply) => reply.startsWith('\x1b]11;rgb:'))).toBe(true); // OSC 11
  });

  it('regravar a fita pelo caminho de repaint não escreve nada no PTY', async () => {
    const { term, ptyWrite } = wiredTerminal();
    const tape = createAdoptionRepaintTape();
    // Chunks cortados no meio das sequências, como chegam do PTY.
    tape.retain(OLD_OUTPUT.slice(0, 9));
    tape.retain(OLD_OUTPUT.slice(9, 20));
    tape.retain(OLD_OUTPUT.slice(20));

    let painted = '';
    const outcome = repaintAdoptedFrame({
      hasContent: false,
      tape: tape.read(),
      write: (data) => {
        painted += data;
      },
    });
    await writeParsed(term, painted);

    expect(outcome).toBe('painted');
    expect(ptyWrite).not.toHaveBeenCalled();
    // O quadro visível continua lá: só o tráfego de pergunta/resposta saiu.
    expect(firstLine(term)).toBe('hello');
  });

  it('query ao vivo passa crua e o xterm responde; a mesma query vinda do replay não', async () => {
    // Mesmo filtro do onData do terminal-host: só o que o preload marcou como
    // replay é sanitizado — o TUI que pergunta agora recebe a resposta agora.
    const { term, ptyWrite } = wiredTerminal();
    const filter = createReplayOutputFilter();

    await writeParsed(term, filter('old\r\n\x1b[6n\x1b[c', true));
    expect(ptyWrite).not.toHaveBeenCalled();

    await writeParsed(term, filter('\x1b[6n', false));
    expect(ptyWrite).toHaveBeenCalledOnce();
    expect(ptyWrite.mock.calls[0]?.[1]).toMatch(/^\x1b\[\d+;\d+R$/);
  });
});
