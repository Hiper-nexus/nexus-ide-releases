/** Authorization for speech without repeating the wake word. */
// Keep hot follow-up short. A one-minute authority window made the room/TV own
// the Gemini mic after every narration; logs showed ambient phrases ("Yes.",
// "obrigado por assistir") becoming tool calls/new missions. Real follow-up is
// still supported, but after this window the user must say the wake word again.
export const FOLLOW_UP_AUTHORITY_MS = 12_000;

export class FollowUpAuthority {
  private deadline = 0;

  arm(now = performance.now(), durationMs = FOLLOW_UP_AUTHORITY_MS): number {
    this.deadline = now + Math.max(0, durationMs);
    return this.deadline;
  }

  clear(): void {
    this.deadline = 0;
  }

  isAuthorized(now = performance.now()): boolean {
    if (this.deadline <= 0 || now >= this.deadline) {
      this.deadline = 0;
      return false;
    }
    return true;
  }

  remainingMs(now = performance.now()): number {
    return this.isAuthorized(now) ? Math.max(0, this.deadline - now) : 0;
  }
}

export const followUpAuthority = new FollowUpAuthority();
