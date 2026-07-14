import { describe, expect, it } from 'vitest';
import {
  bootGreeting,
  homeCliBeat,
  homeReadyBeat,
  launchGreeting,
} from './endorphin';

describe('endorphin beats', () => {
  it('bootGreeting muda com a hora', () => {
    expect(bootGreeting(new Date('2026-07-14T08:00:00'))).toMatch(/Bom dia/);
    expect(bootGreeting(new Date('2026-07-14T23:00:00'))).toMatch(/Noite/);
  });

  it('launchGreeting sempre traz título e kicker', () => {
    const beat = launchGreeting(new Date('2026-07-14T15:00:00'));
    expect(beat.id).toBe('launch');
    expect(beat.title.length).toBeGreaterThan(4);
    expect(beat.kicker?.length).toBeGreaterThan(2);
  });

  it('homeReadyBeat resume CLIs e tools', () => {
    const beat = homeReadyBeat(2, 12);
    expect(beat.title).toMatch(/online/i);
    expect(beat.line).toContain('2 CLIs');
    expect(beat.line).toContain('12');
  });

  it('homeCliBeat puxa para ação', () => {
    expect(homeCliBeat().title.toLowerCase()).toContain('cli');
  });
});
