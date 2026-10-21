/**
 * Contador de caracteres de um campo com teto, e o aviso de que passou.
 *
 * Nasceu de um defeito real (21/10/2026): o campo do roteiro tinha
 * `maxLength` e o navegador cortava o texto colado SEM contador, sem aviso e
 * sem marca — o operador só percebia lendo o que sobrou na caixa, e o vídeo
 * saía errado pagando API. A regra aqui é a oposta: nada é cortado em
 * silêncio. O campo aceita o texto inteiro, o contador fica à vista e, se
 * passar do teto, quem envia é bloqueado com o número exato do excesso —
 * a pessoa decide o que tirar, não o navegador.
 */

export const CHARACTER_BUDGET_NEAR_RATIO = 0.9;

export type CharacterBudgetTone = 'calm' | 'near' | 'over';

export function characterBudgetTone(length: number, limit: number): CharacterBudgetTone {
  if (length > limit) return 'over';
  return length >= Math.floor(limit * CHARACTER_BUDGET_NEAR_RATIO) ? 'near' : 'calm';
}

/** "1.234 / 6.000" com separador de milhar do pt-BR. */
export function formatCharacterBudget(length: number, limit: number): string {
  return `${length.toLocaleString('pt-BR')} / ${limit.toLocaleString('pt-BR')}`;
}

export function characterBudgetMessage(length: number, limit: number): string | null {
  const over = length - limit;
  if (over <= 0) return null;
  return over === 1
    ? 'Passou 1 caractere do limite. Tire ele para enviar — nada é cortado sem você ver.'
    : `Passou ${over.toLocaleString('pt-BR')} caracteres do limite. Tire o excesso para enviar — nada é cortado sem você ver.`;
}

export function CharacterBudget({
  value,
  limit,
  id,
  label,
}: {
  value: string;
  limit: number;
  /** Liga o aviso ao campo por `aria-describedby`. */
  id: string;
  /** Nome do campo, só para o leitor de tela. */
  label: string;
}) {
  const tone = characterBudgetTone(value.length, limit);
  const message = characterBudgetMessage(value.length, limit);
  // Silencioso enquanto sobra espaço: contador em todo campo vazio é ruído.
  if (tone === 'calm' && value.length === 0) return null;
  return (
    <span className="char-budget" id={id}>
      <span
        className={`char-budget__count char-budget__count--${tone}`}
        // Só anuncia quando há o que dizer; a contagem a cada tecla
        // entupiria o leitor de tela.
        {...(tone === 'calm' ? {} : { role: 'status', 'aria-live': 'polite' as const })}
      >
        <span className="char-budget__sr">{`${label}: `}</span>
        {formatCharacterBudget(value.length, limit)}
      </span>
      {message && (
        <span className="char-budget__over" role="alert">
          {message}
        </span>
      )}
    </span>
  );
}
