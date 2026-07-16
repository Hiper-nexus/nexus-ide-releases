import { describe, expect, it } from 'vitest';
import {
  authorizeMobileRpc,
  isDestructiveMobileRpc,
  mobileRpcKindForBridgeType,
} from './mobile-companion-policy';

describe('mobile-companion-policy', () => {
  it('allows read RPCs when device active', () => {
    expect(
      authorizeMobileRpc({ kind: 'pane.list', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
    expect(
      authorizeMobileRpc({ kind: 'mission.list', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
    expect(
      authorizeMobileRpc({ kind: 'ops.snapshot', deviceActive: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
  });

  it('fails closed when device revoked', () => {
    expect(
      authorizeMobileRpc({ kind: 'pane.list', deviceActive: false }),
    ).toEqual({ allowed: false, reason: 'device-revoked' });
  });

  it('requires confirmation for destructive writes', () => {
    expect(
      authorizeMobileRpc({ kind: 'fs.delete', deviceActive: true }),
    ).toEqual({ allowed: false, reason: 'destructive-confirmation-required' });
    expect(
      authorizeMobileRpc({
        kind: 'fs.delete',
        deviceActive: true,
        deviceConfirmed: true,
      }),
    ).toEqual({ allowed: true, requiresConfirmation: true });
    expect(isDestructiveMobileRpc('git.push')).toBe(true);
  });

  it('never allows mission.complete from mobile', () => {
    expect(
      authorizeMobileRpc({
        kind: 'mission.complete',
        deviceActive: true,
        deviceConfirmed: true,
      }),
    ).toEqual({ allowed: false, reason: 'mission-complete-not-allowed-on-mobile' });
  });
});

describe('mobileRpcKindForBridgeType', () => {
  it('mapeia os tipos read-mostly atuais da bridge', () => {
    expect(mobileRpcKindForBridgeType('panes.list')).toBe('pane.list');
    expect(mobileRpcKindForBridgeType('pane.read')).toBe('pane.read');
    expect(mobileRpcKindForBridgeType('pane.stream.open')).toBe('pane.stream.subscribe');
    expect(mobileRpcKindForBridgeType('pane.input')).toBe('pane.input');
    expect(mobileRpcKindForBridgeType('pane.stream.frame')).toBe('pane.input');
  });

  it('mapeia tipos destrutivos futuros para o kind gateado', () => {
    expect(mobileRpcKindForBridgeType('git.push')).toBe('git.push');
    expect(mobileRpcKindForBridgeType('git.reset')).toBe('git.reset');
    expect(mobileRpcKindForBridgeType('worktree.remove')).toBe('worktree.remove');
    expect(mobileRpcKindForBridgeType('fs.write')).toBe('fs.write');
    expect(mobileRpcKindForBridgeType('fs.delete')).toBe('fs.delete');
    expect(mobileRpcKindForBridgeType('mission.complete')).toBe('mission.complete');
  });

  it('cada destrutivo mapeado exige confirmação do device', () => {
    for (const type of ['git.reset', 'worktree.remove', 'fs.write']) {
      const kind = mobileRpcKindForBridgeType(type);
      expect(kind).not.toBeNull();
      expect(authorizeMobileRpc({ kind: kind!, deviceActive: true, deviceConfirmed: false }).allowed).toBe(false);
      expect(authorizeMobileRpc({ kind: kind!, deviceActive: true, deviceConfirmed: true }).allowed).toBe(true);
    }
  });

  it('retorna null para frames internos e controle não-modelado', () => {
    expect(mobileRpcKindForBridgeType('ping')).toBeNull();
    expect(mobileRpcKindForBridgeType('pair')).toBeNull();
    expect(mobileRpcKindForBridgeType('auth')).toBeNull();
    expect(mobileRpcKindForBridgeType('pane.resize')).toBeNull();
    expect(mobileRpcKindForBridgeType('pane.close')).toBeNull();
  });

  it('gate composto: um git.push sem confirmação é negado', () => {
    const kind = mobileRpcKindForBridgeType('git.push');
    expect(kind).not.toBeNull();
    const decision = authorizeMobileRpc({
      kind: kind!,
      deviceActive: true,
      deviceConfirmed: false,
    });
    expect(decision.allowed).toBe(false);
  });
});
