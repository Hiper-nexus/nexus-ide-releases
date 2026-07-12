import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DOCTOR_DIAGNOSTIC_MODEL = 'grok-4.5';
export const DOCTOR_DIAGNOSTIC_EFFORT = 'xhigh';

export function unwrapDoctorDiagnosticOutput(output: string): string {
  if (!output) throw new Error('Doctor não devolveu diagnóstico');
  try {
    const envelope = JSON.parse(output) as {
      structuredOutput?: unknown;
      text?: unknown;
      structuredOutputError?: unknown;
    };
    if (envelope.structuredOutput != null) {
      return JSON.stringify(envelope.structuredOutput);
    }
    if (typeof envelope.text === 'string' && envelope.text.trim()) {
      return envelope.text.trim();
    }
    if (typeof envelope.structuredOutputError === 'string') {
      throw new Error(envelope.structuredOutputError);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return output;
    throw error;
  }
  return output;
}

/**
 * LLM escalation for the deterministic Doctor. It is diagnosis/design only:
 * recovery policies remain signed code and never execute model-authored shell.
 */
export async function diagnoseWithDoctorGrok(input: {
  cwd: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  model?: string;
  effort?: string;
}): Promise<string> {
  const prompt = `${input.system}\n\n${input.user}`;
  const { stdout } = await execFileAsync(
    'grok',
    [
      '--single',
      prompt,
      '--model',
      input.model || DOCTOR_DIAGNOSTIC_MODEL,
      '--reasoning-effort',
      input.effort === 'max' || !input.effort
        ? DOCTOR_DIAGNOSTIC_EFFORT
        : input.effort,
      '--json-schema',
      JSON.stringify(input.jsonSchema),
      '--max-turns',
      '3',
      '--disable-web-search',
      '--verbatim',
    ],
    {
      cwd: input.cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    },
  );
  const output = stdout.trim();
  if (!output) throw new Error('Grok Doctor não devolveu diagnóstico');
  // Grok CLI writes a transport envelope even in --single mode. Consumers of
  // this module expect the model payload, not session/thought metadata.
  return unwrapDoctorDiagnosticOutput(output);
}
