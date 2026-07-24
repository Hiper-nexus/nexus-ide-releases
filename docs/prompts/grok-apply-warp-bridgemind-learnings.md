# Prompt para o Grok — aplicar integralmente os aprendizados de Warp e BridgeMind no Nexus IDE

Você é o principal engenheiro de produto, arquiteto de software, especialista em desktop apps, segurança e UX do Nexus IDE.

Sua missão é implementar no repositório atual do Nexus, de forma incremental e verificável, todos os aprendizados relevantes observados no Warp e no BridgeMind/BridgeSpace. Não entregue apenas um plano: inspecione, projete, implemente, teste, documente e valide cada etapa.

O resultado deve ser um Nexus mais forte em terminal, agentes, missões, memória, MCP, skills, editor, busca, Git, workspaces, segurança e experiência de uso — preservando as vantagens atuais do Nexus.

## 1. Regras não negociáveis

1. Não pule nenhum item deste prompt sem registrar explicitamente o motivo técnico, risco, dependência ou bloqueio.
2. Não faça um big-bang rewrite.
3. Não reescreva Electron/React em Rust ou crie um framework gráfico próprio.
4. Não copie código, assets, textos proprietários ou implementação do Warp/BridgeMind.
5. Use apenas as ideias, contratos e padrões de UX como inspiração clean-room.
6. O Nexus é MIT; não introduza código AGPL do Warp. O Warp tem `warpui`/`warpui_core` sob MIT e o restante sob AGPL v3.
7. Preserve todas as alterações já existentes no worktree. Nunca use `git reset --hard`, `git checkout --`, remoção destrutiva ou limpeza de arquivos do usuário.
8. Não faça push, abra PR ou altere estado remoto sem instrução explícita.
9. Não instale dependências sem verificar compatibilidade, licença, tamanho, segurança e necessidade.
10. Valide todo input externo com Zod ou equivalente.
11. Fail closed para permissões, MCP, filesystem, secrets, agentes e efeitos colaterais.
12. Toda funcionalidade nova precisa de feature flag, teste, telemetria mínima, documentação e estratégia de rollback.
13. Respeite o design reference Linear para ferramentas de desenvolvimento: densidade controlada, near-black surfaces, accent consistente, hierarquia clara, bordas hairline e animações somente em `transform`, `opacity` ou `clip-path`.
14. Nunca exponha secrets, tokens, conteúdo privado, transcript bruto ou caminhos desnecessários em logs, screenshots, testes ou relatórios.
15. Prefira muitos módulos pequenos e interfaces explícitas. Evite arquivos acima de 800 linhas e funções acima de 50 linhas.

## 2. Estado atual que você deve respeitar

O Nexus já possui uma base importante. Antes de modificar qualquer coisa, leia e entenda:

- `src/main/pty/pty-manager.ts`
- `src/main/pty/pty-host-client.ts`
- `src/main/pty/pty-host-core.ts`
- `src/renderer/terminal/terminal-output-scheduler.ts`
- `src/renderer/terminal/terminal-host.ts`
- `src/main/persistence/db.ts`
- `src/main/orch/mission-driver-runtime.ts`
- `src/main/orch/mission-driver-io.ts`
- `src/main/orch/mission-store.ts`
- `src/main/orch/mcp-dispatch.ts`
- `src/main/orch/mcp-effect-policy.ts`
- `src/main/orch/mcp-server.ts`
- `src/main/orch/skill-mirror.ts`
- `src/main/context/context-knowledge-service.ts`
- `src/main/persistence/workspace-store.ts`
- `src/main/persistence/renderer-workspace-scope.ts`
- `src/renderer/components/WorkspaceBar.tsx`
- `src/renderer/components/MissionWizard.tsx`
- `src/renderer/components/FilesPanel.tsx`
- `docs/ARCHITECTURE.md`
- `package.json`

O Nexus já tem pontos fortes que devem ser preservados:

- PTY isolado em `utilityProcess`.
- env allowlist e bloqueio de variáveis perigosas.
- ownership de sessão e replay/ACK de output.
- scheduler com prioridade de foreground, backpressure, limites de backlog e chunking ANSI-safe.
- effect policy para MCP e ferramentas.
- schemas e validação de argumentos.
- reservas duráveis e budgets de missão.
- multi-CLI, contas, failover, squads, handoffs e operação local-first.
- workspace scope e proteção contra path traversal.

Não substitua essas capacidades por uma solução genérica. Estenda-as.

## 3. Evidências que devem guiar a implementação

### Warp

O Warp ensina principalmente:

- blocos semânticos de terminal;
- shell integration com lifecycle de comando;
- editor baseado em snapshots, anchors, undo/redo e múltiplas seleções;
- busca unificada com fontes sync/async, cancelamento e ranking estável;
- índice incremental de codebase;
- eventos ordenados, cursor, reconexão e replay para agentes;
- MCP client com stdio, Streamable HTTP, SSE legado, OAuth e capability negotiation;
- perfis de permissão e isolamento;
- core de domínio reutilizável por GUI e TUI;
- feature flags por canal, presubmit, testes de integração e lock de skills.

### BridgeMind/BridgeSpace local

Foi analisado o BridgeSpace 3.4.9 instalado em `/Applications/BridgeSpace.app`.

Padrões observados:

- onboarding Start → Layout → Agents;
- seleção visual de 1, 2, 4, 6, 8, 10 ou 12 terminais;
- ações Enable all, One of each, Split evenly e Open without AI;
- presets e workspaces recentes;
- launcher separado para BridgeSpace, BridgeSwarm, BridgeBoard, BridgeMemory e BridgeSkills;
- painel contextual com Browser, Editor, Git e Skills;
- ações do terminal para handoff, worktree, Git, copy path e copy output;
- shell integration OSC 133 e OSC 9;9;
- histórico SQLite com comando, cwd, projeto, shell, exit code, duração, branch, sessão, redaction e estatísticas;
- hooks reversíveis por agente;
- reap de agentes concluídos em background;
- MCP com fonte canônica, drift, matriz por ferramenta, backup `.bak`, diff e secrets mascarados;
- catálogo de skills com descrição, categoria, fases, Copy e drag-and-drop para o terminal;
- memória local-first em Markdown com `.bridgememory/` e wikilinks;
- editor com modo leitura/renderizado e ação explícita Edit source;
- settings pesquisáveis, atalhos customizáveis e aplicação imediata;
- labels de segurança como Experimental, Official flows only, You switch e Not connected.

## 4. Fase 0 — diagnóstico obrigatório antes de editar

Execute primeiro:

1. `git status --short`.
2. `git diff --stat`.
3. `rg --files` para mapear o repositório.
4. Graphify ou análise equivalente para detectar fronteiras, ciclos, god nodes e módulos de alto acoplamento.
5. Inventário de testes, scripts, migrations, IPCs e stores.
6. Verificação de dependências e licenças.
7. Levantamento de performance atual do terminal, renderer, banco, IPC e startup.
8. Verificação do design reference `~/.design-references/linear.md` antes de alterar UI.

Crie antes da implementação um documento curto em `docs/analysis/` contendo:

- estado inicial;
- arquivos que serão alterados;
- dependências;
- riscos;
- ordem de execução;
- métricas baseline;
- itens que não podem regredir.

## 5. Fase 1 — contratos de domínio e infraestrutura comum

Antes de criar telas, extraia ou estabilize os contratos abaixo.

### 5.1 CommandBlock

Crie um modelo imutável para representar um comando:

- `id`;
- `sessionId`;
- `paneId`;
- `workspaceId`;
- `missionId` opcional;
- `command` redigido;
- `cwd` validado;
- `projectRoot`;
- `shell`;
- `gitBranch`;
- `startedAt`;
- `endedAt`;
- `durationMs`;
- `exitCode`;
- `status`;
- referência ou faixa de output;
- estado de redaction;
- hash/idempotency key.

O stream bruto do PTY continua sendo a fonte visual da verdade. O `CommandBlock` é uma camada semântica lateral.

### 5.2 Mission event journal

Crie uma tabela append-only `mission_events` com:

- sequência monotônica;
- `mission_id`;
- `run_id`;
- `parent_run_id`;
- tipo do evento;
- payload validado;
- idempotency key;
- timestamp;
- origem;
- status de entrega/ACK.

Implemente:

- append transacional;
- cursor por consumidor;
- replay;
- projeções para UI;
- recuperação após crash;
- deduplicação;
- relação pai/filho entre agentes;
- migração reversível;
- fixtures determinísticas.

Não remova a lógica atual de `effectMayHaveCommitted`, budgets ou reservas duráveis.

### 5.3 SearchMixer

Crie uma interface única de busca para:

- arquivos;
- comandos;
- símbolos;
- panes;
- missões;
- agentes;
- settings;
- skills;
- ferramentas MCP;
- workspaces;
- handoffs.

O mixer deve ter:

- debounce;
- cancelamento;
- generation counter;
- descarte de callbacks obsoletos;
- resultados parciais;
- ranking estável;
- prioridade por fonte;
- fallback local via ripgrep;
- limite de resultados;
- redaction.

### 5.4 Feature flag infrastructure

Crie flags tipadas com:

- owner;
- descrição;
- canal `dev`, `dogfood`, `preview`, `stable`;
- data de criação;
- data planejada de remoção;
- kill switch;
- telemetria;
- comportamento fail-closed.

## 6. Fase 2 — terminal semântico e histórico

Implemente:

1. Shell integration OSC 133 para zsh, bash e fish.
2. OSC de cwd seguro e validado.
3. Parser tolerante a shells sem integração.
4. Persistência de comandos em SQLite.
5. Redaction antes da gravação.
6. Denylist configurável.
7. Duração e exit code.
8. Busca por cwd, projeto, branch e comando.
9. Estatísticas de sucesso e uso.
10. Retenção, rotação e limite de tamanho.
11. Reexecução controlada.
12. Ações de copy output, copy path e attach to mission.
13. Handoff gerado a partir do bloco.
14. Criação de Git worktree relacionada ao pane.

Critérios de aceite:

- comando sem shell integration não quebra o terminal;
- secret nunca aparece em histórico ou log;
- crash não corrompe o banco;
- output continua ANSI-safe;
- comandos podem ser pesquisados por projeto;
- reexecução passa pela mesma política de segurança do terminal;
- o usuário entende claramente comando, duração e resultado.

## 7. Fase 3 — onboarding e workspace shell

Evolua o onboarding do Nexus para ter:

1. escolha de modo de trabalho;
2. escolha visual de layout;
3. distribuição de agentes;
4. preset salvo;
5. workspace recente;
6. abrir sem IA;
7. preview antes de lançar;
8. ação primária única;
9. escape claro para usuários avançados.

Não obrigue o usuário a configurar agente, MCP ou conta para abrir um terminal.

Crie uma launcher view que organize claramente:

- Terminal;
- Missions;
- Swarm;
- Board;
- Memory;
- Skills.

Mantenha uma casca compartilhada com sidebar e painel direito contextual.

## 8. Fase 4 — painel contextual unificado

Implemente tabs ou views para:

- Browser;
- Editor;
- Git;
- Skills;
- Mission;
- Handoff;
- Search.

Requisitos:

- resize por splitter;
- hide/show por atalho;
- foco de teclado previsível;
- tabs persistentes por workspace;
- estado de loading e empty state úteis;
- nenhuma permissão adicional implícita ao abrir uma tab;
- browser com allowlist, redaction e isolamento;
- nunca executar JavaScript arbitrário de agente em páginas sem aprovação explícita.

## 9. Fase 5 — editor real

Substitua o `textarea` por CodeMirror 6 ou outra solução madura avaliada formalmente.

Implemente em ordem:

1. syntax highlighting;
2. undo/redo;
3. busca e replace;
4. múltiplas seleções;
5. dirty state;
6. save e save all;
7. autosave opcional;
8. diff;
9. detecção de alteração externa;
10. limite de arquivo;
11. diagnóstico/LSP quando disponível;
12. Markdown renderizado em modo leitura;
13. ação Edit source explícita;
14. versionamento/hash para evitar sobrescrita silenciosa.

Critérios de aceite:

- abrir arquivo de 1 MB sem travar a UI;
- não perder alterações;
- não salvar fora do workspace autorizado;
- autosave reversível;
- arquivo binário e muito grande exibem explicação clara;
- editor mantém latência de digitação aceitável.

## 10. Fase 6 — MCP Hub e sincronização multi-agente

Crie um hub local que combine cliente MCP e sincronização de configuração.

Transportes desejados:

- stdio;
- Streamable HTTP;
- SSE legado apenas para compatibilidade;
- headers customizados;
- OAuth/PKCE;
- capability negotiation;
- reconnect e health status.

Também implemente uma fonte canônica local:

- importação de Claude Code, Codex, Cursor, OpenCode e outros;
- matriz servidor × ferramenta;
- detecção de drift;
- diff antes de escrever;
- backup timestamped `.bak`;
- secrets mascarados na UI;
- rollback;
- health check;
- escopo por projeto/workspace;
- política Nexus aplicada a toda chamada.

Nenhuma ferramenta MCP pode escapar de schema validation, effect policy, allowlist, auditoria ou limites de payload.

## 11. Fase 7 — skills como catálogo e sincronização

Crie uma experiência BridgeSkills para o Nexus:

- skills built-in e custom;
- categoria;
- descrição curta;
- número de fases;
- autoria e origem;
- versão/hash;
- compatibilidade por agente;
- preview do conteúdo;
- Copy;
- attach to mission;
- drag-and-drop ou ação equivalente para inserir no terminal;
- sincronização com agentes externos;
- status importable/synced/drifted;
- uninstall all com confirmação e rollback.

Crie também um lock de skills do projeto com origem, versão e digest.

## 12. Fase 8 — BridgeMemory para Nexus

Implemente memória local-first por workspace/projeto:

- diretório configurável `.nexus-memory/`;
- Markdown legível;
- wikilinks `[[...]]`;
- autocomplete;
- backlinks;
- busca;
- memória de decisão;
- memória de missão;
- memória de agente;
- retenção e redaction;
- indexação opcional em SQLite;
- exportação fácil;
- sem lock-in obrigatório em servidor.

Integre com `context-knowledge-service.ts`, mas não esconda o conteúdo em uma abstração opaca.

O usuário deve conseguir:

- pedir “lembrar isto”;
- buscar uma decisão antiga;
- anexar memória a uma missão;
- inspecionar e editar o Markdown diretamente.

## 13. Fase 9 — agentes, hooks, contas e recursos

Implemente:

- hooks reversíveis por agente;
- status instalado/não instalado;
- diff da alteração global;
- uninstall all;
- eventos de finished e needs-input;
- resume de sessão;
- isolamento de config home por conta;
- troca de conta sempre explícita;
- limite de memória/processos;
- reap de agentes finalizados em background;
- nunca matar agente em execução;
- health status por agente;
- transcript path controlado e redigido.

Contas nunca devem trocar automaticamente sem indicar claramente o perfil ativo.

## 14. Fase 10 — autonomia e isolamento

Crie perfis explícitos:

- `Inspect`: somente leitura;
- `Edit`: modifica workspace, efeitos externos pedem confirmação;
- `Autonomous`: opera em worktree/container isolado;
- `Custom`: configuração explícita por ferramenta, diretório e comando.

Cada decisão deve mostrar:

- ação;
- motivo;
- ferramenta;
- escopo;
- missão;
- perfil ativo;
- resultado;
- se o efeito pode ter sido aplicado.

Comece por Git worktree. Adicione Docker/remote como providers desacoplados.

Nunca introduza cloud secrets ou workload tokens sem necessidade clara para o produto local.

## 15. Fase 11 — observabilidade e segurança

Implemente ou valide:

- audit log append-only;
- redaction recursiva e limitada;
- nenhuma credencial em log;
- tamanho máximo de payload;
- profundidade máxima de objetos;
- rate limit de chamadas sensíveis;
- health metrics por PTY, missão, MCP e agente;
- startup/shutdown metrics;
- memória e fila do terminal;
- tempo de busca;
- tempo de abertura do editor;
- reconexão e replay;
- falhas de migration;
- erro de escrita e recuperação.

Auditoria não pode falhar silenciosamente. Se o log não puder ser escrito, a política correspondente deve definir se a ação será bloqueada.

Faça revisão específica de:

- path traversal;
- shell injection;
- command injection;
- XSS no browser/editor;
- CSRF em endpoints locais;
- MCP tool poisoning;
- prompt injection em skills, Markdown e páginas;
- secrets em histórico;
- permissões de hooks globais;
- escopo renderer → main;
- arquivos fora do workspace;
- symlinks;
- OAuth tokens;
- migrações SQLite.

## 16. Fase 12 — testes obrigatórios

Para cada feature, escreva testes antes ou junto da implementação:

- unitários;
- integração main/renderer;
- IPC com schema inválido;
- fixtures reais de PTY;
- testes de shell integration;
- crash/recovery;
- replay de eventos;
- deduplicação;
- MCP drift e rollback;
- redaction;
- Git worktree;
- hooks install/uninstall;
- skills sync;
- memória e wikilinks;
- editor com arquivo grande;
- busca cancelada e resultado obsoleto;
- segurança de browser;
- smoke test do Electron empacotado;
- E2E dos fluxos críticos.

Critérios mínimos de regressão:

- 12 panes simultâneos sem perda silenciosa de output foreground;
- terminal responsivo durante flood de output;
- missão recuperável após encerramento do app;
- MCP nunca executa ferramenta desconhecida;
- nenhum teste contém secret real;
- workspace scope nunca cruza projetos;
- migration pode ser aplicada em banco novo e antigo.

## 17. Roadmap de execução

Execute em ondas, mas não abandone os itens posteriores.

### Onda A — fundação e maior retorno

- diagnóstico e baseline;
- CommandBlock;
- OSC 133;
- command history;
- mission event journal;
- feature flags;
- onboarding;
- ações contextuais de terminal.

### Onda B — integração diária

- painel contextual;
- editor CodeMirror;
- SearchMixer;
- MCP Hub;
- drift/backup/sync;
- skills catalog;
- hooks e resume.

### Onda C — contexto e autonomia

- BridgeMemory;
- perfis de autonomia;
- Git worktree;
- isolamento provider;
- indexação incremental;
- recursos/reap de agentes;
- mobile/remote usando o mesmo journal.

### Onda D — endurecimento

- testes E2E;
- performance lab;
- crash/recovery;
- segurança;
- documentação;
- release channels;
- remoção de flags antigas;
- presubmit único.

## 18. Métricas de aceite

Registre baseline e resultado para:

- tempo até primeiro terminal;
- tempo até primeira missão;
- busca local p95;
- primeiro resultado parcial de busca;
- tempo de abertura do editor;
- latência de digitação;
- memória com 1, 4, 8 e 12 panes;
- backlog máximo por terminal;
- perda de output foreground;
- tempo de recuperação de missão;
- eventos perdidos/duplicados;
- taxa de reconhecimento de `CommandBlock`;
- tempo de sync MCP;
- número de secrets redigidos;
- tempo de attach de skill;
- tempo para criar/resumir agente;
- crash-free sessions.

Metas iniciais sugeridas:

- primeiro terminal em menos de 30 segundos;
- busca local p95 abaixo de 50 ms;
- resultados assíncronos iniciais abaixo de 500 ms;
- zero evento de missão perdido após replay;
- zero duplicação de efeito por retry;
- zero secret em histórico, log ou transcript;
- troca de painel sem travar o terminal;
- terminal foreground preservado sob carga.

## 19. Documentação obrigatória

Atualize ou crie:

- `docs/ARCHITECTURE.md`;
- `docs/SECURITY.md`;
- `docs/OPERATIONS.md`;
- `docs/MCP-HUB.md`;
- `docs/SKILLS.md`;
- `docs/MEMORY.md`;
- `docs/TERMINAL-BLOCKS.md`;
- `docs/MISSION-EVENTS.md`;
- `docs/EDITOR.md`;
- `docs/RELEASE.md`;
- changelog da versão.

Cada documento deve explicar:

- contrato;
- ownership;
- fluxo de erro;
- limites;
- migração;
- rollback;
- segurança;
- métricas;
- como testar.

## 20. Formato obrigatório de cada checkpoint

Ao concluir cada onda, entregue:

1. Resumo do que foi implementado.
2. Lista exata de arquivos modificados.
3. Testes executados e resultado.
4. Métricas comparadas com baseline.
5. Riscos restantes.
6. Itens não implementados e motivo.
7. Migrações aplicadas.
8. Feature flags ativadas.
9. Como fazer rollback.
10. Próximo checkpoint.

Não marque uma onda como concluída se algum critério de aceite estiver faltando.

## 21. Checklist final anti-omissão

Antes de declarar conclusão, responda `OK`, `PARCIAL` ou `BLOQUEADO` para cada item:

- [ ] diagnóstico do Nexus concluído;
- [ ] worktree preservado;
- [ ] CommandBlock;
- [ ] OSC 133;
- [ ] histórico com redaction;
- [ ] estatísticas e denylist;
- [ ] ações contextuais do terminal;
- [ ] mission event journal;
- [ ] replay/cursor/ACK;
- [ ] SearchMixer;
- [ ] onboarding progressivo;
- [ ] presets e workspaces recentes;
- [ ] abrir sem IA;
- [ ] launcher de modos;
- [ ] painel Browser/Editor/Git/Skills/Mission;
- [ ] editor real;
- [ ] Markdown read mode;
- [ ] MCP Hub;
- [ ] OAuth/capabilities/reconnect;
- [ ] MCP source of truth;
- [ ] drift/diff/backup/rollback;
- [ ] skills catalog;
- [ ] skills lock;
- [ ] hooks reversíveis;
- [ ] resume de agente;
- [ ] reap de agentes concluídos;
- [ ] contas isoladas;
- [ ] BridgeMemory local-first;
- [ ] wikilinks e autocomplete;
- [ ] perfis de autonomia;
- [ ] worktree isolation;
- [ ] observabilidade;
- [ ] segurança;
- [ ] migrations;
- [ ] unit tests;
- [ ] integration tests;
- [ ] E2E;
- [ ] smoke do app empacotado;
- [ ] performance budgets;
- [ ] documentação;
- [ ] changelog;
- [ ] rollback documentado;
- [ ] flags antigas removidas ou justificadas.

Se algum item estiver `PARCIAL` ou `BLOQUEADO`, explique exatamente por quê e crie a próxima ação concreta. Não esconda lacunas com linguagem genérica.

## Resultado esperado

Ao final, o Nexus deve oferecer uma experiência integrada onde:

```text
workspace
  ├─ terminal semântico
  ├─ command history
  ├─ agentes resumíveis
  ├─ missões reproduzíveis
  ├─ MCP sincronizado e governado
  ├─ skills aplicáveis em um gesto
  ├─ memória local legível
  ├─ editor real
  ├─ Git/worktree contextual
  └─ browser seguro no mesmo painel
```

Implemente tudo de forma incremental, mensurável, segura e reversível. Não entregue somente recomendações. Faça o trabalho no código e prove com testes.
