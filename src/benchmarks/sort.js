// Ordenação da tabela de benchmarks no navegador. Pura: quem não publicou o número vai SEMPRE por último (nunca vira o "menor").
export function sortByValue(items, direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    const leftEmpty = typeof left.value !== 'number';
    const rightEmpty = typeof right.value !== 'number';
    if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? left.label.localeCompare(right.label, 'pt-BR') : leftEmpty ? 1 : -1;
    return left.value === right.value ? left.label.localeCompare(right.label, 'pt-BR') : sign * (left.value - right.value);
  });
}

/** Clicar de novo no mesmo benchmark inverte a direção; outro benchmark começa do maior. */
export function nextSort(current, benchmarkId) {
  return current.id === benchmarkId
    ? { id: benchmarkId, direction: current.direction === 'desc' ? 'asc' : 'desc' }
    : { id: benchmarkId, direction: 'desc' };
}
