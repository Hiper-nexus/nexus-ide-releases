// Linha de prova do hero: oferta (teste sem cartão + preço) e frescor da release. Tudo vem do que o servidor e o GitHub
// confirmam agora; nada é escrito na página. Puro; a parte de rede e DOM está em initializeHeroProof.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STALE_AFTER_DAYS = 30;

export function relativeTime(publishedMs, nowMs) {
  if (!Number.isFinite(publishedMs) || !Number.isFinite(nowMs)) return null;
  const age = Math.max(0, nowMs - publishedMs);
  if (age < 2 * MINUTE) return 'agora há pouco';
  if (age < HOUR) return `há ${Math.floor(age / MINUTE)} min`;
  if (age < 24 * HOUR) return `há ${Math.floor(age / HOUR)} h`;
  if (age < 2 * DAY) return 'ontem';
  if (age <= STALE_AFTER_DAYS * DAY) return `há ${Math.floor(age / DAY)} dias`;
  return null;
}

export function formatOffer(view) {
  const trial = view?.trial;
  if (!trial || !Number.isInteger(trial.days) || trial.days <= 0) return null;
  const days = `${trial.days} ${trial.days === 1 ? 'dia' : 'dias'} de teste, sem cartão`;
  return view.price ? `${days} · depois ${view.price}` : days;
}

export function newestRelease(catalog) {
  const rows = [...(catalog?.macos ?? []), ...(catalog?.windows ?? [])]
    .filter(row => typeof row?.version === 'string' && Number.isFinite(Date.parse(row.publishedAt)));
  if (rows.length === 0) return null;
  const newest = rows.reduce((best, row) => (Date.parse(row.publishedAt) > Date.parse(best.publishedAt) ? row : best));
  return { version: newest.version, publishedAt: newest.publishedAt };
}

export function formatRelease(release, nowMs) {
  if (!release) return null;
  const when = relativeTime(Date.parse(release.publishedAt), nowMs);
  return when ? `v${release.version} · publicada ${when}` : `v${release.version}`;
}

/** Quando nem a API de status nem a de releases respondem, a linha mostra o que o produto é
 *  (fixo, sem promessa de oferta) em vez de deixar um vazio acima da dobra. */
export const PROOF_FALLBACK = ['17 adaptadores de IA', 'worktrees isoladas', 'macOS, Linux e Windows'];

/** Preenche #hero-proof com o que conseguir confirmar; sem nada confirmado, mostra a prova estática. */
export async function initializeHeroProof({ status, releases, now = Date.now(), element = globalThis.document?.getElementById('hero-proof') } = {}) {
  if (!element) return;
  const [view, catalog] = await Promise.all([Promise.resolve(status).catch(() => null), Promise.resolve(releases).catch(() => null)]);
  const parts = [formatOffer(view), formatRelease(newestRelease(catalog), now)].filter(Boolean);
  const lines = parts.length === 0 ? PROOF_FALLBACK : parts;
  element.replaceChildren(...lines.flatMap((text, index) => {
    const item = Object.assign(globalThis.document.createElement('span'), { textContent: text });
    return index === 0 ? [item] : [Object.assign(globalThis.document.createElement('i'), { ariaHidden: 'true', className: 'hero-proof-sep' }), item];
  }));
  element.hidden = false;
}
