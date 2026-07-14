import { describe, expect, it } from 'vitest';
import {
  agentPickerEmptyBeat,
  bootGreeting,
  homeCliBeat,
  homeReadyBeat,
  launchGreeting,
  missionRailActiveBeat,
  missionRailEmptyBeat,
  orchHandoffsEmptyBeat,
  orchMissionsEmptyBeat,
  orchTodosEmptyBeat,
  settingsNavPillar,
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

  it('missionRailEmptyBeat conta uma história com CTA implícita', () => {
    const beat = missionRailEmptyBeat('demo');
    expect(beat.id).toBe('mission-rail-empty');
    expect(beat.title.toLowerCase()).toContain('missão');
    expect(beat.line).toContain('demo');
  });

  it('missionRailActiveBeat narra ativas vs lista', () => {
    expect(missionRailActiveBeat(2, 5).title).toMatch(/2 missões ativas/);
    expect(missionRailActiveBeat(0, 3).kicker).toMatch(/espera/i);
  });

  it('settingsNavPillar resolve pilares YOU/APP/AGENTS/SYSTEM', () => {
    expect(settingsNavPillar('you').story).toMatch(/cockpit/i);
    expect(settingsNavPillar('system').label).toBe('Sistema');
  });

  it('agent-picker e orch empties têm kicker + título acionável', () => {
    const picker = agentPickerEmptyBeat();
    expect(picker.id).toBe('agent-picker-empty');
    expect(picker.kicker?.length).toBeGreaterThan(2);
    expect(picker.line?.toLowerCase()).toMatch(/provider|cli/);

    const missions = orchMissionsEmptyBeat();
    expect(missions.title.toLowerCase()).toMatch(/missão/);
    expect(orchHandoffsEmptyBeat().id).toBe('orch-handoffs-empty');
    expect(orchTodosEmptyBeat().id).toBe('orch-todos-empty');
  });
});
