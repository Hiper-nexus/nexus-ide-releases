import type { WebContents } from 'electron';
import { z } from 'zod';
import { APPROVAL_CHANNELS } from '../../shared/approval-channels';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_ID_MAX_CHARS,
  type ApprovalRequestView,
} from '../../shared/approval-decision';
import { handleTrusted } from '../security/trusted-ipc';
import {
  approvalBroker,
  setDesktopApprovalSurfaces,
  type ApprovalBroker,
  type ApprovalRespondResult,
} from './approval-broker';

/**
 * IPC do card de aprovação do desktop (PRV-02). Só o frame principal da
 * janela principal alcança (`handleTrusted`). O renderer lista, responde com
 * uma DECISÃO (nunca tecla no PTY) e informa quais sessões têm o card visível
 * — sem isso o hook não espera pelo desktop. Entrada inválida é recusada sem
 * efeito; a lista volta por push quando muda.
 */

const MAX_SURFACES = 64;
const SESSION_ID_MAX_CHARS = 200;

const RespondRequest = z
  .object({
    requestId: z.string().min(1).max(APPROVAL_REQUEST_ID_MAX_CHARS),
    expectedRevision: z.number().int().positive(),
    optionId: z.enum(APPROVAL_DECISIONS),
  })
  .strict();

const SurfacesRequest = z
  .object({
    sessionIds: z.array(z.string().min(1).max(SESSION_ID_MAX_CHARS)).max(MAX_SURFACES),
  })
  .strict();

export function registerApprovalIpc(broker: ApprovalBroker = approvalBroker): void {
  const listeners = new Set<WebContents>();
  const surfacesBySender = new Map<number, readonly string[]>();
  const publishSurfaces = () =>
    setDesktopApprovalSurfaces([...surfacesBySender.values()].flat());
  const track = (sender: WebContents) => {
    if (listeners.has(sender)) return;
    listeners.add(sender);
    // Janela fechada/recarregada não pode deixar card "visível" para trás:
    // o hook esperaria um respondente que não existe mais.
    sender.once('destroyed', () => {
      listeners.delete(sender);
      surfacesBySender.delete(sender.id);
      publishSurfaces();
    });
  };

  handleTrusted(APPROVAL_CHANNELS.list, (event): ApprovalRequestView[] => {
    track(event.sender);
    return broker.list();
  });

  handleTrusted(APPROVAL_CHANNELS.respond, (_event, raw): ApprovalRespondResult | { status: 'rejected'; reason: 'invalid-params' } => {
    const request = RespondRequest.safeParse(raw);
    if (!request.success) return { status: 'rejected', reason: 'invalid-params' };
    return broker.respond({ ...request.data, source: 'desktop' });
  });

  handleTrusted(APPROVAL_CHANNELS.surfaces, (event, raw): boolean => {
    const request = SurfacesRequest.safeParse(raw);
    if (!request.success) return false;
    track(event.sender);
    surfacesBySender.set(event.sender.id, request.data.sessionIds);
    publishSurfaces();
    return true;
  });

  broker.subscribe(() => {
    const list = broker.list();
    // Mesmo critério do broadcastToListeners do adapter-registry (sem puxar o
    // grafo dele): destruído sai da lista, crashado só pula este envio.
    for (const sender of [...listeners]) {
      if (sender.isDestroyed()) {
        listeners.delete(sender);
        continue;
      }
      if (sender.isCrashed()) continue;
      sender.send(APPROVAL_CHANNELS.changed, list);
    }
  });
}
