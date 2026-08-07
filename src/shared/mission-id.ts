/**
 * Identidade de missão — a única fonte de verdade para (a) que texto pode virar
 * nome de arquivo de projeção e (b) que `source` significa "esta nota pertence
 * a esta missão".
 *
 * CHARSET ANTES DE VIRAR PATH. Mission id vira nome de arquivo. APFS e HFS+ são
 * case-insensitive por padrão, então `mission-Auth` e `mission-auth` são o MESMO
 * arquivo: duas linhas do SQLite viram uma projeção só, com conteúdo decidido
 * por quem escreveu por último, e o guard de idempotência (comparar os bytes em
 * disco antes de reescrever) nunca converge — reescrita perpétua, onChange em
 * loop. No Windows ':' abre Alternate Data Stream e '\' separa diretório; em
 * qualquer lugar '/' e '..' saem do diretório de projeção. Travar em
 * `^[a-z0-9][a-z0-9-]{0,63}$` resolve os três de uma vez: sem caixa alta não
 * existe par que o volume possa dobrar, e sobra só o que é seguro como basename.
 * O teto de 64 deixa `${id}.md` folgado sob o limite de 255 bytes por componente.
 *
 * AUTORIDADE DA ATRIBUIÇÃO. O escopo de execução vem do sender autorizado e
 * nunca de argumento do renderer (o padrão que memory-ipc.ts documenta). A
 * identidade da missão segue a mesma regra: o chamador pode NOMEAR uma missão,
 * mas quem PROVA que ela existe — e existe dentro daquele escopo — é o main.
 * `source` forjado não promove nota nenhuma a kind=mission, porque só a forma
 * canônica exata conta como atribuição.
 */

/** Formato de `makeId('mission')`: prefixo + base36 de Date.now + contador. */
export const MISSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MISSION_PROJECTION_SOURCE_PREFIX = 'operator:mission:';

export function isProjectableMissionId(value: unknown): value is string {
  return typeof value === 'string' && MISSION_ID_PATTERN.test(value);
}

/**
 * Portão único: nada vira path, source ou frontmatter sem passar por aqui.
 * A mensagem não ecoa o valor recebido — ele pode carregar caminho ou controle.
 */
export function assertProjectableMissionId(value: unknown): string {
  if (!isProjectableMissionId(value)) {
    throw new Error(
      'mission_id_unsafe: mission id must match ^[a-z0-9][a-z0-9-]{0,63}$ ' +
        'before it can become a file name',
    );
  }
  return value;
}

/** Nome de arquivo da projeção — validado, portanto sempre um basename. */
export function missionProjectionBasename(
  missionId: unknown,
  extension = '.md',
): string {
  return `${assertProjectableMissionId(missionId)}${extension}`;
}

/** Forma canônica de atribuição; só um id já validado pode gerá-la. */
export function missionProjectionSource(missionId: unknown): string {
  return `${MISSION_PROJECTION_SOURCE_PREFIX}${assertProjectableMissionId(missionId)}`;
}

/**
 * Provenance de agente: `agent-authored:<mission|pane>:<sha256>`, derivada em
 * main da autoridade física do pane (tools-memory.defaultSource). O worker não
 * escolhe nada dela, então ela É escopo de missão legítimo — mas o segmento
 * final é um hash OPACO de sessão, não um mission id. O parser antigo
 * (`/(?:^|:)mission:(.+)$/`) publicava esse sha256 no campo missionId da
 * projeção, criando uma identidade que nunca existiu em missão nenhuma.
 */
const AGENT_AUTHORED_MISSION_SOURCE =
  /^agent-authored:mission:[a-f0-9]{64}$/;

/**
 * Leitura: devolve o id APENAS quando o source é exatamente a forma canônica do
 * operador e o id ainda passa no charset. Qualquer outra coisa que apenas
 * contenha `mission:` não é atribuição — é texto.
 */
export function missionIdFromProjectionSource(
  source: string | null | undefined,
): string | undefined {
  if (typeof source !== 'string') return undefined;
  if (!source.startsWith(MISSION_PROJECTION_SOURCE_PREFIX)) return undefined;
  const candidate = source.slice(MISSION_PROJECTION_SOURCE_PREFIX.length);
  return isProjectableMissionId(candidate) ? candidate : undefined;
}

export function isMissionProjectionSource(
  source: string | null | undefined,
): boolean {
  return missionIdFromProjectionSource(source) !== undefined;
}

/**
 * A nota pertence ao escopo de uma missão — o que decide `kind='mission'`, e
 * portanto a entrada na busca de missões. Duas formas, ambas derivadas em main:
 * a atribuição explícita do operador (que carrega mission id) e a provenance
 * do agente (que carrega autoridade de sessão). Nenhuma outra conta.
 */
export function isMissionScopedSource(
  source: string | null | undefined,
): boolean {
  if (typeof source !== 'string') return false;
  return (
    isMissionProjectionSource(source) ||
    AGENT_AUTHORED_MISSION_SOURCE.test(source)
  );
}

/**
 * Atribuição autorizada. `missionExists` é a prova de existência dentro do
 * escopo já autorizado do sender — o charset é conferido ANTES, para que texto
 * não validado nunca chegue ao store (que o usa como chave e pode tocar disco).
 */
export function authorizedMissionId(
  claimed: string | undefined,
  missionExists: (missionId: string) => boolean,
): string | undefined {
  if (claimed === undefined) return undefined;
  const missionId = assertProjectableMissionId(claimed);
  if (!missionExists(missionId)) {
    throw new Error(
      'mission_id_unauthorized: no such mission in the authorized workspace scope',
    );
  }
  return missionId;
}
