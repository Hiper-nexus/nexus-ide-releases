import { describe, expect, it, vi } from 'vitest';
import { announceTabMissionLeader, tabMissionLeaderNotice } from './operator-hand-mission';

describe('aviso ao pane promovido a orquestrador da aba', () => {
  it('cola uma linha só dizendo qual missão ele orquestra', async () => {
    const inject = vi.fn(async () => {});
    expect(await announceTabMissionLeader('pty-b', 'Missão · Login', inject)).toBe(true);
    expect(inject).toHaveBeenCalledWith('pty-b', expect.stringContaining('Você agora orquestra a Missão · Login'));
    expect(tabMissionLeaderNotice('Missão\n· Login')).not.toContain('\n');
  });

  it('falhar em avisar não derruba nada', async () => {
    const inject = vi.fn(async () => {
      throw new Error('session is gone');
    });
    expect(await announceTabMissionLeader('pty-b', 'Missão · Login', inject)).toBe(false);
  });
});
