/**
 * Task cujo destinatário são os PRÓPRIOS panes da missão (perguntar/chamar/
 * responder aos panes). Worker não tem ferramenta de pane — despachar essa
 * classe gera papelada honesta no lugar do efeito ("workers cannot create
 * panes", nota do próprio worker em 20/08). Ela fica com o Maestro, que tem
 * as ferramentas e a doutrina EXCEÇÃO/FECHO para executar e concluir.
 */
const IMPLEMENTATION_OPENER = /^(?:(?:please|por favor|quero|preciso|I want to|I need you to)\s+)*(?:build|create|implement|fix|develop|add|refactor|crie|criar|construa|construir|implemente|implementar|corrija|corrigir|adicione|desenvolva|desenvolver)\b/iu;

export function isPaneMetaTask(title: string): boolean {
  const text = title.normalize('NFC').trim();
  // Describing an app that asks agents is implementation, not a live ask.
  if (IMPLEMENTATION_OPENER.test(text)) return false;
  return (
    /\b(?:pergunt|respond|cham)\w*\b[^.\n]{0,40}\bpanes?\b/iu.test(text) ||
    /\bpanes?\b[^\n]{0,40}\b(?:pergunt|respond|cham)\w*/iu.test(text) ||
    /\bcada\s+pane\b/iu.test(text) ||
    // Ditado por voz vem com typo no verbo ("oergunta aos panes quwnto e
    // 1+1" derrotou o padrão acima em campo, 20/08). A construção de
    // destinatário ("aos panes") + carga interrogativa é evidência
    // suficiente sem o verbo; task de código fala "do pane"/"o pane X" e
    // não carrega interrogação.
    (/\baos?\s+(?:todos\s+(?:os\s+)?)?panes\b/iu.test(text) &&
      /\?|\bquanto|\bqual|\bquem\b|\bonde\b|\bquando\b|\d\s*\+\s*\d/iu.test(
        text,
      )) ||
    // VOZ traduz para inglês: "How much is 2x2 and they have to answer you."
    // Sem "pane" no texto a first-wave selava 1 entrega e abria só 1 writer.
    /\bthey have to answer\b/iu.test(text) ||
    /\bhave (?:them|everyone) answer\b/iu.test(text) ||
    /^(?:(?:please|can you|could you|would you)\s+)?ask (?:the )?(?:panes?|team|workers?|agents?)\b/iu.test(text) ||
    /\beach (?:one|pane|agent|worker)\b[^.\n]{0,60}\banswer/iu.test(text)
  );
}

/** Pergunta que o worker recebe — sem o wrapper "pergunte aos panes / they have to answer". */
export function extractMetaPaneQuestion(objective: string): string {
  const text = objective.normalize('NFC').trim();
  if (!text) return '';
  const withoutAnswerTail = text
    .replace(
      /\s+and (?:they|everyone|each one) (?:must|should|have to) answer(?: you)?[.\s]*$/iu,
      '',
    )
    .replace(/\bhave (?:them|everyone) answer[.\s]*$/iu, '')
    .trim();
  const ask = withoutAnswerTail.match(
    /(?:pergunte|perguntar|ask)\b(?:\s+(?:the\s+|aos?\s+|a\s+)?(?:todos\s+(?:os\s+)?)?(?:panes?|team|workers?|agents?|cada\s+(?:um|pane)))?\s*[:.]?\s*(.+)/iu,
  );
  const extracted = (ask?.[1] ?? withoutAnswerTail)
    .replace(/\s*[,.]?\s*(?:e\s+)?(?:aguarde|consolide|responda).*$/iu, '')
    .replace(/[,\s]+$/u, '')
    .trim();
  return extracted || text;
}
