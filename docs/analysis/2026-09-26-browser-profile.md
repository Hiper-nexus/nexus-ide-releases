# Perfil e logins do navegador Nexus

Pedido aprovado pelo operador: perfil persistente próprio do Nexus, importação
seletiva de sessões compatíveis do Chrome, acesso fácil pela barra e opção de
uso por novos navegadores dos agentes. Busca na barra: F-362.

## Comportamento

O botão **Perfil e logins** abre um painel dentro da aba. O operador escolhe
**Perfil Nexus** ou **Isolado**, um perfil do Chrome e os sites a importar.
Nenhum site vem marcado. O resultado informa os sites com dados importados e
os itens expirados/incompatíveis; não afirma que o serviço aceitou o login.

Compartilhar com novos navegadores dos agentes é uma opção explícita. O modo
inicial é gravado por pane, por isso mudar o padrão não concede os logins a
agentes já existentes. Uma escolha explícita de Isolado também é durável.

A importação nativa do Chrome nesta versão atende ao macOS e ao formato v10
compatível com Chrome Safe Storage. Só o clique de importação solicita essa
leitura do Keychain. Formatos criptográficos não suportados e cookies
particionados do Chrome são contabilizados como incompatíveis. O banco é
aberto somente para leitura, sem modificar o perfil de origem. Senhas,
extensões, Google Sync e armazenamento de sites fora dos cookies não são
importados. Sites com autenticação vinculada ao dispositivo ou a outros tipos
de armazenamento podem exigir novo login.

## Fronteiras preservadas

Cada pane conserva sua própria Session, proxy e lista de IPs autorizados.
Compartilhar diretamente uma partition do Chromium sobrescreveria callbacks
de rede por pane e misturaria essas permissões. O perfil sincroniza somente
os cookies, conservando nome, domínio, path, atributos e chave de partição.
Preferências ficam no userData; o conteúdo de sessão usa o cofre cifrado
existente, nunca JSON plano no projeto nem payload do renderer.

O protocolo Network do debugger opera na Session do alvo. Storage sem
browserContextId não foi usado: no Electron testado ele alcançava a sessão
padrão. Snapshots incluem revisões de mutação; alterações ocorridas durante
await invalidam a cópia. Logout pendente vence rotação concorrente no lote.
Remoções e atualizações são aplicadas em um único comando de cookies.

Ao trocar de workspace, a vista de saída pode terminar de guardar seus cookies
com a autoridade imutável daquele WebContents. Importação e troca de perfil
continuam conferindo o workspace ativo e a entrada exata após awaits. A troca
de perfil preserva somente os IPs já autorizados para aquele pane e seu fence
de URL, com nova validação de DNS durante a navegação.

## Evidências

- Regressões de cópia, logout, partições, conflito entre panes, mudança durante
  snapshot e falha do cofre em `browser-profile-cookies.test.ts`.
- Persistência da escolha e opt-in em `browser-personal-profile.test.ts`.
- SQLite sintético real, seleção de sites, digest de domínio do schema 24,
  validade e preservação do banco em `chrome-cookie-import.test.ts`.
- Formulário, seleção explícita e resultado parcial nos testes do renderer.
- `node scripts/check-browser-profile-electron.mjs`: duas janelas reais;
  preservação de host-only/partição, replicação e logout; sessão padrão intacta.
- `node scripts/check-browser-profile-ui.mjs`: BrowserPane/ProfilePanel reais,
  preload/IPC/Main reais, SQLite sintético do Chrome e cofre de teste. A página
  HTTP local recebeu a sessão importada; depois, Isolado manteve a página sem
  enviar aquele login. Esse check no macOS usa o SQLite compilado para Electron
  do app instalado, ou `NEXUS_BROWSER_QA_SQLITE_BINDING` explícito.
- Capturas em `docs/qa/evidence/2026-09-26-browser-profile/` mostram o painel e
  a página sintética autenticada separadamente (WebContentsView tem superfície
  própria). Nenhum cookie ou perfil real do operador foi importado nos testes.

Referências primárias: [Electron Cookies](https://www.electronjs.org/docs/latest/api/cookies),
[conversão nativa de cookies do Electron](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_cookies.cc),
[formato macOS v10 do Chromium](https://github.com/chromium/chromium/blob/130.0.6723.91/components/os_crypt/sync/os_crypt_mac.mm).
