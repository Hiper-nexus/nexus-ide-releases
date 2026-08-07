/**
 * Minimum product intelligence for worker-authored blocks (status=blocked).
 *
 * Compress the worker's reason into a short operator question + 2–4 chips.
 * Never invent authority — only rephrase what the worker already proved.
 */

export interface WorkerDecisionGuidance {
  readonly summary: string;
  readonly question: string;
  readonly options: readonly string[];
}

function clip(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function uniqueOptions(options: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    const label = clip(option, 240);
    const key = label.toLocaleLowerCase('pt-BR');
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 4) break;
  }
  return out;
}

/** Story the gate allows right now (review / only authorized). */
function extractAuthorizedStory(detail: string): string | null {
  const patterns = [
    /autoriza(?:m)?\s+(?:apenas|somente)\s+(?:a\s+)?story\s*(\d+(?:\.\d+)*)/iu,
    /story\s*(\d+(?:\.\d+)*)\s*\(\s*status\s+review\s*\)/iu,
    /somente\s+(?:a\s+)?story\s*(\d+(?:\.\d+)*)\s+em\s+review/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(detail);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Story the worker cannot start (backlog / unassigned / no spec). */
function extractBlockedStory(detail: string): string | null {
  const patterns = [
    /story\s*(\d+(?:\.\d+)*)\s+est[aá]\s+backlog/iu,
    /story\s*(\d+(?:\.\d+)*)[\s\S]{0,60}?sem story spec/iu,
    /story\s*(\d+(?:\.\d+)*)[\s\S]{0,60}?UNASSIGNED/iu,
    /antes de iniciar\s+(?:a\s+)?(?:story\s*)?(\d+(?:\.\d+)*)/iu,
    /n[aã]o iniciar\s+(?:a\s+)?(?:story\s*)?(\d+(?:\.\d+)*)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(detail);
    if (match?.[1]) return match[1];
  }
  return null;
}

function storyForkGuidance(
  blocked: string,
  authorized: string,
): WorkerDecisionGuidance {
  return Object.freeze({
    summary: clip(
      `Story ${blocked} não está liberada; o gate autoriza a Story ${authorized}.`,
      200,
    ),
    question: `A Story ${blocked} está bloqueada pelo gate (autorizada agora: ${authorized}). Como seguimos?`,
    options: Object.freeze([
      `Continuar com a Story ${authorized} (autorizada — review/aceite)`,
      `Liberar a Story ${blocked} (gate/spec) e insistir nela`,
      'Encerrar a missão por agora',
    ]),
  });
}

/**
 * Pull worker-authored paths like:
 * "Decisão necessária: (1) foo; ou (2) bar"
 */
function extractWorkerNumberedPaths(detail: string): string[] {
  const paths: string[] = [];
  // Split on (1) (2) or 1) 2) even on one line.
  const chunks = detail.split(/(?=\(\s*\d+\s*\)|\b\d+\s*[.)]\s+)/u);
  for (const chunk of chunks) {
    const match = /^\(?\s*\d+\s*\)?[.)]?\s*(.+)$/su.exec(chunk.trim());
    if (!match?.[1]) continue;
    let body = match[1]
      .replace(/\s*;?\s*ou\s*$/iu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    // Stop at next decision boundary noise.
    body = body.split(/\s+Nenhum arquivo foi|\s+Além disso,/iu)[0]!.trim();
    if (body.length >= 12 && body.length <= 200) paths.push(body);
  }
  return uniqueOptions(paths);
}

/**
 * Infer a short operator question + chips from a worker blocked handoff detail.
 */
export function inferWorkerDecisionGuidance(
  detail: string,
): WorkerDecisionGuidance {
  const text = detail.replace(/\s+/gu, ' ').trim();
  if (!text) {
    return Object.freeze({
      summary: 'O worker parou e pediu uma decisão.',
      question: 'O worker bloqueou a tarefa. O que você quer fazer?',
      options: Object.freeze([
        'Replanejar com outro objetivo',
        'Tentar de novo do jeito que está',
        'Encerrar a missão',
      ]),
    });
  }

  const authorized = extractAuthorizedStory(detail);
  const blocked = extractBlockedStory(detail);

  // Classic HiperGO gate: only 1.3 in review, 1.4 is backlog.
  if (authorized && blocked && authorized !== blocked) {
    return storyForkGuidance(blocked, authorized);
  }
  if (blocked && !authorized) {
    return Object.freeze({
      summary: clip(
        `Story ${blocked} bloqueada por governança do repositório.`,
        200,
      ),
      question: `A Story ${blocked} não pode começar agora. Como seguimos?`,
      options: Object.freeze([
        'Mudar o objetivo para a story autorizada no gate',
        `Liberar a Story ${blocked} (gate/spec) e insistir nela`,
        'Encerrar a missão por agora',
      ]),
    });
  }
  if (authorized && !blocked) {
    return Object.freeze({
      summary: clip(
        `O gate autoriza a Story ${authorized}; o objetivo pedido não está liberado.`,
        200,
      ),
      question: `O repositório autoriza a Story ${authorized}. Como seguimos?`,
      options: Object.freeze([
        `Continuar com a Story ${authorized} (autorizada)`,
        'Replanejar com outro objetivo liberado',
        'Encerrar a missão por agora',
      ]),
    });
  }

  const workerPaths = extractWorkerNumberedPaths(detail);
  if (workerPaths.length >= 2) {
    return Object.freeze({
      summary: clip(text, 200),
      question: 'O worker parou e listou caminhos. Qual você escolhe?',
      options: Object.freeze([
        ...workerPaths.slice(0, 3),
        'Encerrar a missão por agora',
      ].filter((option, index, all) => all.indexOf(option) === index).slice(0, 4)),
    });
  }

  return Object.freeze({
    summary: clip(text, 200),
    question: 'O worker parou e pediu uma decisão. O que você quer fazer?',
    options: Object.freeze([
      'Replanejar com outro objetivo',
      'Tentar de novo do jeito que está',
      'Encerrar a missão por agora',
    ]),
  });
}
