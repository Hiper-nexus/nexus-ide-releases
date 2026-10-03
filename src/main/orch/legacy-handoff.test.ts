import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  extractLegacyHandoffsFromText,
  findLegacyMarker,
  isPlaceholderSummary,
  LEGACY_DEDUPE_TTL_MS,
  LEGACY_MARKER,
  LegacyHandoffDedupe,
  LegacyHandoffParser,
  type LegacyHandoffPayload,
  normalizeHandoffStatusInput,
} from './legacy-handoff';
import { cpuTimeMs } from '../../test/cpu-time';

function collect(): {
  parser: LegacyHandoffParser;
  received: Array<{ sessionId: string; payload: LegacyHandoffPayload }>;
} {
  const received: Array<{ sessionId: string; payload: LegacyHandoffPayload }> =
    [];
  const parser = new LegacyHandoffParser((sessionId, payload) =>
    received.push({ sessionId, payload }),
  );
  return { parser, received };
}

describe('extractJsonObject', () => {
  it('extracts a balanced object and reports the end offset', () => {
    const text = 'noise {"a": {"b": 1}} trailing';
    const result = extractJsonObject(text);
    expect(result?.value).toEqual({ a: { b: 1 } });
    expect(text.slice(result!.end)).toBe(' trailing');
  });

  it('ignores braces inside strings', () => {
    const result = extractJsonObject('{"s": "close } brace {"}');
    expect(result?.value).toEqual({ s: 'close } brace {' });
  });

  it('returns null while the object is incomplete', () => {
    expect(extractJsonObject('{"a": 1, ')).toBeNull();
  });

  it('repairs a terminal hard-wrap inside a string literal', () => {
    // TUI line-wrap at the pane width inserts CR/LF + transcript indent in the
    // middle of the JSON text (field case: AGY/gemini transcript).
    const wrapped =
      '{"status":"success","summary":"Inspeção somente leitura realizada: 0 ' +
      'entradas visíveis\r\n  encontradas.","artifacts":[]}';
    const result = extractJsonObject(wrapped);
    expect(JSON.parse(JSON.stringify(result?.value))).toEqual({
      status: 'success',
      summary: 'Inspeção somente leitura realizada: 0 entradas visíveis encontradas.',
      artifacts: [],
    });
  });

  it('keeps pretty-printed blocks and rejects still-invalid JSON', () => {
    const pretty = '{\n  "a": 1,\n  "b": "x"\n}';
    expect(extractJsonObject(pretty)?.value).toEqual({ a: 1, b: 'x' });
    expect(extractJsonObject('{"a": }')).toBeNull();
  });
});

describe('LegacyHandoffParser', () => {
  const block =
    `${LEGACY_MARKER}\n` +
    '{"status": "success", "summary": "done the thing", "artifacts": ["a.ts"]}\n';

  it('parses a complete legacy handoff block', () => {
    const { parser, received } = collect();
    parser.feed('s1', `regular output\n${block}more output`);
    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe('s1');
    expect(received[0].payload).toEqual({
      status: 'success',
      summary: 'done the thing',
      artifacts: ['a.ts'],
    });
  });

  it('detects a marker split across chunks', () => {
    const { parser, received } = collect();
    const full = block;
    const mid = Math.floor(LEGACY_MARKER.length / 2);
    parser.feed('s1', `prefix ${full.slice(0, mid)}`);
    parser.feed('s1', full.slice(mid));
    expect(received).toHaveLength(1);
  });

  it.each(['## NEXUS_HANDOFF v1', '#### NEXUS_HANDOFF v1'])(
    'accepts the provider-normalized Markdown heading %s',
    (marker) => {
      const { parser, received } = collect();
      const split = marker.length - 3;
      parser.feed('agy-session', `provider output\n${marker.slice(0, split)}`);
      parser.feed(
        'agy-session',
        `${marker.slice(split)}\n` +
          '{"status":"success","summary":"Mapeamento independente concluído sem alterar arquivos.","artifacts":[]}',
      );

      expect(received).toEqual([
        {
          sessionId: 'agy-session',
          payload: {
            status: 'success',
            summary:
              'Mapeamento independente concluído sem alterar arquivos.',
            artifacts: [],
          },
        },
      ]);
    },
  );

  it.each([
    '# NEXUS_HANDOFF v1',
    'NEXUS_HANDOFF v1',
    'NEXUS_HANDOFF',
    '### NEXUS_HANDOFF',
  ])('accepts the field/Overclock sentinel %s', (marker) => {
    const { parser, received } = collect();
    parser.feed(
      'agy-plain',
      `${marker}\n` +
        '{"status":"success","summary":"Interface implementada no pane sem tool MCP.","artifacts":[]}',
    );
    expect(received).toEqual([
      {
        sessionId: 'agy-plain',
        payload: {
          status: 'success',
          summary: 'Interface implementada no pane sem tool MCP.',
          artifacts: [],
        },
      },
    ]);
  });

  it('maps Overclock Stop-hook status done/error onto the Nexus contract', () => {
    const { parser, received } = collect();
    parser.feed(
      's1',
      `${LEGACY_MARKER}\n` +
        '{"status":"done","summary":"Worker finished the turn without calling the tool.","artifacts":[]}',
    );
    parser.feed(
      's2',
      `NEXUS_HANDOFF\n` +
        '{"status":"error","summary":"Provider aborted before the worker could ship.","artifacts":[]}',
    );
    expect(received.map((r) => r.payload.status)).toEqual(['success', 'failed']);
  });

  it.each(['## nexus_handoff v1', 'nexus_handoff', 'order_handoff'])(
    'keeps non-contract sentinel %s rejected',
    (marker) => {
      const { parser, received } = collect();
      parser.feed(
        's1',
        `${marker}\n` +
          '{"status":"success","summary":"Entrega que não possui framing confiável.","artifacts":[]}',
      );
      expect(received).toHaveLength(0);
    },
  );

  it('buffers JSON split across chunks', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "partial",`);
    expect(received).toHaveLength(0);
    parser.feed('s1', ' "summary": "half done"}');
    expect(received).toHaveLength(1);
    expect(received[0].payload.status).toBe('partial');
    expect(received[0].payload.artifacts).toEqual([]);
  });

  it('drops payloads with invalid status or missing summary', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "weird", "summary": "x"}`);
    parser.feed('s2', `${LEGACY_MARKER}\n{"status": "success"}`);
    expect(received).toHaveLength(0);
  });

  it('keeps sessions independent and handles multiple blocks per session', () => {
    const { parser, received } = collect();
    parser.feed('s1', block);
    parser.feed('s2', 'no marker here');
    parser.feed('s1', `${LEGACY_MARKER}\n{"status":"failed","summary":"broke"}`);
    expect(received.map((r) => [r.sessionId, r.payload.status])).toEqual([
      ['s1', 'success'],
      ['s1', 'failed'],
    ]);
  });

  it('abandons an unterminated block instead of buffering forever', () => {
    const { parser, received } = collect();
    parser.feed('s1', `${LEGACY_MARKER}\n{"status": "success", "summary": "`);
    parser.feed('s1', 'x'.repeat(20_000));
    parser.feed('s1', '"}');
    expect(received).toHaveLength(0);
  });

  it('delivers a real handoff whose summary the TUI hard-wrapped', () => {
    const { parser, received } = collect();
    const summary =
      'Inspeção somente leitura realizada no nível raiz: 0 entradas visíveis encontradas.';
    // Exactly what the AGY transcript emitted after ANSI-strip: the JSON string
    // broken by CR/LF + two-space continuation indent.
    const wrappedBlock =
      `${LEGACY_MARKER}\r\n  \r\n  {"status":"success","summary":"Inspeção ` +
      `somente leitura realizada no nível raiz: 0 entradas visíveis\r\n  ` +
      `encontradas.","artifacts":[]}\r\n`;
    parser.feed('s1', wrappedBlock);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({
      status: 'success',
      summary,
      artifacts: [],
    });
  });

  it('still rejects a wrapped placeholder example block', () => {
    const { parser, received } = collect();
    const wrappedPlaceholder =
      `${LEGACY_MARKER}\r\n  {"status":"success","summary":"<resumo objetivo ` +
      `do que\r\n  fez>","artifacts":[]}`;
    parser.feed('s1', wrappedPlaceholder);
    expect(received).toHaveLength(1);
    expect(isPlaceholderSummary(received[0].payload.summary)).toBe(true);
  });
});

describe('isPlaceholderSummary', () => {
  it('rejeita o template do contrato ecoado pelo kickoff', () => {
    expect(isPlaceholderSummary('<resumo objetivo do que fez>')).toBe(true);
  });

  it('rejeita resumos curtos demais', () => {
    expect(isPlaceholderSummary('ok')).toBe(true);
    expect(isPlaceholderSummary('   feito   ')).toBe(true);
  });

  it('aceita uma entrega real', () => {
    expect(
      isPlaceholderSummary('Implementei o formulário de login com validação.'),
    ).toBe(false);
  });
});

describe('extractLegacyHandoffsFromText', () => {
  it('re-lê um snapshot PTY já stripado (idle/exit, não só o stream ao vivo)', () => {
    const text =
      'noise\nNEXUS_HANDOFF\n' +
      '{"status":"success","summary":"Tela de missões renderiza a lista paginada.","artifacts":[]}\n' +
      'idle prompt';
    expect(extractLegacyHandoffsFromText(text)).toEqual([
      {
        status: 'success',
        summary: 'Tela de missões renderiza a lista paginada.',
        artifacts: [],
      },
    ]);
  });

  it('ignora buffer sem o sentinel', () => {
    expect(extractLegacyHandoffsFromText('worker idle after painting UI')).toEqual(
      [],
    );
  });
});

describe('LegacyHandoffDedupe', () => {
  const payload: LegacyHandoffPayload = {
    status: 'success',
    summary: 'Implementei o formulário de login com validação.',
    artifacts: [],
  };

  it('deixa a primeira entrega passar e barra o repaint idêntico', () => {
    let now = 1_000;
    const dedupe = new LegacyHandoffDedupe(() => now);
    expect(dedupe.isDuplicate('s1', payload)).toBe(false);
    now += 5_000; // repaint segundos depois
    expect(dedupe.isDuplicate('s1', payload)).toBe(true);
  });

  it('conteúdo diferente ou sessão diferente não é duplicata', () => {
    const dedupe = new LegacyHandoffDedupe(() => 1_000);
    expect(dedupe.isDuplicate('s1', payload)).toBe(false);
    expect(dedupe.isDuplicate('s2', payload)).toBe(false);
    expect(
      dedupe.isDuplicate('s1', { ...payload, summary: 'Outra entrega real feita.' }),
    ).toBe(false);
  });

  it('expira após o TTL (reentrega tardia legítima passa)', () => {
    let now = 1_000;
    const dedupe = new LegacyHandoffDedupe(() => now);
    expect(dedupe.isDuplicate('s1', payload)).toBe(false);
    now += LEGACY_DEDUPE_TTL_MS + 1;
    expect(dedupe.isDuplicate('s1', payload)).toBe(false);
  });

  it('dropSession limpa só a sessão encerrada', () => {
    let now = 1_000;
    const dedupe = new LegacyHandoffDedupe(() => now);
    dedupe.isDuplicate('s1', payload);
    dedupe.isDuplicate('s2', payload);
    dedupe.dropSession('s1');
    now += 5_000;
    expect(dedupe.isDuplicate('s1', payload)).toBe(false); // limpo
    expect(dedupe.isDuplicate('s2', payload)).toBe(true); // preservado
  });
});

describe('normalizeHandoffStatusInput (aliases do Overclock na fronteira)', () => {
  it('mapeia done→success e error→failed', () => {
    expect(normalizeHandoffStatusInput('done')).toBe('success');
    expect(normalizeHandoffStatusInput('error')).toBe('failed');
  });

  it('preserva o vocabulário canônico e valores inválidos (zod decide)', () => {
    expect(normalizeHandoffStatusInput('success')).toBe('success');
    expect(normalizeHandoffStatusInput('partial')).toBe('partial');
    expect(normalizeHandoffStatusInput('banana')).toBe('banana');
    expect(normalizeHandoffStatusInput(undefined)).toBe(undefined);
  });
});

/** F-764 C.3: a busca anterior (dez `indexOf`), só como referência. */
const REFERENCE_VARIANTS = [
  '### NEXUS_HANDOFF v1',
  '## NEXUS_HANDOFF v1',
  '#### NEXUS_HANDOFF v1',
  '# NEXUS_HANDOFF v1',
  '### NEXUS_HANDOFF',
  '## NEXUS_HANDOFF',
  '#### NEXUS_HANDOFF',
  '# NEXUS_HANDOFF',
  'NEXUS_HANDOFF v1',
  'NEXUS_HANDOFF',
];
function referenceFindLegacyMarker(text: string): { index: number; length: number } | null {
  let found: { index: number; length: number } | null = null;
  for (const marker of REFERENCE_VARIANTS) {
    const index = text.indexOf(marker);
    if (index === -1) continue;
    if (
      found === null ||
      index < found.index ||
      (index === found.index && marker.length > found.length)
    ) {
      found = { index, length: marker.length };
    }
  }
  return found;
}

describe('marcador legado em tempo linear (F-764 C.3)', () => {
  it('acha o mesmo marcador que as dez buscas antigas em 20 mil textos aleatórios', () => {
    const pieces = ['#', '#', ' ', 'NEXUS_HANDOFF', ' v1', 'v1', ' ', 'x', 'NEXUS_HANDOF', '\n'];
    let seed = 764;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 20_000; round += 1) {
      let text = '';
      const length = Math.floor(random() * 12);
      for (let i = 0; i < length; i += 1) {
        text += pieces[Math.floor(random() * pieces.length)];
      }
      expect(findLegacyMarker(text), JSON.stringify(text)).toEqual(
        referenceFindLegacyMarker(text),
      );
    }
  });

  it.each([16_384, 262_144])(
    '%i caracteres de blocos vazios: sem estourar a pilha, em tempo linear',
    (size) => {
      const text = 'NEXUS_HANDOFF{}'.repeat(Math.floor(size / 15));
      // A versão recursiva estourava a pilha a partir de ~64 KB; com a
      // validação do zod em cada bloco, 256 KB passavam de 300 ms.
      expect(extractLegacyHandoffsFromText(text)).toEqual([]);
      expect(cpuTimeMs(() => extractLegacyHandoffsFromText(text))).toBeLessThan(
        size > 16_384 ? 100 : 20,
      );
    },
  );

  it('blocos válidos seguidos no mesmo texto continuam saindo em ordem', () => {
    const block = (summary: string) =>
      `### NEXUS_HANDOFF v1\n{"status":"success","summary":"${summary}"}\n`;
    const text = block('primeiro resumo com tamanho real') + block('segundo resumo com tamanho real');
    expect(extractLegacyHandoffsFromText(text).map((payload) => payload.summary)).toEqual([
      'primeiro resumo com tamanho real',
      'segundo resumo com tamanho real',
    ]);
  });
});
