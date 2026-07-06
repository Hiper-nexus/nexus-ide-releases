const PROMPT_WINDOW = 4_096;

interface PromptSignature {
  adapterIds: readonly string[];
  name: string;
  phrases: readonly string[];
  response: string;
}

export const ACCEPT_DEFAULT_PROMPT_RESPONSE = '\r';

export const BUILTIN_PROMPT_SIGNATURES: readonly PromptSignature[] = [
  {
    adapterIds: ['agy'],
    name: 'agy-workspace-trust',
    phrases: [
      'do you trust the contents of this project?',
      'antigravity cli requires permission to read, edit, and execute files here',
      'yes, i trust this folder',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
  },
  {
    adapterIds: ['grok'],
    name: 'grok-folder-trust',
    phrases: [
      'do you trust the contents of this directory?',
      'grok build may run or modify contents in this directory',
      'yes, proceed',
    ],
    response: ACCEPT_DEFAULT_PROMPT_RESPONSE,
  },
];

function normalizePromptText(output: string): string {
  return output.toLowerCase().replace(/\s+/g, ' ');
}

export function matchesPromptSignature(
  output: string,
  signature: PromptSignature,
): boolean {
  const normalized = normalizePromptText(output);
  return signature.phrases.every((phrase) => normalized.includes(phrase));
}

function signaturesFor(adapterId: string): PromptSignature[] {
  return BUILTIN_PROMPT_SIGNATURES.filter((signature) =>
    signature.adapterIds.includes(adapterId),
  );
}

export class CliPromptAutoResponder {
  private readonly buffers = new Map<string, string>();
  private readonly sessions = new Map<string, PromptSignature[]>();

  bind(sessionId: string, adapterId: string): void {
    const signatures = signaturesFor(adapterId);
    if (signatures.length === 0) return;
    this.sessions.set(sessionId, signatures);
    this.buffers.delete(sessionId);
  }

  unbind(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.buffers.delete(sessionId);
  }

  isPending(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.buffers.clear();
  }

  observe(sessionId: string, output: string): string | null {
    const signatures = this.sessions.get(sessionId);
    if (!signatures) return null;
    const buffer = `${this.buffers.get(sessionId) ?? ''}${output}`.slice(
      -PROMPT_WINDOW,
    );
    const match = signatures.find((signature) =>
      matchesPromptSignature(buffer, signature),
    );
    if (!match) {
      this.buffers.set(sessionId, buffer);
      return null;
    }
    this.unbind(sessionId);
    return match.response;
  }
}
