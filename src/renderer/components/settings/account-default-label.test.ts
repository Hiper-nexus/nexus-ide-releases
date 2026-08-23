import { describe, expect, it } from 'vitest';
import {
  defaultAccountLabel,
  emailFromAuthDetail,
} from './account-default-label';

describe('defaultAccountLabel — duas contas Claude precisam ser distinguíveis', () => {
  it('o que o operador digitou sempre vence', () => {
    expect(
      defaultAccountLabel({
        typed: '  trabalho  ',
        adapterId: 'claude',
        authDetail: 'sessão Claude viva: pessoal@gmail.com',
      }),
    ).toBe('trabalho');
  });

  it('sem rótulo digitado, usa o e-mail da sessão viva', () => {
    // Foi assim que a conta "retorno" ganhou nome; a outra ficou "Conta
    // Claude" e as duas apareciam indistinguíveis no seletor (print 23/08).
    expect(
      defaultAccountLabel({
        typed: '',
        adapterId: 'claude',
        authDetail: 'sessão Claude viva: retornoja@gmail.com',
      }),
    ).toBe('retornoja@gmail.com');
  });

  it('sem e-mail conhecido cai no nome do adapter, nunca em vazio', () => {
    expect(
      defaultAccountLabel({
        typed: '',
        adapterId: 'claude',
        adapterLabel: 'Claude',
        authDetail: 'sessão OAuth local (auth.json)',
      }),
    ).toBe('Conta Claude');
    expect(
      defaultAccountLabel({ typed: '   ', adapterId: 'kimi' }),
    ).toBe('Conta kimi');
  });

  it('extrai o e-mail de qualquer diagnóstico', () => {
    expect(emailFromAuthDetail('sessão Claude viva: a.b+x@dominio.com.br')).toBe(
      'a.b+x@dominio.com.br',
    );
    expect(emailFromAuthDetail('sem sessão')).toBeNull();
    expect(emailFromAuthDetail(null)).toBeNull();
  });
});
