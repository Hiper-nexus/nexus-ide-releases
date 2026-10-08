/**
 * IPC read-only do metadado rico de modelo (entrega A2 → renderer).
 *
 * Um único canal invoke (`model:richMetadata`) que resolve preço USD/MTok,
 * janela de contexto, teto de saída e capacidades para um par
 * {adapterId, modelId}, a partir do recorte vendorado do oh-my-pi. Nada é
 * escrito; o metadado não contém segredos. Sem flag de feature: é dado de
 * catálogo público, útil no seletor de modelo mesmo com hubs desligados.
 *
 * Fonte: getRichModelMetadata() em ./model-catalog.ts. O retorno
 * (RichModelMetadata) é estruturalmente atribuível a RichModelMetadataView,
 * o contrato compartilhado que cruza o preload.
 */
import { z } from 'zod';
import type { RichModelMetadataView } from '../../shared/model-metadata-types';
import { getRichModelMetadata } from './model-catalog';
import { handleTrusted } from '../security/trusted-ipc';

/**
 * Espelha `MODEL_CHANNELS.richMetadata` (ver WIRING → src/shared/channels.ts).
 * Literal local para este arquivo novo compilar antes da costura em
 * channels.ts; depois de costurado, troque por `MODEL_CHANNELS.richMetadata`.
 */
const MODEL_RICH_METADATA_CHANNEL = 'model:richMetadata';

const richMetadataRequestSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(256),
  })
  .strict();

export function registerModelMetadataIpc(): void {
  // QLT-07: canal só da janela principal (hoje nenhum preload o chama).
  handleTrusted(
    MODEL_RICH_METADATA_CHANNEL,
    (_event, raw): RichModelMetadataView | null => {
      const { adapterId, modelId } = richMetadataRequestSchema.parse(raw);
      return getRichModelMetadata(adapterId, modelId);
    },
  );
}
