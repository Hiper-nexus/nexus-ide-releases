import { describe, expect, it, vi } from 'vitest';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import { sendProviderContext } from './live-transport-context';

function provider(
  supportsPassiveContextUpdates: boolean,
): TurnManagedRealtimeProvider {
  return {
    isReady: true,
    supportsPassiveContextUpdates,
    sendContext: vi.fn(),
  } as unknown as TurnManagedRealtimeProvider;
}

describe('sendProviderContext', () => {
  it('sends passive context to providers that support a silent update channel', () => {
    const target = provider(true);

    sendProviderContext(target, 'Tela atual', ['- abrir: ok']);

    expect(target.sendContext).toHaveBeenCalledWith(
      expect.stringContaining('Current Nexus screen:\nTela atual'),
    );
  });

  it('does not turn Gemini context telemetry into realtime user activity', () => {
    const target = provider(false);

    sendProviderContext(target, 'Tela atual', ['- abrir: ok']);

    expect(target.sendContext).not.toHaveBeenCalled();
  });
});
