/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternalFromAnchor } from './open-external';

afterEach(() => { Reflect.deleteProperty(window, 'nexus'); });

describe('openExternalFromAnchor (F-1376)', () => {
  it('absorve rejeição do IPC sem deixar promise não tratada', async () => {
    const opened: string[] = [];
    // A spy acompanha o estado da promise e pode mascarar unhandledRejection.
    const openExternal = (url: string) => {
      opened.push(url);
      return Promise.reject(new Error('external denied'));
    };
    Object.defineProperty(window, 'nexus', {
      configurable: true, value: { app: { openExternal } },
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const click = new MouseEvent('click', { cancelable: true });
      openExternalFromAnchor(
        click as unknown as Parameters<typeof openExternalFromAnchor>[0],
        'https://example.com/docs',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(click.defaultPrevented).toBe(true);
      expect(opened).toEqual(['https://example.com/docs']);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
