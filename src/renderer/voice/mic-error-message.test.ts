import { describe, expect, it } from 'vitest';
import { micErrorMessage } from './mic-error-message';

function domError(name: string, message = 'x'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('micErrorMessage', () => {
  it('sem microfone no Windows aponta a entrada de som, não permissão', () => {
    const message = micErrorMessage(domError('NotFoundError', 'Requested device not found'), 'win32');
    expect(message).toContain('Nenhum microfone ativo no Windows');
    expect(message).toContain('Som › Entrada');
  });

  it('bloqueio de privacidade no Windows aponta o interruptor dos apps de desktop', () => {
    expect(micErrorMessage(domError('NotAllowedError'), 'win32')).toContain(
      'aplicativos da área de trabalho',
    );
  });

  it('microfone ocupado pede para fechar o outro app', () => {
    expect(micErrorMessage(domError('NotReadableError'), 'darwin')).toContain('em uso');
  });

  it('erro desconhecido mantém o detalhe', () => {
    expect(micErrorMessage(new Error('boom'), 'linux')).toBe('Microfone indisponível: boom');
  });
});
