# Nexus V2 — Reescrita limpa inspirada no BridgeMind

**Status:** aprovado pelo usuário em 2026-08-07  
**Alvo observado:** BridgeSpace / BridgeMind 3.4.18  
**Decisão de plataforma:** Electron permanece; produto e autoridade de missão serão reescritos  
**Referências internas:** `DESIGN.md`, `docs/analysis/bridge-reverse-final/`, `docs/ARCHITECTURE.md`

## 1. Problema

O Nexus atual não pode ser recuperado apenas com um redesign superficial. A
interface oferece várias superfícies concorrentes para a mesma ação, e o motor
permite que representações diferentes da mesma missão discordem entre si.

A evidência direta observada na versão instalada 0.28.1 foi uma missão marcada
como `CONCLUÍDA` enquanto o plano de controle ainda mostrava uma unidade elegível
aguardando dispatch e ondas posteriores pendentes. Isso não é um defeito de
copy: é uma quebra de autoridade.

Na interface, `MissionRail`, `OpsBoard`, `OrchestrationPanel`, wizard modal,
seletor de modos e painéis contextuais competem por navegação, progresso e
controle. O resultado é alto atrito, baixa legibilidade e nenhuma superfície em
que o usuário possa confiar como verdade do sistema.

## 2. Decisão

O Nexus V2 será uma **reescrita limpa do produto e da camada de coordenação de
missões**, com corte integral das superfícies antigas depois da migração.

Não será uma migração para Tauri. O runtime Electron existente contém
infraestrutura já testada e específica deste produto: PTY em utility process,
isolamento de processo, xterm/WebGL, preload tipado, `safeStorage`, SQLite,
panes de navegador, integração com módulos Node nativos, assinatura,
notarização e gates de release. Reimplementar esses drivers não corrigiria a
causa do defeito e criaria uma segunda frente de risco.

A fronteira é explícita:

### Será reescrito

- shell visual e hierarquia de informação;
- launcher e rail de workspaces;
- criação, revisão e início de missão;
- board operacional e grafo de agentes;
- inspetor de agente, plano, chat, atividade, equipe e resultado;
- navegação entre board e terminais;
- configurações e linguagem de produto;
- fachada principal do motor de missão;
- máquina de estados e transições de missão;
- admissão, recuperação, bloqueio e conclusão;
- projeção única de estado para renderer e persistência.

### Será preservado como primitive interno

- host PTY e transporte de terminal;
- `terminal-host`, xterm e restauração de scrollback;
- preload e contratos IPC tipados;
- sandbox e fronteiras de segurança;
- split tree e persistência de layout por workspace;
- stores SQLite e secrets do sistema operacional;
- receipt físico de kickoff e ACK de handoff;
- gates de escopo, aprovação, sessão e ownership;
- MCP lease e controles de configuração sensíveis.

Preservar esses primitives não preserva o produto atual. Eles serão dependências
de baixo nível de uma aplicação nova.

## 3. Objetivos

1. Permitir que uma pessoa leiga crie e execute uma missão sem conhecer
   “orquestrador”, “receipt”, “dispatch authority”, worktree ou protocolo de
   handoff.
2. Manter uma única verdade operacional para estado, progresso, bloqueio e
   conclusão.
3. Tornar board, terminais, plano, conversa e resultado partes do mesmo fluxo,
   não produtos paralelos.
4. Retomar missões preservando os mesmos contextos e sessões dos agentes.
5. Mostrar falha e recuperação no ponto exato em que ocorreram.
6. Entregar uma composição visual próxima da estrutura observada no BridgeMind,
   mantendo nome, marca, mascote, assets e textos próprios do Nexus.
7. Remover completamente as superfícies antigas após a migração de todos os
   callers.

## 4. Não objetivos

- copiar logo, nome, ilustrações, código ou assets proprietários do BridgeMind;
- reproduzir defeitos observados no alvo, como truncamento de broadcast;
- trocar o runtime desktop apenas para aproximar a stack tecnológica do alvo;
- manter aliases, shims visuais ou rotas de compatibilidade para a UI antiga;
- expor configuração técnica no caminho principal da pessoa iniciante;
- criar novos modos de missão além do único fluxo guiado.

## 5. Princípios de produto

### 5.1 Uma ação, uma superfície

Cada intenção possui um único lugar:

- criar missão: launcher ou botão do rail;
- acompanhar missão: board;
- executar/intervir: composer e terminais;
- entender estado: inspetor;
- responder bloqueio: pergunta inline;
- configurar o produto: configurações em tela inteira.

### 5.2 Complexidade progressiva

O caminho principal pergunta somente:

1. O que a equipe deve entregar?
2. Onde ela deve trabalhar?
3. Quem deve participar?
4. Está tudo certo para iniciar?

Provider, modelo, effort, orçamento, worktree, política de aprovação, receipts e
telemetria ficam em **Avançado**. Defaults seguros devem permitir iniciar sem
abrir essa seção.

### 5.3 Estado legível

Estado nunca depende só de cor. Toda superfície usa a mesma palavra e o mesmo
sinal:

- Preparando;
- Pronta para iniciar;
- Iniciando;
- Trabalhando;
- Precisa de resposta;
- Recuperando;
- Falhou;
- Concluída.

Termos internos continuam disponíveis em detalhes técnicos, logs e diagnóstico,
mas não são a linguagem primária.

### 5.4 Conclusão é fato, não decoração

Uma missão só pode ser concluída quando o plano verificável estiver terminal e
a autoridade canônica de conclusão tiver aceitado a evidência. Uma mensagem de
agente, pane fechado, processo encerrado ou ausência temporária de fila não é
prova suficiente isoladamente.

## 6. Arquitetura de experiência

### 6.1 Shell persistente

A aplicação usa um rail esquerdo de 240 px e chrome superior mínimo.

O rail contém:

- workspaces recentes;
- missões ativas agrupadas pelo workspace;
- missões recentes concluídas;
- destinos `Quadro` e `Memória`;
- ação `Novo`;
- acesso a configurações no rodapé.

O rail não mostra XP, level, custo, provider ou detalhes de pane. Estado da
missão usa texto curto, glifo e cor semântica.

### 6.2 Launcher

Ao abrir sem destino selecionado, o conteúdo principal oferece quatro ações:

- **Abrir workspace** — terminal e arquivos do projeto;
- **Missão em equipe** — fluxo guiado de missão;
- **Quadro** — tarefas e acompanhamento manual;
- **Memória** — notas locais, busca e wikilinks.

Cada ação explica em uma frase quando usar. Não existe seletor
Autopilot/Free/Squad/PRD.

### 6.3 Configuração de missão

O setup ocupa o canvas inteiro e possui três etapas persistentes no topo.

#### Etapa 1 — Missão

Campos:

- pasta do projeto;
- texto principal “O que você quer que a equipe entregue?”;
- contexto opcional com arquivos e referências;
- seção Avançado recolhida.

A interface salva rascunho automaticamente por workspace. Sair do setup não
apaga conteúdo.

#### Etapa 2 — Equipe

Mostra uma lista de papéis compreensíveis, por exemplo:

- Coordenar e revisar;
- Implementar interface;
- Implementar motor;
- Verificar o resultado.

Cada papel pode ser expandido para provider, modelo, effort e instruções. O
sistema recomenda uma equipe mínima baseada no escopo, mas o usuário pode
remover ou adicionar papéis antes do início.

#### Etapa 3 — Revisar e iniciar

Mostra:

- entrega solicitada;
- projeto;
- equipe;
- permissões relevantes;
- riscos concretos;
- estimativa de paralelismo;
- defaults técnicos resumidos sob Avançado.

A ação primária é `Iniciar missão`. Esta ação aciona a revisão main-owned e
gera recibo auditável. Não existe aprovação escondida depois do CTA.

### 6.4 Runtime da missão

O board é a superfície canônica da missão.

Elementos:

- cabeçalho com nome, estado, duração e progresso verificável;
- ações `Terminais`, `Pausar/Parar` e `Retomar` quando aplicáveis;
- grafo central de coordenador e agentes;
- conexões que representam dependência ou handoff real;
- composer inferior com alvo `@todos` ou agente específico;
- inspetor lateral sob demanda.

Cada agente mostra nome, papel, estado, tarefa atual e tempo. Métricas técnicas
ficam no inspetor, não no card.

### 6.5 Inspetor único

O inspetor substitui `OpsBoard`, `OrchestrationPanel` e painéis contextuais
paralelos. Abas:

- **Agente** — tarefa, estado, sessão, ação segura disponível;
- **Plano** — unidades, dependências, ondas e evidência;
- **Conversa** — mensagens do operador e agentes;
- **Atividade** — eventos cronológicos normalizados;
- **Equipe** — roster e configuração efetiva;
- **Resultado** — resumo, artefatos, checks e falhas quando terminal.

Selecionar um agente no grafo abre a aba Agente. Selecionar uma unidade do plano
abre Plano. O inspetor nunca muda a autoridade; apenas projeta e solicita ações
ao motor.

### 6.6 Terminais

`Terminais` troca o canvas pelo grid real, sem abrir outro produto. O grid
preserva:

- split tree;
- foco;
- scrollback;
- sessão retomável;
- toolbar curta por pane;
- aprovação de comando visível;
- retorno ao board em um clique.

Board e terminais observam a mesma missão e o mesmo conjunto de agentes.

### 6.7 Perguntas bloqueantes

Quando um agente precisa de decisão, a missão passa atomicamente para
`Precisa de resposta` somente depois de o evento de pergunta ter sido
persistido.

A pergunta aparece:

- no card do agente;
- no topo do board;
- na aba Conversa;
- como chips de resposta quando houver opções;
- com campo livre quando necessário.

Responder persiste a decisão, envia ao contexto correto, retoma o agente e só
então retorna a missão a `Trabalhando`.

### 6.8 Conclusão e retomada

Ao concluir:

- o board permanece navegável;
- o grafo preserva a configuração final;
- Plano mostra todas as unidades terminais;
- Resultado mostra entrega, checks, artefatos e ressalvas;
- Terminais continuam inspecionáveis;
- `Retomar` reabre as mesmas sessões quando ainda válidas.

Retomar nunca cria silenciosamente uma missão nova.

## 7. Configurações

Configurações são uma página inteira com rail de seções e linhas agrupadas. A
primeira entrega contém:

- Conta e cobrança;
- Aparência;
- Terminal;
- Atalhos;
- Notificações;
- Agentes e hooks;
- MCP;
- Skills;
- Voz;
- Chaves de API;
- Sobre.

Configurações técnicas mostram estado real, origem do valor e ação de reparo.
Não usam cartões decorativos nem modais encadeados.

## 8. Sistema visual

### 8.1 Direção

O default V2 adota uma composição clara rosada inspirada na estrutura observada
no tema Pink City do BridgeMind, sem portar tokens literalmente.

- fundo claro quente e contínuo;
- rail levemente diferenciado;
- tinta escura de alto contraste;
- magenta reservado para seleção e atividade viva;
- verde, âmbar e vermelho apenas para estado;
- divisores finos em vez de pilhas de cards;
- elevação curta apenas em inspector, popover e cards do grafo.

`Nexus Dark` permanece como tema completo. A implementação atualizará
`DESIGN.md` e `base.css` para que a fonte autoritativa deixe de contradizer o
novo default aprovado.

### 8.2 Tipografia

- Inter: interface e texto;
- JetBrains Mono: dados, terminal, duração e identificadores;
- VT323: assinatura opcional e pontual do Nexus, nunca corpo de texto.

Piso de 12 px para texto de UI; texto primário normalmente 14–16 px. Ações têm
verbo e objeto em PT-BR.

### 8.3 Espaço e tamanho

- escala base de 4 px;
- alvos interativos mínimos de 32 px;
- CTA primário mínimo de 40 px;
- rail de 240 px;
- inspetor entre 360 e 440 px;
- conteúdo usa `minmax(0, 1fr)` para evitar overflow;
- janela mínima suportada: 1100 × 700;
- composição de referência e QA: 1400 × 900.

### 8.4 Motion

- feedback: 120–150 ms;
- transição de estado: 150–220 ms;
- entrada de inspector/popover: até 220 ms;
- apenas `transform` e `opacity` em movimento espacial;
- nenhuma animação em box-shadow/border de terminal;
- `prefers-reduced-motion` obrigatório.

### 8.5 Acessibilidade

- WCAG AA para texto e estado;
- foco visível instantâneo;
- navegação integral por teclado;
- ícones sem texto com `aria-label`;
- estado expresso por palavra/glifo e não só cor;
- ordem de foco equivalente à ordem visual;
- perguntas bloqueantes anunciadas por região viva sem roubar foco do terminal.

## 9. Motor de missão V2

### 9.1 Autoridade única

O main process expõe uma fachada `MissionEngine`. Renderer, scheduler, driver,
recovery e projeções não escrevem estado terminal diretamente; solicitam uma
transição à fachada.

Responsabilidades:

- validar transições;
- persistir estado e intenção atomicamente;
- controlar admissão;
- emitir eventos normalizados;
- coordenar recuperação;
- aceitar ou rejeitar conclusão;
- gerar snapshot canônico para renderer.

### 9.2 Estados canônicos

A máquina principal usa:

- `draft`;
- `review_ready`;
- `approved`;
- `starting`;
- `running`;
- `blocked_user`;
- `blocked_technical`;
- `recovering`;
- `stopping`;
- `failed`;
- `completed`.

`intent_state` deixa de ser uma segunda verdade livre. Ele passa a ser derivado
da transição aceita ou persistido na mesma transação quando necessário para
compatibilidade de store.

### 9.3 Regra única de admissão

Dispatch só pode ocorrer quando as três condições forem verdadeiras no mesmo
snapshot:

1. a missão possui autoridade de dispatch válida;
2. existe receipt de kickoff atual para a aprovação vigente;
3. o orquestrador registrado está vivo.

A ausência de qualquer condição produz um motivo explícito e uma ação de
recuperação. O scheduler não pode retornar silenciosamente.

### 9.4 Kickoff

Fluxo:

1. renderer solicita aprovação;
2. main valida plano selado e escopo;
3. missão entra em `starting`;
4. orquestrador é criado;
5. kickoff físico é enviado;
6. receipt atual é persistido;
7. liveness é confirmada;
8. missão entra em `running`;
9. scheduler recebe autorização para dispatch.

Se receipt ou liveness falharem, a missão entra em `blocked_technical` com ação
`Tentar iniciar novamente`. Nunca permanece visualmente “rodando” sem admissão.

### 9.5 Perguntas

A ordem é invariável:

1. persistir/emitir a pergunta enquanto a missão ainda está `running`;
2. confirmar que a pergunta possui destino e opções válidas;
3. transicionar atomicamente para `blocked_user`.

Essa ordem preserva o trabalho não commitado já existente e impede bloqueio sem
pergunta visível.

### 9.6 Handoff

Handoff só altera o plano depois de ACK físico. Uma mensagem textual não é ACK.
O engine registra origem, destino, unidade, sessão, receipt e timestamp. Falha
de ACK mantém ownership no agente de origem e oferece retry explícito.

### 9.7 Conclusão

Existe uma única autoridade padrão para missões guiadas. Ela exige:

- todas as unidades requeridas em estado terminal permitido;
- nenhum dispatch elegível ou em voo;
- nenhum handoff aguardando ACK;
- orquestrador com resultado final aceito;
- evidência requerida pelo plano presente;
- projeção e persistência reconciliadas na mesma transação lógica.

Timers legados e caminhos paralelos de conclusão serão removidos ou guardados
por uma única flag de runtime sem execução simultânea.

## 10. Dados e projeções

O renderer recebe um `MissionSnapshot` canônico contendo:

- identidade e workspace;
- estado e motivo;
- progresso verificável;
- roster efetivo;
- grafo de dependências/handoffs;
- agentes e sessões;
- pergunta pendente;
- eventos recentes;
- resultado terminal;
- ações atualmente permitidas.

Componentes não inferem “concluída”, “bloqueada” ou “retomável” a partir de
campos parciais. Essas capacidades vêm prontas em `allowedActions` e no estado
canônico.

Persistência continua por workspace real. `layoutWorkspacePath` permanece
diferente de `persistKey`; o V2 não mistura caminho exibido, chave de layout e
checkout de autoridade.

## 11. Fronteiras de componentes

A nova UI será dividida por responsabilidade:

- `AppShell` — janela, rail e destino principal;
- `WorkspaceRail` — workspaces, missões e destinos;
- `Launcher` — quatro entradas do produto;
- `MissionSetup` — fluxo de três etapas e rascunho;
- `MissionBoard` — projeção do grafo e estado;
- `MissionInspector` — abas de inspeção;
- `MissionComposer` — direção para equipe/agente;
- `MissionQuestion` — bloqueio e resposta;
- `TerminalWorkspace` — host visual do split tree existente;
- `SettingsWorkspace` — configurações em página inteira;
- `useMissionSnapshot` — assinatura IPC sem lógica de autoridade;
- `MissionEngine` — fachada main-owned.

Nenhum componente de produto deve ultrapassar 800 linhas. Setup, inspector e
board são compostos de unidades testáveis, não arquivos monolíticos.

## 12. Estratégia de migração e remoção

A migração será um corte vertical, não um período indefinido com duas UIs.

1. Introduzir contratos canônicos e `MissionEngine` atrás do fluxo atual.
2. Migrar todos os writers de estado para a fachada.
3. Construir o shell V2 e o setup sobre os novos contratos.
4. Construir board, inspector e composer.
5. Integrar o terminal host existente.
6. Exercitar uma missão real completa no shell V2.
7. Trocar o entrypoint para o V2.
8. Remover `MissionRail`, `OpsBoard`, `OrchestrationPanel`, wizard e seletor de
   modos antigos.
9. Remover CSS, exports, testes e flags sem caller.
10. Atualizar `DESIGN.md`, arquitetura e documentação operacional afetada.

Não haverá aliases visuais, rotas deprecated ou fallback silencioso para o
produto antigo.

## 13. Tratamento de falhas

| Falha | Estado | Superfície | Recuperação |
|---|---|---|---|
| Aprovação inválida | `review_ready` | Revisão | corrigir campo destacado |
| Spawn do orquestrador | `blocked_technical` | Board + Atividade | tentar novamente |
| Receipt de kickoff ausente | `blocked_technical` | Board + inspector | reenviar kickoff |
| Agente precisa de decisão | `blocked_user` | pergunta inline | responder e retomar |
| Handoff sem ACK | `running` com aviso | conexão + Atividade | repetir handoff |
| Sessão perdida | `recovering` | card do agente | retomar ou substituir |
| Worker falhou | `running` ou `failed` conforme plano | agente + Plano | retry/reassign |
| Persistência falhou | estado anterior preservado | banner não modal | repetir escrita |
| Conclusão rejeitada | `running` ou `blocked_technical` | Resultado + Plano | mostrar pendências |

Falhas nunca são absorvidas como sucesso visual. Mensagens devem explicar o que
aconteceu, o que foi preservado e qual ação é segura.

## 14. Segurança

A reescrita mantém as fronteiras existentes:

- renderer continua não confiável;
- IPC permanece explícito e validado;
- nenhuma credencial aparece em snapshot do renderer;
- MCP lease e bearer tokens continuam no main process;
- comandos e approvals preservam trilha auditável;
- URLs externas e panes de browser continuam sanitizados;
- scope, ownership, session e receipt fences não são relaxados para simplificar
  a UX.

A simplificação ocorre na apresentação, não removendo garantias.

## 15. Critérios de aceitação

### Produto

- Launcher apresenta os quatro destinos sem jargão interno.
- Uma nova missão pode ser configurada em três etapas sem abrir modal gigante.
- Usuário iniciante consegue iniciar usando defaults seguros.
- Board, terminal e inspector exibem a mesma missão e os mesmos agentes.
- Pergunta bloqueante pode ser respondida sem abandonar o board.
- Missão concluída permanece inspecionável e retoma sessões existentes.
- Não existem simultaneamente Rail, OpsBoard e OrchestrationPanel.
- Não existe seletor Autopilot/Free/Squad/PRD no caminho novo.

### Motor

- Dispatch sem authority, receipt ou orquestrador vivo falha visivelmente.
- Estado e intenção não divergem após crash entre escritas.
- Pergunta é observável antes de `blocked_user`.
- Handoff sem ACK não transfere ownership.
- `completed` é impossível com unidade elegível, dispatch em voo ou handoff
  pendente.
- Reabrir uma missão lê o snapshot canônico persistido.

### Qualidade

- Teste co-localizado para cada source alterado;
- `npm run typecheck` aprovado;
- testes focados de orquestração aprovados;
- `npm run security:renderer-sinks` aprovado;
- app Electron real inicia sem console error relevante;
- fluxo real seguro completa do setup à retomada;
- launcher, setup, board, terminais, inspector e settings capturados a
  1400 × 900;
- composição comparada visualmente com BridgeMind, sem uso de assets do alvo;
- navegação por teclado, foco e reduced motion verificados.

## 16. Cenário de prova end-to-end

A prova final usa um workspace descartável e uma missão segura:

1. abrir launcher;
2. escolher `Missão em equipe`;
3. selecionar workspace de prova;
4. pedir uma inspeção somente leitura com resultado verificável;
5. aceitar equipe recomendada;
6. revisar e iniciar;
7. observar approval e receipt de kickoff;
8. observar dispatch e output de agentes;
9. responder uma pergunta bloqueante controlada;
10. observar handoff com ACK;
11. verificar que conclusão só ocorre após todas as unidades terminais;
12. abrir Resultado, Plano, Conversa e Atividade;
13. alternar para Terminais e voltar ao board;
14. fechar e reabrir a missão;
15. retomar as mesmas sessões;
16. confirmar persistência do estado e ausência de split-brain.

Esse cenário, e não apenas typecheck ou screenshot, define “pronto”.
