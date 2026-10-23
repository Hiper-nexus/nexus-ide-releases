/**
 * Product baseline, not optional Design Pro coaching or a skill grant.
 * MCP initialize reaches every provider/role; briefs and the operator hook
 * also carry it so non-MCP workers and hook refreshes do not depend on a skill.
 * It governs UI work only and grants no capture, tool or filesystem authority.
 */
export const UI_COMPOSITION_POLICY = `# Nexus UI composition baseline

Mandatory whenever you create, change or review UI, regardless of model, Design Pro or skill availability. Follow the operator's explicit direction and the project's existing design contract; do not redesign unrelated surfaces.
- Compose deliberately: do not dump every heading, label, value, status and action into one flat left-aligned stack. Establish a focal point, typographic hierarchy, semantic groups, consistent spacing and shared alignment axes. Do not alternate alignment randomly for variety.
- Choose alignment by function, not habit: readable paragraphs and form labels normally use start alignment; comparable numeric columns use end alignment; center short focal/empty-state content only when the composition calls for it. Respect RTL. Never fix a flat layout by centering everything or by globally applying text-align.
- In compact cards, separate identity/header, related metadata and actions. Pair labels with their values, give the primary action clear priority and align related controls together. Use rows/grid when space permits, a coherent responsive stack when it does not; preserve reading/tab order, long-text wrapping and accessible states. A left-aligned layout can be correct when its hierarchy and grouping are intentional.
- For UI work, use the Impeccable skill if available, including the launcher documented by its installed version. If unavailable, apply this baseline yourself. The skill being absent, skipped or disabled never waives the baseline. Do not guess global commands or unrelated packages; a skill's documented executable is allowed within the pane's authority.
- Before delivery, inspect the rendered result at the supported viewport sizes using authorized tools, checking hierarchy, grouping, spacing, alignment and overflow. Report the viewports and what you actually observed; code/build/tests or a screenshot path alone are not visual inspection. If inspection is unavailable, state the limitation, never claim a visual pass. Reviewers must reject a flat default composition with concrete defects, not accept it just because it builds or has a screenshot.`;

/** Attached to Main-verified evidence; a capture proves bytes, not good design. */
export const UI_COMPOSITION_REVIEW =
  'Confira hierarquia, agrupamento, espaçamento, alinhamento funcional e overflow: ' +
  'não aceite títulos, metadados e ações despejados numa pilha uniforme à esquerda, ' +
  'nem a centralização de tudo como correção. Texto de leitura à esquerda e pilhas responsivas ' +
  'são válidos quando têm composição intencional. Respeite o contrato do projeto e a direção do operador; ' +
  'aponte defeitos concretos antes de aprovar: a existência da captura não comprova qualidade visual.';

// A known, leading context block: routing classifies the task, not these rules.
export const UI_COMPOSITION_CONTEXT = `<nexus-ui-composition>\n${UI_COMPOSITION_POLICY}\n</nexus-ui-composition>`;
