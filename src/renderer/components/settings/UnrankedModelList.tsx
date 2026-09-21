import { ProviderLogo } from '../ProviderLogo';
import type { UnrankedModel } from './unranked-models';

export function UnrankedModelList({ models, selectedId, onSelect }: {
  models: readonly UnrankedModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <div className="rank-ops__block">
      <h4 className="rank-ops__block-title">Modelos não avaliados</h4>
      <p className="rank-ops__mission-hint">
        Modelos do catálogo disponíveis para avaliação. As notas e a posição
        aparecem depois que um benchmark é publicado.
      </p>
      <div className="rank-race" role="list" aria-label="Modelos não avaliados">
        {models.map((model) => (
          <button
            key={model.id}
            type="button"
            role="listitem"
            className={`rank-race__row ${selectedId === model.id ? 'rank-race__row--active' : ''} ${model.installed ? '' : 'rank-race__row--ghost'}`}
            aria-pressed={selectedId === model.id}
            aria-label={`${model.modelId} — não avaliado`}
            onClick={() => onSelect(model.id)}
          >
            <span className="rank-race__place" aria-hidden="true">—</span>
            <ProviderLogo adapterId={model.adapterId} label={model.label} size="sm" />
            <span className="rank-race__id">
              <strong>{model.modelId}</strong>
              <span className="rank-race__adapter">
                {model.label} · {model.installed ? 'instalada' : 'não disponível nesta máquina'}
              </span>
            </span>
            <span className="rank-race__adapter">Não avaliado</span>
            <span className="rank-race__score" aria-label="Sem nota">—</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function UnrankedModelDetail({ model }: { model: UnrankedModel }) {
  return (
    <div className="rank-ops__detail" aria-live="polite" aria-label="Modelo não avaliado selecionado">
      <div className="rank-ops__detail-head">
        <ProviderLogo adapterId={model.adapterId} label={model.label} size="sm" />
        <span className="rank-ops__detail-identity">
          <span className="rank-ops__detail-name">{model.modelId}</span>
          <span className="rank-ops__detail-adapter">{model.label} · Não avaliado</span>
        </span>
      </div>
      <p className="rank-ops__mission-hint">
        Ainda não há notas de programação, raciocínio, interface ou segurança
        para este modelo. Uma avaliação real permitirá compará-lo por tarefa.
      </p>
      <p className="rank-ops__foot">
        custo {model.costTier ?? 'desconhecido'}
        {model.source ? ` · catálogo ${model.source}` : ''}
      </p>
    </div>
  );
}
