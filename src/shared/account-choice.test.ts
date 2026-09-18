import { describe, expect, it } from 'vitest';
import { maskAccountLabel } from './account-choice';

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
