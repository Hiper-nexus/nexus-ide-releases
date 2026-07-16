import { describe, expect, it } from 'vitest';
import type {
  BrowserDesignAnnotation,
  BrowserDesignElementContext,
} from '../../shared/browser-design';
import { formatDesignAnnotationsPrompt } from './design-annotation-format';

const SELECTION: BrowserDesignElementContext = {
  ref: 'e1',
  tag: 'button',
  id: 'save',
  classes: ['btn-primary'],
  selector: '#save',
  rect: { x: 12, y: 34, width: 120, height: 40 },
  rectPage: { x: 12, y: 234, width: 120, height: 40 },
  isFixed: false,
  text: 'Salvar',
  outerHtml: '<button id="save">Salvar</button>',
  attributes: { id: 'save' },
  computedStyles: { display: 'inline-block', color: 'rgb(0, 0, 0)' },
  url: 'http://localhost:5173/checkout',
  frameworkHints: {
    framework: 'react',
    componentName: 'SaveButton',
    ownerChain: ['SaveButton', 'App'],
    source: { file: 'src/SaveButton.tsx', line: 3 },
  },
};

function annotation(
  over: Partial<BrowserDesignAnnotation> = {},
): BrowserDesignAnnotation {
  return {
    id: 'a1',
    comment: 'aumentar o contraste do texto',
    intent: 'fix',
    priority: 'suggestion',
    createdAt: 1_700_000_000_000,
    label: 'button#save "Salvar"',
    selection: SELECTION,
    ...over,
  };
}

describe('formatDesignAnnotationsPrompt', () => {
  it('numbers items to match badges and wraps page data in the untrusted envelope', () => {
    const prompt = formatDesignAnnotationsPrompt({
      annotations: [
        annotation(),
        annotation({
          id: 'a2',
          comment: 'esse botão deveria ser secundário?',
          intent: 'question',
          label: 'button#cancel',
        }),
      ],
    });

    expect(prompt).toContain('2 anotações');
    expect(prompt).toContain('BEGIN_UNTRUSTED_PAGE_DATA');
    expect(prompt).toContain('END_UNTRUSTED_PAGE_DATA');
    const envelope = prompt.slice(
      prompt.indexOf('BEGIN_UNTRUSTED_PAGE_DATA'),
      prompt.indexOf('END_UNTRUSTED_PAGE_DATA'),
    );
    // Page-derived data lives ONLY inside the envelope…
    expect(envelope).toContain('#save');
    expect(envelope).toContain('SaveButton');
    // …while the numbered user notes (trusted) sit outside it.
    const notes = prompt.slice(prompt.indexOf('END_UNTRUSTED_PAGE_DATA'));
    expect(notes).toContain('1. [corrigir] aumentar o contraste do texto');
    expect(notes).toContain('2. [pergunta] esse botão deveria ser secundário?');
    expect(notes).toContain('Responda ponto a ponto');
  });

  it('flags non-default priority and redacts secrets/control chars from page data', () => {
    const prompt = formatDesignAnnotationsPrompt({
      annotations: [
        annotation({
          priority: 'blocking',
          selection: {
            ...SELECTION,
            text: 'token Bearer abcdef0123456789abcdef',
            outerHtml: '<button>x\u0007y</button>',
          },
        }),
      ],
    });
    expect(prompt).toContain('[corrigir] (bloqueante)');
    expect(prompt).not.toContain('abcdef0123456789abcdef');
    expect(prompt).not.toContain('\u0007');
  });

  it('attaches a trusted DESIGN.md block when provided', () => {
    const prompt = formatDesignAnnotationsPrompt({
      annotations: [annotation()],
      designSystem: '# Tokens\ncor primária: #2f6ae0',
    });
    expect(prompt).toContain('BEGIN_DESIGN_SYSTEM');
    expect(prompt).toContain('cor primária: #2f6ae0');
    expect(prompt).toContain('Alinhe qualquer UI gerada ao design system');
  });

  it('bounds the envelope under adversarial payload sizes and rejects empty input', () => {
    const oversized = Array.from({ length: 20 }, (_, i) =>
      annotation({
        id: `a${i}`,
        selection: {
          ...SELECTION,
          outerHtml: '<div>'.padEnd(4_000, 'x'),
          text: 'y'.repeat(500),
        },
      }),
    );
    const prompt = formatDesignAnnotationsPrompt({ annotations: oversized });
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(() => formatDesignAnnotationsPrompt({ annotations: [] })).toThrow(
      /no design annotations/,
    );
  });

  it('NUNCA corta as notas confiáveis: envelope e DESIGN.md encolhem primeiro', () => {
    // Pior caso: 20 anotações com comentários longos + payloads de página
    // gordos + DESIGN.md no teto — o orçamento aperta em todas as seções.
    const heavy = Array.from({ length: 20 }, (_, i) =>
      annotation({
        id: `a${i}`,
        comment: `nota ${i + 1} ${'c'.repeat(1_900)}`,
        selection: {
          ...SELECTION,
          outerHtml: '<section>'.padEnd(4_000, 'z'),
          text: 'texto '.repeat(80),
        },
      }),
    );
    const prompt = formatDesignAnnotationsPrompt({
      annotations: heavy,
      designSystem: '# Tokens\n' + 'regra de design\n'.repeat(700),
    });

    expect(prompt.length).toBeLessThanOrEqual(24_000);
    // TODAS as 20 notas numeradas presentes, com a instrução final intacta.
    for (let i = 1; i <= 20; i += 1) {
      expect(prompt).toContain(`${i}. [corrigir] nota ${i}`);
    }
    expect(prompt).toContain('Responda ponto a ponto');
    // O envelope permaneceu bem-formado (marcadores balanceados).
    expect(prompt).toContain('BEGIN_UNTRUSTED_PAGE_DATA');
    expect(prompt).toContain('END_UNTRUSTED_PAGE_DATA');
    const envelope = prompt.slice(
      prompt.indexOf('BEGIN_UNTRUSTED_PAGE_DATA') + 'BEGIN_UNTRUSTED_PAGE_DATA\n'.length,
      prompt.indexOf('\nEND_UNTRUSTED_PAGE_DATA'),
    );
    const parsed = JSON.parse(envelope) as {
      annotations: unknown[];
      omittedEntries?: number;
    };
    // O ajuste degrada o envelope (menos entradas/campos), nunca as notas.
    expect(
      parsed.annotations.length + (parsed.omittedEntries ?? 0),
    ).toBe(20);
  });

  it('encaixa o envelope medindo a string real (sem inflação de escapes)', () => {
    // Conteúdo denso em aspas/backslashes: um re-embrulho ingênuo do preview
    // truncado dobraria os escapes e estouraria o teto.
    const quoteDense = Array.from({ length: 20 }, (_, i) =>
      annotation({
        id: `q${i}`,
        selection: {
          ...SELECTION,
          selector: '#a "\\"'.repeat(60),
          outerHtml: '<div data-x="\\"quoted\\"">'.repeat(120),
          text: '"\\" '.repeat(30),
        },
      }),
    );
    const prompt = formatDesignAnnotationsPrompt({ annotations: quoteDense });
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    const envelope = prompt.slice(
      prompt.indexOf('BEGIN_UNTRUSTED_PAGE_DATA') + 'BEGIN_UNTRUSTED_PAGE_DATA\n'.length,
      prompt.indexOf('\nEND_UNTRUSTED_PAGE_DATA'),
    );
    expect(() => JSON.parse(envelope)).not.toThrow();
    expect(prompt).toContain('Responda ponto a ponto');
  });

  it('outerHtml do envelope passa pela poda de valores de formulário (safeOuterHtml)', () => {
    const prompt = formatDesignAnnotationsPrompt({
      annotations: [
        annotation({
          selection: {
            ...SELECTION,
            outerHtml:
              '<form><input value="user@bank.com"><textarea>meu segredo</textarea></form>',
          },
        }),
      ],
    });
    expect(prompt).not.toContain('user@bank.com');
    expect(prompt).not.toContain('meu segredo');
    expect(prompt).toContain('[FORM_VALUE_REDACTED]');
  });
});
