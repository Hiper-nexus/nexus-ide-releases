import { describe, expect, it } from 'vitest';
import type {
  AccountChoiceAlternative,
  AccountChoiceReceipt,
  AccountChoiceSource,
} from './account-choice';
import {
  accountChoiceAriaLabel,
  accountChoiceChipLabel,
  accountChoiceChipView,
  accountChoiceTooltip,
} from './account-choice-display';

/** 02/10/2026 12:00 UTC — relógio e fuso fixos: o texto de horário é determinístico. */
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const OPTIONS = { now: NOW, timeZone: 'UTC' } as const;
const TODAY_1830 = Date.UTC(2026, 9, 2, 18, 30);

const lessHeadroom: AccountChoiceAlternative = {
  label: 'x•••@y•••.com',
  usedPct: 44,
  window: 'Semanal',
  resetsAt: null,
  skipped: 'less-headroom',
};
const cooldown: AccountChoiceAlternative = {
  label: 'z•••@w•••.com',
  usedPct: null,
  window: null,
  resetsAt: null,
  skipped: 'cooldown',
};

function receipt(overrides: Partial<AccountChoiceReceipt> = {}): AccountChoiceReceipt {
  return {
    adapterId: 'claude',
    source: 'headroom-rule',
    account: { label: 'g•••@l•••.com', mode: 'subscription' },
    headroom: { usedPct: 12, window: 'Sessão', resetsAt: TODAY_1830, score: 0.88 },
    alternatives: [lessHeadroom, cooldown],
    decidedAt: NOW - 1_000,
    ...overrides,
  };
}

const ALL_SOURCES: AccountChoiceSource[] = [
  'pinned',
  'headroom-rule',
  'active',
  'active-fallback',
  'native',
  'legacy',
];

describe('accountChoiceChipLabel', () => {
  it('mostra só o rótulo mascarado da conta', () => {
    for (const source of ['pinned', 'headroom-rule', 'active', 'active-fallback'] as const) {
      expect(accountChoiceChipLabel(receipt({ source }))).toBe('g•••@l•••.com');
    }
  });

  it('conta por API key diz isso antes do rótulo', () => {
    expect(
      accountChoiceChipLabel(receipt({ account: { label: 'Co•••va', mode: 'api_key' } })),
    ).toBe('API key · Co•••va');
  });

  it('login nativo sem conta gerenciada vira "conta nativa"; com conta (vaga do AGY) mostra o rótulo', () => {
    expect(accountChoiceChipLabel(receipt({ source: 'native', account: null, headroom: null, alternatives: [] }))).toBe(
      'conta nativa',
    );
    expect(accountChoiceChipLabel(receipt({ source: 'native' }))).toBe('g•••@l•••.com');
  });

  it('caminho legado e recibo sem conta (fora do nativo) não mostram chip', () => {
    expect(accountChoiceChipLabel(receipt({ source: 'legacy' }))).toBeNull();
    expect(accountChoiceChipLabel(receipt({ source: 'legacy', account: null, note: 'aviso' }))).toBeNull();
    expect(accountChoiceChipLabel(receipt({ source: 'pinned', account: null }))).toBeNull();
  });

  it('o rótulo nunca é vazio e nunca é cru, mesmo se o produtor errar', () => {
    expect(accountChoiceChipLabel(receipt({ account: { label: '', mode: 'unknown' } }))).toBe('•••');
    const masked = accountChoiceChipLabel(
      receipt({ account: { label: 'gabriel@lupygo.com.br', mode: 'subscription' } }),
    );
    expect(masked).toBe('g•••@l•••.com.br');
    expect(masked).not.toMatch(/gabriel|lupygo/);
  });
});

describe('accountChoiceTooltip — regra de folga', () => {
  it('explica quem decidiu, a folga medida da vencedora e as alternativas com o motivo', () => {
    expect(accountChoiceTooltip(receipt(), OPTIONS)).toBe(
      'Conta escolhida pela regra de folga: 12% usado na janela Sessão (reinicia às 18:30). ' +
        'Alternativas: x•••@y•••.com — menos folga (44% usado); z•••@w•••.com — em espera.',
    );
  });

  it('formata o reinício conforme o dia: hoje, outro dia e já passado', () => {
    const at = (resetsAt: number) =>
      accountChoiceTooltip(
        receipt({ alternatives: [], headroom: { usedPct: 12, window: 'Sessão', resetsAt, score: 1 } }),
        OPTIONS,
      );
    expect(at(Date.UTC(2026, 9, 3, 9, 5))).toContain('(reinicia em 03/10 às 09:05)');
    expect(at(Date.UTC(2026, 9, 2, 8, 0))).toContain('(reiniciou às 08:00)');
    expect(at(Date.UTC(2026, 9, 1, 8, 0))).toContain('(reiniciou em 01/10 às 08:00)');
  });

  it('usa só o que o recibo traz: sem janela, sem reinício, sem percentual', () => {
    const only = (headroom: AccountChoiceReceipt['headroom']) =>
      accountChoiceTooltip(receipt({ headroom, alternatives: [] }), OPTIONS);
    expect(only({ usedPct: 12, window: null, resetsAt: null, score: 1 })).toBe(
      'Conta escolhida pela regra de folga: 12% usado.',
    );
    expect(only({ usedPct: 0, window: 'Sessão', resetsAt: null, score: 1 })).toBe(
      'Conta escolhida pela regra de folga: 0% usado na janela Sessão.',
    );
    expect(only({ usedPct: null, window: 'Sessão', resetsAt: TODAY_1830, score: null })).toBe(
      'Conta escolhida pela regra de folga: cota ainda não medida.',
    );
    expect(only(null)).toBe('Conta escolhida pela regra de folga: cota ainda não medida.');
  });

  it('cobre cada motivo de alternativa descartada', () => {
    const tip = (skipped: AccountChoiceAlternative['skipped'], usedPct: number | null = null) =>
      accountChoiceTooltip(
        receipt({ alternatives: [{ ...lessHeadroom, skipped, usedPct }] }),
        OPTIONS,
      );
    expect(tip('cooldown')).toContain('x•••@y•••.com — em espera.');
    expect(tip('no-credential')).toContain('x•••@y•••.com — sem credencial.');
    expect(tip('unknown-quota')).toContain('x•••@y•••.com — cota desconhecida.');
    expect(tip('less-headroom', 61)).toContain('x•••@y•••.com — menos folga (61% usado).');
    expect(tip('less-headroom', null)).toContain('x•••@y•••.com — menos folga.');
  });

  it('mostra até 3 alternativas e resume o resto em "+N"', () => {
    const many = (n: number) =>
      accountChoiceTooltip(
        receipt({
          // Rótulos mascarados reais guardam 1 caractere do local: letras distintas.
          alternatives: Array.from({ length: n }, (_, i) => ({
            ...cooldown,
            label: `${'abcdefg'[i]}•••@d•••.com`,
          })),
        }),
        OPTIONS,
      )!;
    expect(many(3)).toContain('c•••@d•••.com — em espera.');
    expect(many(3)).not.toContain('+');
    expect(many(4)).toContain('c•••@d•••.com — em espera; +1 outra.');
    expect(many(4)).not.toContain('d•••@d•••.com');
    expect(many(7)).toContain('+4 outras.');
  });

  it('sem alternativas não imprime a frase de alternativas', () => {
    expect(accountChoiceTooltip(receipt({ alternatives: [] }), OPTIONS)).not.toContain('Alternativas');
  });
});

describe('accountChoiceTooltip — demais origens', () => {
  it('conta fixada: só a frase da fixação quando não há medição, e nunca as alternativas', () => {
    expect(
      accountChoiceTooltip(receipt({ source: 'pinned', headroom: null }), OPTIONS),
    ).toBe('Conta fixada por quem abriu o pane.');
    const withHeadroom = accountChoiceTooltip(receipt({ source: 'pinned' }), OPTIONS)!;
    expect(withHeadroom).toBe(
      'Conta fixada por quem abriu o pane. Medido na escolha: 12% usado na janela Sessão (reinicia às 18:30).',
    );
    expect(withHeadroom).not.toContain('Alternativas');
  });

  it('a medição é da hora da escolha: nunca é apresentada como estado atual da conta', () => {
    for (const source of ['pinned', 'active', 'active-fallback', 'native'] as const) {
      const tip = accountChoiceTooltip(receipt({ source }), OPTIONS)!;
      expect(tip).toContain('Medido na escolha:');
      expect(tip).not.toMatch(/Medido:/);
    }
  });

  it('conta ativa: explica a regra de permanência e lista as alternativas', () => {
    const tip = accountChoiceTooltip(
      receipt({ source: 'active', alternatives: [{ ...lessHeadroom }] }),
      OPTIONS,
    )!;
    expect(tip).toContain('Conta ativa mantida (a ativa fica até a cota medida zerar).');
    expect(tip).toContain('Medido na escolha: 12% usado na janela Sessão (reinicia às 18:30).');
    // Sob "ativa mantida" a irmã não perdeu por folga: não foi comparada.
    expect(tip).toContain('x•••@y•••.com — disponível (44% usado).');
    expect(tip).not.toContain('menos folga');
  });

  it('fallback na ativa: avisa o último recurso e repete o aviso do recibo', () => {
    const note = 'nenhuma conta livre com credencial para claude; abrindo na ativa "g•••@l•••.com"';
    const tip = accountChoiceTooltip(
      receipt({ source: 'active-fallback', headroom: null, alternatives: [cooldown], note }),
      OPTIONS,
    )!;
    expect(tip).toContain('Conta ativa usada como último recurso.');
    expect(tip).toContain('Cota não medida na escolha.');
    expect(tip).toContain('z•••@w•••.com — em espera.');
    expect(tip).toContain(`Aviso: ${note}.`);
  });

  it('o aviso não ganha ponto duplicado nem texto fora do recibo', () => {
    const tip = accountChoiceTooltip(receipt({ source: 'active-fallback', note: 'sem folga.' }), OPTIONS)!;
    expect(tip.endsWith('Aviso: sem folga.')).toBe(true);
  });

  it('login nativo: frase curta, com a medição se houver conta', () => {
    expect(
      accountChoiceTooltip(
        receipt({ source: 'native', account: null, headroom: null, alternatives: [] }),
        OPTIONS,
      ),
    ).toBe('Login nativo da CLI.');
    const slot = accountChoiceTooltip(receipt({ source: 'native' }), OPTIONS)!;
    expect(slot).toBe('Login nativo da CLI. Medido na escolha: 12% usado na janela Sessão (reinicia às 18:30).');
    expect(slot).not.toContain('Alternativas');
  });

  it('caminho legado não tem texto', () => {
    expect(accountChoiceTooltip(receipt({ source: 'legacy' }), OPTIONS)).toBeNull();
  });
});

describe('texto exibido — o que nunca aparece', () => {
  it('chip e tooltip são nulos juntos e o tooltip nunca é vazio, em todas as origens', () => {
    for (const source of ALL_SOURCES) {
      for (const account of [receipt().account, null]) {
        const r = receipt({ source, account });
        const label = accountChoiceChipLabel(r);
        const tip = accountChoiceTooltip(r, OPTIONS);
        expect(label === null).toBe(tip === null);
        if (label !== null) expect(label.trim()).not.toBe('');
        if (tip !== null) expect(tip.trim()).not.toBe('');
      }
    }
  });

  it('não vaza rótulo cru nem e-mail cru, mesmo com recibo não mascarado', () => {
    const raw = receipt({
      source: 'active-fallback',
      account: { label: 'gabriel@lupygo.com.br', mode: 'subscription' },
      alternatives: [{ ...lessHeadroom, label: 'ana.silva@gmail.com' }],
      note: 'abrindo na ativa "gabriel@lupygo.com.br"',
    });
    const all = [
      accountChoiceChipLabel(raw),
      accountChoiceTooltip(raw, OPTIONS),
      accountChoiceAriaLabel(raw, OPTIONS),
    ].join('\n');
    expect(all).not.toMatch(/gabriel|lupygo|silva|gmail/);
    expect(all).toContain('g•••@l•••.com.br');
    expect(all).toContain('a•••@g•••.com');
  });

  it('não expõe score, instante da decisão nem o id do adapter', () => {
    const tip = accountChoiceTooltip(receipt(), OPTIONS)!;
    expect(tip).not.toContain('0.88');
    expect(tip).not.toContain('0,88');
    expect(tip).not.toContain(String(NOW - 1_000));
    expect(tip).not.toContain('claude');
  });

  it('tolera janela/reinício inválidos sem lançar', () => {
    const odd = receipt({
      headroom: { usedPct: 12, window: 'Sessão', resetsAt: Number.NaN, score: 1 },
    });
    expect(() => accountChoiceTooltip(odd, { now: NOW, timeZone: 'Nao/Existe' })).not.toThrow();
    expect(accountChoiceTooltip(odd, { now: NOW, timeZone: 'Nao/Existe' })).toContain('12% usado');
    const badZone = receipt({ alternatives: [] });
    expect(accountChoiceTooltip(badZone, { now: NOW, timeZone: 'Nao/Existe' })).toBe(
      'Conta escolhida pela regra de folga: 12% usado na janela Sessão.',
    );
  });
});

describe('accountChoiceChipView', () => {
  it('junta rótulo, tooltip e aria do mesmo recibo', () => {
    const r = receipt();
    expect(accountChoiceChipView(r, OPTIONS)).toEqual({
      label: accountChoiceChipLabel(r),
      tooltip: accountChoiceTooltip(r, OPTIONS),
      ariaLabel: accountChoiceAriaLabel(r, OPTIONS),
      isWarning: false,
    });
  });

  it('é nulo exatamente quando não há chip', () => {
    expect(accountChoiceChipView(receipt({ source: 'legacy' }), OPTIONS)).toBeNull();
    expect(accountChoiceChipView(receipt({ source: 'pinned', account: null }), OPTIONS)).toBeNull();
  });

  it('marca alerta no fallback na ativa e em qualquer recibo com aviso', () => {
    expect(accountChoiceChipView(receipt({ source: 'active-fallback' }), OPTIONS)?.isWarning).toBe(true);
    expect(accountChoiceChipView(receipt({ note: 'algo deu errado' }), OPTIONS)?.isWarning).toBe(true);
    for (const source of ['pinned', 'headroom-rule', 'active', 'native'] as const) {
      expect(accountChoiceChipView(receipt({ source }), OPTIONS)?.isWarning).toBe(false);
    }
  });
});

describe('accountChoiceAriaLabel', () => {
  it('abre com a conta (o texto visível do chip) e segue com a explicação do tooltip', () => {
    const r = receipt();
    expect(accountChoiceAriaLabel(r, OPTIONS)).toBe(
      `Conta do pane: g•••@l•••.com. ${accountChoiceTooltip(r, OPTIONS)}`,
    );
  });

  it('é nulo quando não há chip', () => {
    expect(accountChoiceAriaLabel(receipt({ source: 'legacy' }), OPTIONS)).toBeNull();
  });
});
