import snapshot from './snapshot.js';
import { validateCatalog } from './releases.js';
import { browserPlatform, recommendDownload } from './platform.js';

function link(label, url) {
  const anchor = document.createElement('a');
  anchor.textContent = label;
  anchor.href = url;
  return anchor;
}

function recommendationCopy(device, installer) {
  if (installer.url !== '#download') return `Instalador recomendado para ${device.os === 'macos' ? 'seu Mac Apple Silicon' : 'seu Windows x64'}. As duas opções continuam disponíveis abaixo.`;
  if (device.os === 'macos') return device.architecture === 'x64' || device.architecture === 'x86'
    ? 'Mac Intel identificado. O instalador disponível é para Apple Silicon; não há instalador Intel neste catálogo.'
    : 'Você está em um Mac. Este download exige Apple Silicon (M1 ou mais recente). Confira em  → Sobre Este Mac antes de escolher.';
  if (device.os === 'windows') return 'Este instalador é para Windows x64. A arquitetura deste computador não foi confirmada como x64; escolha somente se for compatível.';
  if (device.os === 'mobile') return 'Você está em um dispositivo móvel. Abra esta página no seu Mac ou PC para instalar o NexusIDE.';
  return 'Escolha o sistema do computador onde você vai instalar. Downloads disponíveis: macOS Apple Silicon e Windows x64.';
}

function renderHistory(rows) {
  const history = document.getElementById('windows-history');
  history.replaceChildren(...rows.map((row, index) => {
    const item = document.createElement('li');
    const version = document.createElement('strong');
    version.textContent = `v${row.version}${index === 0 ? ' · mais recente' : ''}`;
    const actions = document.createElement('div');
    actions.append(link('Baixar instalador ↗', row.url), link('Notas desta versão ↗', row.releaseUrl));
    item.append(version, actions);
    return item;
  }));
}

function renderDownloads(catalog, device) {
  for (const [os, label] of [['macos', 'Apple Silicon · .dmg'], ['windows', 'x64 · instalador']]) {
    const latest = catalog[os][0];
    if (!latest) continue;
    const anchor = document.querySelector(`[data-download="${os}"]`);
    anchor.href = latest.url;
    anchor.querySelector('p').textContent = `${label} · v${latest.version}`;
  }
  const installer = recommendDownload(device, catalog);
  for (const anchor of document.querySelectorAll('[data-recommended-download]')) {
    anchor.href = installer.url;
    anchor.textContent = installer.url === '#download' ? 'Escolher meu download ↓' : `Baixar para ${device.os === 'macos' ? 'macOS' : 'Windows'} ↗`;
  }
  document.getElementById('download-compatibility').textContent = recommendationCopy(device, installer);
  document.querySelectorAll('[data-download]').forEach(anchor => anchor.classList.toggle('recommended', installer.url !== '#download' && anchor.href === installer.url));
  renderHistory(catalog.windows);
}

export async function initializeDownloads() {
  const device = await browserPlatform(navigator);
  renderDownloads(snapshot.catalog, device);
  const status = document.getElementById('catalog-status');
  try {
    const response = await fetch('/api/releases', { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('catalog-unavailable');
    const payload = await response.json();
    const catalog = validateCatalog(payload.catalog);
    if (!catalog.windows.length && !catalog.macos.length) throw new Error('catalog-invalid');
    renderDownloads(catalog, device);
    const date = Number.isFinite(Date.parse(payload.checkedAt)) ? new Date(payload.checkedAt).toLocaleDateString('pt-BR') : '';
    status.textContent = payload.source === 'github' ? 'Catálogo consultado no GitHub. Somente versões estáveis publicadas.' : `Última consulta disponível${date ? `: ${date}` : ''}. Confira novas versões no GitHub.`;
  } catch {
    status.textContent = 'A consulta ao vivo está indisponível. Mostrando o último catálogo verificado; confira novas versões no GitHub.';
  }
}
