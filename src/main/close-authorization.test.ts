import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeAppQuit,
  closeNeedsConfirmation,
  completeConfirmedWindowClose,
  isAppQuitAuthorized,
  QUIT_DIALOG_BUTTONS,
  quitChoiceFromResponse,
  resetCloseAuthorizationForTest,
  revokeAppQuitAuthorization,
} from './close-authorization';

beforeEach(resetCloseAuthorizationForTest);

describe('diálogo de sair (F-726)', () => {
  it('sair e retomar é o padrão; só o botão explícito encerra as missões', () => {
    expect(QUIT_DIALOG_BUTTONS).toEqual([
      'Cancelar',
      'Sair e retomar ao abrir',
      'Sair e encerrar missões',
    ]);
    expect(quitChoiceFromResponse(0)).toBe('cancel');
    expect(quitChoiceFromResponse(1)).toBe('quit-resume');
    expect(quitChoiceFromResponse(2)).toBe('quit-close-missions');
    // Esc / fechar o diálogo / resposta inesperada nunca encerra nada.
    expect(quitChoiceFromResponse(-1)).toBe('cancel');
    expect(quitChoiceFromResponse(7)).toBe('cancel');
  });
});

describe('close authorization', () => {
  it('requires confirmation only while live sessions would be destroyed', () => {
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: false, smokeTest: false }),
    ).toBe(true);
    expect(
      closeNeedsConfirmation({ sessionCount: 0, authorized: false, smokeTest: false }),
    ).toBe(false);
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: true, smokeTest: false }),
    ).toBe(false);
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: false, smokeTest: true }),
    ).toBe(false);
  });

  it('remembers an authorized app quit for the window close phase', () => {
    expect(isAppQuitAuthorized()).toBe(false);
    authorizeAppQuit();
    expect(isAppQuitAuthorized()).toBe(true);
    revokeAppQuitAuthorization();
    expect(isAppQuitAuthorized()).toBe(false);
  });

  it('routes a confirmed Darwin window close with a mission agent through app shutdown', () => {
    const order: string[] = [];
    const quitApp = () => {
      order.push(isAppQuitAuthorized() ? 'authorized-quit' : 'unsafe-quit');
    };
    const sealRuntimeAdmission = () => order.push('admission-sealed');

    expect(
      completeConfirmedWindowClose({
        sealRuntimeAdmission,
        quitApp,
      }),
    ).toBe('app-shutdown');
    expect(order).toEqual(['admission-sealed', 'authorized-quit']);
    expect(isAppQuitAuthorized()).toBe(true);
  });

  it('requires fresh confirmation after a failed shutdown revokes authorization', () => {
    const quitApp = vi.fn();
    const sealRuntimeAdmission = vi.fn();
    completeConfirmedWindowClose({
      sealRuntimeAdmission,
      quitApp,
    });
    expect(quitApp).toHaveBeenCalledOnce();

    revokeAppQuitAuthorization();
    expect(
      closeNeedsConfirmation({
        sessionCount: 1,
        authorized: isAppQuitAuthorized(),
        smokeTest: false,
      }),
    ).toBe(true);

    completeConfirmedWindowClose({
      sealRuntimeAdmission,
      quitApp,
    });
    expect(quitApp).toHaveBeenCalledTimes(2);
    expect(sealRuntimeAdmission).toHaveBeenCalledTimes(2);
  });

  it('routes an empty sole window through sealed app shutdown without a modal', () => {
    const quitApp = vi.fn();
    const sealRuntimeAdmission = vi.fn();

    expect(
      completeConfirmedWindowClose({
        sealRuntimeAdmission,
        quitApp,
      }),
    ).toBe('app-shutdown');
    expect(sealRuntimeAdmission).toHaveBeenCalledOnce();
    expect(quitApp).toHaveBeenCalledOnce();
    expect(isAppQuitAuthorized()).toBe(true);
  });
});
