import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAgyKeyringPayload,
  deleteAgyWindowsKeyringBlob,
  invalidateAgyWindowsKeyringCache,
  isAgyKeyringBlob,
  readAgyWindowsKeyringBlob,
  readAgyWindowsKeyringBlobAsync,
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

describe('leitura assíncrona da vaga para o ciclo de cota (#18)', () => {
  type Callback = (error: Error | null, stdout: string) => void;
  const asyncExec = (stdout: () => string) => vi.fn(
    (_file: string, _args: string[], _options: unknown, callback: Callback) => {
      queueMicrotask(() => callback(null, stdout()));
      return { stdin: { end: vi.fn() } };
    },
  );

  it('não bloqueia o Main, junta leituras simultâneas e divide o cache curto com a leitura síncrona', async () => {
    const exec = asyncExec(() => Buffer.from(keyringBlob).toString('base64'));
    const reads = await Promise.all([1, 2, 3].map(() =>
      readAgyWindowsKeyringBlobAsync({ exec: exec as never, platform: 'win32', now: 1_000 })));
    expect(reads).toEqual([keyringBlob, keyringBlob, keyringBlob]);
    expect(exec).toHaveBeenCalledTimes(1);
    // O segredo nunca vai no argv; o stdin é fechado para o PowerShell não esperar.
    expect((exec.mock.calls[0]![1] as string[]).join(' ')).not.toContain('refresh_token');
    expect(exec.mock.results[0]!.value.stdin.end).toHaveBeenCalled();

    const syncExec = vi.fn();
    expect(readAgyWindowsKeyringBlob({ exec: syncExec as never, platform: 'win32', now: 2_000 })).toBe(keyringBlob);
    expect(syncExec).not.toHaveBeenCalled();
  });

  it('troca de conta no meio da leitura não publica o blob anterior no cache', async () => {
    let finish: Callback = () => undefined;
    const slow = vi.fn((_file: string, _args: string[], _options: unknown, callback: Callback) => {
      finish = callback;
      return { stdin: { end: vi.fn() } };
    });
    const pending = readAgyWindowsKeyringBlobAsync({ exec: slow as never, platform: 'win32', now: 1_000 });
    invalidateAgyWindowsKeyringCache();
    finish(null, Buffer.from(keyringBlob).toString('base64'));
    expect(await pending).toBe(keyringBlob);

    const after = asyncExec(() => '');
    expect(await readAgyWindowsKeyringBlobAsync({ exec: after as never, platform: 'win32', now: 1_100 })).toBeNull();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('leitura síncrona fresca mais nova não é sobrescrita por leitura assíncrona antiga em voo (L3)', async () => {
    let finish: Callback = () => undefined;
    const slow = vi.fn((_file: string, _args: string[], _options: unknown, callback: Callback) => {
      finish = callback;
      return { stdin: { end: vi.fn() } };
    });
    const older = readAgyWindowsKeyringBlobAsync({ exec: slow as never, platform: 'win32', now: 1_000 });
    const newer = JSON.stringify({ token: { access_token: 'b', refresh_token: 'rb' }, id_token: 'h.e30.s' });
    const syncExec = vi.fn(() => Buffer.from(newer).toString('base64'));
    expect(readAgyWindowsKeyringBlob({ exec: syncExec as never, platform: 'win32', now: 1_050, fresh: true })).toBe(newer);
    finish(null, Buffer.from(keyringBlob).toString('base64'));
    expect(await older).toBe(keyringBlob);

    const never = vi.fn();
    expect(readAgyWindowsKeyringBlob({ exec: never as never, platform: 'win32', now: 1_100 })).toBe(newer);
    expect(never).not.toHaveBeenCalled();
  });

  it('falha do PowerShell vira null sem lançar, e fora do Windows não executa nada', async () => {
    const failing = vi.fn((_file: string, _args: string[], _options: unknown, callback: Callback) => {
      callback(new Error('powershell exploded'), '');
      return { stdin: { end: vi.fn() } };
    });
    expect(await readAgyWindowsKeyringBlobAsync({ exec: failing as never, platform: 'win32', now: 1 })).toBeNull();
    const never = vi.fn();
    expect(await readAgyWindowsKeyringBlobAsync({ exec: never as never, platform: 'darwin' })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
