/**
 * Predefinições de estilo do vídeo de apresentação (pedido do operador,
 * 21/10/2026). O campo "Estilo" era livre com um placeholder — quem não sabe
 * descrever estilo de vídeo escrevia pouco ("bonito", "moderno") e o render
 * saía errado, pagando API a cada tentativa.
 *
 * Cada predefinição ESCREVE no campo um texto de direção concreto (luz,
 * câmera, paleta, tipografia, ritmo) e continua editável: é ponto de partida,
 * não camisa de força. A lista cobre os caminhos reais do estúdio:
 *
 * - O motor padrão é o HyperFrames (`resources/video-engines/hyperframes`),
 *   composição em HTML/CSS: `motion-graphics` e `screen-demo` são o que ele
 *   faz nativamente, sem pagar nenhum modelo de vídeo.
 * - `live-action`, `3d`, `anime-2d` e `illustration` descrevem os planos que
 *   o agente gera como clipe de IA (a tabela `shared/media-video-models`:
 *   Veo, Seedance, Kling, Grok Imagine, Wan, PixVerse, Vidu, Hailuo) e que
 *   entram na composição. Por isso o texto fala de luz, câmera e material —
 *   é o vocabulário a que esses modelos respondem — e nunca cita marca,
 *   obra ou pessoa real, que todos eles recusam.
 *
 * Puro e sem React: o texto é testado sem montar tela.
 */

export type VideoStylePresetId =
  | 'motion-graphics'
  | 'screen-demo'
  | 'live-action'
  | '3d'
  | 'anime-2d'
  | 'illustration';

export interface VideoStylePreset {
  readonly id: VideoStylePresetId;
  /** Rótulo do chip, curto o bastante para caber na linha. */
  readonly label: string;
  /** Uma linha dizendo para que serve, no `title` do chip. */
  readonly hint: string;
  /** O que entra no campo "Estilo" ao escolher. Editável depois. */
  readonly text: string;
}

export const VIDEO_STYLE_PRESETS: readonly VideoStylePreset[] = [
  {
    id: 'motion-graphics',
    label: 'Motion graphics',
    hint: 'Formas e tipografia animadas — o que o HyperFrames faz sem pagar modelo de vídeo.',
    text:
      'Motion graphics: formas geométricas e tipografia grande como protagonista, paleta da marca sobre fundo sólido, ' +
      'entradas por máscara e corte no tempo da narração. Sem foto e sem 3D — o texto e o ícone carregam a mensagem.',
  },
  {
    id: 'screen-demo',
    label: 'Tela do produto',
    hint: 'A tela real do produto guiando o olho; bom para demonstrar o que já existe.',
    text:
      'Demonstração de tela: a tela real do produto em primeiro plano, com zoom e panorâmica suaves até o ponto de atenção, ' +
      'cursor destacado e uma legenda curta por ação. Moldura discreta de dispositivo, fundo neutro, nada piscando.',
  },
  {
    id: 'live-action',
    label: 'Filmado (cinema)',
    hint: 'Cena com gente e câmera real, com cara de comercial filmado.',
    text:
      'Cinematográfico filmado: câmera real com profundidade de campo rasa, luz natural suave com contraluz, ' +
      'movimento lento de dolly e leve câmera na mão. Cor de cinema (sombra fria, pele quente), grão sutil, ' +
      'cortes no ritmo da narração.',
  },
  {
    id: '3d',
    label: '3D / CGI',
    hint: 'Produto em 3D, render de estúdio — bom para objeto, embalagem e mascote com volume.',
    text:
      '3D/CGI: render limpo com luz de estúdio em três pontos, material com reflexo suave e oclusão de ambiente, ' +
      'fundo em gradiente neutro e câmera orbitando devagar. O produto flutua com sombra de contato que o apoia no quadro.',
  },
  {
    id: 'anime-2d',
    label: 'Animação 2D',
    hint: 'Personagem animado com traço limpo e cor chapada.',
    text:
      'Animação 2D: traço limpo de contorno constante, cores chapadas em paleta reduzida e sombra em dois tons. ' +
      'Movimento com antecipação e easing marcado; fundo simples, que não disputa com o personagem.',
  },
  {
    id: 'illustration',
    label: 'Desenho / ilustração',
    hint: 'Ilustração feita à mão, com textura — bom para explicar ideia abstrata.',
    text:
      'Desenho ilustrado: ilustração editorial à mão, textura de papel e lápis, paleta quente e reduzida, ' +
      'composição com bastante respiro. Movimento discreto: parallax leve e elementos que entram sendo desenhados.',
  },
];

/** A predefinição cujo texto está escrito no campo, se alguma. */
export function matchVideoStylePreset(value: string): VideoStylePresetId | null {
  const text = value.trim();
  if (!text) return null;
  return VIDEO_STYLE_PRESETS.find((preset) => preset.text === text)?.id ?? null;
}

/**
 * O que o campo vira ao clicar no chip: escolher escreve o texto; clicar de
 * novo no que já está escrito limpa. Nunca apaga o que a pessoa digitou por
 * cima — texto próprio (que não é de nenhuma predefinição) é substituído só
 * quando ela escolhe uma, que é o que o clique pede.
 */
export function toggleVideoStylePreset(current: string, id: VideoStylePresetId): string {
  const preset = VIDEO_STYLE_PRESETS.find((item) => item.id === id);
  if (!preset) return current;
  return current.trim() === preset.text ? '' : preset.text;
}
