export type PixelIconName =
  | 'mission'
  | 'agent'
  | 'terminal'
  | 'browser'
  | 'grid'
  | 'files'
  | 'board'
  | 'orch'
  | 'crown'
  | 'crown-outline'
  | 'config'
  | 'mic'
  | 'vision'
  | 'plus'
  | 'sparkle'
  | 'close'
  | 'sun'
  | 'moon'
  | 'chevron'
  | 'chevron-down'
  | 'bolt'
  | 'key'
  | 'id-badge'
  | 'warn'
  | 'user'
  | 'users'
  | 'status-idle'
  | 'status-busy'
  | 'status-exited'
  | 'status-hibernated'
  | 'status-spawning'
  | 'scroll-bottom'
  | 'restart'
  | 'resume'
  | 'blocks'
  | 'maximize'
  | 'split-right'
  | 'split-down'
  | 'more'
  | 'update'
  | 'star'
  | 'star-outline'
  | 'search'
  | 'bell'
  | 'file'
  | 'volume'
  | 'volume-off'
  | 'stop'
  | 'power'
  | 'grip'
  | 'minimize'
  | 'refresh'
  | 'info'
  | 'check'
  | 'trash'
  | 'arrow-left'
  | 'arrow-right'
  | 'link'
  | 'bug';

/**
 * Icon set pixel — desenhado em grid 11×11, em rects crisp
 * (currentColor). Um idioma só de ícones, na pegada operador/pixel, no lugar da
 * sopa de emoji + glifos Unicode. Cada ícone é uma lista de rects [x,y,w,h]
 * (w/h default 1).
 */

type Rect = [number, number, number?, number?];

const ICONS: Record<PixelIconName, Rect[]> = {
  // ▸ play em degraus
  mission: [
    [3, 2, 1, 7],
    [4, 3, 1, 5],
    [5, 4, 1, 3],
    [6, 5, 1, 1],
  ],
  // cabeça de robô: antena + contorno + dois olhos
  agent: [
    [5, 1, 1, 2],
    [2, 3, 7, 1],
    [2, 3, 1, 5],
    [8, 3, 1, 5],
    [2, 8, 7, 1],
    [4, 5, 1, 1],
    [6, 5, 1, 1],
  ],
  // >_ prompt
  terminal: [
    [2, 3, 1, 1],
    [3, 4, 1, 1],
    [4, 5, 1, 1],
    [3, 6, 1, 1],
    [2, 7, 1, 1],
    [5, 8, 4, 1],
  ],
  // janela com barra de título
  browser: [
    [1, 2, 9, 1],
    [1, 2, 1, 6],
    [9, 2, 1, 6],
    [1, 8, 9, 1],
    [1, 4, 9, 1],
  ],
  // 2×2 blocos
  grid: [
    [1, 1, 3, 3],
    [7, 1, 3, 3],
    [1, 7, 3, 3],
    [7, 7, 3, 3],
  ],
  // pasta (aba + corpo)
  files: [
    [1, 3, 4, 1],
    [1, 4, 9, 1],
    [1, 4, 1, 5],
    [9, 4, 1, 5],
    [1, 8, 9, 1],
  ],
  // kanban: header + 3 colunas
  board: [
    [1, 2, 9, 1],
    [1, 4, 2, 6],
    [5, 4, 2, 6],
    [8, 4, 2, 6],
  ],
  // hub + 4 spokes
  orch: [
    [4, 4, 3, 3],
    [5, 1, 1, 2],
    [5, 8, 1, 2],
    [1, 5, 2, 1],
    [8, 5, 2, 1],
  ],
  crown: [
    [2, 3, 1, 5],
    [3, 4, 1, 4],
    [4, 2, 1, 6],
    [5, 4, 1, 4],
    [6, 2, 1, 6],
    [7, 4, 1, 4],
    [8, 3, 1, 5],
    [2, 8, 7, 1],
  ],
  'crown-outline': [
    [2, 3, 1, 5],
    [4, 2, 1, 3],
    [6, 2, 1, 3],
    [8, 3, 1, 5],
    [3, 6, 5, 1],
    [2, 8, 7, 1],
  ],
  // sliders (configuração)
  config: [
    [1, 3, 9, 1],
    [3, 2, 2, 3],
    [1, 7, 9, 1],
    [6, 6, 2, 3],
  ],
  // microfone
  mic: [
    [4, 1, 3, 5],
    [3, 5, 1, 1],
    [7, 5, 1, 1],
    [5, 6, 1, 2],
    [3, 9, 5, 1],
  ],
  // eye / vision sensor
  vision: [
    [2, 5, 1, 1],
    [3, 4, 1, 1],
    [4, 3, 3, 1],
    [7, 4, 1, 1],
    [8, 5, 1, 1],
    [7, 6, 1, 1],
    [4, 7, 3, 1],
    [3, 6, 1, 1],
    [5, 5, 1, 1],
  ],
  // + cruz
  plus: [
    [5, 2, 1, 7],
    [2, 5, 7, 1],
  ],
  // faísca (magia / squad sob medida)
  sparkle: [
    [5, 2, 1, 7],
    [2, 5, 7, 1],
    [3, 3, 1, 1],
    [7, 7, 1, 1],
    [7, 3, 1, 1],
    [3, 7, 1, 1],
  ],
  // close / cross (x)
  close: [
    [3, 3, 1, 1],
    [4, 4, 1, 1],
    [5, 5, 1, 1],
    [6, 6, 1, 1],
    [7, 7, 1, 1],
    [7, 3, 1, 1],
    [6, 4, 1, 1],
    [4, 6, 1, 1],
    [3, 7, 1, 1],
  ],
  // sun (wake)
  sun: [
    [4, 4, 3, 3],
    [5, 1, 1, 2],
    [5, 8, 1, 2],
    [1, 5, 2, 1],
    [8, 5, 2, 1],
  ],
  // moon (sleep)
  moon: [
    [4, 2, 4, 1],
    [3, 3, 2, 1],
    [2, 4, 2, 1],
    [2, 5, 2, 1],
    [2, 6, 2, 1],
    [3, 7, 2, 1],
    [4, 8, 4, 1],
  ],
  // chevron right
  chevron: [
    [4, 3],
    [5, 4],
    [6, 5],
    [5, 6],
    [4, 7],
  ],
  // chevron down (mesmo desenho, rotacionado)
  'chevron-down': [
    [3, 4],
    [7, 4],
    [4, 5],
    [6, 5],
    [5, 6],
  ],
  // raio (modo agêntico / disparar)
  bolt: [
    [6, 1],
    [5, 2],
    [4, 3],
    [3, 4, 5, 1],
    [6, 5],
    [5, 6],
    [4, 7],
    [3, 8],
  ],
  // chave: anel à esquerda + haste com dentes
  key: [
    [2, 3, 2, 1],
    [1, 4, 1, 2],
    [4, 4, 1, 2],
    [2, 6, 2, 1],
    [5, 5, 4, 1],
    [7, 6, 1, 1],
    [9, 5, 1, 2],
  ],
  // crachá: cartão + foto + linhas
  'id-badge': [
    [1, 2, 9, 1],
    [1, 2, 1, 7],
    [9, 2, 1, 7],
    [1, 8, 9, 1],
    [3, 4, 2, 2],
    [6, 4, 2, 1],
    [6, 6, 2, 1],
  ],
  // triângulo de alerta com exclamação
  warn: [
    [5, 1, 1, 1],
    [4, 2, 1, 1], [6, 2, 1, 1],
    [4, 3, 1, 1], [6, 3, 1, 1],
    [3, 4, 1, 1], [7, 4, 1, 1],
    [3, 5, 1, 1], [7, 5, 1, 1],
    [2, 6, 1, 1], [8, 6, 1, 1],
    [2, 7, 1, 1], [8, 7, 1, 1],
    [2, 8, 7, 1],
    [5, 3, 1, 3],
    [5, 7, 1, 1],
  ],
  // operador solo: cabeça + tronco
  user: [
    [4, 2, 3, 3],
    [3, 6, 5, 1],
    [2, 7, 7, 2],
  ],
  // squad: dois operadores lado a lado
  users: [
    [2, 2, 2, 2],
    [7, 2, 2, 2],
    [1, 5, 4, 3],
    [6, 5, 4, 3],
  ],
  // status idle (filled circle)
  'status-idle': [
    [4, 3, 3, 1],
    [3, 4, 5, 1],
    [3, 5, 5, 1],
    [3, 6, 5, 1],
    [4, 7, 3, 1],
  ],
  // status busy (dense/segmented thick ring)
  'status-busy': [
    [3, 3, 5, 1],
    [3, 4, 2, 1], [6, 4, 2, 1],
    [3, 5, 2, 1], [6, 5, 2, 1],
    [3, 6, 2, 1], [6, 6, 2, 1],
    [3, 7, 5, 1],
  ],
  // status exited (small cross)
  'status-exited': [
    [3, 3, 1, 1], [7, 3, 1, 1],
    [4, 4, 1, 1], [6, 4, 1, 1],
    [5, 5, 1, 1],
    [4, 6, 1, 1], [6, 6, 1, 1],
    [3, 7, 1, 1], [7, 7, 1, 1],
  ],
  // status hibernated (circle with horizontal bar)
  'status-hibernated': [
    [4, 3, 3, 1],
    [3, 4, 1, 1], [7, 4, 1, 1],
    [3, 5, 5, 1],
    [3, 6, 1, 1], [7, 6, 1, 1],
    [4, 7, 3, 1],
  ],
  // status spawning (hollow circle)
  'status-spawning': [
    [4, 3, 3, 1],
    [3, 4, 1, 1], [7, 4, 1, 1],
    [3, 5, 1, 1], [7, 5, 1, 1],
    [3, 6, 1, 1], [7, 6, 1, 1],
    [4, 7, 3, 1],
  ],
  // seta para o fim do scroll
  'scroll-bottom': [
    [5, 1, 1, 5],
    [3, 4, 1, 1],
    [4, 5, 1, 1],
    [5, 6, 1, 1],
    [6, 5, 1, 1],
    [7, 4, 1, 1],
    [2, 8, 7, 1],
  ],
  // setas circulares de restart
  restart: [
    [3, 2, 5, 1],
    [7, 2, 1, 3],
    [6, 4, 1, 1],
    [3, 8, 5, 1],
    [3, 5, 1, 3],
    [4, 6, 1, 1],
  ],
  // ▸ play parado numa barra: "continuar de onde parou". Distinto do ⟲ de
  // restart (recomeçar) e do ▸ solto de 'mission'.
  resume: [
    [2, 2, 1, 7],
    [4, 2, 1, 7],
    [5, 3, 1, 5],
    [6, 4, 1, 3],
    [7, 5, 1, 1],
  ],
  // dois blocos de comando empilhados (histórico de comandos)
  blocks: [
    [1, 1, 9, 1],
    [1, 4, 9, 1],
    [1, 2, 1, 2],
    [9, 2, 1, 2],
    [1, 6, 9, 1],
    [1, 9, 9, 1],
    [1, 7, 1, 2],
    [9, 7, 1, 2],
  ],
  // cantos expandindo para tela cheia
  maximize: [
    [1, 1, 4, 1],
    [1, 1, 1, 4],
    [6, 1, 4, 1],
    [9, 1, 1, 4],
    [1, 6, 1, 4],
    [1, 9, 4, 1],
    [9, 6, 1, 4],
    [6, 9, 4, 1],
  ],
  // moldura dividida ao meio, metade da direita cheia (split / ao lado).
  // Os dois blocos cheios de antes, com a divisória também cheia, viravam
  // um retângulo sólido — lia como "parar", não como dividir.
  'split-right': [
    [1, 2, 9, 1],
    [1, 8, 9, 1],
    [1, 3, 1, 5],
    [9, 3, 1, 5],
    [5, 3, 1, 5],
    [6, 3, 3, 5],
  ],
  // moldura dividida ao meio, metade de baixo cheia (split para baixo)
  'split-down': [
    [2, 1, 7, 1],
    [2, 9, 7, 1],
    [2, 2, 1, 7],
    [8, 2, 1, 7],
    [3, 5, 5, 1],
    [3, 6, 5, 3],
  ],
  // menu ⋯
  more: [
    [2, 5, 1, 1],
    [5, 5, 1, 1],
    [8, 5, 1, 1],
  ],
  // seta subindo para a bandeja (atualização disponível)
  update: [
    [5, 1, 1, 5],
    [4, 2, 1, 1],
    [6, 2, 1, 1],
    [3, 3, 1, 1],
    [7, 3, 1, 1],
    [2, 7, 1, 2],
    [8, 7, 1, 2],
    [2, 8, 7, 1],
  ],
  // estrela cheia (pin ativo)
  star: [
    [5, 1, 1, 1],
    [4, 2, 3, 1],
    [1, 3, 9, 1],
    [2, 4, 7, 1],
    [3, 5, 5, 1],
    [2, 6, 3, 1],
    [6, 6, 3, 1],
    [2, 7, 1, 1],
    [8, 7, 1, 1],
  ],
  // estrela vazada (pin inativo)
  'star-outline': [
    [5, 1, 1, 1],
    [4, 2, 1, 1],
    [6, 2, 1, 1],
    [1, 3, 3, 1],
    [7, 3, 3, 1],
    [2, 4, 1, 1],
    [8, 4, 1, 1],
    [3, 5, 1, 1],
    [7, 5, 1, 1],
    [2, 6, 1, 1],
    [4, 6, 3, 1],
    [8, 6, 1, 1],
    [2, 7, 1, 1],
    [8, 7, 1, 1],
  ],
  // lupa
  search: [
    [3, 2, 3, 1],
    [2, 3, 1, 1],
    [6, 3, 1, 1],
    [2, 4, 1, 1],
    [6, 4, 1, 1],
    [3, 5, 3, 1],
    [6, 6, 1, 1],
    [7, 7, 1, 1],
    [8, 8, 1, 1],
  ],
  // sino: cabo, corpo em sino e badalo — semântica de notificações
  bell: [
    [5, 1, 1, 1],
    [4, 2, 3, 1],
    [4, 3, 3, 1],
    [3, 4, 5, 1],
    [3, 5, 5, 1],
    [3, 6, 5, 1],
    [2, 7, 7, 1],
    [5, 8, 1, 1],
  ],
  // folha com canto dobrado — item de arquivo, distinto da pasta `files`
  file: [
    [3, 1, 6, 1],
    [2, 2, 1, 8],
    [3, 9, 6, 1],
    [9, 2, 1, 7],
    [7, 1, 2, 2],
    [4, 4, 4, 1],
    [4, 6, 3, 1],
  ],
  // alto-falante / alto-falante silenciado
  volume: [
    [1, 4, 3, 3],
    [4, 3, 2, 5],
    [6, 2, 1, 7],
    [8, 3, 1, 5],
    [9, 4, 1, 3],
  ],
  'volume-off': [
    [1, 4, 3, 3],
    [4, 3, 2, 5],
    [6, 2, 1, 7],
    [1, 1, 9, 1],
    [2, 2, 1, 1],
    [8, 8, 1, 1],
    [9, 9, 1, 1],
  ],
  stop: [
    [2, 2, 7, 7],
  ],
  power: [
    [5, 1, 1, 5],
    [3, 2, 1, 1],
    [7, 2, 1, 1],
    [2, 3, 1, 4],
    [8, 3, 1, 4],
    [3, 7, 1, 1],
    [7, 7, 1, 1],
    [4, 8, 3, 1],
  ],
  grip: [
    [2, 2, 2, 1],
    [6, 2, 2, 1],
    [2, 5, 2, 1],
    [6, 5, 2, 1],
    [2, 8, 2, 1],
    [6, 8, 2, 1],
  ],
  minimize: [
    [2, 6, 7, 1],
  ],
  refresh: [
    [3, 1, 5, 1],
    [2, 2, 1, 2],
    [7, 2, 2, 1],
    [1, 4, 1, 4],
    [2, 8, 2, 1],
    [4, 9, 4, 1],
    [8, 5, 1, 3],
  ],
  info: [
    [4, 1, 3, 1],
    [3, 2, 5, 1],
    [3, 3, 1, 5],
    [7, 3, 1, 5],
    [4, 8, 3, 1],
    [5, 4, 1, 2],
  ],
  check: [
    [1, 5, 2, 1],
    [3, 6, 2, 1],
    [5, 4, 2, 2],
    [7, 2, 2, 2],
  ],
  trash: [
    [2, 3, 7, 1],
    [3, 4, 1, 5],
    [7, 4, 1, 5],
    [4, 2, 3, 1],
    [4, 9, 3, 1],
  ],
  'arrow-left': [
    [2, 5, 7, 1],
    [3, 4, 1, 1],
    [4, 3, 1, 1],
    [3, 6, 1, 1],
    [4, 7, 1, 1],
  ],
  'arrow-right': [
    [2, 5, 7, 1],
    [7, 3, 1, 1],
    [6, 4, 1, 1],
    [7, 6, 1, 1],
    [6, 7, 1, 1],
  ],
  // elo de ligação entre nota e pane
  link: [
    [2, 3, 3, 1],
    [1, 4, 1, 3],
    [2, 7, 3, 1],
    [6, 3, 3, 1],
    [9, 4, 1, 3],
    [6, 7, 3, 1],
    [4, 5, 3, 1],
  ],
  // inseto: antenas, cabeça, corpo e patas (reportar um problema)
  bug: [
    [2, 0],
    [3, 1],
    [8, 0],
    [7, 1],
    [4, 2, 3, 1],
    [2, 3, 7, 1],
    [2, 4, 7, 1],
    [2, 5, 7, 1],
    [2, 6, 7, 1],
    [3, 7, 5, 1],
    [4, 8, 3, 1],
    [0, 3, 2, 1],
    [9, 3, 2, 1],
    [0, 5, 2, 1],
    [9, 5, 2, 1],
    [1, 7, 2, 1],
    [8, 7, 2, 1],
  ],
};

interface PixelIconProps {
  name: PixelIconName;
  size?: number;
  className?: string;
}

/**
 * A grade tem 11 células: abaixo de 11px cada célula vira menos de 1px de tela
 * e o `crispEdges` descarta traços inteiros (o "+" da grade de terminais sumia
 * em 10px). 11px é o menor tamanho em que o desenho sai completo.
 */
const MIN_CRISP_SIZE = 11;

export function PixelIcon({ name, size = 12, className }: PixelIconProps) {
  const renderSize = Math.max(size, MIN_CRISP_SIZE);
  return (
    <svg
      className={`pixel-icon ${className ?? ''}`}
      width={renderSize}
      height={renderSize}
      viewBox="0 0 11 11"
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
    >
      {ICONS[name].map(([x, y, w = 1, h = 1], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
  );
}
