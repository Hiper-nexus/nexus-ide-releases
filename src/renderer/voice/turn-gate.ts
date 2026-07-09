/**
 * INVARIANTE DE MUTE (C2): um turno NUNCA pode terminar com o gate de áudio
 * Live fechado. finishAndProcess tem ~20 saídas antecipadas e várias ligam
 * suppressRealtimeAudioOut=true; uma saída esquecida = silêncio total
 * permanente (o bug de mute documentado). A abertura vai no finally — mas só
 * o turno ATUAL pode mexer no gate: se um turno mais novo nos superou
 * (wait.superseded), a supressão agora pertence a ele e desmutar por cima
 * quebraria o mute do turno novo.
 */
export function shouldOpenGateOnTurnExit(
  currentToken: number,
  turnToken: number,
): boolean {
  return currentToken === turnToken;
}
