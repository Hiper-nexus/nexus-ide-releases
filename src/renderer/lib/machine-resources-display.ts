/** F-1172: formatação pt-BR dos recursos da máquina (card e indicador do rail). */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const oneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const twoDecimals = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** "12 GB", "3,6 GB", "410 MB". */
export function formatResourceBytes(bytes: number): string {
  if (bytes >= GiB) return `${oneDecimal.format(bytes / GiB)} GB`;
  return `${integer.format(bytes / MiB)} MB`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatLoad(load: number): string {
  return twoDecimals.format(load);
}
