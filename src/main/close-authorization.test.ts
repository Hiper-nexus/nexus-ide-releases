import { beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeAppQuit,
  closeNeedsConfirmation,
  isAppQuitAuthorized,
  resetCloseAuthorizationForTest,
} from './close-authorization';

beforeEach(resetCloseAuthorizationForTest);

describe('close authorization', () => {
  it('requires confirmation only while live sessions would be destroyed', () => {
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: false, smokeTest: false }),
    ).toBe(true);
    expect(
      closeNeedsConfirmation({ sessionCount: 0, authorized: false, smokeTest: false }),
    ).toBe(false);
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: true, smokeTest: false }),
    ).toBe(false);
    expect(
      closeNeedsConfirmation({ sessionCount: 2, authorized: false, smokeTest: true }),
    ).toBe(false);
  });

  it('remembers an authorized app quit for the window close phase', () => {
    expect(isAppQuitAuthorized()).toBe(false);
    authorizeAppQuit();
    expect(isAppQuitAuthorized()).toBe(true);
  });
});
