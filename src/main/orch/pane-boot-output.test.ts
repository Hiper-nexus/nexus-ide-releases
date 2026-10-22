import { describe, expect, it } from 'vitest';
import {
  PANE_BOOT_OUTPUT_MAX_CHARS,
  PANE_BOOT_OUTPUT_MAX_LINES,
  PANE_BOOT_OUTPUT_SCAN_CHARS,
  sanitizePaneBootOutput,
} from './pane-boot-output';
import { cpuTimeMs } from '../../test/cpu-time';

describe('sanitized boot output', () => {
  it('redacts credentials across lines before selecting the last 40 lines', () => {
    const privateBody = Array.from({ length: 50 }, (_, index) => `private-body-${index}`);
    const raw = [
      '-----BEGIN PRIVATE KEY-----', ...privateBody, '-----END PRIVATE KEY-----',
      'Bearer opaque-bearer-credential',
      'AIzaabcdefghijklmnopqrstuvwxyz012345678',
      'gsk_abcdefghijklmnopqrstuvwxyz0123456789',
      'xai-abcdefghijklmnopqrstuvwxyz0123456789',
      'cfut_abcdefghijklmnopqrstuvwxyz0123456789',
      '0123456789abcdef0123456789abcdef.abcdefghijklmn',
      '\u001b]0;hidden terminal title\u0007\u001b[31mError: invalid --model\u001b[0m',
      'sessionFingerprint=opaque-account-identity',
    ].join('\n');
    const tail = sanitizePaneBootOutput(raw);
    expect(tail).toContain('Error: invalid --model');
    expect(tail).not.toMatch(/private-body|opaque-bearer|AIza|gsk_|xai-|cfut_|0123456789abcdef|opaque-account|terminal title|\u001b/);
  });

  it('caps exceptionally long boot errors without retaining ANSI or secret values', () => {
    const tail = sanitizePaneBootOutput(`API_KEY=${'z'.repeat(20_000)}\nError: ${'x'.repeat(20_000)}`);
    expect(tail.length).toBeLessThanOrEqual(PANE_BOOT_OUTPUT_MAX_CHARS);
    expect(tail).not.toContain('zzzz');
  });

  it('records that the process produced no output', () => {
    expect(sanitizePaneBootOutput('')).toBe('[sem saída capturada]');
    expect(sanitizePaneBootOutput('   \n\n\t\n')).toBe('[sem saída capturada]');
  });

  it('a chave cortada pela janela (END sem BEGIN) não vaza o corpo', () => {
    const body = Array.from({ length: 500 }, (_, index) => `corpo-${index}-${'q'.repeat(30)}`);
    const raw = ['-----BEGIN OPENSSH PRIVATE KEY-----', ...body,
      '-----END OPENSSH PRIVATE KEY-----', 'Error: mcode saiu'].join('\n');
    expect(raw.length).toBeGreaterThan(PANE_BOOT_OUTPUT_SCAN_CHARS);
    const tail = sanitizePaneBootOutput(raw);
    expect(tail).toContain('Error: mcode saiu');
    expect(tail).toContain('[chave privada redigida]');
    expect(tail).not.toMatch(/corpo-|qqqq/);
  });

  it('chave sem END até o fim e linha que é só base64 ficam redigidas', () => {
    const tail = sanitizePaneBootOutput([
      'Error: boot',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
      '-----BEGIN RSA PRIVATE KEY-----',
      'segredo-sem-fim',
    ].join('\n'));
    expect(tail).toContain('Error: boot');
    expect(tail).not.toMatch(/MIIEv|segredo-sem-fim/);
  });

  it('quadros seguidos do spinner viram uma linha e liberam espaço para a causa', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const raw = [
      ...Array.from({ length: 120 }, (_, index) => `    ${frames[index % frames.length]} Starting server...`),
      'MCode could not load its native SQLite dependency.',
    ].join('\r');
    const tail = sanitizePaneBootOutput(raw);
    expect(tail.split('\n')).toEqual([
      '⠏ Starting server...',
      'MCode could not load its native SQLite dependency.',
    ]);
  });
});

describe('F-788: cauda do boot em tempo linear (lição do F-764)', () => {
  const SIZE = 16_384;
  const rows = (row: () => string, count: number) =>
    Array.from({ length: count }, row).join('\n').slice(-SIZE);
  const inputs: Array<[string, string]> = [
    ['linhas em branco com espaços', '   \n'.repeat(SIZE / 4)],
    ['só quebras de linha', '\n'.repeat(SIZE)],
    ['tela em branco', rows(() => ' '.repeat(131), 140)],
    ['caixa de input │…│', rows(() => `│${' '.repeat(129)}│`, 140)],
    ['moldura de shell │ ⎿', rows(() => `  │  ⎿${' '.repeat(120)}`, 140)],
    ['espaço sem quebra (cursor absoluto)', ' '.repeat(SIZE)],
    ['introdutores OSC sem terminador', '\u001b]'.repeat(SIZE / 2)],
    ['esquema de URL sem fim (a.a.a…)', 'a.'.repeat(SIZE / 2)],
    ['cabeçalho x- repetido', 'x-'.repeat(SIZE / 2)],
    ['atribuições "token =" sem valor', `token =${' '.repeat(32)}\n`.repeat(SIZE / 40)],
  ];

  it.each(inputs)('%s: cauda curta em tempo linear', (_label, text) => {
    const tail = sanitizePaneBootOutput(text);
    // CPU, melhor de duas depois de aquecer (o tier-up da regex não é o que se
    // mede): no runner do CI o relógio de parede leu 68 ms de fila numa
    // varredura de ~3 ms.
    const elapsedMs = cpuTimeMs(() => sanitizePaneBootOutput(text));
    expect(tail.length).toBeLessThanOrEqual(PANE_BOOT_OUTPUT_MAX_CHARS);
    expect(tail.split('\n').length).toBeLessThanOrEqual(PANE_BOOT_OUTPUT_MAX_LINES + 1);
    // A versão que redigia o texto inteiro levava ~70 ms aqui e ~1 s em 64 KB.
    expect(elapsedMs).toBeLessThan(50);
  });

  it('ring inteiro (256 KB) custa o mesmo que a janela', () => {
    const ring = '   \n'.repeat(65_536);
    sanitizePaneBootOutput(ring);
    const startedAt = performance.now();
    expect(sanitizePaneBootOutput(ring)).toBe('[sem saída capturada]');
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
