import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ order: [] as string[], listener: undefined as (() => void) | undefined }));
vi.mock('./license-access', () => ({
  getAccessState: () => { h.order.push('evaluate'); return { canUseApp: false }; },
  onAccessChanged: (listener: () => void) => { h.order.push('subscribe'); h.listener = listener; return () => { h.listener = undefined; }; },
}));
import { initializeLicenseAuthority } from './license-bootstrap';
it('subscribes and evaluates the fail-closed authority synchronously before returning to bootstrap', () => {
  const broadcast = vi.fn();
  const off = initializeLicenseAuthority(broadcast);
  expect(h.order).toEqual(['subscribe', 'evaluate']);
  h.listener?.(); expect(broadcast).toHaveBeenCalledOnce();
  off(); expect(h.listener).toBeUndefined();
});
