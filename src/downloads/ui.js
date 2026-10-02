import snapshot from './snapshot.js';
import { validateCatalog } from './releases.js';
import { browserPlatform, recommendDownload } from './platform.js';

function link(label, url) {
  const anchor = document.createElement('a');
  anchor.textContent = label;
  anchor.href = url;
  return anchor;
}

const LINUX_CHOICE = 'Escolha o pacote da sua distribuição: .deb (Debian, Ubuntu), .rpm (Fedora, openSUSE) ou o .zip portátil.';

function recommendationCopy(device, installer, linux) {
  if (device.os === 'linux') {
    if (device.architecture === 'arm64' || device.architecture === 'arm32' || device.architecture === 'x86') return 'O Linux do NexusIDE é para x64; este computador não parece ser x64. Escolha somente se for compatível.';
    return linux.length ? `Linux x64 identificado. ${LINUX_CHOICE}` : 'Linux x64 identificado. O pacote Linux ainda está em validação e não foi publicado; assim que sair, ele aparece aqui.';
  }
  if (installer.url !== '#download') return `Instalador recomendado para ${device.os === 'macos' ? 'seu Mac Apple Silicon' : 'seu Windows x64'}. As duas opções continuam disponíveis abaixo.`;
  if (device.os === 'macos') return device.architecture === 'x64' || device.architecture === 'x86'
    ? 'Mac Intel identificado. O instalador disponível é para Apple Silicon; não há instalador Intel neste catálogo.'
    : 'Você está em um Mac. Este download exige Apple Silicon (M1 ou mais recente). Confira em  → Sobre Este Mac antes de escolher.';
  if (device.os === 'windows') return 'Este instalador é para Windows x64. A arquitetura deste computador não foi confirmada como x64; escolha somente se for compatível.';
  if (device.os === 'mobile') return 'Você está em um dispositivo móvel. Abra esta página no seu Mac ou PC para instalar o NexusIDE.';
  return `Escolha o sistema do computador onde você vai instalar. Downloads disponíveis: macOS Apple Silicon, Windows x64${linux.length ? ' e Linux x64 (beta)' : '; o Linux está em validação'}.`;
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

const LINUX_FORMAT_LABEL = { deb: '.deb', rpm: '.rpm', zip: '.zip' };

function renderLinux(rows) {
  const card = document.querySelector('[data-download-linux]');
  if (!card) return;
  const latest = rows[0];
  card.dataset.state = latest ? 'ready' : 'pending';
  card.querySelector('[data-linux-status]').textContent = latest
    ? `x64 · beta sem assinatura digital · v${latest.version} · sem atualização automática`
    : 'x64 · .deb, .rpm e .zip portátil · em validação, ainda não publicado';
  const formats = card.querySelector('[data-linux-formats]');
  formats.hidden = !latest;
  // O comando de um clique só aparece quando há pacote publicado para ele instalar.
  const quick = card.querySelector('[data-linux-quick]');
  if (quick) quick.hidden = !latest;
  formats.replaceChildren(...(latest ? [
    ...latest.files.map(file => {
      const anchor = link(LINUX_FORMAT_LABEL[file.format], file.url);
      anchor.className = 'linux-format';
      anchor.setAttribute('aria-label', `Baixar o pacote ${LINUX_FORMAT_LABEL[file.format]} do Linux x64, versão ${latest.version}`);
      return anchor;
    }),
    ...(latest.checksums ? [Object.assign(link('SHA-256 ↗', latest.checksums.url), { className: 'linux-sums' })] : []),
  ] : []));
}

/** Copia o comando de instalação do Linux; sem a API de área de transferência, seleciona o texto para o Ctrl+C. */
function initializeLinuxCopy() {
  const button = document.querySelector('[data-linux-copy]');
  const command = document.querySelector('[data-linux-cmd]');
  const note = document.querySelector('[data-linux-copied]');
  if (!button || !command || !note) return;
  let timer;
  const say = text => {
    note.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => { note.textContent = ''; }, 2500);
  };
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      say('Copiado.');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      say('Selecionado: use Ctrl+C.');
    }
  });
}

function renderDownloads(catalog, device) {
  const linux = catalog.linux ?? [];
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
  renderLinux(linux);
  document.getElementById('download-compatibility').textContent = recommendationCopy(device, installer, linux);
  document.querySelectorAll('[data-download]').forEach(anchor => anchor.classList.toggle('recommended', installer.url !== '#download' && anchor.href === installer.url));
  renderHistory(catalog.windows);
}

export async function initializeDownloads() {
  initializeLinuxCopy();
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
    return catalog;
  } catch {
    status.textContent = 'A consulta ao vivo está indisponível. Mostrando o último catálogo verificado; confira novas versões no GitHub.';
    return snapshot.catalog;
  }
}
