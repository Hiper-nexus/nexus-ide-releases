import { app, autoUpdater, dialog } from 'electron';

/**
 * Auto-update via Squirrel.Mac (o MakerZIP já produz o payload). É opt-in por
 * ambiente: só arma quando EMPACOTADO e com NEXUS_UPDATE_FEED apontando para o
 * servidor de update — em dev/unsigned é no-op, nunca tenta baixar de lugar
 * nenhum. Checa no boot e a cada 6h; ao ter update pronto, oferece reiniciar.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  const feed = process.env.NEXUS_UPDATE_FEED?.trim();
  if (!feed) {
    // Sem servidor configurado ainda (SaaS não foi ao ar) — não arma nada.
    return;
  }
  try {
    autoUpdater.setFeedURL({ url: feed });
  } catch (err) {
    console.warn('[updater] setFeedURL falhou:', err);
    return;
  }

  autoUpdater.on('error', (err) =>
    console.warn('[updater] erro (ignorado):', err),
  );
  autoUpdater.on('update-downloaded', (_e, _notes, name) => {
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Reiniciar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
        title: 'Atualização pronta',
        message: `NexusIDE ${name ?? ''} foi baixado.`,
        detail: 'Reinicie para aplicar a atualização.',
        noLink: true,
      })
      .then((res) => {
        if (res.response === 0) autoUpdater.quitAndInstall();
      });
  });

  const check = () => {
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.warn('[updater] checkForUpdates falhou:', err);
    }
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();
}
