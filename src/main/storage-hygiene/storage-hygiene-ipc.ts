import { STORAGE_HYGIENE_CHANNELS } from '../../shared/channels';
import { handleTrusted } from '../security/trusted-ipc';
import type { StorageHygieneService } from './storage-hygiene-service';

/** Só a janela principal (Configurações → Diagnóstico) lê e dispara a limpeza. */
export function registerStorageHygieneIpc(service: StorageHygieneService): void {
  handleTrusted(STORAGE_HYGIENE_CHANNELS.report, () => service.report());
  handleTrusted(STORAGE_HYGIENE_CHANNELS.cleanNow, async () => {
    await service.runNow('manual');
    // Medição nova antes de responder: o operador vê o efeito na hora.
    await service.refreshMeasurements();
    return service.report();
  });
}
