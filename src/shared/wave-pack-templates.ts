/**
 * Pack templates — declared fan-out story lists (Landing / SaaS / Fix).
 * See docs/design/mission-wave-pack.md Wave 2.
 *
 * Intentionally independent of mission-wave-pack to avoid circular imports.
 */

export const WAVE_PACK_TEMPLATE_IDS = ["landing", "saas", "fix"] as const;
export type WavePackTemplateId = (typeof WAVE_PACK_TEMPLATE_IDS)[number];

export type WavePackTemplateStory = {
  readonly id: string;
  readonly epicStoryId: string;
  readonly title: string;
  readonly body: string;
};

export type WavePackTemplate = {
  readonly id: WavePackTemplateId;
  readonly label: string;
  readonly hint: string;
  readonly stories: readonly WavePackTemplateStory[];
};

function story(
  epic: number,
  index: number,
  title: string,
  body: string,
): WavePackTemplateStory {
  const epicStoryId = `${epic}.${index}`;
  return Object.freeze({
    id: `story-${epic}-${index}`,
    epicStoryId,
    title,
    body,
  });
}

export const WAVE_PACK_TEMPLATES: readonly WavePackTemplate[] = Object.freeze([
  Object.freeze({
    id: "landing" as const,
    label: "Landing",
    hint: "3 panes · hero, seções, polish",
    stories: Object.freeze([
      story(
        1,
        1,
        "Hero e estrutura da página",
        "Monte a estrutura da landing (layout, tipografia base, hero com headline, subcopy e CTA primário). Sem seções secundárias ainda.",
      ),
      story(
        1,
        2,
        "Seções de conteúdo",
        "Implemente as seções principais (benefícios, prova social ou features, CTA intermediário). Reuse tokens do hero; não refatore o hero.",
      ),
      story(
        1,
        3,
        "Polish responsivo e acessibilidade",
        "Ajuste breakpoints, foco/teclado, contraste e microinterações. Não redesenhe o conteúdo; valide CTA e leitura em mobile.",
      ),
    ]),
  }),
  Object.freeze({
    id: "saas" as const,
    label: "SaaS",
    hint: "5 panes · auth, CRUD, billing, settings, smoke",
    stories: Object.freeze([
      story(
        1,
        1,
        "Auth mínima",
        "Fluxo de autenticação mínimo (login/sessão) suficiente para o restante do produto. Sem billing ainda.",
      ),
      story(
        1,
        2,
        "CRUD do domínio core",
        "CRUD da entidade principal do produto. Reuse auth; não mexa em billing.",
      ),
      story(
        1,
        3,
        "Billing stub",
        "Stub de cobrança/planos (UI + contrato) sem gateway real se não houver chave. Não reescreva auth/CRUD.",
      ),
      story(
        1,
        4,
        "Settings da conta",
        "Tela de settings (perfil, preferências). Isolado de billing e CRUD core.",
      ),
      story(
        1,
        5,
        "Smoke de ponta a ponta",
        "Roteiro smoke: login → criar item → ver settings. Documente falhas; não reimplemente features.",
      ),
    ]),
  }),
  Object.freeze({
    id: "fix" as const,
    label: "Fix",
    hint: "2 panes · correção + regressão",
    stories: Object.freeze([
      story(
        1,
        1,
        "Reproduzir e corrigir",
        "Reproduza o bug descrito no objetivo, isole a causa e aplique o menor patch. Sem refactors laterais.",
      ),
      story(
        1,
        2,
        "Regressão e validação",
        "Adicione ou rode verificação de regressão (teste/checklist) cobrindo o fix. Não reabra o patch sem evidência.",
      ),
    ]),
  }),
]);

const BY_ID: ReadonlyMap<WavePackTemplateId, WavePackTemplate> = new Map(
  WAVE_PACK_TEMPLATES.map((template) => [template.id, template]),
);

export function isWavePackTemplateId(value: unknown): value is WavePackTemplateId {
  return (
    typeof value === "string" &&
    (WAVE_PACK_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}

export function wavePackTemplateById(
  id: WavePackTemplateId,
): WavePackTemplate {
  const template = BY_ID.get(id);
  if (!template) {
    throw new Error(`wave_pack_template_unknown: ${id}`);
  }
  return template;
}

export function storiesForWavePackTemplate(
  id: WavePackTemplateId,
): readonly WavePackTemplateStory[] {
  return wavePackTemplateById(id).stories;
}
