/**
 * A folga de uma conta depende do MODELO que o pane vai rodar.
 *
 * O AGY devolve um bucket por grupo de modelo — `agy-bridge.ts` registra
 * "Gemini × (5h|semanal), Claude/GPT × (5h|semanal)" — e `headroomReadings`
 * colapsa por `kind` ficando com o mais apertado. Sem este filtro, um bucket
 * Claude/GPT cheio drenaria uma conta que serve perfeitamente um pane Gemini:
 * o operador pagaria N contas para usar a fatia de uma.
 *
 * A regra de casamento espelha `groupRank` do `agy-bridge`: substring no nome
 * normalizado, porque o `displayName` vem do servidor e não é um prefixo fixo.
 *
 * Todo recuo é para o comportamento de hoje (pior bucket): no máximo drena
 * cedo, nunca tarde. Puro.
 */
import type { HeadroomInput } from './account-headroom';

type ModelGroup = 'gemini' | 'third-party';

const norm = (value: string): string => value.toLowerCase();

/** Grupo que o rótulo da janela representa; `null` = rótulo sem grupo conhecido. */
function groupOfWindowLabel(label: string): ModelGroup | null {
  const v = norm(label);
  if (v.includes('gemini')) return 'gemini';
  if (v.includes('claude') || v.includes('gpt')) return 'third-party';
  return null;
}

/** Grupo que o modelo consome; `null` = modelo que não sabemos classificar. */
function groupOfModel(model: string): ModelGroup | null {
  const v = norm(model);
  if (v.includes('gemini')) return 'gemini';
  if (v.includes('claude') || v.includes('gpt') || /\bo[134]\b/.test(v)) {
    return 'third-party';
  }
  return null;
}

/**
 * As janelas de `input` que o `model` de fato consome. Recua para o input
 * inteiro quando o modelo é nulo ou não classificável, e quando o filtro
 * esvaziaria a lista — nunca devolve uma conta "sem janela medida", que o
 * motor leria como folga.
 */
export function windowsServingModel(
  input: HeadroomInput,
  model: string | null,
): HeadroomInput {
  if (!model) return input;
  const wanted = groupOfModel(model);
  if (!wanted) return input;
  const kept = input.windows.filter((window) => {
    const group = groupOfWindowLabel(window.label);
    return group === null || group === wanted;
  });
  if (kept.length === 0 || kept.length === input.windows.length) return input;
  return { ...input, windows: kept };
}
