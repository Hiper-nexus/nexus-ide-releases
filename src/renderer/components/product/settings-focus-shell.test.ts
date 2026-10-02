import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Nas Configurações eram três colunas de navegação (rail do app com Cotas,
 * Recentes e Limpar + coluna de configurações + abas) e o conteúdo ficava com
 * ~60% da largura. O shell entra em modo foco: o rail mantém só a navegação.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const appShellCss = fs.readFileSync(path.join(root, 'styles/app-shell.css'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');

it('marks the shell as focus mode while Settings is open', () => {
  expect(appSource).toMatch(/destination\.kind === 'settings' \? 'nexus-shell--focus'/);
});

it('hides the project lists and rail utilities in focus mode, keeping the operator rail width', () => {
  expect(appShellCss).toMatch(/\.nexus-shell--focus \.workspace-rail__scroll,\s*\n\.nexus-shell--focus \.workspace-rail__utilities \{\s*display: none;/);
  // Estreitar cortava a busca e "Novo pedido" (controles com largura mínima).
  expect(appShellCss).not.toMatch(/\.nexus-shell--focus \{[^}]*--nexus-shell-rail-width/);
});
