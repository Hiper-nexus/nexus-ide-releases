/** Authorization for speech without repeating the wake word. */
// A natural pause after a spoken/tool response often exceeds eight seconds.
// Keep the already-open Gemini mic authoritative long enough for a real
// conversational follow-up without forcing the user to repeat "Jarvis".
export const FOLLOW_UP_AUTHORITY_MS = 60_000;

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
