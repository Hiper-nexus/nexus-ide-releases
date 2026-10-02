import { describe, expect, it } from 'vitest';
import {
  maskAccountLabel,
  parseAccountChoiceReceipt,
  sanitizeReceiptText,
  type AccountChoiceReceipt,
} from './account-choice';

describe('maskAccountLabel', () => {
  it('mascara e-mail mantendo 1º char de cada lado e o sufixo do TLD', () => {
    expect(maskAccountLabel('gabriel@lupygo.com.br')).toBe('g•••@l•••.com.br');
    expect(maskAccountLabel('a@b.co')).toBe('a•••@b•••.co');
    expect(maskAccountLabel('maria.silva@empresa.io')).toBe('m•••@e•••.io');
  });

  it('o sufixo nunca guarda subdomínios internos', () => {
    expect(maskAccountLabel('ana@gmail.com')).toBe('a•••@g•••.com');
    expect(maskAccountLabel('ops@mail.example.com')).toBe('o•••@m•••.com');
    expect(maskAccountLabel('x@y.co.uk')).toBe('x•••@y•••.co.uk');
    // Penúltimo rótulo > 3 chars → cai no último mesmo com 3+ rótulos.
    expect(maskAccountLabel('u@mail.empresa.com.br')).toBe('u•••@m•••.com.br');
  });

  it('domínio sem ponto mantém só o 1º char', () => {
    expect(maskAccountLabel('ops@localhost')).toBe('o•••@l•••');
  });

  it('não-e-mail longo vira 2+•••+2', () => {
    expect(maskAccountLabel('Conta Corporativa')).toBe('Co•••va');
    expect(maskAccountLabel('pessoal1')).toBe('pe•••l1');
  });

  it('rótulo curto vira só •••', () => {
    expect(maskAccountLabel('adm')).toBe('•••');
    expect(maskAccountLabel('')).toBe('•••');
    expect(maskAccountLabel('abc123')).toBe('•••');
  });

  it('nunca devolve id, fingerprint ou token do rótulo', () => {
    const masked = maskAccountLabel('user-9f8c-token@dominio.com');
    expect(masked).not.toContain('9f8c');
    expect(masked).not.toContain('token');
  });
});

describe('maskAccountLabel — idempotência (o saneador remascara o que já veio mascarado)', () => {
  const samples = [
    'gabriel@lupygo.com.br',
    'a@b.co',
    'ana@gmail.com',
    'ops@mail.example.com',
    'x@y.co.uk',
    'u@mail.empresa.com.br',
    'ops@localhost',
    'Conta Corporativa',
    'pessoal1',
    'abcdefg',
    'abcdef',
    'adm',
    '',
    'user-9f8c-token@dominio.com',
  ];

  it.each(samples)('mask(mask(%j)) === mask(%j)', (raw) => {
    const once = maskAccountLabel(raw);
    expect(maskAccountLabel(once)).toBe(once);
  });
});

describe('sanitizeReceiptText', () => {
  it('tira controle, colapsa espaço e corta no limite', () => {
    expect(sanitizeReceiptText('  Sessão\u0000\n\t 5h  ', 32)).toBe('Sessão 5h');
    expect(sanitizeReceiptText('x'.repeat(100), 10)).toBe('x'.repeat(10));
  });

  it('mascara e-mail cru que apareça no texto livre e preserva o resto', () => {
    const out = sanitizeReceiptText('abrindo na ativa gabriel@lupygo.com.br agora', 200);
    expect(out).toBe('abrindo na ativa g•••@l•••.com.br agora');
    expect(out).not.toContain('gabriel');
    expect(out).not.toContain('lupygo');
  });

  it('não corrompe o que já está mascarado nem a pontuação final', () => {
    expect(sanitizeReceiptText('na ativa "g•••@l•••.com".', 200)).toBe('na ativa "g•••@l•••.com".');
    expect(sanitizeReceiptText('use ana@gmail.com.', 200)).toBe('use a•••@g•••.com.');
  });

  it('texto vazio ou só de controle vira string vazia', () => {
    expect(sanitizeReceiptText('', 10)).toBe('');
    expect(sanitizeReceiptText('\u0007\u0001', 10)).toBe('');
  });
});

const validReceipt: AccountChoiceReceipt = {
  adapterId: 'claude',
  source: 'headroom-rule',
  account: { label: 'g•••@l•••.com', mode: 'subscription' },
  headroom: { usedPct: 12, window: 'Sessão', resetsAt: 1_760_000_000_000, score: 0.88 },
  alternatives: [
    { label: 'x•••@y•••.com', usedPct: 44, window: 'Semanal', resetsAt: null, skipped: 'less-headroom' },
    { label: 'z•••@w•••.com', usedPct: null, window: null, resetsAt: null, skipped: 'cooldown' },
  ],
  decidedAt: 1_759_999_000_000,
};

describe('parseAccountChoiceReceipt', () => {
  it('aceita um recibo bem formado e devolve uma cópia igual (sem compartilhar referência)', () => {
    const parsed = parseAccountChoiceReceipt(validReceipt);
    expect(parsed).toEqual(validReceipt);
    expect(parsed).not.toBe(validReceipt);
    expect(parsed?.alternatives).not.toBe(validReceipt.alternatives);
  });

  it.each([undefined, null, 42, 'oi', true, [], [validReceipt]])('recusa entrada que não é objeto: %j', (raw) => {
    expect(parseAccountChoiceReceipt(raw)).toBeNull();
  });

  it('descarta toda chave fora da lista de permissão (id, fingerprint, token, e-mail cru)', () => {
    const parsed = parseAccountChoiceReceipt({
      ...validReceipt,
      accountId: 'acct-9f8c',
      sessionFingerprint: 'fp-secret',
      token: 'sk-ant-secret',
      email: 'gabriel@lupygo.com.br',
      account: { ...validReceipt.account, id: 'acct-9f8c', email: 'gabriel@lupygo.com.br' },
      headroom: { ...validReceipt.headroom, accountId: 'acct-9f8c' },
      alternatives: [
        { ...validReceipt.alternatives[0], id: 'acct-b', fingerprint: 'fp-b' },
        validReceipt.alternatives[1],
      ],
    });
    const json = JSON.stringify(parsed);
    for (const leak of ['acct-9f8c', 'acct-b', 'fp-secret', 'fp-b', 'sk-ant-secret', 'gabriel@lupygo']) {
      expect(json).not.toContain(leak);
    }
    expect(parsed).toEqual(validReceipt);
  });

  it('remascara rótulo cru de conta e de alternativa (defesa se um produtor esquecer)', () => {
    const parsed = parseAccountChoiceReceipt({
      ...validReceipt,
      account: { label: 'gabriel@lupygo.com.br', mode: 'api_key' },
      alternatives: [{ ...validReceipt.alternatives[0], label: 'ana.silva@gmail.com' }],
    });
    expect(parsed?.account?.label).toBe('g•••@l•••.com.br');
    expect(parsed?.alternatives[0].label).toBe('a•••@g•••.com');
    expect(JSON.stringify(parsed)).not.toMatch(/gabriel|lupygo|silva|gmail/);
  });

  it('recusa source, mode e skipped fora do conjunto conhecido', () => {
    expect(parseAccountChoiceReceipt({ ...validReceipt, source: 'vip' })).toBeNull();
    expect(
      parseAccountChoiceReceipt({ ...validReceipt, account: { label: 'a•••', mode: 'oauth' } })?.account?.mode,
    ).toBe('unknown');
    const parsed = parseAccountChoiceReceipt({
      ...validReceipt,
      alternatives: [
        { ...validReceipt.alternatives[0], skipped: 'because-i-said-so' },
        validReceipt.alternatives[1],
      ],
    });
    expect(parsed?.alternatives).toEqual([validReceipt.alternatives[1]]);
  });

  it('recusa adapterId com formato suspeito', () => {
    for (const adapterId of ['', ' claude', 'claude\n', 'a'.repeat(65), 'claude/../x', 42]) {
      expect(parseAccountChoiceReceipt({ ...validReceipt, adapterId })).toBeNull();
    }
  });

  it('aceita account e headroom nulos (nativa, legada)', () => {
    const native = { ...validReceipt, source: 'native', account: null, headroom: null, alternatives: [] };
    expect(parseAccountChoiceReceipt(native)).toEqual(native);
  });

  it('saneia números: percentual 0-100 inteiro, score 0-1, reset positivo; resto vira null', () => {
    const parsed = parseAccountChoiceReceipt({
      ...validReceipt,
      headroom: { usedPct: 140.6, window: 'Sessão', resetsAt: -5, score: 7 },
      alternatives: [
        { ...validReceipt.alternatives[0], usedPct: Number.NaN, resetsAt: Number.POSITIVE_INFINITY },
        { ...validReceipt.alternatives[1], usedPct: -3 },
      ],
    });
    expect(parsed?.headroom).toEqual({ usedPct: 100, window: 'Sessão', resetsAt: null, score: 1 });
    expect(parsed?.alternatives[0]).toMatchObject({ usedPct: null, resetsAt: null });
    expect(parsed?.alternatives[1]).toMatchObject({ usedPct: 0 });
  });

  it('recusa recibo sem decidedAt finito', () => {
    expect(parseAccountChoiceReceipt({ ...validReceipt, decidedAt: 'ontem' })).toBeNull();
    expect(parseAccountChoiceReceipt({ ...validReceipt, decidedAt: Number.NaN })).toBeNull();
  });

  it('saneia janela e note (texto livre): controle fora, e-mail mascarado, tamanho limitado', () => {
    const parsed = parseAccountChoiceReceipt({
      ...validReceipt,
      source: 'active-fallback',
      headroom: { ...validReceipt.headroom, window: `Sessão\u0000${'x'.repeat(200)}` },
      note: `nenhuma conta livre; abrindo na ativa gabriel@lupygo.com.br ${'y'.repeat(500)}`,
    });
    expect(parsed?.headroom?.window?.length).toBeLessThanOrEqual(32);
    expect(parsed?.headroom?.window).not.toContain('\u0000');
    expect(parsed?.note?.length).toBeLessThanOrEqual(240);
    expect(parsed?.note).toContain('g•••@l•••.com.br');
    expect(parsed?.note).not.toContain('gabriel');
  });

  it('omite note vazio ou que não é texto', () => {
    expect(parseAccountChoiceReceipt({ ...validReceipt, note: '   ' })).not.toHaveProperty('note');
    expect(parseAccountChoiceReceipt({ ...validReceipt, note: 42 })).not.toHaveProperty('note');
  });

  it('limita a quantidade de alternativas (frota grande) sem lançar', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...validReceipt.alternatives[0],
      label: `c${i}@x.com`,
    }));
    const parsed = parseAccountChoiceReceipt({ ...validReceipt, alternatives: many });
    expect(parsed?.alternatives.length).toBe(100);
  });

  it('nunca lança, nem com objeto hostil (getter que lança, protótipo estranho)', () => {
    const hostile = {
      get adapterId(): string {
        throw new Error('boom');
      },
    };
    expect(() => parseAccountChoiceReceipt(hostile)).not.toThrow();
    expect(parseAccountChoiceReceipt(hostile)).toBeNull();
    expect(parseAccountChoiceReceipt(Object.create({ source: 'pinned' }))).toBeNull();
  });
});
