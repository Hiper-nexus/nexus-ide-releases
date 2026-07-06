import { listHandoffs, onHandoffsChange } from '../orch/handoff-store';
import { getVoiceConfig } from './voice-config-store';
import { toSpeakable } from './speakable';
import type { Handoff } from '../../shared/orch-types';

/**
 * Narração proativa: quando um worker entrega, trava ou falha, a JARVIS AVISA
 * em voz alta em vez de esperar ser perguntada — o usuário fica de olho no
 * código, não na timeline. Dirigido a evento (onHandoffsChange), sem polling.
 *
 * Anti-tagarelice: só narra em modo jarvis; nunca narra histórico (seed no
 * boot); junta rajadas num único aviso (debounce 1,5s); dedupe por handoff; e
 * o texto passa pelo toSpeakable (código/JSON nunca são lidos em voz alta).
 * Quem decide se PODE falar agora é o renderer (não interrompe turno ativo).
 */

const BURST_MS = 1_500;
const MAX_SPOKEN_SUMMARY = 140;
// Silêncio total nos primeiros segundos após ligar: além do corte por
// createdAt, isto blinda contra qualquer rajada de handoffs disparada pela
// reabertura de missões/panes no boot (re-submits com createdAt novo). Nada
// de fala proativa até o app assentar.
const BOOT_GRACE_MS = 6_000;

type Broadcast = (channel: string, payload?: unknown) => void;

const seen = new Set<string>();
let pending: Handoff[] = [];
let burstTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
// Baseline TEMPORAL: só narramos handoffs criados DEPOIS de o narrador ligar.
// O handoff-store hidrata do SQLite depois do bootstrap e pode emitir em vários
// eventos; um flag de "primeira vez" não basta. Comparar createdAt com o
// instante do init é à prova de ordem: história (createdAt no passado) nunca é
// falada. (Sem isso, a JARVIS lê o histórico inteiro em voz alta ao abrir.)
let startedAt = 0;

function phraseFor(handoff: Handoff): string {
  const from = (handoff.fromAgent ?? 'um worker').slice(0, 60);
  const short = toSpeakable(handoff.summary, 'summary').slice(0, MAX_SPOKEN_SUMMARY);
  switch (handoff.status) {
    case 'stalled':
      return `Atenção: ${from} parece travado. ${short}`;
    case 'failed':
      return `${from} falhou na tarefa. ${short}`;
    case 'blocked':
      return `${from} está bloqueado e precisa de você. ${short}`;
    case 'partial':
      return `${from} entregou parcialmente: ${short}`;
    default:
      return `${from} entregou: ${short}`;
  }
}

function flush(broadcast: Broadcast): void {
  burstTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  // Rajada (vários workers terminando juntos) vira UM aviso curto.
  const text =
    batch.length === 1
      ? phraseFor(batch[0])
      : `${batch.length} atualizações do squad. ${batch.map(phraseFor).join(' ')}`.slice(
          0,
          400,
        );
  broadcast('voice:narrate', { text });
}

function onChange(broadcast: Broadcast): void {
  const jarvis = getVoiceConfig().routing === 'jarvis';
  const withinBootGrace = Date.now() - startedAt < BOOT_GRACE_MS;
  for (const handoff of listHandoffs({ includeDelivered: true })) {
    if (seen.has(handoff.id)) continue;
    seen.add(handoff.id);
    // História (criada antes do narrador ligar), boot grace, ou fora do modo
    // jarvis: só marca como visto, nunca fala.
    if (!jarvis || withinBootGrace || handoff.createdAt <= startedAt) continue;
    pending.push(handoff);
  }
  if (pending.length > 0 && !burstTimer) {
    burstTimer = setTimeout(() => flush(broadcast), BURST_MS);
    burstTimer.unref?.();
  }
}

export function initJarvisNarrator(broadcast: Broadcast): void {
  if (unsubscribe) return;
  startedAt = Date.now();
  // Seed do que já existe (caso a store já esteja hidratada); o corte temporal
  // por createdAt cobre o caso em que ela hidrata depois, no primeiro onChange.
  for (const handoff of listHandoffs({ includeDelivered: true })) {
    seen.add(handoff.id);
  }
  unsubscribe = onHandoffsChange(() => onChange(broadcast));
}

export function shutdownJarvisNarrator(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (burstTimer) clearTimeout(burstTimer);
  burstTimer = null;
  pending = [];
  seen.clear();
  startedAt = 0;
}
