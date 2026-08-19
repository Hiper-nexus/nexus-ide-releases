import { describe, expect, it, beforeEach } from 'vitest';
import {
  decideSameCheckoutFanout,
  extractOwnershipFilesFromPrompt,
  ownershipFilesOverlap,
  registerSameCheckoutClaim,
  resetSameCheckoutClaimsForTests,
  sameCheckoutClaimOf,
} from './same-checkout-fanout';

describe('same-checkout fan-out', () => {
  beforeEach(() => {
    resetSameCheckoutClaimsForTests();
  });

  it('permite dois escritores no mesmo turno com paths disjuntos', () => {
    const first = decideSameCheckoutFanout({
      spawnReadOnly: false,
      requestedFiles: ['saas-waitlist/server.js'],
      activeWriters: [],
    });
    expect(first).toEqual({ allowed: true });

    const second = decideSameCheckoutFanout({
      spawnReadOnly: false,
      requestedFiles: ['saas-waitlist/public/index.html'],
      activeWriters: [
        {
          paneId: 'pane-codex-1',
          state: 'busy',
          files: ['saas-waitlist/server.js'],
        },
      ],
    });
    expect(second).toEqual({ allowed: true });
  });

  it('serializa quando o mesmo arquivo colide', () => {
    const decision = decideSameCheckoutFanout({
      spawnReadOnly: false,
      requestedFiles: ['saas-waitlist/server.js'],
      activeWriters: [
        {
          paneId: 'pane-busy',
          state: 'busy',
          files: ['saas-waitlist/server.js', 'README.md'],
        },
      ],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/collision|pane-busy/);
    }
  });

  it('sem files= fail-closed serializa contra qualquer escritor ativo', () => {
    const decision = decideSameCheckoutFanout({
      spawnReadOnly: false,
      requestedFiles: [],
      activeWriters: [
        { paneId: 'pane-1', state: 'spawning', files: ['a.js'] },
      ],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/serialized|files=/);
    }
  });

  it('read-only spawn nunca é bloqueado por escritor', () => {
    expect(
      decideSameCheckoutFanout({
        spawnReadOnly: true,
        requestedFiles: [],
        activeWriters: [
          { paneId: 'pane-w', state: 'busy', files: ['x.ts'] },
        ],
      }),
    ).toEqual({ allowed: true });
  });

  it('extrai paths do prompt para fan-out implícito', () => {
    const files = extractOwnershipFilesFromPrompt(
      'Crie saas-waitlist/server.js e saas-waitlist/public/index.html e README.md',
    );
    expect(files).toContain('saas-waitlist/server.js');
    expect(files).toContain('saas-waitlist/public/index.html');
    expect(files).toContain('README.md');
  });

  it('registra claims por pane', () => {
    registerSameCheckoutClaim('pane-a', ['a.js', 'b.js']);
    expect(sameCheckoutClaimOf('pane-a')).toEqual(['a.js', 'b.js']);
    expect(ownershipFilesOverlap(['a.js'], ['c.js'])).toBe(false);
    expect(ownershipFilesOverlap(['a.js'], ['a.js'])).toBe(true);
  });
});
