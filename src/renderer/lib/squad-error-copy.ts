/**
 * F-1577: o catálogo de equipes é global e não exige projeto aberto. Se algum
 * caminho do Main ainda recusar por falta do escopo do projeto, a tela diz em
 * português o que fazer — nunca o código cru do Main.
 */
const NO_WORKSPACE_SCOPE = /renderer has no authorized workspace scope/i;

/** `action` completa a frase: "Abra um projeto para <action>." */
export function squadErrorCopy(error: string, action: string): string {
  return NO_WORKSPACE_SCOPE.test(error) ? `Abra um projeto para ${action}.` : error;
}
