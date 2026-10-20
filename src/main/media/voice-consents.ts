import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VoiceCloneProvider, VoiceCloneReceiptView } from '../../shared/voice-clone-types';
import { removeTreeSync } from '../util/remove-tree';

/**
 * Consent receipts of "Minha voz" (F-1593), kept ONLY on this computer:
 * `<userData>/media/voice-consents.json` (0600, atomic replace) plus the
 * recorded declaration in `<userData>/media/voice-consents/<id>/` (0700 dir,
 * 0600 file). Voice is sensitive personal data (LGPD art. 5, II; ANPD Radar
 * nº 6): nothing here goes to logs, traces, the workspace or the agent.
 */

export interface VoiceConsentReceipt {
  readonly id: string;
  readonly provider: VoiceCloneProvider;
  readonly voiceId: string;
  readonly voiceName: string;
  /** Name the person declared; the declaration audio is the proof. */
  readonly speakerName: string;
  readonly declarationText: string;
  readonly declarationSha256: string;
  readonly samplesSha256: readonly string[];
  readonly samplesSeconds: number;
  readonly consentVersion: string;
  readonly readingTextSha256: string;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly verification: {
    readonly method: 'stt';
    readonly provider: 'elevenlabs' | 'gemini';
    readonly model: string;
    readonly heard: readonly ('nome' | 'idade' | 'autorização' | 'código')[];
  };
  readonly requiresVerification: boolean;
  /** Gemini (F-1601): the official consent clip Google checked, kept as proof. */
  readonly providerConsent?: {
    readonly method: 'consent_audio';
    readonly phrase: string;
    readonly sha256: string;
  };
}

interface ConsentFile {
  readonly version: 1;
  readonly receipts: VoiceConsentReceipt[];
}

const RECEIPT_ID_RE = /^[a-f0-9]{24}$/u;

export function newReceiptId(): string {
  return randomBytes(12).toString('hex');
}

export function receiptView(receipt: VoiceConsentReceipt): VoiceCloneReceiptView {
  return {
    id: receipt.id,
    provider: receipt.provider,
    voiceId: receipt.voiceId,
    voiceName: receipt.voiceName,
    createdAt: receipt.createdAt,
    requiresVerification: receipt.requiresVerification,
  };
}

export class VoiceConsentStore {
  private cache: ConsentFile | null = null;

  constructor(private readonly mediaRoot: string) {}

  get file(): string {
    return path.join(this.mediaRoot, 'voice-consents.json');
  }

  private evidenceDir(id: string): string {
    if (!RECEIPT_ID_RE.test(id)) throw new Error('recibo inválido');
    return path.join(this.mediaRoot, 'voice-consents', id);
  }

  private read(): ConsentFile {
    if (this.cache) return this.cache;
    let parsed: ConsentFile = { version: 1, receipts: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ConsentFile>;
      if (raw.version === 1 && Array.isArray(raw.receipts)) {
        parsed = {
          version: 1,
          receipts: raw.receipts.filter(
            (receipt): receipt is VoiceConsentReceipt =>
              Boolean(receipt) &&
              typeof receipt.id === 'string' &&
              RECEIPT_ID_RE.test(receipt.id) &&
              typeof receipt.voiceId === 'string',
          ),
        };
      }
    } catch {
      // Missing or unreadable: no receipts. A corrupt file is never rewritten
      // blindly — `write` replaces it only when the user adds or removes one.
    }
    this.cache = parsed;
    return parsed;
  }

  private write(next: ConsentFile): void {
    fs.mkdirSync(this.mediaRoot, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // Windows: o ACL do perfil do usuário protege o arquivo.
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    this.cache = next;
  }

  list(): VoiceConsentReceipt[] {
    return [...this.read().receipts];
  }

  hasVoice(voiceId: string): boolean {
    return this.read().receipts.some((receipt) => receipt.voiceId === voiceId);
  }

  get(id: string): VoiceConsentReceipt | null {
    return this.read().receipts.find((receipt) => receipt.id === id) ?? null;
  }

  /** Evidence first, receipt last: a receipt never points at missing proof. */
  add(receipt: VoiceConsentReceipt, declarationWav: Uint8Array, consentWav?: Uint8Array): void {
    const dir = this.evidenceDir(receipt.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'declaration.wav'), declarationWav, { mode: 0o600, flag: 'wx' });
    if (consentWav) fs.writeFileSync(path.join(dir, 'provider-consent.wav'), consentWav, { mode: 0o600, flag: 'wx' });
    try {
      const current = this.read();
      this.write({ version: 1, receipts: [...current.receipts, receipt] });
    } catch (error) {
      removeTreeSync(dir);
      throw error;
    }
  }

  /** Receipt and evidence are removed together; missing pieces are not an error. */
  remove(id: string): boolean {
    const current = this.read();
    const exists = current.receipts.some((receipt) => receipt.id === id);
    if (exists) {
      this.write({ version: 1, receipts: current.receipts.filter((receipt) => receipt.id !== id) });
    }
    const dir = this.evidenceDir(id);
    if (fs.existsSync(dir)) removeTreeSync(dir);
    return exists;
  }
}
