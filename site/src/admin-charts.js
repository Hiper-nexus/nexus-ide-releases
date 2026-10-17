/**
 * Gráficos e ícones do /admin/ em SVG puro, no desenho dos cards do @shadcnuikit: área com linearGradient e barras,
 * anel (donut) por stroke-dasharray, barra segmentada e sparkline. A geometria são funções puras (testadas); o DOM é
 * montado com createElementNS e todo texto entra por textContent, nunca innerHTML.
 */
const SVG = 'http://www.w3.org/2000/svg';
let uid = 0;

export function svgEl(doc, tag, attrs = {}, text) {
  const node = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

// Ícones no traçado do Lucide (24×24, traço 2): string é um path; c = círculo, r = retângulo, p = polilinha.
export const ICONS = {
  dashboard: [['r', 3, 3, 7, 9, 1], ['r', 14, 3, 7, 5, 1], ['r', 14, 12, 7, 9, 1], ['r', 3, 16, 7, 5, 1]],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  wallet: ['M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'],
  funnel: ['M10 20a1 1 0 0 0 .55.9l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .52-1.34L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.74 1.67l7.22 7.99A2 2 0 0 1 10 14z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', ['c', 9, 7, 4], 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  gift: [['r', 3, 8, 18, 4, 1], 'M12 8v13', 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7', 'M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5'],
  tag: ['M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z', ['c', 7.5, 7.5, 0.5]],
  percent: ['M19 5 5 19', ['c', 6.5, 6.5, 2.5], ['c', 17.5, 17.5, 2.5]],
  bug: ['m8 2 1.88 1.88', 'M14.12 3.88 16 2', 'M9 7.13v-1a3 3 0 1 1 6 0v1', 'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6', 'M12 20v-9', 'M6.53 9C4.6 8.8 3 7.1 3 5', 'M6 13H2', 'M3 21c0-2.1 1.7-3.9 3.8-4', 'M20.97 5c0 2.1-1.6 3.8-3.5 4', 'M22 13h-4', 'M17.2 17c2.1.1 3.8 1.9 3.8 4'],
  panelClose: [['r', 3, 3, 18, 18, 2], 'M9 3v18', 'm16 15-3-3 3-3'],
  panelOpen: [['r', 3, 3, 18, 18, 2], 'M9 3v18', 'm14 9 3 3-3 3'],
  calendar: ['M8 2v4', 'M16 2v4', ['r', 3, 4, 18, 18, 2], 'M3 10h18'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', ['p', '7 10 12 15 17 10'], 'M12 15V3'],
  fileText: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  trendingUp: [['p', '22 7 13.5 15.5 8.5 10.5 2 17'], ['p', '16 7 22 7 22 13']],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  card: [['r', 2, 5, 20, 14, 2], 'M2 10h20'],
  banknote: [['r', 2, 6, 20, 12, 2], ['c', 12, 12, 2], 'M6 12h.01M18 12h.01'],
  pie: ['M21.21 15.89A10 10 0 1 1 8 2.83', 'M22 12A10 10 0 0 0 12 2v10z'],
  chart: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
  receipt: ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z', 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8', 'M12 17.5v-11'],
  hourglass: ['M5 22h14', 'M5 2h14', 'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22', 'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'],
  check: [['c', 12, 12, 10], 'm9 12 2 2 4-4'],
  calendarX: ['M8 2v4', 'M16 2v4', ['r', 3, 4, 18, 18, 2], 'M3 10h18', 'm14 14-4 4', 'm10 14 4 4'],
  ban: [['c', 12, 12, 10], 'm4.9 4.9 14.2 14.2'],
  radio: [['c', 12, 12, 2], 'M16.24 7.76a6 6 0 0 1 0 8.49', 'M7.76 16.24a6 6 0 0 1 0-8.49', 'M19.07 4.93a10 10 0 0 1 0 14.14', 'M4.93 19.07a10 10 0 0 1 0-14.14'],
  play: ['M6 3 20 12 6 21Z'],
  checks: ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  bot: ['M12 8V4H8', ['r', 4, 8, 16, 12, 2], 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  repeat: ['m17 2 4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'm7 22-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'],
  gauge: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'],
  database: ['M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  external: ['M7 7h10v10', 'M7 17 17 7'],
  search: [['c', 11, 11, 8], 'm21 21-4.3-4.3'],
  user: [['c', 12, 8, 5], 'M20 21a8 8 0 0 0-16 0'],
};

/** Ícone decorativo (aria-hidden): o nome acessível fica no texto ao lado. */
export function icon(name, { size = 16, doc = globalThis.document } = {}) {
  const shapes = ICONS[name] ?? ICONS.dashboard;
  const node = svgEl(doc, 'svg', {
    class: 'adm-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  });
  for (const shape of shapes) {
    if (typeof shape === 'string') node.append(svgEl(doc, 'path', { d: shape }));
    else if (shape[0] === 'c') node.append(svgEl(doc, 'circle', { cx: shape[1], cy: shape[2], r: shape[3] }));
    else if (shape[0] === 'r') node.append(svgEl(doc, 'rect', { x: shape[1], y: shape[2], width: shape[3], height: shape[4], rx: shape[5] }));
    else node.append(svgEl(doc, 'polyline', { points: shape[1] }));
  }
  return node;
}

/** Teto "redondo" do eixo (1, 2, 2,5, 5 ou 10 vezes uma potência de 10), para as linhas de grade caírem em números legíveis. */
export function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value)), unit = value / power;
  const step = [1, 2, 2.5, 5, 10].find(candidate => unit <= candidate);
  return step * power;
}

const round = value => Math.round(value * 100) / 100;

/**
 * Curva monotônica (Fritsch-Carlson): passa por todos os pontos e nunca ultrapassa os vizinhos, então a área não
 * afunda abaixo de zero nem inventa um pico entre dois buckets.
 */
export function monotonePath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${round(points[0][0])},${round(points[0][1])}`;
  const n = points.length, dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / (dx[i] || 1));
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i++) tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i] / slope[i], b = tangent[i + 1] / slope[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); tangent[i] = t * a * slope[i]; tangent[i + 1] = t * b * slope[i]; }
  }
  let d = `M${round(points[0][0])},${round(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1], third = dx[i] / 3;
    d += `C${round(x0 + third)},${round(y0 + tangent[i] * third)},${round(x1 - third)},${round(y1 - tangent[i + 1] * third)},${round(x1)},${round(y1)}`;
  }
  return d;
}

/**
 * Geometria do gráfico de área + barras. points: [{ label, area, bar }] com números ≥ 0 ou null (sem dado).
 * Devolve coordenadas prontas: caminho da área, linha, barras, grade e rótulos.
 */
export function revenueGeometry(points, { width = 640, height = 240, pad = { top: 12, right: 12, bottom: 28, left: 56 }, ticks = 4 } = {}) {
  const innerW = Math.max(1, width - pad.left - pad.right), innerH = Math.max(1, height - pad.top - pad.bottom);
  const values = points.flatMap(point => [point.area, point.bar]).filter(value => Number.isFinite(value));
  const max = niceMax(Math.max(0, ...values));
  const step = innerW / Math.max(1, points.length), baseline = pad.top + innerH;
  const x = index => pad.left + step * index + step / 2, y = value => baseline - (value / max) * innerH;
  const known = points.map((point, index) => [x(index), point.area]).filter(([, value]) => Number.isFinite(value)).map(([px, value]) => [px, y(value)]);
  const line = monotonePath(known);
  const area = known.length > 1 ? `${line}L${round(known.at(-1)[0])},${baseline}L${round(known[0][0])},${baseline}Z` : '';
  const barW = Math.max(2, Math.min(24, step * 0.5));
  const bars = points.flatMap((point, index) => (Number.isFinite(point.bar) && point.bar > 0
    ? [{ index, x: round(x(index) - barW / 2), y: round(y(point.bar)), width: round(barW), height: round(baseline - y(point.bar)) }] : []));
  const grid = Array.from({ length: ticks + 1 }, (_, i) => ({ value: (max / ticks) * i, y: round(baseline - (innerH / ticks) * i) }));
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 64))));
  const labels = points.flatMap((point, index) => (index % every === 0 || index === points.length - 1) && (points.length - 1 - index >= every || index === points.length - 1)
    ? [{ index, x: round(x(index)), text: point.label }] : []);
  return { width, height, pad, max, baseline, step, area, line, bars, grid, labels, x: points.map((_, index) => round(x(index))), dots: known.map(([px, py]) => [round(px), round(py)]) };
}

/** Arcos do anel: comprimento e deslocamento de cada fatia no stroke-dasharray, com um respiro entre fatias. */
export function donutArcs(values, { radius = 60, gap = 2 } = {}) {
  const circumference = 2 * Math.PI * radius;
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  const visible = values.filter(value => Number.isFinite(value) && value > 0).length;
  let offset = 0;
  return {
    circumference: round(circumference), total,
    arcs: values.map(value => {
      const share = total > 0 && Number.isFinite(value) && value > 0 ? value / total : 0;
      const length = share * circumference, drawn = visible > 1 ? Math.max(0, length - gap) : length;
      const arc = { share, length: round(drawn), dasharray: `${round(drawn)} ${round(circumference - drawn)}`, dashoffset: round(-offset) };
      offset += length;
      return arc;
    }),
  };
}

export function sparklinePath(values, { width = 96, height = 28, pad = 2 } = {}) {
  const known = values.filter(value => Number.isFinite(value));
  if (known.length < 2) return '';
  const max = Math.max(...known), min = Math.min(...known), span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  const points = values.flatMap((value, index) => (Number.isFinite(value) ? [[pad + step * index, height - pad - ((value - min) / span) * (height - pad * 2)]] : []));
  return monotonePath(points);
}

/** Caixa vazia composta (nunca um painel em branco): ícone, frase do que falta e de onde virá. */
export function chartEmpty(container, message, { doc = globalThis.document, iconName = 'chart' } = {}) {
  const box = doc.createElement('div');
  box.className = 'adm-chart-empty';
  const text = doc.createElement('p');
  text.textContent = message;
  box.append(icon(iconName, { size: 20, doc }), text);
  container.replaceChildren(box);
  return box;
}

/**
 * Área (curva + gradiente) e barras discretas com grade tracejada, eixos e leitura do bucket sob o ponteiro ou o teclado.
 * series: { points: [{label, area, bar}], areaLabel, barLabel, format(value) }.
 */
export function renderRevenueAreaChart(container, { points, areaLabel, barLabel, format, emptyMessage }, { doc = globalThis.document, width, height = 240 } = {}) {
  if (!points.length || !points.some(point => Number.isFinite(point.area) || Number.isFinite(point.bar))) {
    return chartEmpty(container, emptyMessage ?? 'Sem pontos no período.', { doc });
  }
  const w = Math.max(240, Math.round(width ?? container.clientWidth ?? 640) || 640);
  const geo = revenueGeometry(points, { width: w, height, pad: { top: 12, right: 12, bottom: 28, left: w < 420 ? 44 : 56 } });
  const id = `adm-grad-${++uid}`;
  const svg = svgEl(doc, 'svg', { class: 'adm-area-chart', viewBox: `0 0 ${w} ${height}`, width: w, height, 'aria-hidden': 'true', focusable: 'false' });
  const defs = svgEl(doc, 'defs'), gradient = svgEl(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svgEl(doc, 'stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': 0.32 }), svgEl(doc, 'stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': 0 }));
  defs.append(gradient);
  svg.append(defs);
  const grid = svgEl(doc, 'g', { class: 'adm-chart-grid' });
  for (const tick of geo.grid) {
    grid.append(svgEl(doc, 'line', { x1: geo.pad.left, x2: w - geo.pad.right, y1: tick.y, y2: tick.y, 'stroke-dasharray': tick.value === 0 ? null : '3 3' }));
    grid.append(svgEl(doc, 'text', { x: geo.pad.left - 8, y: tick.y + 4, 'text-anchor': 'end', class: 'adm-chart-axis' }, format(tick.value, true)));
  }
  svg.append(grid);
  const bars = svgEl(doc, 'g', { class: 'adm-chart-bars' });
  for (const bar of geo.bars) bars.append(svgEl(doc, 'rect', { x: bar.x, y: bar.y, width: bar.width, height: bar.height, rx: 3, 'data-index': bar.index }));
  svg.append(bars);
  if (geo.area) svg.append(svgEl(doc, 'path', { class: 'adm-chart-area', d: geo.area, fill: `url(#${id})` }));
  if (geo.line) svg.append(svgEl(doc, 'path', { class: 'adm-chart-line', d: geo.line, fill: 'none' }));
  const labels = svgEl(doc, 'g', { class: 'adm-chart-axis' });
  for (const label of geo.labels) labels.append(svgEl(doc, 'text', { x: label.x, y: height - 8, 'text-anchor': 'middle' }, label.text));
  svg.append(labels);
  const guide = svgEl(doc, 'line', { class: 'adm-chart-guide', x1: 0, x2: 0, y1: geo.pad.top, y2: geo.baseline, visibility: 'hidden' });
  const dot = svgEl(doc, 'circle', { class: 'adm-chart-dot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
  svg.append(guide, dot);

  // Leitura acessível: o grupo recebe foco, setas trocam o bucket e a linha abaixo do gráfico anuncia os valores.
  const frame = doc.createElement('div');
  frame.className = 'adm-chart-frame';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-label', `${areaLabel} e ${barLabel}, ${points.length} pontos. Use as setas para ler cada ponto.`);
  const readout = doc.createElement('p');
  readout.className = 'adm-chart-readout';
  readout.setAttribute('aria-live', 'polite');
  const describe = index => {
    const point = points[index];
    const parts = [point.label, `${areaLabel}: ${Number.isFinite(point.area) ? format(point.area) : 'sem dado'}`, `${barLabel}: ${Number.isFinite(point.bar) ? format(point.bar) : 'sem dado'}`];
    return parts.join(' · ');
  };
  let active = points.length - 1;
  const show = index => {
    active = Math.max(0, Math.min(points.length - 1, index));
    const cx = geo.x[active];
    guide.setAttribute('x1', String(cx)); guide.setAttribute('x2', String(cx)); guide.setAttribute('visibility', 'visible');
    const area = points[active].area;
    if (Number.isFinite(area)) {
      dot.setAttribute('cx', String(cx)); dot.setAttribute('cy', String(round(geo.baseline - (area / geo.max) * (geo.baseline - geo.pad.top))));
      dot.setAttribute('visibility', 'visible');
    } else dot.setAttribute('visibility', 'hidden');
    for (const rect of bars.children) rect.classList?.toggle('is-active', Number(rect.getAttribute('data-index')) === active);
    readout.textContent = describe(active);
  };
  frame.addEventListener?.('pointermove', event => {
    const box = svg.getBoundingClientRect?.();
    if (!box || !box.width) return;
    show(Math.floor((((event.clientX - box.left) / box.width) * w - geo.pad.left) / geo.step));
  });
  frame.addEventListener?.('keydown', event => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const move = moves[event.key];
    show(Number.isFinite(move) ? active + move : move < 0 ? 0 : points.length - 1);
  });
  readout.textContent = describe(active);
  frame.append(svg);
  container.replaceChildren(frame, readout);
  return frame;
}

/** Anel da carteira: uma circunferência por fatia (stroke-dasharray/dashoffset), total no centro. */
export function renderWalletDonutChart(container, { segments, total, centerLabel = 'contas' }, { doc = globalThis.document, size = 160, stroke = 16 } = {}) {
  const radius = (size - stroke) / 2, center = size / 2;
  const { arcs } = donutArcs(segments.map(segment => segment.value), { radius });
  const svg = svgEl(doc, 'svg', { class: 'adm-donut', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': `${total} ${centerLabel}: ${segments.map(segment => `${segment.label} ${segment.value ?? 'sem dado'}`).join(', ')}` });
  svg.append(svgEl(doc, 'circle', { class: 'adm-donut-track', cx: center, cy: center, r: radius, fill: 'none', 'stroke-width': stroke }));
  const ring = svgEl(doc, 'g', { transform: `rotate(-90 ${center} ${center})` });
  segments.forEach((segment, index) => {
    const arc = arcs[index];
    if (arc.length <= 0) return;
    ring.append(svgEl(doc, 'circle', { cx: center, cy: center, r: radius, fill: 'none', stroke: segment.color, 'stroke-width': stroke, 'stroke-dasharray': arc.dasharray, 'stroke-dashoffset': arc.dashoffset, 'data-key': segment.key }));
  });
  svg.append(ring);
  svg.append(svgEl(doc, 'text', { x: center, y: center + 2, 'text-anchor': 'middle', class: 'adm-donut-total' }, String(total)));
  svg.append(svgEl(doc, 'text', { x: center, y: center + 22, 'text-anchor': 'middle', class: 'adm-donut-caption' }, centerLabel));
  container.replaceChildren(svg);
  return svg;
}

/** Barra horizontal segmentada (Income Sources): cada fatia ocupa a sua fração; sem total, só o trilho. */
export function renderStackedBar(container, segments, { doc = globalThis.document, label = 'Distribuição' } = {}) {
  const bar = doc.createElement('div');
  bar.className = 'adm-stacked-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${label}: ${segments.map(segment => `${segment.label} ${Math.round(segment.share * 100)}%`).join(', ')}`);
  for (const segment of segments) {
    if (!(segment.share > 0)) continue;
    const piece = doc.createElement('span');
    piece.className = 'adm-stacked-seg';
    piece.style.setProperty('--share', String(round(segment.share * 100)));
    piece.style.setProperty('--seg', segment.color);
    piece.dataset.key = segment.id ?? segment.key;
    bar.append(piece);
  }
  container.replaceChildren(bar);
  return bar;
}

export function renderSparkline(container, values, { doc = globalThis.document, width = 96, height = 28 } = {}) {
  const d = sparklinePath(values, { width, height });
  if (!d) { container.replaceChildren(); return null; }
  // Estica na largura do cartão; o traço não engrossa junto (non-scaling-stroke).
  const svg = svgEl(doc, 'svg', { class: 'adm-sparkline', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgEl(doc, 'path', { d, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
  container.replaceChildren(svg);
  return svg;
}
