import { getOrchSettings } from '../persistence/settings-store';
import { analysisClient } from '../pty/pty-analysis-runtime';
import { CliPromptAutoResponder } from './cli-prompt-autoresponder-core';
export * from './cli-prompt-autoresponder-core';
class WorkerCliPromptAutoResponder extends CliPromptAutoResponder {
  readonly cache = new Map<string, { generation: number | null; at: number; value: ReturnType<CliPromptAutoResponder['analysisSnapshot']> }>();
  readonly settling = new Map<string, number>();
  acceptWorker(sessionId: string, value: ReturnType<CliPromptAutoResponder['analysisSnapshot']> & { verified?: boolean }, at: number) {
    // F-984: depois de responder, o Worker desvincula a assinatura e não manda
    // mais snapshot; o `defer: true` dos snapshots da resposta/verificação
    // ficava 180 s no cache e o brief do Kimi nunca saía. A espera depois da
    // resposta é do `settling` e do `isVerifying` do próprio Main.
    const settled = value.response || value.verified === true;
    this.cache.set(sessionId, { generation: analysisClient.generation(sessionId), at, value: settled ? { ...value, defer: false, banner: false } : value });
    this.acceptAnalysis(sessionId, value, at);
    if (value.response) this.settling.set(sessionId, at + 450);
  }
  private cached(sessionId: string) {
    if (analysisClient.status(sessionId) !== 'active' || !getOrchSettings().cliPromptAutoResponderEnabled) return null;
    const entry = this.cache.get(sessionId); return entry && Date.now() - entry.at <= 180_000 ? entry.value : null;
  }
  override shouldDeferInjection(sessionId: string, now = Date.now()): boolean {
    return this.isVerifying(sessionId) || (this.settling.get(sessionId) ?? 0) > now || Boolean(this.cached(sessionId)?.defer);
  }
  override isHoldingForBanner(sessionId: string): boolean { return Boolean(this.cached(sessionId)?.banner); }
  override forceAcceptResponse(sessionId: string, now = Date.now()) {
    const forced = this.cached(sessionId)?.force; if (!forced) return null;
    this.acceptAnalysis(sessionId, forced, now); this.settling.set(sessionId, now + 450);
    analysisClient.control(sessionId, 'prompt', { accepted: forced });
    return { response: forced.response, fallbackResponse: forced.fallbackResponse };
  }
  override setWriter(writer: (sessionId: string, data: string) => void): void {
    super.setWriter((sessionId, data) => { const cached = this.cache.get(sessionId); if (analysisClient.status(sessionId) === 'active' && cached?.generation === analysisClient.generation(sessionId)) writer(sessionId, data); });
  }
  override bind(sessionId: string, adapterId: string, now = Date.now(), options: { governed?: boolean } = {}): void {
    super.bind(sessionId, adapterId, now, options); this.cache.delete(sessionId); this.settling.delete(sessionId);
    analysisClient.control(sessionId, 'prompt', { bind: { adapterId, now, governed: options.governed ?? true } });
  }
  override drop(sessionId: string): void { super.drop(sessionId); this.cache.delete(sessionId); this.settling.delete(sessionId); analysisClient.control(sessionId, 'prompt', { drop: true }); }
}
export const cliPromptAutoResponder = new WorkerCliPromptAutoResponder(() => getOrchSettings().cliPromptAutoResponderEnabled);
