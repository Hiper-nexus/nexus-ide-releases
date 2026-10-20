/** Tipos do cliente do agente de assinatura do YubiKey (client.cjs). */
declare function signFile(file: string): Promise<void>;

declare namespace signFile {
  interface AgentStatus {
    ok: true;
    unlocked: boolean;
    reason?: string;
    pid?: number;
    thumbprint?: string;
    /** DER do certificado que o motor segura, em base64. */
    certificate?: string;
    startedAt?: number;
    /** `null` = agente só deste build (morre com ele). */
    expiresAt?: number | null;
  }

  interface EnsureAgentOptions {
    thumbprint: string;
    spkiSha256: string;
    /** 0 = só este build; 1 a 168 horas. */
    hours: number;
    parentPid?: number;
    /** `save` pede o PIN para guardá-lo; sem isto, PIN guardado ou a janela do Windows. */
    pinMode?: 'save';
    directory?: string;
    nodePath?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    log?: (message: string) => void;
  }

  function verifyFile(file: string, env?: NodeJS.ProcessEnv): Promise<void>;
  function ensureAgent(options: EnsureAgentOptions): Promise<AgentStatus & { started: boolean }>;
  function agentStatus(directory?: string): Promise<(AgentStatus & { info: unknown }) | undefined>;
  function stopAgent(directory?: string): Promise<boolean>;
  function failures(): Array<{ file: string; error: string }>;
  function parseAgentHours(value: string | undefined): number;
  const MIN_REMAINING_MS: number;
}

export = signFile;
