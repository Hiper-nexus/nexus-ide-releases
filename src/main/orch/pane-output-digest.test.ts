import { describe, expect, it } from 'vitest';
import {
  capDigestEntries,
  digestBudgetPerPane,
  digestPaneTail,
  DIGEST_MANY_MAX_CHARS,
  DIGEST_MAX_LINE_CHARS,
  DIGEST_MAX_SIGNAL_LINES,
  DIGEST_TAIL_LINES,
  normalizeRedrawLine,
  PANE_READ_MANY_MAX_PANES,
} from './pane-output-digest';

const lines = (n: number, prefix = 'linha') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe('digestPaneTail', () => {
  it('janela curta: devolve as linhas não-vazias, sem marcar gap nenhum', () => {
    const digest = digestPaneTail('compilando\npronto');
    expect(digest.text).toBe('compilando\npronto');
    expect(digest.keptLines).toBe(2);
    expect(digest.omittedLines).toBe(0);
  });

  it('guarda sinais do miolo na ordem original e o tail verbatim', () => {
    const earlier = [
      'lint passou',
      'error: cannot find module ./x',
      ...lines(40),
      'warning: deprecado',
      ...lines(40),
    ];
    const tail = lines(DIGEST_TAIL_LINES + 5, 'tail');
    const digest = digestPaneTail([...earlier, ...tail].join('\n'));

    const out = digest.text.split('\n');
    expect(out[0]).toBe('…');
    expect(out[1]).toBe('error: cannot find module ./x');
    expect(out[2]).toBe('…');
    expect(out[3]).toBe('warning: deprecado');
    expect(out[4]).toBe('…');
    // Tail: as últimas 30 linhas não-vazias, verbatim e na ordem.
    expect(out.slice(5)).toEqual(tail.slice(-DIGEST_TAIL_LINES));
  });

  it('deduplica sinais repetidos e nunca passa de 12', () => {
    const earlier = Array.from(
      { length: 30 },
      (_, i) => `error: falha ${i % 3}`,
    );
    const digest = digestPaneTail(
      [...earlier, ...lines(DIGEST_TAIL_LINES, 'tail')].join('\n'),
    );
    const signalLines = digest.text
      .split('\n')
      .filter((line) => line.startsWith('error'));
    expect(signalLines).toEqual([
      'error: falha 0',
      'error: falha 1',
      'error: falha 2',
    ]);
    expect(signalLines.length).toBeLessThanOrEqual(DIGEST_MAX_SIGNAL_LINES);
  });

  it('descarta moldura de box-drawing/spinner sem contar como conteúdo', () => {
    const digest = digestPaneTail(
      [
        '┌──────────┐',
        '│ spinner ⠋ │'.replace(/[^⠋─│┌┐└┘ ]/g, ''),
        '⠋⠙⠹⠸',
        'trabalhando',
        '└──────────┘',
      ].join('\n'),
    );
    expect(digest.text).toBe('trabalhando');
    expect(digest.keptLines).toBe(1);
  });

  it('prompt de confirmação é sinal (pergunta/[y/n])', () => {
    const digest = digestPaneTail(
      [...lines(50), 'Apply these changes? [y/n]', ...lines(40, 'tail')].join(
        '\n',
      ),
    );
    expect(digest.text).toContain('Apply these changes? [y/n]');
    expect(digest.text).toContain('…');
  });

  it('sem sinal no miolo: uma única "…" marca o corte antes do tail', () => {
    const digest = digestPaneTail(
      [...lines(60), ...lines(DIGEST_TAIL_LINES, 'tail')].join('\n'),
    );
    const out = digest.text.split('\n');
    expect(out[0]).toBe('…');
    expect(out.length).toBe(DIGEST_TAIL_LINES + 1);
    expect(out.slice(1)).toEqual(lines(DIGEST_TAIL_LINES, 'tail').slice(0));
  });

  it('contagens: kept + omitted cobrem todas as linhas do input', () => {
    const input = ['error: x', ...lines(100), ...lines(20, 'tail')].join('\n');
    const digest = digestPaneTail(input);
    expect(digest.keptLines + digest.omittedLines).toBe(
      input.split('\n').length,
    );
    expect(digest.omittedLines).toBeGreaterThan(0);
  });

  it('sinal colado no tail não ganha "…" duplicado', () => {
    const digest = digestPaneTail(['ok', 'tests: 10 passed'].join('\n'));
    expect(digest.text).toBe('ok\ntests: 10 passed');
  });

  it('tail vazio e input vazio não quebram', () => {
    expect(digestPaneTail('').text).toBe('');
    expect(digestPaneTail('').keptLines).toBe(0);
  });
});

// F-987: nexus_pane_read_many com 6 panes e lines:40 devolveu 86.402
// caracteres, quase tudo redesenho de TUI. Fixture reproduz o lixo do campo:
// spinners colados, "Working (… • esc to interrupt)" letra a letra, quadros de
// status repetidos e redesenho por CR — com o conteúdo útil no fim.
const STATUS = (seconds: number) => `Working (2m ${seconds}s • esc to interrupt)`;
const typed = (text: string) =>
  Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1)).join('');
const gluedFrames = Array.from(
  { length: 60 },
  (_, i) => `✻ ${STATUS(10 + (i % 50))}`,
).join('');
const crRedraw = Array.from(
  { length: 80 },
  (_, i) => `⠋ Working (${i}s • esc to interrupt)`,
).join('\r');

function tuiGarbagePane(pane: number): string {
  const lines: string[] = [];
  for (let i = 0; i < 35; i += 1) {
    if (i % 3 === 0) lines.push('✻✶✳✢·'.repeat(40));
    else if (i % 3 === 1) lines.push(typed(STATUS(54)) + gluedFrames);
    else lines.push(crRedraw);
  }
  lines.push(
    `⏺ Read(src/main/orch/pane-${pane}.ts)`,
    '  ⎿  Read 412 lines',
    `Achado ${pane}: o supervisor trata disco vazio como falha de entrega.`,
    `✻ ${STATUS(54)}`,
    `> estudo do pane ${pane} em andamento`,
  );
  return lines.join('\n');
}

describe('F-987: redesenho de TUI não estoura o digest', () => {
  it('normaliza CR, spinner e texto digitado letra a letra', () => {
    expect(normalizeRedrawLine(typed(STATUS(54))).trim()).toBe(STATUS(54));
    expect(normalizeRedrawLine(`✻ W✶ Wo✳ Wor✢ Work✽ Worki`).trim()).toBe('Worki');
    expect(normalizeRedrawLine('velho 1\rvelho 2\rnovo estado\r').trim()).toBe(
      'novo estado',
    );
    expect(normalizeRedrawLine('✻✶✳✢·✻✶✳✢·✻✶✳✢·')).toBe('·');
  });

  it('quadros colados viram poucos caracteres; números e separadores ficam intactos', () => {
    const line = normalizeRedrawLine(gluedFrames);
    expect(line.length).toBeLessThanOrEqual(DIGEST_MAX_LINE_CHARS);
    expect(line).toContain('esc to interrupt');
    expect(normalizeRedrawLine('total 1000000 bytes, hash aabbaabbaabb')).toBe(
      'total 1000000 bytes, hash aabbaabbaabb',
    );
    expect(normalizeRedrawLine('====================')).toBe('====================');
  });

  it('linha gigante tem teto e marca o corte', () => {
    const line = normalizeRedrawLine(`inicio ${'x'.repeat(50_000)} fim-da-linha`);
    expect(line.length).toBeLessThanOrEqual(DIGEST_MAX_LINE_CHARS);
    expect(line).toContain('…');
    expect(line.endsWith('fim-da-linha')).toBe(true);
  });

  it('F-1406: escape CSI com parâmetro privado (Codex 0.162) não vira texto', () => {
    // Codex 0.162 emite ESC[>4;0m (XTMODKEYS) e ESC[>7u (kitty keyboard) no
    // boot; a primeira linha do pane mostrava ">4;0m>7u>_ OpenAI Codex…".
    expect(normalizeRedrawLine('\x1b[>4;0m\x1b[>7u>_ OpenAI Codex (v0.162.1)')).toBe(
      '>_ OpenAI Codex (v0.162.1)',
    );
    expect(
      digestPaneTail('\x1b[>4;0m\x1b[>7u>_ OpenAI Codex (v0.162.1)\ncomposer').text,
    ).toBe('>_ OpenAI Codex (v0.162.1)\ncomposer');
  });

  it('seis panes com lixo de TUI cabem no teto somado e preservam as últimas linhas úteis', () => {
    const budget = digestBudgetPerPane(6);
    const raw = Array.from({ length: 6 }, (_, pane) => tuiGarbagePane(pane));
    expect(raw.join('').length).toBeGreaterThan(86_402);
    const digests = raw.map((tail) => digestPaneTail(tail, { maxChars: budget }));
    const payload = JSON.stringify(
      digests.map((digest, pane) => ({ paneId: `pane-${pane}`, ...digest })),
    );
    expect(payload.length).toBeLessThanOrEqual(DIGEST_MANY_MAX_CHARS + 2_000);
    for (const [pane, digest] of digests.entries()) {
      expect(digest.text).toContain(`⏺ Read(src/main/orch/pane-${pane}.ts)`);
      expect(digest.text).toContain('Read 412 lines');
      expect(digest.text).toContain(`Achado ${pane}: o supervisor trata disco vazio`);
      expect(digest.text).toContain(`> estudo do pane ${pane} em andamento`);
      expect(digest.text.endsWith(`> estudo do pane ${pane} em andamento`)).toBe(true);
      expect(digest.text).not.toContain('WWoWor');
      expect(digest.text).not.toContain('✻✶✳✢');
      // Só o status mais recente sobrevive.
      expect(digest.text.match(/esc to interrupt/g)).toHaveLength(1);
    }
  });

  it('conteúdo útil grande respeita o teto por pane, corta o mais antigo e marca', () => {
    const budget = digestBudgetPerPane(6);
    const tail = Array.from(
      { length: 40 },
      (_, i) =>
        `resultado ${i}: ` +
        Array.from({ length: 24 }, (_, j) => `arquivo-${i}-${j}.ts`).join(' '),
    ).join('\n');
    const digest = digestPaneTail(tail, { maxChars: budget });
    expect(digest.text.length).toBeLessThanOrEqual(budget);
    expect(digest.truncated).toBe(true);
    expect(digest.text.split('\n')[0]).toMatch(/^… \[digest: \d+ linha\(s\) omitida\(s\) pelo teto/);
    expect(digest.text).toContain('resultado 39: arquivo-39-0.ts');
    expect(digest.text).not.toContain('resultado 0:');
    expect(digest.keptLines + digest.omittedLines).toBe(40);
  });

  it('teto por pane: divide o total descontando o JSON, com piso e teto', () => {
    expect(digestBudgetPerPane(1)).toBe(6_000);
    expect(digestBudgetPerPane(6)).toBe(3_700);
    expect(digestBudgetPerPane(0)).toBe(6_000);
    // No limite de panes por chamada, piso × quantidade cabe no teto total.
    expect(
      digestBudgetPerPane(PANE_READ_MANY_MAX_PANES) * PANE_READ_MANY_MAX_PANES,
    ).toBeLessThanOrEqual(DIGEST_MANY_MAX_CHARS);
  });

  it('rede final: a resposta agregada nunca passa do teto e mantém o fim de cada texto', () => {
    const entries = Array.from({ length: 30 }, (_, pane) => ({
      paneId: `pane-${pane}`,
      mode: 'digest',
      text: Array.from({ length: 40 }, (_, i) => `pane ${pane} linha ${i} ${'x'.repeat(30)}`).join('\n'),
      keptLines: 40,
      omittedLines: 0,
    }));
    expect(JSON.stringify(entries).length).toBeGreaterThan(DIGEST_MANY_MAX_CHARS);
    const capped = capDigestEntries(entries);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(DIGEST_MANY_MAX_CHARS);
    for (const [pane, entry] of capped.entries()) {
      expect(String(entry.text).endsWith(`pane ${pane} linha 39 ${'x'.repeat(30)}`)).toBe(true);
      expect(entry.truncated).toBe(true);
    }
    // Já dentro do teto: nada muda.
    const small = [{ paneId: 'a', text: 'ok' }];
    expect(capDigestEntries(small)).toEqual(small);
  });

  it('linha uniforme gigante não trava (orçamento de comparação)', () => {
    const started = performance.now();
    const digest = digestPaneTail(Array.from({ length: 40 }, () => 'x'.repeat(256_000)).join('\n'));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_LINE_CHARS + 2);
  });

  it('lista longa com números não colapsa (só quadro com relógio compara sem dígitos)', () => {
    const list = Array.from({ length: 30 }, (_, j) => `a${j}.ts`).join(' ');
    expect(list.length).toBeGreaterThan(160);
    expect(normalizeRedrawLine(list)).toBe(list);
  });

  it('linhas distintas só por número continuam distintas; quadros de relógio colapsam', () => {
    const digest = digestPaneTail(
      ['linha 1', 'linha 2', 'Elapsed 12s', 'Elapsed 13s', 'Elapsed 14s', 'fim'].join('\n'),
    );
    expect(digest.text).toBe('linha 1\nlinha 2\nElapsed 14s\nfim');
  });

  it('F-1356: tail só com quadros de spinner/contador devolve aviso legível em vez de dígitos soltos', () => {
    const rawTail = ['⠋ 5', '⠙ 6'].join('\n');
    const digest = digestPaneTail(rawTail);
    expect(digest.text).toMatch(/spinner|sem texto/);

    const mixedTail = ['⠋ 5', '⠙ 6', '⏺ Task executed successfully'].join('\n');
    const mixedDigest = digestPaneTail(mixedTail);
    expect(mixedDigest.text).toBe('⏺ Task executed successfully');
  });
});


