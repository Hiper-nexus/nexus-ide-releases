import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Menu da aplicação. Até aqui o app usava o menu padrão do Electron; ele só
 * ganha uma entrada: Ajuda → "Reportar um problema…". Os demais menus são os
 * MESMOS papéis do menu padrão (App no macOS, Arquivo, Editar, Exibir, Janela),
 * então atalhos e comportamento não mudam. A entrada nova não reivindica
 * acelerador: atalho novo seria decisão de produto, e conflita com o que a
 * grade de terminais já captura.
 */

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  onReportProblem: () => void;
}

export function buildAppMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  return [
    ...(options.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Reportar um problema…',
          click: () => options.onReportProblem(),
        },
      ],
    },
  ];
}

/** Chamar depois do `ready` da app. */
export function installAppMenu(options: AppMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(options)));
}
