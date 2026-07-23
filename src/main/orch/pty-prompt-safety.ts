const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/** Reject bytes that can escape bracketed paste or submit/cancel PTY input. */
export function assertSafePtyPrompt(prompt: string): string {
  if (UNSAFE_TERMINAL_CONTROL.test(prompt)) {
    throw new Error('unsafe terminal control in prompt');
  }
  return prompt;
}
