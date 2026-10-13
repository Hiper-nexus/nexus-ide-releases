import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAgyKeyringPayload,
  deleteAgyWindowsKeyringBlob,
  invalidateAgyWindowsKeyringCache,
  isAgyKeyringBlob,
  readAgyWindowsKeyringBlob,
  writeAgyWindowsKeyringBlob,
} from './agy-windows-keyring';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const keyringBlob = JSON.stringify({
  token: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expiry: '2026-09-28T20:00:00Z' },
  auth_method: 'consumer',
  id_token: jwt({ sub: '111', email: 'a@example.com' }),
});

beforeEach(() => invalidateAgyWindowsKeyringCache());

describe('vaga do AGY no Gerenciador de Credenciais (F-677)', () => {
  it('lê o blob pelo stdout em base64 e guarda em cache curto', () => {
    const exec = vi.fn(() => Buffer.from(keyringBlob).toString('base64'));
    const first = readAgyWindowsKeyringBlob({ exec: exec as never, platform: 'win32', now: 1_000 });
    const cached = readAgyWindowsKeyringBlob({ exec: exec as never, platform: 'win32', now: 2_000 });
    expect(first).toBe(keyringBlob);
    expect(cached).toBe(keyringBlob);
    expect(exec).toHaveBeenCalledTimes(1);
    readAgyWindowsKeyringBlob({ exec: exec as never, platform: 'win32', now: 3_000, fresh: true });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fora do Windows nunca chama o PowerShell', () => {
    const exec = vi.fn();
    expect(readAgyWindowsKeyringBlob({ exec: exec as never, platform: 'darwin' })).toBeNull();
    expect(writeAgyWindowsKeyringBlob(keyringBlob, { exec: exec as never, platform: 'linux' })).toBe(false);
    expect(deleteAgyWindowsKeyringBlob({ exec: exec as never, platform: 'darwin' })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('grava pelo stdin (nunca argv) e só confirma com "ok"', () => {
    const exec = vi.fn((_file: string, args: string[], options: { input?: string }) => {
      expect(args.join(' ')).not.toContain('refresh_token');
      expect(Buffer.from(options.input ?? '', 'base64').toString('utf8')).toBe(keyringBlob);
      return 'ok';
    });
    expect(writeAgyWindowsKeyringBlob(keyringBlob, { exec: exec as never, platform: 'win32' })).toBe(true);
    const failing = vi.fn(() => 'fail');
    expect(writeAgyWindowsKeyringBlob(keyringBlob, { exec: failing as never, platform: 'win32' })).toBe(false);
  });

  it('esvazia a vaga local sem tocar no servidor e invalida o cache', () => {
    const readExec = vi.fn(() => Buffer.from(keyringBlob).toString('base64'));
    expect(readAgyWindowsKeyringBlob({ exec: readExec as never, platform: 'win32', now: 1_000 })).toBe(keyringBlob);
    const deleteExec = vi.fn(() => 'ok');
    expect(deleteAgyWindowsKeyringBlob({ exec: deleteExec as never, platform: 'win32' })).toBe(true);
    const emptyExec = vi.fn(() => '');
    expect(readAgyWindowsKeyringBlob({ exec: emptyExec as never, platform: 'win32', now: 1_500 })).toBeNull();
    expect(emptyExec).toHaveBeenCalledTimes(1);
  });

  it('recusa blob acima do limite do Windows sem chamar o PowerShell', () => {
    const exec = vi.fn();
    expect(writeAgyWindowsKeyringBlob('x'.repeat(2_561), { exec: exec as never, platform: 'win32' })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('decodifica bytes crus e o prefixo base64 do go-keyring', () => {
    expect(decodeAgyKeyringPayload(Buffer.from(keyringBlob))).toBe(keyringBlob);
    const wrapped = `go-keyring-base64:${Buffer.from(keyringBlob).toString('base64')}`;
    expect(decodeAgyKeyringPayload(Buffer.from(wrapped))).toBe(keyringBlob);
    expect(decodeAgyKeyringPayload(Buffer.from('  '))).toBeNull();
  });

  it('formato da vaga exige refresh_token aninhado e id_token', () => {
    expect(isAgyKeyringBlob(keyringBlob)).toBe(true);
    expect(isAgyKeyringBlob(JSON.stringify({ access_token: 'a', refresh_token: 'r' }))).toBe(false);
    expect(isAgyKeyringBlob('not json')).toBe(false);
  });
});
