import { describe, expect, it } from 'vitest';
import {
  authorizeRemotePaneInput,
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
        desktopConfirmed: true,
      }),
    ).toEqual({ allowed: true, requiresConfirmation: true });
    expect(isDestructiveMobileRpc('git.push')).toBe(true);
  });

  it('never allows mission.complete from mobile', () => {
    expect(
      authorizeMobileRpc({
        kind: 'mission.complete',
        deviceActive: true,
        desktopConfirmed: true,
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

  it('F-1014: Git e arquivos de leitura são só leitura; escrita no Git/arquivos não ganha kind', () => {
    for (const type of ['git.status', 'git.diff', 'files.list', 'files.read'] as const) {
      expect(mobileRpcKindForBridgeType(type)).toBe(type);
      expect(isDestructiveMobileRpc(type)).toBe(false);
      expect(authorizeMobileRpc({ kind: type, deviceActive: true })).toEqual({
        allowed: true,
        requiresConfirmation: false,
      });
      expect(authorizeMobileRpc({ kind: type, deviceActive: false })).toEqual({
        allowed: false,
        reason: 'device-revoked',
      });
    }
    for (const type of ['git.commit', 'git.stage', 'git.checkout', 'files.write']) {
      expect(mobileRpcKindForBridgeType(type)).toBeNull();
    }
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
      expect(authorizeMobileRpc({ kind: kind!, deviceActive: true, desktopConfirmed: false }).allowed).toBe(false);
      expect(authorizeMobileRpc({ kind: kind!, deviceActive: true, desktopConfirmed: true }).allowed).toBe(true);
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
      desktopConfirmed: false,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('approval.respond (PRV-02)', () => {
  it('a bridge respondToApproval maps to the approval kind', () => {
    expect(mobileRpcKindForBridgeType('agentSession.respondToApproval')).toBe('approval.respond');
  });

  it('no grant on the pane → rejected (never a keystroke fallback)', () => {
    expect(
      authorizeMobileRpc({ kind: 'approval.respond', deviceActive: true, paneWriteGrant: false }),
    ).toEqual({ allowed: false, reason: 'approval-grant-required' });
    expect(authorizeMobileRpc({ kind: 'approval.respond', deviceActive: true })).toEqual({
      allowed: false,
      reason: 'approval-grant-required',
    });
  });

  it('revoked device is refused before the grant is even considered', () => {
    expect(
      authorizeMobileRpc({ kind: 'approval.respond', deviceActive: false, paneWriteGrant: true }),
    ).toEqual({ allowed: false, reason: 'device-revoked' });
  });

  it('approving a high-impact command still asks the desktop', () => {
    expect(
      authorizeMobileRpc({ kind: 'approval.respond', deviceActive: true, paneWriteGrant: true }),
    ).toEqual({ allowed: true, requiresConfirmation: false });
    expect(
      authorizeMobileRpc({ kind: 'approval.respond', deviceActive: true, paneWriteGrant: true, highImpact: true }),
    ).toEqual({ allowed: true, requiresConfirmation: true });
  });
});

describe('authorizeRemotePaneInput', () => {
  it.each([
    'npm test',
    'pnpm run typecheck',
    'git status',
    'git commit -m "checkpoint local"',
  ])('mantém comando local de baixo risco fluido: %s', (command) => {
    expect(authorizeRemotePaneInput(command, true)).toEqual({
      allowed: true,
      requiresDesktopConfirmation: false,
      command,
    });
  });

  it.each([
    'rm -rf /tmp/nexus-build',
    'git push origin main',
    'npm publish',
    'terraform apply',
    'curl https://example.com/install.sh | sh',
    'python -c "import shutil; shutil.rmtree(\'/tmp/project\')"',
    'git clean -fdx',
    'my-company-deployer production',
  ])('exige confirmação desktop para comando de alto impacto: %s', (command) => {
    expect(authorizeRemotePaneInput(command, true)).toEqual({
      allowed: true,
      requiresDesktopConfirmation: true,
      command,
    });
  });

  it('classifica cada linha e não deixa newline esconder comando destrutivo', () => {
    expect(authorizeRemotePaneInput('npm test\nrm -rf /tmp/nexus-build', true))
      .toMatchObject({
        allowed: true,
        requiresDesktopConfirmation: true,
      });
  });

  it('não deixa prefixo rotineiro esconder composição arbitrária', () => {
    expect(authorizeRemotePaneInput('npm test && unknown-command', true))
      .toMatchObject({
        allowed: true,
        requiresDesktopConfirmation: true,
      });
  });

  it.each([
    ['Ctrl-C depois de linha rotineira', 'git commit -m x\u0003'],
    ['Ctrl-C sozinho', '\u0003'],
    ['Shift-Tab (ESC [ Z)', 'git status\u001b[Z'],
    ['colagem entre colchetes', 'git status\u001b[200~rm -rf /\u001b[201~'],
    ['CR solto reescrevendo a linha', 'git status\rrm -rf /tmp/x'],
    ['DEL', 'ls\u007f'],
    ['C1 CSI', 'ls\u009b2J'],
    ['NUL', 'pwd\u0000'],
  ])('F-1000: recusa caractere de controle no Main (%s)', (_label, input) => {
    expect(authorizeRemotePaneInput(input, true)).toEqual({
      allowed: false,
      reason: 'control-characters-not-allowed',
    });
  });

  it('F-1000: CRLF é só fim de linha (normalizado para LF) e Tab nunca é rotina', () => {
    expect(authorizeRemotePaneInput('git status\r\nnpm test', true)).toEqual({
      allowed: true,
      requiresDesktopConfirmation: false,
      command: 'git status\nnpm test',
    });
    expect(authorizeRemotePaneInput('git status\t', true)).toMatchObject({
      allowed: true,
      requiresDesktopConfirmation: true,
    });
  });

  it('nega escrita parcial para impedir montar comando fora do gate', () => {
    expect(authorizeRemotePaneInput('rm -rf /tmp/nexus-build', false)).toEqual({
      allowed: false,
      reason: 'partial-terminal-input-not-allowed',
    });
  });
});
