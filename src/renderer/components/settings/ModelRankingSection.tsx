import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ModelComparisonEntry,
  ModelComparisonSnapshot,
} from "../../../shared/eval-ranking-types";
import { openExternalFromAnchor } from "../../lib/open-external";
import {
  CLI_LABELS,
  COMPARE_SORT_HINTS,
  COMPARE_SORT_KEYS,
  COMPARE_SORT_LABELS,
  OPERATIONAL_BAND_LABELS,
  OPERATIONAL_BANDS,
  type CompareSortKey,
  bandOf,
  bestFor,
  bestValuePick,
  costTierLabel,
  formatGeneratedAt,
  formatPercent,
  formatScore,
  groupByBand,
  originBadge,
  originNote,
  sortComparison,
  sourceHref,
  valueFor,
} from "./ranking-view";
import { ProviderLogo } from "../ProviderLogo";
import { PixelIcon } from "../PixelIcon";
import { SettingsSectionTitle } from "./SettingsSectionTitle";

/**
 * Ajustes → Comparar modelos (F-1588). Benchmarks oficiais publicados pelos
 * fabricantes — a mesma régua da escolha automática — sobre os modelos que
 * esta máquina oferece, na versão mais nova de cada linha. Modelo sem número
 * publicado aparece sem nota; nada aqui é estimado à mão.
 */

/** Quantos modelos sem número aparecem antes de "Mostrar todos". */
const UNSCORED_PREVIEW = 12;

const BAND_HINTS = {
  fast: "Tarefas simples e repetitivas",
  balanced: "Criação e manutenção no dia a dia",
  deep: "Análises e problemas complexos",
} as const;

const PUBLISHED_KEYS = ["deepSWE", "terminalBench21", "swebenchVerified"] as const;

function scoreKindLabel(entry: ModelComparisonEntry): string {
  if (entry.scoreKind === "measured") return "medida pelo Nexus";
  if (entry.scoreKind === "published") return "benchmark publicado";
  return "sem número publicado";
}

function ComparisonList({
  rows,
  sort,
  selectedId,
  onSelect,
}: {
  rows: readonly ModelComparisonEntry[];
  sort: CompareSortKey;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="rank-race"
      role="list"
      aria-label={`Modelos por ${COMPARE_SORT_LABELS[sort]}`}
    >
      {rows.map((entry, index) => {
        const value = valueFor(entry, sort);
        const active = entry.id === selectedId;
        const ready = entry.cli === "ready";
        const badge = originBadge(entry);
        const shown = sort === "score" ? formatScore(value) : formatPercent(value);
        return (
          <button
            key={entry.id}
            type="button"
            role="listitem"
            className={`rank-race__row ${active ? "rank-race__row--active" : ""} ${ready ? "" : "rank-race__row--ghost"}`}
            onClick={() => onSelect(entry.id)}
            aria-pressed={active}
            aria-label={`${value === null ? "Sem número" : `${index + 1}º`}: ${entry.modelId} (${entry.adapterLabel}) — ${COMPARE_SORT_LABELS[sort]} ${value === null ? "não publicado" : shown}, ferramenta ${CLI_LABELS[entry.cli]}`}
          >
            <span className="rank-race__place">
              {value === null ? "—" : `#${index + 1}`}
            </span>
            <ProviderLogo adapterId={entry.adapterId} label={entry.adapterLabel} size="sm" />
            <span className="rank-race__id">
              <strong>{entry.modelId}</strong>
              <span className="rank-race__adapter">
                {entry.adapterLabel}
                <span
                  className={`rank-race__presence ${
                    ready ? "rank-race__presence--live" : "rank-race__presence--missing"
                  }`}
                >
                  <span className="rank-race__presence-dot" aria-hidden="true" />
                  {CLI_LABELS[entry.cli]}
                </span>
                <span className="rank-race__band">
                  {OPERATIONAL_BAND_LABELS[bandOf(entry)]}
                </span>
                {badge !== null && (
                  <span className="rank-estimate" title={originNote(entry) ?? undefined}>
                    {badge}
                  </span>
                )}
              </span>
            </span>
            <span className="rank-race__track" aria-hidden="true">
              <span
                className="rank-race__bar"
                style={{ transform: `scaleX(${value === null ? 0 : Math.min(100, value) / 100})` }}
                data-cost={entry.costTier}
              />
            </span>
            <span className="rank-race__score">{shown}</span>
          </button>
        );
      })}
    </div>
  );
}

function Highlights({
  entries,
  onSelect,
}: {
  entries: readonly ModelComparisonEntry[];
  onSelect: (id: string) => void;
}) {
  const picks: Array<{ key: string; kind: string; pick: ModelComparisonEntry | null; value: string }> = [
    ...COMPARE_SORT_KEYS.map((key) => {
      const pick = bestFor(entries, key);
      const value = pick ? valueFor(pick, key) : null;
      return {
        key,
        kind: key === "score" ? "Maior nota geral" : `Melhor em ${COMPARE_SORT_LABELS[key]}`,
        pick,
        value: key === "score" ? `nota ${formatScore(value)}` : formatPercent(value),
      };
    }),
    (() => {
      const pick = bestValuePick(entries);
      return {
        key: "value",
        kind: pick ? `Melhor na faixa ${OPERATIONAL_BAND_LABELS[bandOf(pick)]}` : "",
        pick,
        value: pick ? `nota ${formatScore(pick.score)} · custo ${costTierLabel(pick)}` : "",
      };
    })(),
  ];
  const shown = picks.filter((p) => p.pick !== null);
  if (shown.length === 0) return null;
  return (
    <div className="rank-missions" role="list" aria-label="Destaques pelos benchmarks publicados">
      {shown.map((p) => (
        <button
          key={p.key}
          type="button"
          role="listitem"
          className="rank-missions__card"
          onClick={() => onSelect(p.pick!.id)}
        >
          <span className="rank-missions__head">
            <ProviderLogo adapterId={p.pick!.adapterId} label={p.pick!.adapterLabel} size="sm" />
            <span className="rank-missions__kind">{p.kind}</span>
          </span>
          <span className="rank-missions__model">{p.pick!.modelId}</span>
          <span className="rank-missions__meta">
            {p.pick!.adapterLabel} · {p.value}
          </span>
        </button>
      ))}
    </div>
  );
}

function BandBoard({
  entries,
  onSelect,
}: {
  entries: readonly ModelComparisonEntry[];
  onSelect: (id: string) => void;
}) {
  const groups = groupByBand(entries);
  return (
    <div className="rank-bands" role="list" aria-label="Faixas de custo">
      {OPERATIONAL_BANDS.map((band) => {
        const rows = groups[band];
        return (
          <div key={band} className="rank-bands__col" role="listitem">
            <h5 className="rank-bands__title">
              {OPERATIONAL_BAND_LABELS[band]}
              <span className="rank-bands__count">{rows.length}</span>
            </h5>
            <p className="rank-bands__hint">{BAND_HINTS[band]}</p>
            {rows.length === 0 ? (
              <p className="rank-bands__hint">Nenhum modelo nesta faixa.</p>
            ) : (
              <ul className="rank-bands__list">
                {rows.slice(0, 4).map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="rank-bands__item"
                      onClick={() => onSelect(entry.id)}
                    >
                      <ProviderLogo adapterId={entry.adapterId} label={entry.adapterLabel} size="sm" />
                      <span className="rank-bands__model">{entry.modelId}</span>
                      <span className="rank-bands__score">{formatScore(entry.score)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComparisonDetail({ entry }: { entry: ModelComparisonEntry }) {
  const href = sourceHref(entry);
  const note = originNote(entry);
  const measured = entry.measured;
  return (
    <div className="rank-ops__detail" aria-live="polite" aria-label="Modelo selecionado">
      <div className="rank-ops__detail-head">
        <ProviderLogo adapterId={entry.adapterId} label={entry.adapterLabel} size="sm" />
        <span className="rank-ops__detail-identity">
          <span className="rank-ops__detail-name">{entry.modelId}</span>
          <span className="rank-ops__detail-adapter">
            {entry.adapterLabel}
            <span
              className={`rank-race__presence ${
                entry.cli === "ready" ? "rank-race__presence--live" : "rank-race__presence--missing"
              }`}
            >
              <span className="rank-race__presence-dot" aria-hidden="true" />
              ferramenta {CLI_LABELS[entry.cli]}
            </span>
          </span>
        </span>
        <span className="rank-ops__detail-rank" title="Nota geral (0 a 100)">
          {formatScore(entry.score)}
        </span>
      </div>
      {entry.scoreKind === "none" ? (
        <p className="rank-ops__mission-hint">
          O fabricante não publicou DeepSWE, Terminal-Bench 2.1 nem SWE-bench Verified
          para este modelo. A escolha automática o trata com nota neutra, sem bônus nem
          punição.
        </p>
      ) : (
        <div className="rank-ops__dims">
          {PUBLISHED_KEYS.map((key) => {
            const value = entry.benchmarks[key];
            return (
              <div key={key} className="rank-ops__dim-cell">
                <span className="rank-ops__dim-label">{COMPARE_SORT_LABELS[key]}</span>
                <span className="rank-ops__dim-val">{formatPercent(value)}</span>
                <span
                  className="rank-ops__dim-bar"
                  aria-hidden="true"
                  style={{ width: `${typeof value === "number" ? Math.min(100, value) : 0}%` }}
                />
              </div>
            );
          })}
        </div>
      )}
      {measured && (
        <p className="rank-ops__mission-hint">
          Avaliação medida pelo Nexus em {formatGeneratedAt(measured.evaluatedAt)}: geral{" "}
          {formatScore(measured.overall)}
          {measured.coding !== undefined && ` · programação ${formatScore(measured.coding)}`}
          {measured.reasoning !== undefined && ` · raciocínio ${formatScore(measured.reasoning)}`}
          {measured.frontend !== undefined && ` · interface ${formatScore(measured.frontend)}`}
          {measured.security !== undefined && ` · segurança ${formatScore(measured.security)}`}.
        </p>
      )}
      {note && <p className="rank-ops__mission-hint">{note}</p>}
      <p className="rank-ops__foot">
        nota {scoreKindLabel(entry)} · faixa {OPERATIONAL_BAND_LABELS[bandOf(entry)]} · custo{" "}
        {costTierLabel(entry)}
      </p>
      {entry.source && (
        <p className="rank-ops__foot">
          Fonte:{" "}
          {href ? (
            <a className="settings-link" href={href} onClick={(e) => openExternalFromAnchor(e, href)}>
              {new URL(href).host}
            </a>
          ) : (
            entry.source
          )}
        </p>
      )}
    </div>
  );
}

export function ModelRankingSection() {
  const [snapshot, setSnapshot] = useState<ModelComparisonSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<CompareSortKey>("score");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onlyInstalled, setOnlyInstalled] = useState(true);
  const [showAllUnscored, setShowAllUnscored] = useState(false);

  const load = useCallback(() => {
    const compare = window.nexus?.ranking?.compare;
    if (typeof compare !== "function") {
      setError("A comparação de modelos não está disponível nesta versão.");
      setLoading(false);
      return () => undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void compare()
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const entries = snapshot?.entries ?? [];
  const visible = useMemo(
    () => (onlyInstalled ? entries.filter((entry) => entry.cli === "ready") : entries),
    [entries, onlyInstalled],
  );
  const sorted = useMemo(() => sortComparison(visible, sort), [visible, sort]);
  const withValue = sorted.filter((entry) => valueFor(entry, sort) !== null);
  const withoutValue = sorted.filter((entry) => valueFor(entry, sort) === null);
  const rows = showAllUnscored
    ? sorted
    : [...withValue, ...withoutValue.slice(0, UNSCORED_PREVIEW)];

  const selected =
    visible.find((entry) => entry.id === selectedId) ?? sortComparison(visible, "score")[0] ?? null;

  const scored = entries.filter((entry) => entry.score !== null).length;
  const ready = entries.filter((entry) => entry.cli === "ready").length;

  return (
    <section className="rank-ops" aria-labelledby="ranking-title">
      <header className="rank-ops__intro">
        <SettingsSectionTitle id="ranking-title">Comparar modelos</SettingsSectionTitle>
        <p className="settings-detail__hint">
          Compare os modelos desta máquina pelos benchmarks oficiais que cada fabricante
          publicou. É a mesma régua da escolha automática; modelo sem número publicado
          aparece sem nota, nunca com nota inventada.
        </p>
      </header>

      {loading && (
        <p className="rank-ops__status" role="status">
          <PixelIcon name="bolt" size={11} /> Carregando comparação…
        </p>
      )}
      {error && (
        <div className="rank-ops__status rank-ops__status--error" role="alert">
          <PixelIcon name="warn" size={11} /> Não foi possível carregar a comparação: {error}{" "}
          <button type="button" className="settings-btn settings-btn--sm" onClick={() => load()}>
            Tentar novamente
          </button>
        </div>
      )}

      {snapshot && (
        <>
          <div className="rank-ops__fleet" role="status">
            <span>
              <strong>{entries.length}</strong> modelos
            </span>
            <span className="rank-ops__sep" aria-hidden="true">·</span>
            <span>
              <strong>{scored}</strong> com benchmark publicado
            </span>
            <span className="rank-ops__sep" aria-hidden="true">·</span>
            <span>
              <strong>{entries.length - scored}</strong> sem número publicado
            </span>
            <span className="rank-ops__sep" aria-hidden="true">·</span>
            <span>
              <strong>{ready}</strong> com a ferramenta instalada
            </span>
            {snapshot.olderVersionsHidden > 0 && (
              <>
                <span className="rank-ops__sep" aria-hidden="true">·</span>
                <span
                  className="rank-ops__dim"
                  title="Quando a mesma linha tem versão mais nova, só a mais nova aparece."
                >
                  {snapshot.olderVersionsHidden} versões antigas ocultas
                </span>
              </>
            )}
            <span className="rank-ops__sep" aria-hidden="true">·</span>
            <span className="rank-ops__dim">lido {formatGeneratedAt(snapshot.generatedAt)}</span>
          </div>

          {visible.length === 0 ? (
            <div className="rank-ops__status">
              {entries.length === 0
                ? "Nenhuma ferramenta de IA informou modelos ainda."
                : "Nenhuma ferramenta de IA instalada e ligada nesta máquina."}{" "}
              {onlyInstalled && entries.length > 0 && (
                <button
                  type="button"
                  className="settings-btn settings-btn--sm"
                  onClick={() => setOnlyInstalled(false)}
                >
                  Ver modelos das ferramentas não instaladas
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="rank-ops__block">
                <h3 className="rank-ops__block-title">Faixas de custo</h3>
                <p className="rank-ops__mission-hint">
                  Use a faixa mais barata que resolve e reserve os modelos caros para
                  problemas complexos.
                </p>
                <BandBoard entries={visible} onSelect={setSelectedId} />
              </div>

              <div className="rank-ops__block">
                <h3 className="rank-ops__block-title">Destaques</h3>
                <Highlights entries={visible} onSelect={setSelectedId} />
              </div>
            </>
          )}

          <div className="rank-ops__sort" role="group" aria-label="Ordenar a lista">
            <span className="rank-ops__sort-label">Ordenar por:</span>
            {COMPARE_SORT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={sort === key}
                className={`rank-ops__chip ${sort === key ? "rank-ops__chip--on" : ""}`}
                onClick={() => setSort(key)}
                title={COMPARE_SORT_HINTS[key]}
              >
                {COMPARE_SORT_LABELS[key]}
              </button>
            ))}
            <label className="rank-ops__only-installed">
              <input
                type="checkbox"
                checked={onlyInstalled}
                onChange={(event) => setOnlyInstalled(event.target.checked)}
              />
              Só ferramentas instaladas
            </label>
          </div>
          <p className="rank-ops__mission-hint">{COMPARE_SORT_HINTS[sort]}</p>

          {visible.length > 0 && (
            <div className="rank-ops__stage">
              <div className="rank-ops__stage-main">
                <h3 className="rank-ops__block-title">
                  Comparação · {COMPARE_SORT_LABELS[sort]}
                </h3>
                <ComparisonList
                  rows={rows}
                  sort={sort}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelectedId}
                />
                {!showAllUnscored && withoutValue.length > UNSCORED_PREVIEW && (
                  <button
                    type="button"
                    className="settings-btn rank-ops__show-all"
                    onClick={() => setShowAllUnscored(true)}
                  >
                    Mostrar todos os {withoutValue.length} modelos sem número em{" "}
                    {COMPARE_SORT_LABELS[sort]}
                  </button>
                )}
              </div>
              <div className="rank-ops__stage-side">
                <h3 className="rank-ops__block-title">Detalhe</h3>
                {selected ? (
                  <ComparisonDetail entry={selected} />
                ) : (
                  <p className="rank-ops__status">Selecione um modelo na lista.</p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
