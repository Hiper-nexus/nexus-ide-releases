// Gate de montagem do boot paralelo: a navegação do renderer começa cedo (o
// documento sobe e o splash estático aparece), mas o React só monta quando o
// bootstrap terminou de registrar todo o IPC — a garantia anti-corrida que o
// deferRendererLoad dava, agora segurando o mount em vez da navegação.
// Bootstrap falho rejeita o gate: nenhum renderer parcial executa IPC.
import { WINDOW_CHANNELS } from '../shared/channels';
import { handleTrusted } from './security/trusted-ipc';

let resolveGate!: () => void;
let rejectGate!: (error: unknown) => void;
let settled = false;

const gate = new Promise<void>((resolve, reject) => {
  resolveGate = resolve;
  rejectGate = reject;
});
// O gate pode ficar pendurado até o fim do processo em cenários sem janela
// (smoke do main sem renderer): a rejeição nunca pode escapar como
// unhandledRejection por falta de consumidor.
void gate.catch(() => {});

export function resolveBootReady(): void {
  if (settled) return;
  settled = true;
  resolveGate();
}

export function rejectBootReady(error: unknown): void {
  if (settled) return;
  settled = true;
  rejectGate(error);
}

let registered = false;

/** Handler único; a janela o registra na criação, antes de qualquer navegação. */
export function registerBootReadyIpc(): void {
  if (registered) return;
  registered = true;
  handleTrusted(WINDOW_CHANNELS.bootReady, () => gate);
}
