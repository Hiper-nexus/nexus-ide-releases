/**
 * Mobile companion v1 policy (Gap E — thin-client stack).
 * Destructive writes require explicit desktop confirmation; revocation closes sessions.
 * Copyright (c) 2026 Lovecast Inc. — Nexus-authored; uses ORCA remote pairing concepts @ 143c36e.
 * See third_party/licenses/orca-MIT.txt.
 *
 * Stack: thin-client/PWA over remote-bridge — NOT React Native, NOT ORCA mobile/.
 */

import { requiresVoiceCommandConfirmation } from '../jarvis/guardrails';

export type MobileRpcKind =
  | 'pane.list'
  | 'pane.read'
  | 'pane.stream.subscribe'
  | 'pane.input'
  | 'approval.respond'
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
  /** Main-owned desktop confirmation result; never sourced from the client. */
  readonly desktopConfirmed?: boolean;
  /** Device still paired / token not revoked. */
  readonly deviceActive: boolean;
  /** approval.respond: the device's scope may WRITE the pane that owns the request. */
  readonly paneWriteGrant?: boolean;
  /** approval.respond: approving a high-impact command needs the desktop dialog. */
  readonly highImpact?: boolean;
};

export type MobileAuthorizeResult =
  | { readonly allowed: true; readonly requiresConfirmation: boolean }
  | { readonly allowed: false; readonly reason: string };

/**
 * Gate mobile RPCs. Fail closed when device revoked.
 * Destructive kinds require desktopConfirmed === true.
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
  // PRV-02: responder a um pedido do broker é uma DECISÃO, nunca tecla no PTY.
  // Sem autoridade de escrita no pane do pedido (o "grant" do aparelho) a
  // resposta é recusada — nunca vira input de terminal.
  if (input.kind === 'approval.respond') {
    if (input.paneWriteGrant !== true) {
      return { allowed: false, reason: 'approval-grant-required' };
    }
    return { allowed: true, requiresConfirmation: input.highImpact === true };
  }
  if (DESTRUCTIVE.has(input.kind)) {
    if (input.desktopConfirmed !== true) {
      return { allowed: false, reason: 'destructive-confirmation-required' };
    }
    return { allowed: true, requiresConfirmation: true };
  }
  return { allowed: false, reason: 'unknown-rpc' };
}

export function isDestructiveMobileRpc(kind: MobileRpcKind): boolean {
  return DESTRUCTIVE.has(kind);
}

export type RemotePaneInputDecision =
  | {
      readonly allowed: true;
      readonly requiresDesktopConfirmation: boolean;
      readonly command: string;
    }
  | { readonly allowed: false; readonly reason: string };

const REMOTE_ROUTINE_COMMAND_PATTERNS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|typecheck|lint|check)(?::[a-z0-9:_-]+)?)(?:\s+[-\w=.,:/@]+)*$/i,
  /^npx\s+tsc\s+--noEmit(?:\s+[-\w=.,:/@]+)*$/i,
  /^node\s+node_modules\/vitest\/vitest\.mjs\s+run(?:\s+[-\w=.,:/@]+)*$/i,
  /^git\s+(?:status|diff|log|show|rev-parse)(?:\s+[-\w=.,:/@~^]+)*$/i,
  /^git\s+commit(?:\s+[^;&|`$<>\\\r\n]+)?$/i,
  /^(?:pwd|clear|whoami|uname)(?:\s+[-\w=.,:/@]+)*$/i,
  /^ls(?:\s+[-\w=.,:/@~]+)*$/i,
  /^cd(?:\s+[-\w=.,:/@~]+)?$/i,
  /^(?:y|yes|n|no)$/i,
];

/**
 * Teclas de controle (C0 exceto Tab/LF, DEL e C1 — inclui ESC e, com ele,
 * qualquer sequência CSI/OSC) nunca entram por um caminho remoto: num PTY
 * elas são Ctrl-C, Esc, Shift-Tab, colagem entre colchetes… — ações que não
 * aparecem no texto do comando que a política classifica. O CR só vale como
 * parte de CRLF (normalizado para LF antes desta checagem).
 */
// eslint-disable-next-line no-control-regex -- recusa caracteres de controle de propósito
const REMOTE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function isRoutineRemoteCommand(command: string): boolean {
  // Shell composition/substitution turns an otherwise safe-looking prefix
  // into arbitrary execution. Unknown commands and composed commands require
  // the desktop; only this intentionally small allowlist stays zero-modal.
  if (/[;&|`$<>\\]/.test(command)) return false;
  return REMOTE_ROUTINE_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(command),
  );
}

/**
 * A remote client may submit one complete terminal command at a time.
 *
 * Raw/partial keystreams are denied because they can assemble `rm -rf` (or a
 * deploy) across multiple messages and bypass any per-command classifier.
 * Complete routine local commands keep the 0.19.26 no-modal behavior. The
 * shared Jarvis guardrail remains the single classifier for destructive,
 * publish, deploy and remote effects; each line is checked independently so
 * an embedded newline cannot hide a second high-impact command.
 *
 * Control characters are refused HERE, in the Main, for every remote write
 * path (bridge WSS, PWA and the companion relay all dispatch through
 * handleAuthedMessage): the app-side block is UX, not authority.
 */
export function authorizeRemotePaneInput(
  input: string,
  submit: boolean,
): RemotePaneInputDecision {
  if (!submit) {
    return { allowed: false, reason: 'partial-terminal-input-not-allowed' };
  }
  const command = input.replace(/\r\n/g, '\n');
  if (REMOTE_CONTROL_CHARACTER.test(command)) {
    return { allowed: false, reason: 'control-characters-not-allowed' };
  }
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { allowed: false, reason: 'empty-terminal-input' };
  }
  return {
    allowed: true,
    // Tab completa/alterna modos na TUI do agente: nunca é "de rotina". Vale
    // no texto cru — o trim das linhas o apagaria do que é classificado, mas
    // ele ainda chegaria ao PTY.
    requiresDesktopConfirmation:
      command.includes('\t') ||
      lines.some(
        (line) =>
          requiresVoiceCommandConfirmation(line) ||
          !isRoutineRemoteCommand(line),
      ),
    command,
  };
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
    case 'agentSession.respondToApproval':
      return 'approval.respond';
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
