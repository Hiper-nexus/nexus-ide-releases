/**
 * Mobile companion v1 policy (Gap E — thin-client stack).
 * Destructive writes require explicit device confirmation; revocation closes sessions.
 * Copyright (c) 2026 Lovecast Inc. — Nexus-authored; uses ORCA remote pairing concepts @ 143c36e.
 * See third_party/licenses/orca-MIT.txt.
 *
 * Stack: thin-client/PWA over remote-bridge — NOT React Native, NOT ORCA mobile/.
 */

export type MobileRpcKind =
  | 'pane.list'
  | 'pane.read'
  | 'pane.stream.subscribe'
  | 'pane.input'
  | 'mission.list'
  | 'ops.snapshot'
  | 'mission.complete'
  | 'git.push'
  | 'git.reset'
  | 'worktree.remove'
  | 'fs.write'
  | 'fs.delete';

const DESTRUCTIVE: ReadonlySet<MobileRpcKind> = new Set([
  'mission.complete',
  'git.push',
  'git.reset',
  'worktree.remove',
  'fs.write',
  'fs.delete',
]);

const READ_ONLY: ReadonlySet<MobileRpcKind> = new Set([
  'pane.list',
  'pane.read',
  'pane.stream.subscribe',
  'mission.list',
  'ops.snapshot',
]);

export type MobileAuthorizeInput = {
  readonly kind: MobileRpcKind;
  /** Device-side explicit confirmation token present for this request. */
  readonly deviceConfirmed?: boolean;
  /** Device still paired / token not revoked. */
  readonly deviceActive: boolean;
};

export type MobileAuthorizeResult =
  | { readonly allowed: true; readonly requiresConfirmation: boolean }
  | { readonly allowed: false; readonly reason: string };

/**
 * Gate mobile RPCs. Fail closed when device revoked.
 * Destructive kinds require deviceConfirmed === true.
 * mission.complete is always denied from mobile (sensors/evidence stay desktop-side).
 */
export function authorizeMobileRpc(input: MobileAuthorizeInput): MobileAuthorizeResult {
  if (!input.deviceActive) {
    return { allowed: false, reason: 'device-revoked' };
  }
  if (input.kind === 'mission.complete') {
    return { allowed: false, reason: 'mission-complete-not-allowed-on-mobile' };
  }
  if (READ_ONLY.has(input.kind) || input.kind === 'pane.input') {
    return { allowed: true, requiresConfirmation: false };
  }
  if (DESTRUCTIVE.has(input.kind)) {
    if (input.deviceConfirmed !== true) {
      return { allowed: false, reason: 'destructive-confirmation-required' };
    }
    return { allowed: true, requiresConfirmation: true };
  }
  return { allowed: false, reason: 'unknown-rpc' };
}

export function isDestructiveMobileRpc(kind: MobileRpcKind): boolean {
  return DESTRUCTIVE.has(kind);
}

/**
 * Map a remote-bridge message `type` to the policy's RPC kind, so the bridge
 * can gate each authed message. Returns null for bridge-internal frames
 * (ping/pair/auth) and control ops the policy does not model — those keep
 * their existing per-message authorization. This is what makes the policy a
 * live gate instead of dead code.
 */
export function mobileRpcKindForBridgeType(type: string): MobileRpcKind | null {
  switch (type) {
    case 'panes.list':
      return 'pane.list';
    case 'pane.read':
      return 'pane.read';
    case 'pane.stream.open':
      return 'pane.stream.subscribe';
    case 'pane.input':
    case 'pane.stream.frame':
      return 'pane.input';
    case 'mission.complete':
      return 'mission.complete';
    case 'git.push':
      return 'git.push';
    case 'git.reset':
      return 'git.reset';
    case 'worktree.remove':
      return 'worktree.remove';
    case 'fs.write':
      return 'fs.write';
    case 'fs.delete':
      return 'fs.delete';
    default:
      return null;
  }
}
