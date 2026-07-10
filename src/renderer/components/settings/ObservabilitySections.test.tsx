/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditSection,
  DiagnosticsSection,
  VisionSection,
} from './ObservabilitySections';
import { useVisionConsentStore } from '../../state/vision-consent-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function mount(element: ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return { host, root };
}

function setNexusApi(value: unknown): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value,
  });
}

describe('Observability settings sections', () => {
  beforeEach(() => {
    useVisionConsentStore.setState({
      allowCloudImage: false,
      consentToken: null,
      pending: false,
      error: null,
      lastCapture: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('toggles cloud image consent on and off, clearing the session token', async () => {
    const setImageConsent = vi.fn(async (allowCloudImage: boolean) =>
      allowCloudImage
        ? { allowCloudImage: true, consentToken: 'consent-token' }
        : { allowCloudImage: false, consentToken: null },
    );
    setNexusApi({
      vision: {
        setImageConsent,
        checkPermission: vi.fn(async () => 'granted'),
        capture: vi.fn(),
      },
    });

    const { host, root } = mount(<VisionSection />);
    await act(async () => {});

    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    expect(setImageConsent).toHaveBeenCalledWith(true);
    expect(useVisionConsentStore.getState().consentToken).toBe('consent-token');
    expect(host.textContent).toContain('permitido');

    await act(async () => {
      toggle.click();
    });
    expect(setImageConsent).toHaveBeenCalledWith(false);
    expect(useVisionConsentStore.getState().consentToken).toBeNull();
    expect(host.textContent).toContain('bloqueado');

    act(() => root.unmount());
  });

  it('renders redacted project audit entries without exposing secret values', async () => {
    setNexusApi({
      ops: {
        auditLog: vi.fn(async () => ({
          path: '/Users/test/project-runtime/runtime.sqlite3',
          readAt: '2026-07-07T12:00:00.000Z',
          entries: [
            {
              timestamp: '2026-07-07T12:00:00.000Z',
              session: 'jarvis-renderer',
              project_id: 'project-test',
              checkout_id: 'checkout-test',
              source: 'ipc-renderer',
              tool: 'nexus_file_write',
              args: {
                path: 'src/app.ts',
                content: '[REDACTED_TEXT]',
                token: '[REDACTED]',
              },
              result: 'ok',
              duration_ms: 12,
              user_authorized: true,
            },
          ],
        })),
      },
    });

    const { host, root } = mount(<AuditSection />);
    await act(async () => {});

    expect(host.textContent).toContain('nexus_file_write');
    expect(host.textContent).toContain('[REDACTED]');
    expect(host.textContent).not.toContain('sk-live-secret');

    act(() => root.unmount());
  });

  it('keeps diagnostics renderable when browser permissions are unavailable', async () => {
    setNexusApi({
      vision: {
        checkPermission: vi.fn(async () => {
          throw new Error('permission API unavailable');
        }),
      },
      voice: {
        openMicSettings: vi.fn(),
        openSoundSettings: vi.fn(),
      },
    });

    const { host, root } = mount(<DiagnosticsSection />);
    await act(async () => {});

    expect(host.textContent).toContain('Diagnóstico');
    expect(host.textContent).toContain('Mic permission');
    expect(host.textContent).toContain('Screen Recording');

    act(() => root.unmount());
  });
});
