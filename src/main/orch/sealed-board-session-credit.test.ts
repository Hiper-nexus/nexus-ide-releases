import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSealedBoardSessionCredits,
  markMissionFilesCredited,
  markSessionSealedBoardCredited,
  sessionAlreadyCreditedSealedBoard,
  uncreditedMissionFiles,
} from './sealed-board-session-credit';

afterEach(() => {
  clearSealedBoardSessionCredits();
});

describe('sealed-board-session-credit', () => {
  it('marca a sessão exatamente uma vez', () => {
    expect(sessionAlreadyCreditedSealedBoard('pty-1')).toBe(false);
    markSessionSealedBoardCredited('pty-1');
    expect(sessionAlreadyCreditedSealedBoard('pty-1')).toBe(true);
    expect(sessionAlreadyCreditedSealedBoard('pty-2')).toBe(false);
  });

  it('não recredita o mesmo arquivo no reconcile do disco', () => {
    markMissionFilesCredited('m1', ['server.js', 'public/index.html']);
    expect(uncreditedMissionFiles('m1', ['server.js', 'extra.ts'])).toEqual([
      'extra.ts',
    ]);
  });
});
