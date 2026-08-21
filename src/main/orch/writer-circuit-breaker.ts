/**
 * Writer connected+writable circuit — 3 failures then remint / skip-silent.
 *
 * Adapted from stablyai/orca @ 4ec6bbf5884e5bd915b4f49c4602b5e5a88b61ae
 * (dispatch-circuit-breaker DISPATCH_CIRCUIT_BREAK_FAILURES = 3);
 * Copyright (c) 2026 Lovecast Inc. — MIT License.
 * See third_party/licenses/orca-MIT.txt.
 *
 * A pane that spawned but never became connected AND stdin-writable is not
 * a live writer. Three deaths of the same role or adapter trip the circuit
 * so Kimi is not reseated forever.
 */

export const WRITER_CIRCUIT_BREAK_FAILURES = 10;

export type WriterCircuitKey = {
  readonly missionId: string;
  readonly adapterId: string;
  readonly role?: string | null;
};

export type WriterCircuitAction = 'retry' | 'remint' | 'skip-silent';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function writerCircuitKey(input: WriterCircuitKey): string {
  return `${normalize(input.missionId)}\u0000${normalize(input.role)}\u0000${normalize(input.adapterId)}`;
}

const failures = new Map<string, number>();

export function recordWriterConnectFailure(input: WriterCircuitKey): number {
  const key = writerCircuitKey(input);
  const next = (failures.get(key) ?? 0) + 1;
  failures.set(key, next);
  return next;
}

export function writerConnectFailures(input: WriterCircuitKey): number {
  return failures.get(writerCircuitKey(input)) ?? 0;
}

export function writerCircuitBroken(input: WriterCircuitKey): boolean {
  return writerConnectFailures(input) >= WRITER_CIRCUIT_BREAK_FAILURES;
}

export function clearWriterConnectFailures(input: WriterCircuitKey): void {
  failures.delete(writerCircuitKey(input));
}

/** Trip explícito por veredito externo (ex.: mortalidade ≤3 sem entrega). */
export function tripWriterCircuit(input: WriterCircuitKey): void {
  const key = writerCircuitKey(input);
  failures.set(
    key,
    Math.max(failures.get(key) ?? 0, WRITER_CIRCUIT_BREAK_FAILURES),
  );
}

export function resetWriterCircuitForTests(): void {
  failures.clear();
}

export function decideWriterCircuitAction(input: {
  readonly attempts: number;
  readonly successorAuthed: boolean;
}): WriterCircuitAction {
  if (input.attempts < WRITER_CIRCUIT_BREAK_FAILURES) return 'retry';
  return input.successorAuthed ? 'remint' : 'skip-silent';
}

export function logWriterCircuitBreak(input: {
  readonly adapterId: string;
  readonly attempts: number;
  readonly role?: string | null;
  readonly missionId?: string | null;
}): void {
  console.warn(
    `[writer_circuit_break] adapter=${input.adapterId} attempts=${input.attempts}` +
      (input.role ? ` role=${input.role}` : '') +
      (input.missionId ? ` mission=${input.missionId}` : ''),
  );
}
