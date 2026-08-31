# Changelog

## 0.70.21 — Corrente viva

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Missões voltam a iniciar no macOS Tahoe 26.6.2. O update do sistema passou a
entregar o SIGTRAP do exec-trace como sinal fatal no detach do supervisor de
PTY — todo pane morria na hora com "processo caiu (code 133)". O supervisor
agora engole essa entrega (SIGTRAP ignorado só na janela do re-exec) e o
detach do provider selado resome antes de soltar, com retry de EBUSY.

## 0.70.20 — Sessão honesta

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

401/quota na conta 1 troca sozinho para a conta 2 com credencial pronta.
Sem toast mentiroso de “Sessão recuperada” em 1s, sem “Continue” digitado
no `/login`. + Pane com outra conta retoma a missão.

## 0.70.19 — Casa pintada

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O app inteiro sob a mesma régua: avatares, Minha Conta e voz na paleta da
casa (índigo legado, verdes Tailwind e ciano antigo saíram); espaçamentos,
fontes, raios e sombras na escala de tokens. Launcher com título hero e
ação primária de 40px, settings com hierarquia de seção, um scrim só para
⌘K, ⌘/ e overlays. Conferido tela por tela nos 5 temas e no Modo Pixel.

## 0.70.18 — Chrome da missão

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Título no rail e no quadro é curto (hostname se colar URL). Terminais
sempre no quadro, mesmo com a missão dormindo. Poll da vaga só com a
tela visível.

## 0.70.17 — Cartão da vaga

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O empty state dos Terminais é um estado curto, não o briefing.
"Missão em pausa" ou "Montando a equipe". Sem URL, sem
"Motivo não registrado".

## 0.70.16 — Título do quadro

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Header do quadro em uma linha. O cartão da vaga nos Terminais também
não pinta o briefing inteiro.

## 0.70.15 — Título do quadro

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O header do quadro não é mais o briefing inteiro. Uma linha, ellipsis;
o texto completo fica no tooltip.

## 0.70.14 — Maestro vivo

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O Maestro **não morre** quando a missão termina o turno. A CLI religa no
mesmo pane; o quadro/rail avisa. Sem mural `[nexus]` no PTY. Digitar é
ajuste, não restart.

- Worker Working depois do fim: Pronto espera handoff; interrupt só
  depois da entrega.
- Grid 2×2: spawn na caixa real, não em 80×24.
- Terminais continua no rail (0.70.13).

Gates: mission-owned-pane-policy, civilian-pronto, terminal-host,
terminal-render-policy. `tsc` limpo.

## 0.70.13 — Terminais no rail

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O grid de terminais **não se adivinha** no nome do workspace. O rail ganha
o destino **Terminais**, o inspetor ganha o botão branco, e o cartão do
agente que já tem pane abre o terminal dele.

- Header do quadro compacta junto com o grafo empilhado (título longo
  não come mais o CTA).
- ⌘K: **Terminais da missão**.

Gates: WorkspaceRail, MissionGraph, MissionInspector, App. `tsc` limpo.

## 0.70.12 — Abrir login da CLI

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O painel de contas misturava vault, sessão nativa, multi-conta e três
botões de login. Sem sessão viva agora há **um** CTA: **Abrir login da
CLI**. O clique avisa na hora, o pane nasce com título `Login Claude` e
o comando `claude auth login` só entra quando o terminal existe.

- Contas salvas não pintam **Em uso** com a CLI deslogada.
- Reserva e chip multi-conta só depois do login.
- O app Claude no Dock continua não contando.

Gates: testes de accounts-login-view, AccountsManager, login-terminal e
SettingsTerminalActions. `tsc` limpo.

## 0.70.11 — Login na CLI

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O badge **conectado** no Claude era o e-mail morto e o item do Keychain
sem token. Missão recusava o Maestro; Contas pintava verde. Agora a
CLI precisa de sessão viva. **Entrar com nova conta** sai de
Configurações e abre o terminal de `claude auth login`. O app do Dock
não conta.

- Início: **Abrir um pane** (escolhe a CLI) e **Terminal puro** (shell).
- Maestro sem sessão não senta se outra CLI está logada.
- Handoff cola no Maestro idle; PTY idle depois do CR não mata o Maestro.
- Boot Vite: watchdog 120s; identity scope em cache 60s; git timeout 30s.

Gates: testes de login-terminal, contas, idle-delivery, identity-cache,
launcher e seating. `tsc` limpo.

## 0.70.10 — Um pane por assento

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Pergunta ao time **não abre cópia**. First-wave senta o roster; spawn extra
(ad-hoc, mesmo nome, DeepSeek/Claude no lugar do Kimi) é recusado no seating.
O Maestro usa `nexus_pane_ask` nos panes já abertos.

- Handoff `queued` cola quando o Maestro idle; a bateria 2x2/3x3 viu
  `consumed` com 3 workers e zero extra.
- Pronto **não** fecha a missão.

Gates: `decideMetaPaneWorkerSpawn` + first-wave. DEV: 2x2 e 3x3 com paste
e sem pane extra.

## 0.70.9 — O time responde

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Pergunta ao time abre **um pane por integrante**, não um Codex só. O worker
entrega, o Maestro cola. Pronto do motor **não** fecha a missão — só você.

- Ditado em inglês (`they have to answer you`) ainda é pergunta a todos.
- Handoff `queued` não some no `nexus_handoff_list`; cola no Maestro idle.
- Pronto espera o paste. Shell morto e pane de outra missão saem do grid.
- Spawn de missão é sessão nova — não retoma papo velho.

Gates: testes de idle-delivery, first-wave e Pronto verdes. DEV: 5 missões
(2x2, 1+1, dois arquivos, landing, 3x3), Encerrar entre cada uma, nenhuma
fechou sozinha.

## 0.70.8 — OpenClaude no seletor

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

**OpenClaude** entra como CLI de primeira classe — Iniciar missão, + Agent,
Configurações › Provedores (CLIs e Login) e o vault de contas. No Overclock
não dava para colar como terminal customizado; aqui escolhe e instala.

- Instalar: `npm install -g @gitlawb/openclaude` (botão Instalar no hub).
- Entrar: `openclaude auth login` ou `/provider` (OpenAI, OpenRouter, Ollama).
- Sessão em `~/.openclaude`, **não** no Keychain do Claude.
- MCP no HOME real. Não é Maestro verificado.

Gates: testes das superfícies CLI/Providers verdes. Suite 11645 testes
passados. tsc limpo.

## 0.70.7 — Uma de cada vez

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O Mac não empilha 15 times. **Iniciar** estaciona as outras. **Encerrar**
vale na hora. Terminais mostra só a missão. Fechar um pane em Aguardando
você **não** reinicia o time.

- Iniciar missão: **Ditar objetivo** e Ferramenta/Modelo de cada papel.
- Hybrid `quanto é 1+1? Depois crie um site` continua missão, não resposta
  direta.
- Encerrar sem diálogo nativo — o modal preso bloqueava as outras Encerrar.
- Pane em Aguardando você / Precisa de você: fechar fecha o pane, não a
  missão.
- Título do quadro não vira `q…`.

Gates: testes do recorte verdes. DEV: 15 missões em lotes de 5, Encerrar
matou 1–2 sessões, zero revival vermelho.

## 0.70.6 — Só você encerra

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

A missão **não acaba** quando o Maestro sai do turno. O resultado aparece no
pane. **Marcar como feito** de verdade tira o Aguardando você.

- Maestro no exit 0: `resultado: …` e `a missão NÃO encerrou. Digite aqui
  para pedir um ajuste.`
- Worker: `agente entregou — a missão segue no Maestro`, não
  `turno encerrado`.
- IPC de Marcar como feito carimba missão já `done` pelo motor. Sem isso o
  chip ficava eterno em Aguardando você (visto no DEV).

A lista Atenção do 0.70.5 continua.

Gates: tsc limpo, testes do exit e do carimbo verdes. CDP: chip Pronto
depois de Marcar como feito.

## 0.70.5 — Logado some da lista

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Depois do login, a lista **Atenção** tira o card. Cursor Agent, Gemini, Muse,
omp, Qoder e Prime já tinham sessão — a lista não olhava.

- Sonda lê a sessão real dessas CLIs, não um `login-needed` eterno.
- O **Entrar** digita no shell: a CLI termina, o prompt volta, o pane
  continua. O card some no "Logged in as …" ou quando a sonda vira sessão.
- Miss de login não fica preso 60s no cache.

Gates: tsc limpo, testes da sonda e do watcher verdes.

## 0.70.4 — O ajuste segura nos dois fechos

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Review senior do 0.70.3: **Pedir um ajuste** ainda podia resecar a missão, e o
sandbox concedia o arquivo vivo do anexo.

- Hold vale no Pronto civil **e** no closer de entrega (board N/N).
- Só solta com handoff **mais novo** que o clique — a primeira mensagem
  no chat não derruba o hold.
- `extraReadPaths` de anexo: **só o selo**. O Read continua no path
  relativo do checkout.

O print único e a lista Atenção com nome da CLI vêm do 0.70.3.

Gates: tsc limpo, testes dos closers e do path do anexo verdes.

## 0.70.3 — Peça o ajuste de verdade

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Pedir um ajuste **espera você orientar**. O print colado entra **uma vez** e
o Maestro lê o arquivo do projeto. A lista Atenção diz **qual CLI** pede login.

### Pedir um ajuste não era um no-op à toa

O botão reabria `running` e o Pronto, no mesmo instante, via os handoffs
antigos e pintava de novo “Aguardando você”. Sem campo para escrever.

- Resume da revisão **segura o Pronto** até o ajuste no chat.
- O quadro abre a aba **Conversa** com o campo embaixo.
- Só depois o Maestro trabalha de novo.

### Print na tela Iniciar

- Cola no drop + na janela **não duplica** a mesma imagem.
- O kickoff manda `.nexus/attachments/mission-context/…` e pede a
  ferramenta Read — não o selo fora do checkout.

### Lista Atenção

Cards “C…” e o botão Ir virado círculo: o layout esmagava o nome da CLI.
Agora: logo, **Cursor Agent / Gemini CLI / …**, selo Login, **Entrar**
abre o login daquela ferramenta.

F-109 e o hold de ajuste. Verificado no app DEV via CDP.

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, testes focados verdes.

## 0.70.2 — O Maestro fica até você encerrar

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Quando a missão termina, o orquestrador **não some**. Quem fecha é só você.

### O bug que não saía

Sessões anteriores mudaram o recado na tela ("digite para pedir um ajuste")
mas o renderer **fechava o pane do Maestro** assim que o motor marcava
`done` e a sessão CLI já tinha saído. Sem o coordenador, não dava para
ver se deu certo nem pedir ajuste.

- Varredura `mission-terminal-cleanup` **não toca o orquestrador**.
- Header dos Terminais e o rail dizem **"Aguardando você"**, não Pronto.
- Writer ainda busy **bloqueia Pronto** (Codex "Working" não é missão
  encerrada).
- Tecla no Maestro morto **revive no mesmo pane**, não abre outro e
  aposenta este.

No quadro: **Pedir um ajuste**, **Marcar como feito**, **Remover**.

F-108. Verificado no app DEV via CDP (header, rail, pane, botões).

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, testes focados verdes.

## 0.70.1 — O router entende o que você pediu

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Sonda com **89 objetivos reais** de e-commerce, SaaS, login, pagamentos, API,
dados, mobile, marketing, infraestrutura, testes, acessibilidade, legado e
missões mistas. Encontrou **17 defeitos de roteamento** — todos corrigidos.

### A missão fazia o oposto do que você pediu

- **"analise o código e já refatore"** e **"diagnostique a lentidão e
  otimize"** entravam em modo somente-leitura: a missão era **proibida de
  consertar** o que você mandou consertar.
- **"sem alterar nada, só me diga"** e **"não mexa em nada"** não eram lidos
  como recusa — a missão **saía com permissão de escrever**.
- **"escreva o PRD"** virava implementação. Escrever um PRD é planejar.
- **"descubra o motivo"** e **"meça onde está o gargalo"** não eram
  reconhecidos como investigação.

### O produto só entendia palavra de programador

Segurança respondia a "segredo" e "credencial" — que ninguém fala. Agora
entende **"as senhas que estão no código"**, **"chaves de api"**, **"variável
de ambiente"**, **https**, **"valide os dados do formulário"**.

Em interface faltavam **formulário**, **rodapé**, **cabeçalho**, **fontes** e
**"acessível"** (só existia "acessibilidade"). *"Coloque um formulário de
contato no rodapé"* não recebia o DESIGN.md.

### Missão com mais de uma natureza

Quando o pedido tem duas metades ("construa o login **e** audite a
segurança"), a lane deixa de proibir uma delas: vence a que entrega.

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, `design-system-sensor`
0 findings, **1196/1196 arquivos e 11558/11558 testes** — incluindo a matriz
de 188 asserções que trava os 17 defeitos.

## 0.70.0 — A missão fala com você

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Auditoria senior da interface inteira pela ótica de quem **não programa**:
159 achados verificados contra o código, organizados em três ondas. Esta
versão fecha as três.

### O fim da missão finalmente responde

- **"O que mudou"** — a aba Resultado mostrava duas listas de identificadores
  em fonte monoespaçada, sem link. Agora lista os arquivos entregues, diz o
  que cada um é (página, estilo, documento…) e abre cada um com um clique.
- **"O que vamos construir"** — o plano que o motor já escrevia e selava
  nunca aparecia em tela nenhuma. Agora abre na aba Plano.
- **"Como vou saber que ficou pronto?"** — campo novo no início. A missão
  nascia sem definição de pronto.
- **"Tentar de novo"** em missão falhada. Antes a única ação era apagar.

### A missão não morre — e não ressuscita sozinha

- Concluída fica **"Aguardando você"** com **"Pedir um ajuste"** e **"Marcar
  como feito"**. Só o seu carimbo encerra.
- Abrir "Terminais" numa missão pronta **não a relança** mais.
- O coordenador continua digitável para o ajuste que a sua revisão pedir.

### Enquanto trabalha, você vê

- Sinal de progresso mesmo sem tarefas planejadas ("2 de 3 trabalhando
  agora") e a frase que faltava: **"pode fechar esta tela"**.
- A aba de abertura responde o estado: entrega no Resultado, pergunta na
  Conversa, falha na Atividade.

### O produto para de falar difícil

- Uma palavra por estado: "Pronto" é da entrega; agente parado **aguarda**.
  Havia três mapas paralelos, um com texto em inglês.
- Erro do Git vira causa e próximo passo, não `stderr`.
- A tela branca deixa de mostrar jargão como texto principal.
- Copy que mandava procurar telas inexistentes ("Operações", "Procurar")
  morreu — inclusive na doutrina do produto.

### O router entende o que você pede

- Missão de UI recebe o DESIGN.md (antes, "refaça a tela pra ficar bonita"
  saía com confiança baixa e sem doutrina).
- **"sem escrever código"** era lido como "escrever código" — planejamento
  virava implementação. Corrigido.
- Auditoria que pede conserto não cai mais em modo somente-leitura.
- Missão de segurança ganhou doutrina; o Nexus escolhe a referência de design
  em vez de mandar o agente vasculhar a pasta.

### Contas

- A segunda conta deixava de apagar a primeira; "Uso e cotas" parou de
  triplicar; Kimi logado aparecia como deslogado.

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, `design-system-sensor`
0 findings (com duas regras novas), **1195/1195 arquivos e 11364/11364
testes**.

## 0.68.5 — Duas contas, um coordenador informado

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **fix(contas): a segunda conta deixava de apagar a primeira** — o modelo
  pedia dois passos (entrar no CLI, depois salvar no Nexus) e, se você
  entrasse na 2ª conta antes de salvar a 1ª, a primeira sumia em silêncio.
  Agora a sessão é salva sozinha quando o terminal de login fecha, e entrar
  de novo na mesma conta atualiza a entrada em vez de empilhar duplicata.
- **fix(contas): "Uso e cotas" parou de triplicar** — a linha "CLI nativo"
  duplicava a conta salva (três linhas para dois assinantes). Ela agora se
  dobra para dentro da conta cujo e-mail é a sessão viva.
- **feat(contas): a tela de multi-conta ficou legível** — sem jargão de
  cofre, com o passo-a-passo à vista, selo "sessão do CLI" na conta que está
  logada agora e um aviso com botão quando a sessão atual ainda não foi
  salva. Nenhuma trava nova.
- **fix(orch): quem delega recebe a doutrina de segurança** — a nota chegava
  ao trabalhador e não ao coordenador, que é justamente quem escreve a tarefa.

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, **1190/1190 arquivos e
11329/11329 testes**.

## 0.68.4 — Porta certa e entrega que abre

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **feat(ux): o Caminho Expresso vira a porta da frente** — `beginFreshMission`
  forçava `step: 'mission'` e jogava quem não programa no wizard de 3 etapas.
  O rascunho vazio já nascia em `express`; a linha era o desvio. O caminho
  padrão cai de 7 telas / 4 decisões para 2 telas / 1 decisão. O wizard
  completo continua em "Avançado" e em ⌘K → "Missão avançada".
- **feat(ux): o objetivo escrito não é mais apagado** — as dez portas que
  chamam `beginFreshMission` preservam o texto. A ETAPA nunca é herdada: o
  "+ Novo" não reabre a Equipe da execução anterior.
- **feat(orch): a entrega abre no navegador de verdade** — abrir arquivo é
  mecânica, não inteligência. Até agora o produto só PEDIA no prompt que a
  LLM rodasse `open`. Novo `mission-deliverable-open`: no done, o main abre
  o HTML que a missão produziu — contido no workspace por `path.relative`,
  só quando o objetivo pediu navegador, uma vez por missão.
- **feat(ux): a missão não morre no done** — o pane do coordenador deixa de
  virar shell vazio quando a missão conclui: a entrega ainda espera sua
  revisão e você pode não aprovar. O banner para de prometer shell e passa a
  dizer que a missão continua aberta para ajuste.
- **fix(orch): o router reconhece a pergunta que o leigo faz** — sonda com 12
  perguntas reais: 8 viravam missão com squad. O veto por verbo de trabalho
  matava até pergunta canônica ("o que é preciso para criar um site?"). Agora
  o veto só vale na abertura imperativa, e "tem como / vale a pena / para que
  serve / não entendi / preciso saber" são reconhecidos. Zero falso-positivo.
- **fix(ui): crash de boot** — um hook declarado depois dos early returns de
  BootScreen mudava a contagem de hooks entre renders ("Rendered more hooks
  than during the previous render") e dava tela branca no primeiro boot.
- **fix(ui): copy que mandava procurar tela inexistente** — "Operações" →
  "aba Atividade", "Procurar" → "Escolher pasta", "Retomar missão" →
  "Retomar" (o rótulo real). Jargão traduzido nas 16 causas de bloqueio:
  worker → integrante, Maestro/orquestrador → coordenador, pane → janela de
  trabalho, CLI/provider → ferramenta de IA.
- **fix(ui): "Conecte um provedor" vira botão** — o pré-requisito de tudo era
  texto morto em três telas. Agora abre Providers. O Iniciar NÃO foi travado.
- **fix(ui): "Início" e "Precisa de você" no rail** — fim do beco em que
  clicar Quadro/Memória perdia para sempre a tela que abre pasta; a lista de
  atenção deixa de existir só por ⌘J.
- **fix(ui): as 11 etapas do boot da missão em português de gente** —
  `squad_sealed` → "Equipe definida", `prevc_freeze` → "Lendo o projeto".
- **fix(voice): desligar a wake word passa a gravar** — antes você desligava
  o microfone, fechava o modal no X e saía com a escuta ativa.
- **fix(ui): ActionCard volta ao DESIGN.md** — o primário derivava de
  `--accent` e o hover neutro reproduzia o repouso do primário, tornando os
  dois cartões da vaga indistinguíveis. Tokens `--text-muted` e
  `--duration-fast` eram usados 8× e nunca declarados.

- **feat(mission): a missão só encerra quando VOCÊ encerra** — o motor
  concluir deixa de encerrar a missão. Ela aparece como **"Aguardando você"**
  com **"Pedir um ajuste"** e **"Marcar como feito"**; só o seu carimbo a dá
  por concluída. "Remover" continua sempre disponível.
- **feat(orch): o coordenador continua digitável depois do done** — o pane
  dele não vira mais shell vazio quando a missão termina, e o banner deixa de
  prometer shell. Reabrir usa `resume` (decisão humana explícita); o gatilho
  mecânico segue recusando missão selada.
- **fix(router): missão de UI volta a receber DESIGN.md** — "refaça a tela pra
  ficar bonita no celular" saía com confiança baixa (faltava o verbo de
  retrabalho) e "deixa a tela mais bonita" também (traço + superfície não
  formavam quórum). Os dois agora aplicam a doutrina de design.
- **fix(router): "sem escrever código" era lido como "escrever código"** — a
  missão de planejamento virava implementação, o oposto do pedido. E
  "auditoria de segurança **e corrija**" caía em somente-leitura, proibida de
  consertar o que foi mandada consertar.
- **feat(router): o Nexus escolhe a referência de design** — em vez de mandar
  o agente vasculhar `~/.design-references`, o próprio Nexus casa o objetivo
  e nomeia o arquivo. Determinístico e mais barato em tokens.
- **feat(orch): missão de segurança ganha doutrina** — segredo nunca em
  código/log, entrada externa validada no servidor, nada de afrouxar permissão
  para "fazer funcionar", e o risco fechado nomeado no summary.
- **fix(dev): `APPLE_TEAM_ID` no shell não quebra mais o dev** — com a
  variável de release exportada no perfil, `npm start` e três suítes morriam
  em "NEXUS_MAC_PUBLISH_RELEASE must be exactly 1".

- **fix(mission): abrir Terminais numa missão pronta não a relança** — a
  missão voltava sozinha para "Trabalhando". Reabrir agora exige gesto seu
  (digitar no pane); montar o pane só mostra o histórico.
- **fix(providers): Kimi logado aparecia como não logado** — a sonda pedia
  JSON e procurava uma string que só existe na saída de texto. O formato do
  Kimi CLI 0.38 (mapa de providers, OAuth aninhado) agora é reconhecido.
- **fix(contas): duas contas do mesmo provedor eram indistinguíveis** — salvar
  a sessão sem digitar nome gravava "Conta Claude". O padrão passa a ser o
  e-mail da sessão viva.
- **fix(contas): entrar com a 2ª conta apagava a 1ª** — o CLI guarda uma
  sessão por vez e a conta só existia depois do "salvar": logar em outra
  antes de salvar perdia a primeira em silêncio (o bug "não mostra as duas
  contas"). Agora o Nexus salva a conta sozinho quando o terminal de login
  fecha; a linha da conta ganha o e-mail e um selo "sessão do CLI" diz qual
  está logada agora; re-login da mesma conta atualiza em vez de duplicar; e
  a sessão não salva aparece com aviso e botão "Salvar esta conta" — sem
  trava nova (doutrina: explicar ≠ bloquear).
- **fix(quota): limites de uso triplicavam a mesma conta** — com duas contas
  salvas, "Uso e cotas" listava "CLI nativo" + as duas contas = três linhas
  para dois assinantes. A linha nativa agora dobra para dentro da conta cujo
  e-mail é a sessão viva (sonda de login, sem tocar o Keychain na main
  thread). Copy do multi-conta sem jargão: "vault" virou Nexus, o fluxo é
  passo-a-passo explícito.

Gates: tsc limpo, `security:renderer-sinks` 0 sinks, **1190/1190 arquivos e
11317/11317 testes**, `design-system-sensor` sem findings. Verificado no app
rodando por CDP: missão real de landing criada, aberta no navegador pelo
Nexus, e o board mostrando "Aguardando você".

## 0.68.3 — Ajustes pós-done e navegador real

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **fix(orch): digitação no pane liberada no done** — o lane de entrada do
  operador aceita digitação em missões `done`. Você pode continuar conversando
  com o agente vivo para pedir refinamentos ("ajusta a cor", "adiciona X")
  sem ser bloqueado por "[nexus] o main recusou a digitação".
- **fix(orch): browser-note embutida na primeira onda** — `firstWaveWorkerPrompt`
  agora inclui a instrução de abrir com `open`/`xdg-open` antes do handoff
  quando o objetivo pedir para abrir no navegador.

Gates: tsc limpo, testes de autoridade IPC 103/103, smoke empacotado PASS.

## 0.68.2 — Orquestrador fica, navegador abre

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **fix(orch): orquestrador permanece no done** — reversão parcial do F-106
  (voo 23/08): o Maestro não morre mais no done; fica vivo como superfície
  de ajuste ("termina isso", "corrige X") até você fechar. Workers idle
  30s continuam encerrando sozinhos. Flag `missionDoneTeardown` atualizada.
- **feat(orch): 'abra no navegador' abre de verdade** — objetivos pedindo
  para abrir/mostrar no navegador agora instruem o worker a rodar
  `open <arquivo>` / `xdg-open <arquivo>` antes do handoff e citar o
  arquivo no summary. Era o que faltava para a landing do Mario Kart
  aparecer sozinha.

Gates: tsc limpo, orquestrador permanece no done 14/14, browser-note no
prompt, suite orch 3157/3157.

## 0.68.1 — Jarvis acordado

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **feat(voice): wake word ON por padrão** — "Hey Jarvis"/"Ei Jarvis"
  funciona de fábrica: detecção 100% local via onnx, sem nuvem, modelos EN +
  PT-BR instalados e validados no boot. Desligar continua um clique
  (Configurações › Voz); política de captura segue dona do kill-switch e o
  preset de ditado puro desliga o wake explicitamente.

## 0.68.0 — Fechos à prova de corrida

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **fix(orch): F-106 retry idempotente no close do done** — a corrida
  done×exit do PTY (sessão que sai no instante em que o teardown pede o
  fechamento) não trava mais o encerramento: retry com re-avaliação completa,
  QA F-106 corrigido e verificado.
- **chore(release): notary restaura o ABI do Node ao fim da cadeia** — a
  release deixava os nativos no ABI do Electron e o dev/teste local morria
  (`ERR_DLOPEN_FAILED`) até rebuild manual. Agora o próprio notary roda
  `rebuild:node` sempre, verde ou vermelha a cadeia.

Gates: tsc limpo, suíte de teardown 14/14, smoke empacotado PASS.

## 0.67.0 — Router desperto e sem fantasmas

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O router de intenção provado AO VIVO nesta máquina: com keys glm/qwen
configuradas, classificou 7/7 missões reais — pergunta pura vira resposta
direta ("15% de 800?" → **120**, sem missão nem pane), meta-de-pane vira
missão-pergunta, landing/ecommerce/bugfix viram trabalho com as skills certas
por tipo. E o fechamento de missão ficou limpo por trás:

- **feat(router): guarda determinística anti-meta-de-pane** — "pergunte aos
  panes…" com typo de ditado ("oergunta…") nunca mais pode escorregar para
  resposta direta: `isPaneMetaTask` veta ANTES do Tier 0/1, sem rede. Matriz
  de 39 casos cobrindo híbridos, acentos, injeção de skill (flag `/i`
  removida do validador) e fail-open provado em campo.
- **feat(orch): cap de effort** — orquestrador sem selo nasce `medium`, não
  herda xhigh/max da config global da CLI; selo explícito do roster sempre
  vence. Com o fix anterior de `--effort` no adapter claude, o esforço agora
  é controlável de ponta a ponta.
- **fix(orch): fantasma do watchdog enterrado** — SUCCESS físico da mesma
  sessão consome failures sintéticos 'nexus-watchdog' ainda na fila; fim da
  cobrança a worker que já respondeu.
- **feat(orch): F-106 teardown híbrido no done** — orquestrador encerra no
  done; workers idle saem em 30s, cancelados por qualquer trabalho novo;
  shells fora de missão intocados; opt-out por flag para E2E.

Gates: 11.187 testes verdes, tsc limpo, 0 sinks executáveis no renderer.

## 0.66.0 — Revisão sempre-on

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

A promessa central do plano dev-sênior (docs/PLANO-DEV-SENIOR.md) entrou no
caminho vivo: missão civil NÃO conclui mais "N/N" sem nenhuma verificação
independente — o operador leigo não valida código, então o Nexus valida.

- **feat(orch): revisão automática main-owned** — o scanner determinístico
  (`candidate-quality-v1`) roda sobre a entrega ANTES do `completeVerified`
  civil. Aprovado: evidência anexada ao resultado. Reprovado: até 2 ciclos de
  reparo com os findings entregues ao Maestro vivo; orçamento esgotado →
  bloqueio VISÍVEL com resumo em linguagem simples (Retomar e "Marcar
  concluída" seguem disponíveis — nunca trava muda). Scanner indisponível
  (workspace sem git): revisor do squad assume; sem revisor, conclui com nota
  honesta. Missões guiadas seguem no gate próprio — sem gate duplo.
- **feat(context): sensores mecânicos Nexus-owned** — `tsc --noEmit` (quando
  há tsconfig) e `npm audit --omit=dev` (quando há lockfile) rodam mesmo sem
  nenhum script no projeto-alvo. Erro de compilação = finding high;
  vulnerabilidade crítica/alta de dependência = finding security — ambos
  passam pelo mesmo fluxo reparo→bloqueio. Fail-open: ferramenta ausente,
  timeout ou registry offline é indisponível, nunca bloqueio.
- **fix(orch): kickoff meta-de-pane proporcional** — missão-pergunta aos
  panes levava doutrina pesada mandando delegar na mesma respiração em que
  mandava executar ("VOCÊ executa"): o Maestro gastava minutos reconciliando
  contradição. Agora recebe o contrato META-DE-PANE + doutrina mínima
  (espera/fecho/voz), sem plano selado redundante.

Gates da release: typecheck limpo, 11.137 testes verdes, 0 sinks executáveis
no renderer.

## 0.65.0 — Loop redondo

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O ciclo completo fechou de ponta a ponta em missões reais no dev aberto:
uma simples (consolidação de respostas entre panes) e uma complexa
(artefato físico criado, verificado por segundo agente e consolidada)
completaram sozinhas. As raízes que impediam a conclusão:

- **fix(orch): fechamento mecânico resolve a espera** — a marcação de
  "handoff pendente" no spawn vetava exatamente o fechamento que a
  resolveria: worker que não chamava `nexus_handoff_submit` ficava mudo
  para sempre (sem `[auto]`, chef-idle em loop, missão sem fim). O Stop
  com resposta honesta agora fecha; dedup segue pela janela do turno e
  pela impressão digital do Stop.
- **fix(hooks): "Aguardando você" fantasma acabou** — a notificação idle
  do CLI ("waiting for your input", ~60s após o turno) era promovida a
  `elicitation_dialog` e lacrava claude/deepseek em `awaiting-input`
  eterno (pane "Pronto" na tela, injeção vetada). Só diálogo real —
  pergunta/aprovação/ferramenta interativa — lacra.
- **fix(persistence): dev não congela mais no Keychain** — leitura fria de
  segredo no binário de dev entrava em `SecItemCopyMatching` síncrono atrás
  de prompt oculto do SecurityAgent: main, gate de hooks, supervisor,
  entregas e CDP morriam juntos e a missão parava sem UM log (F-105,
  diagnosticado com `sample`). Vault desligado por padrão no dev;
  `NEXUS_DEV_VAULT=1` para optar; empacotado intacto.
- **docs(qa): F-103 encerrado** — "+ Novo" com missão finalizada em foco
  sempre funcionou na build sã; o sintoma era o congelamento acima.
- **feat(release): nexus-notary** — um comando roda typecheck → sinks →
  build limpo assinado → notarização (perfil keychain) → staple → smoke do
  ZIP → receipt → gate do candidato.

## 0.64.0 — List é recibo

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

O que faltava para o Maestro ocupado nunca mais travar entrega:

- **feat(handoff): list = recibo** — o Maestro que chama
  `nexus_handoff_list` na PRÓPRIA missão já recebeu o conteúdo (a resposta
  carrega summary+artifacts): os handoffs pendentes listados viram
  `acknowledged` mecanicamente. Fim do "mesmo handoff antigo sendo
  redelivered" e da recuperação física pesada quando o Maestro está
  ocupado — ele lê pela via do pull (doutrina COBRANÇA) e a fila reconhece
  sozinha. Leitura cross-mission é auditoria e nunca reconhece nada;
  `consumed` continua exclusivo do nexus_handoff_ack.
- **fix(review): recibo do main vale por si** — `acknowledged`/`consumed`
  passam o gate sem exigir attempt digitado (handoff reconhecido via list
  nunca teve paste+Enter e voltava a travar em review_missing).
- **fix(delivery): nunca digitar o que o Maestro já leu** — o caminho de
  digitação re-checa o estado fresco e pula handoffs reconhecidos no
  meio-tempo.

Pendência NOMEADA para a 0.65 (não escondida): garble visual de repaint
em pane estreito (frames intercalados / payload Kitty no título) — exige
harness de repro dedicado antes de mexer no caminho mais quente do
terminal; e a flake ambiental de worktree-runtime-registry sob carga.

## 0.63.0 — O STOP é lei

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Uma única release com tudo: a 0.62.0 foi forjada e NUNCA publicada — o
gate de missão real mãos-livres achou mais quatro raízes em cima dela, e
tudo saiu junto aqui. Nove raízes cortadas ao vivo no mesmo dia:

- **fix(orch): encerrou, ficou encerrado** — retry-kickoff mecânico (tecla
  em pane morto, auto-cura de grant, watchdog) NUNCA reabre missão selada
  pelo operador; só o botão Retomar religa. Era o "encerrei todas e ele
  iniciando de novo sozinho, pane rodando por vida própria".
- **fix(orch): encarnação para TODO worker governado** — revisores e
  segunda onda nasciam sem workerIncarnationId e o fechamento mecânico
  C-194.1 recusava a entrega ("não é worker de missão"): a resposta curta
  se perdia e o Maestro esperava para sempre.
- **fix(review): revisão ENTREGUE vale sem cerimônia** — handoff
  `submitted` com prova física de aceite (paste+Enter confirmados pelo
  main) passa o gate; exigir o nexus_handoff_ack do modelo por cima
  travava missão com revisão lida. E a prova de aceite sobrevive ao
  respawn do Maestro (antes voltava a review_missing para sempre).
- **fix(review): "Nenhuma story reprovada" não é reprovação** — vereditos
  estruturados [VALIDADA]/[REPROVADA] decidem primeiro; menção negada não
  conta; o prompt do revisor formaliza os marcadores. A melhor revisão do
  voo (3/3 com HTTP 200 + Chrome + screenshot) virava rejeição eterna.
- **fix(orch): diálogo de rate-limit não congela worker** — "Switch to
  gpt-5.6-luna… Press enter to confirm or esc" mid-turn agora recebe ESC
  sozinho (mantém o modelo do OPERADOR; a ordem dos padrões garante que o
  Enter genérico nunca troque modelo por conta própria).
- **fix(orch): revisor pós-recusa não morre no registro** — remint emitia
  model:'' e o zod min(1) derrubava o loop DEPOIS do pane nascer.
- **fix(panes): diagnóstico interno não vaza pra tela** — o supervisor
  nativo só imprime "responsibility inventory incomplete" quando stderr
  NÃO é o PTY do operador.
- **fix(logs): travas se NOMEIAM** — entrega pulada diz o motivo, recusa
  de conclusão carrega missionId, linha idêntica não repete 63×.
- **ux(panes): mensagens honestas** — religar anuncia ONDE o Maestro
  abre ("em outro pane; este fica como histórico") e só APÓS o aceite;
  exit normal é 1 linha muda; resume exato vai pro log.

Validado no voo do gate (ao vivo): worker entrega → board sela → revisor
abre sozinho → reprova COM evidência forense (querySelectorAll + computed
style + screenshot pegando CSS órfão de escrita concorrente) → Maestro
cobra e despacha o conserto → worker re-entrega. Cada raiz desta lista
tem o teste com a fixture do voo real.

## 0.62.0 — O STOP é lei (interna — nunca publicada)

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Release forjada por um gate novo: missão real rodando mãos-livres em dev,
e cada travada NOMEANDO uma raiz. Cinco raízes cortadas ao vivo:

- **fix(orch): encerrou, ficou encerrado** — retry-kickoff mecânico (tecla
  em pane morto, auto-cura de grant, watchdog) NUNCA mais reabre missão
  selada pelo operador; só o botão Retomar religa. Era o "encerrei todas e
  ele iniciando de novo sozinho, pane rodando por vida própria".
- **fix(orch): encarnação para TODO worker governado** — revisores e
  segunda onda da Via Rápida nasciam sem workerIncarnationId e o
  fechamento mecânico C-194.1 recusava a entrega com "não é worker de
  missão": a resposta curta se perdia e o Maestro esperava para sempre.
  Provado ao vivo: no voo do gate só o Maestro é recusado (correto).
- **fix(review): "Nenhuma story reprovada" não é reprovação** — o parser
  de veredito lia a palavra "reprovada" sem entender negação e a MELHOR
  revisão do voo (3/3 validada com HTTP 200 + Chrome + screenshot) virava
  review_rejected em loop eterno. Vereditos estruturados
  [VALIDADA]/[REPROVADA] decidem primeiro; menção negada não conta; o
  prompt do revisor formaliza os marcadores.
- **fix(orch): revisor pós-recusa não morre no registro** — remint emitia
  model:'' e o zod min(1) do missionPanes.record derrubava o loop DEPOIS
  do pane nascer (revisor vivo, registro morto, missão presa).
- **fix(logs): travas se NOMEIAM** — entrega pulada diz o motivo
  (Maestro morto? workspace trocado?), recusa de conclusão carrega o
  missionId, e linhas idênticas não repetem 63× (dedup por
  missão/handoff/motivo). Silêncio deixou de ser diagnóstico.
- **ux(panes): tecla em pane morto só anuncia religamento APÓS o aceite**
  — nada de "revivendo…" seguido de recusa; e "sessão exata recuperada"
  virou log (só estado surpreendente fala na tela).

Validado no voo do gate (mesma release, ao vivo): worker entrega → board
sela → gate exige revisão → revisor abre sozinho → reprova COM evidência
forense (querySelectorAll + computed style + screenshot pegando CSS órfão
de escrita concorrente) → Maestro cobra o worker e despacha o conserto →
worker re-entrega. O ciclo reprovação→rework inteiro sem um toque humano.

## 0.61.0 — Herança do concorrente

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Os três candidatos herdados do overclick, voz no wizard e os cinco bugs que
o voo real de 19/08 mostrou — tudo validado ao vivo em dev antes do corte:

- **feat(review): "como confirmar" por story selada** — o revisor
  pós-recusa recebe o board com um roteiro de confirmação determinístico
  por story (mesmo texto do selo) e devolve veredito POR STORY com
  evidência citada. Feito ≠ validado.
- **feat(handoff): telemetria autorrelatada** — `telemetry: {durationMs,
  tokensTotal, tokensByModel?, estimated?}` no nexus_handoff_submit; viaja
  como metadado untrusted em artifacts (zero migração) e o Quadro mostra
  "34 min · 1.2M tokens · autorrelato N/M". Estimativa marcada; ausência
  declarada, nunca zero.
- **feat(squad): cadeias de sucessão de assento** — primário → escalação →
  piso em `shared/seat-chains`; o remint do revisor caminha a cadeia e o
  spawn-fail pode adotar a mesma regra.
- **feat(wizard): dite o objetivo por voz** — botão de microfone na etapa
  1 (mesmo pipeline do Space hold-to-talk, modo CODE/CHAT dos panes);
  enquanto o wizard está aberto, qualquer ditado vai pro campo do
  objetivo, nunca pra um pane oculto.
- **feat(orch): doutrina COBRANÇA** — modelo overclock: worker parado sem
  handoff leva nexus_pane_read + cobrança via nexus_pane_write; o Maestro
  não fica mais em "aguardando handoffs" com worker mudo.
- **fix(spawn): a seleção de modelo do operador vale** — assentos
  sintéticos/remintados não escrevem mais default hardcoded como
  req.model (grok subia em 4.5 com 4.6 configurado); a cadeia
  roster → defaultModel do provider → default do adapter decide.
- **fix(anexos): PDF/Office anexam em todo caminho** — wizard, drop em
  qualquer lugar e pane; o pane aceita QUALQUER arquivo até 14 MB;
  rejeição sempre vira toast com motivo, nunca silêncio.
- **fix(terminal): pane não abre em branco pós-corte de backlog** — o
  resync retoma no próximo ESC além do newline; TUI em alternate screen
  redesenha sem `\n` e ficava invisível.
- **fix(wizard): efforts em inglês** — Low/Medium/High/XHigh, mesmo
  vocabulário das CLIs e do rodapé do pane.

## 0.60.2 — O operador manda

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Quatro feridas do voo real de 19/08 fechadas no mesmo dia, mais o beco sem
saída que o operador flagrou na tela:

- **fix(orch): "Marcar concluída" vence o gate de revisão** — missão Parou
  0/0 ficava presa entre review_missing e nenhum botão de cancelar. A
  palavra do operador agora atravessa o gate (operatorOverride só no IPC
  main-side); o Maestro continua incapaz de se autoconcluir sem revisor.
- **fix(board): settle mecânico exige match arquivo↔story** — 7 panes
  settlavam com a mesma lista de files-modified e o board fechava N/N com
  stories sem arquivo. Conclusão física sem match não avança; o fallback
  next-open ficou exclusivo do handoff assertado pelo worker.
- **fix(inject): colagem sem prova de Enter limpa o composer** — briefing
  não ficava mais largado no input do Maestro travando a missão inteira.
- **fix(terminal): resync pós-drop de backlog** — o corte de 2 MB deixava
  o chunk seguinte começar no meio de sequência ANSI e a tela mostrava
  lixo ('(B', '1;2m', payload Kitty do grok). Pós-drop descarta até o
  próximo newline.
- **fix(ui): tecla em pane morto revive UMA vez por janela** — sem as 12
  linhas seguidas de "tecla recebida — revivendo".

## 0.60.1 — O 0.60 que funciona de verdade

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

A identidade 0.60.0 nunca virou release: o main importava 5 módulos que
ficaram presos num branch não mergeado e o build não compilava. Esta versão
completa o stack, atravessa uma missão real de 10 stories de ponta a ponta
em dev e corrige o que o voo real mostrou.

- **fix(build): stack 0.60 completo** — 9 módulos extraídos do branch
  fail-closed (maestro-boot-gate, kickoff-direct-queue, zero-delivery
  watchdog, fail-closed recovery, artifact-gate + 4 deps) com testes;
  typecheck e suíte inteira verdes.
- **fix(orch): recusa de revisão abre o revisor — nunca loop quente** —
  board N/N sem revisor virava 500+ recusas/min de completeVerified; agora
  a recusa loga 1x/60s e spawna o revisor pendente do roster.
- **fix(orch): revisor sem credencial reminta pro CLI logado** — squad do
  wizard com reviewer:cursor-agent sem login não trava mais a conclusão;
  o assento vai pro primeiro CLI com auth present.
- **fix(cli): trust prompt casa em pane estreito** — a moldura do TUI
  quebrava a frase no meio ("is this a --project you created") e o Claude
  ficava eterno no "Yes, I trust this folder"; matching compacto aceita
  automaticamente em spawn governado.
- **fix(workspace): current quarentenado degrada pro launcher** — manifesto
  com lineage divergente derrubava o hydrate inteiro; agora warn + launcher
  e recents vivos.
- **fix(voice): orb não nasce sobre o Enviar da orientação** — âncora
  padrão sobe pra dy:96; o orb continua arrastável e a preferência salva
  vence.
- **fix(security): containment por path.relative no artifact-gate** —
  startsWith(path.resolve) é bypassável por prefixo.
- **test: 24 falhas pré-existentes zeradas** — mocks do stack 0.60,
  probes reais de keychain/kimi isolados (41s→0,9s por arquivo), contrato
  novo do login operacional e ACK de 15 min do spawn.

Validação: missão real de 10 stories (wizard completo via UI) com
first-wave de 7 writers, handoffs MCP consumidos, mortalidade contada,
revive sem duplicar Maestro e Encerrar com marcadores — 2 ciclos de voo
documentados em memória; pendências conhecidas (composer do Maestro preso
em injeção não confirmada; board pode inflar antes da revisão — o gate
segura a conclusão) registradas para a próxima.

## 0.60.0 — Identidade de release

Esta entrada só fixa a identidade de versão **0.60.0** (Nexus / NexusIDE).
Não descreve features enviadas e não declara gates funcionais como
passados.

Os critérios obrigatórios antes da notarização Mac estão no checklist de
[`RELEASE-0.60.md`](RELEASE-0.60.md). Nenhum item desse checklist está
marcado como concluído aqui.

`CFBundleShortVersionString` e o payload de update (ZIP / Squirrel.Mac)
continuam derivados de `package.json` pelo Electron Forge. Não há fonte
separada `latest.yml` / `app-update.yml` no repositório. Entitlements de
hardened runtime e o perfil `nexus-notary` não mudam neste bump.

## 0.50.5 — O terminal explica

_Para atualizar: faça download do DMG/ZIP abaixo e substitua o app (feche o Nexus antes de substituir)._

Quando o app é atualizado em disco enquanto está aberto, o supervisor de
terminais recusava todo spawn com erro técnico em inglês — terminais mortos
sem instrução. A recusa continua (segurança correta: o bundle precisa ser
dono do processo vivo), mas agora o terminal orienta em português.

- **feat(board): "Limpar concluídas" no Quadro** — confirmação em dois
  cliques no cabeçalho; missão viva perde só itens concluídos, checklist de
  missão terminal/órfã sai inteiro; política no main (board-clear-plan),
  store transacional (removeItems/removeList), interface nunca decide.
- **fix(pty): erro de spawn ganha orientação acionável em PT** — bundle
  trocado com app aberto → "feche e reabra o Nexus para religar os
  terminais; a missão continua no rail"; assinatura quebrada → "reinstale
  o app". Texto técnico permanece como evidência; desconhecido segue cru.
- **feat(ptyd): Fase 0 do protocolo de posse do endpoint** — bind privado +
  link exclusivo, incumbente provado por conexão, morte provada por recusa,
  "não sei" nunca vira takeover, endpoint nunca removido no shutdown, sem
  sweeper. Fundação invisível do daemon cuja co-existência (feature.ptyd)
  vem na sequência.


## 0.50.4 — O handoff chega

Data: 2026-08-18

- **Fim do handoff que nunca chega.** Missão real do HiperGO: worker
  entrega (handoff success, `ok:true`), a entrega fica `queued` com ZERO
  tentativas — enquanto o journal registrou o orquestrador idle TODO
  MINUTO esperando workers. A causa era um aviso velho mandando no
  físico: o último evento semântico do orquestrador era "working" de
  DOIS DIAS antes (os hooks daquela sessão morreram), e ele vetava para
  sempre uma injeção que o terminal idle autorizava. Agora "working"
  só trava a entrega por 10 minutos sem nenhum evento novo — laço de
  ferramentas re-pulsa o estado; silêncio de 10 min com terminal idle é
  hook morto, e o terminal vence. Diálogo aberto (permissão/pergunta)
  continua travando em qualquer idade.
- **Re-arm da verdade durável.** A fila em memória é otimização: perde
  na troca de workspace e no authority nulo do momento do submit. O
  supervisor agora re-arma: orquestrador idle com entrega pendente no
  SQLite → re-entrega (idempotente, com janela por missão). O SQLite é
  a verdade; fila é cache.


## 0.50.3 — O Retomar retoma

Data: 2026-08-18

- **Missão encerrada volta quando você pede.** Clicar Retomar numa
  missão "Encerrada pelo operador" explodia com "Mission engine resume
  requires a technical block" — os DOIS estados em que o card oferece o
  botão eram exatamente os que o motor recusava. Reabrir agora é
  religar: o selo de encerramento sai da missão, ela volta a executar e
  a coordenação renasce com re-entrega do que estava pendente. Missão
  concluída com trabalho residual retoma pelo mesmo caminho; concluída
  COM entrega verificada segue intocada.
- **Áudio de WhatsApp cola no terminal.** Colar um áudio `.opus`
  (formato de voz de WhatsApp/Telegram) não colava NADA nem avisava — o
  paste chega sem tipo MIME e o classificador não conhecia a extensão.
  `.opus`, `.oga`, `.aiff` e `.wma` são aceitos; e arquivo recusado
  agora aparece num aviso em vez de morrer em silêncio.
- **A jornada do operador virou cenário.** O teste de sobrevivência
  provava crash e revival, mas nenhum CLIQUE: encerrar missão → Retomar
  agora é script reproduzível que asserciona o ciclo inteiro ao vivo
  (encerrada → Retomar → rodando com UM orquestrador).


## 0.50.2 — Execução instrumentada para o worker

Data: 2026-08-18

- **`nexus_terminal_run` acompanha o Bash da lane.** Worker de lane
  `[Bash, Read, Edit]` podia executar pelo Bash NATIVO mas não pela forma
  INSTRUMENTADA — aquela que o main observa, registra e confina por
  sandbox profile. O gate de evidência pedia prova justamente da coisa
  que a allowlist proibia de instrumentar (missão real: workers
  reportando "nenhum tool capaz de emitir evidence"). Agora a execução
  instrumentada é liberada sse a lane do worker libera Bash (ou é
  irrestrita); lane sem execução (consult/read-only) segue sem — nunca
  escalada silenciosa. O regime do operador/renderer (destructive gate
  exigindo contexto de missão) permanece intacto e travado em teste.
- **Spec do daemon de PTY** (`docs/architecture/pty-daemon-spec.md`): o
  destino arquitetural documentado — PTY sobrevive a quit/update, main
  re-anexa por incarnation, protocolo de posse de endpoint com as regras
  "nunca colapse não-sei em morto" e "sem sweeper". Sem efeito runtime
  nesta versão; é o contrato para o porte futuro.

## 0.50.1 — A missão termina

Data: 2026-08-18

- **Done sancionado na Via Rápida (o destravador).** O gate de conclusão
  recusava TODO `done` do Maestro em missão com squad sem contrato
  congelado — mas a Via Rápida não congela contrato nem tem dispatch
  authority POR CONSTRUÇÃO, então a missão que entregou, teve o handoff
  consumido e ack'ado pelo orquestrador ainda morria "blocked" (missão
  real: "2 handoffs success consumidos" e mesmo assim bloqueada, com o
  próprio Maestro diagnosticando o remédio na description). Agora: handoff
  success consumido/acknowledged COM aceite da sessão CORRENTE do
  orquestrador + nota durável do que foi entregue = verificação sancionada
  (na Via Rápida o ack do Maestro corrente é a autoridade — o Main
  testemunhou os dois lados). Sem aceite corrente ou sem nota: recusa
  continua, fail-closed, nunca verde silencioso.
- **Pergunta em aberto sobrevive ao rebind do orquestrador.** A pergunta
  exigia a sessão exata do orquestrador — após respawn/restart ela SUMIA
  do rail enquanto a missão seguia blocked_user esperando resposta que
  ninguém mais via (família "elicitation não respondida trava"). Agora a
  pergunta da sessão corrente ganha; sem nenhuma, a mais recente da sessão
  anterior fica visível.
- **Cerca de exclusividade com contrato travado em teste.** Liveness
  tri-state (live/exited/unverifiable) como verdade única consumida pelo
  fast-lane; o contrato da cerca — bloquear sobre qualquer sessão
  registrada, porque 'exited' sem prova física significa descendente
  destacado podendo segurar a credencial — agora está travado em teste
  com o porquê escrito. A família deadlock cerca×fast-lane não volta por
  "simplificação".
- **Cenário de sobrevivência do ciclo completo (prova).** Script
  reproduzível: crash com SIGKILL na janela entre o worker entregar e o
  orquestrador consumir → revival → re-entrega → ACK e consumo → missão
  `completed`. A queixa "missão do início ao fim" executada de ponta a
  ponta atravessando crash, verde ao vivo.

## 0.50.0 — Imbatível: a missão vai do início ao fim

Data: 2026-08-18

A campanha 0.50 nasceu da análise profunda das missões REAIS (36h de
code-review com 13 de 20 workers mortos invisíveis, entrega concluída
que morria "blocked", sentinela de HEAD disparando 8× à toa, app
empacotado sem nenhum log) cruzada com a doutrina do Overclock e as 136
releases recentes do Orca upstream. Sete correções estruturais, todas
com teste, todas mapeadas em evidência:

- **A missão não mente mais no fim.** Quit na janela do ack engolia a
  entrega final e a missão acordava "Handoff não entregue" tendo
  ENTREGUE (caso real: "consolidei os sete code reviews" → block). O
  respawn do orquestrador agora RE-ENTREGA os handoffs pendentes pela
  lane de entrega — o trabalho pronto é consumido, nunca viram block.
- **Worker morto é visível e o loop acaba.** Cada worker que morre sem
  entregar vira evento no journal (`worker-died-without-delivery`, com
  adapter e contagem) — o pós-mortem deixa de ser cego. À terceira
  morte do MESMO adapter na mesma missão, o circuit breaker recusa o
  spawn com motivo acionável e o Maestro reroteia para outro agente do
  roster. Fim do pane respawnado 6× para morrer igual.
- **Sentinela de HEAD calibrada.** Commit do trabalho da própria missão
  (headSha/baseSha do evidenceBinding) é interno e silencioso; só
  processo de fora de verdade gera o aviso que gastava turno do
  Maestro para revalidar o próprio trabalho dele (8 falsos positivos
  na missão real).
- **main.trace.ndjson — o app empacotado enxerga.** Log NDJSON
  persistido com redactor de segredos, rotação 5MB×3 e linha de boot
  por sessão. Instrumenta respawn, mortalidade, head-change e breaker.
  Na primeira noite de uso já desambiguou um diagnóstico em segundos.
- **Hang watchdog em worker thread.** Main pendurada (família keychain:
  timers mortos, IPC vivo) ganha marker em disco com a DURAÇÃO do
  hang — "app congelou" deixa de ser mistério. Sem auto-kill.
- **Missão terminal não deixa cadáver no grid.** Panes restaurados de
  missão done/failed sem sessão viva saem do layout sozinhos
  (blocked preserva o contexto para o Retomar).
- **Cenário de sobrevivência como artefato.** O bug real do operador
  (crash → revival → dois orquestradores, um travado) virou script
  reproduzível que ASSERTE NO DOM: boot → missão → SIGKILL → reboot →
  exatamente UM orquestrador vivo, zero grant expirado, zero block
  falso. Verde ao vivo, três vezes.

Base herdada da 0.32.30: um orquestrador por missão no revival, rail
multi-workspace, watchdog de orquestrador ocioso, erro real do spawn
chegando ao operador.

## 0.32.30 — Um orquestrador por missão

Data: 2026-08-17

- **Fim do pane de orquestrador morto no revival.** Reabrir o app (ou
  reviver a missão) após um crash deixava DOIS panes de orquestrador na
  tela: o novo funcionando e o restaurado da sessão anterior travado,
  com teclado morto e mensagens de "unknown or expired orchestration
  spawn grant" a cada tecla. Agora o spawn do orquestrador aposenta na
  hora os panes de orquestrador da mesma missão que não têm sessão viva
  — o main só emite o grant depois de provar o exit físico da sessão
  anterior, então qualquer outro pane do mesmo papel é cadáver por
  definição. Workers e missões vizinhas seguem intocados.
- **Tecla em pane de missão morto não tenta mais ressuscitar o grant
  morto.** Digitar num pane de missão travado disparava um respawn
  local da CLI carregando o token de spawn da sessão anterior do app —
  garantido falhar com o erro de grant expirado. O teclado agora só
  revive pela autoridade do main (que respawna o orquestrador como pane
  novo); pane avulso do operador, sem missão e sem token, continua
  religando a própria CLI na mesma conta como antes.
- **Sem falso aviso de "missão sem pane" na substituição.** Aposentar o
  cadáver para dar lugar ao sucessor não dispara mais o toast de
  "Missão continua em execução / Reabrir panes" — o pane novo nasce no
  mesmo tick.

## 0.32.29 — Nenhuma missão presa

Data: 2026-08-17

- **Fim do deadlock do revival de missão.** A cerca de exclusividade do
  pty-manager contava QUALQUER sessão registrada (inclusive em estado
  exited/hibernated) enquanto o fast-lane só considerava vivo
  busy/idle/spawning — quando os dois discordavam, todo respawn do
  orquestrador era recusado para sempre e cada tecla sua virava "revival
  da missão falhou". Agora o respawn termina as sessões registradas da
  missão com prova física ANTES de spawnar a reposição, e aborta com
  motivo acionável se um processo teimoso não provar a morte — nunca
  cria dois Maestros na mesma missão.
- **O erro real chega ao operador.** O resultado do spawn reportava um
  timeout genérico ("session did not start — adapter missing or spawn
  failed") que escondia a causa verdadeira. O erro concreto do PTY (ex.:
  a própria cerca de exclusividade) agora é propagado pelo
  orch-bridge até o main e a UI.
- **Rail multi-workspace.** Missão rodando em outro workspace era
  invisível: a seção "Em andamento" só era populada com o workspace
  corrente. Agora cada workspace conhecido com missões ativas
  (running/bloqueada/recuperando) aparece com as suas missões, com
  refresco a cada 60s; clicar numa missão de workspace vizinho troca de
  workspace e navega até ela.
- **Missão não fica órfã na troca de workspace.** Os PTYs main-owned
  sobrevivem à troca de workspace; com o deadlock do respawn resolvido e
  a visibilidade do rail, abrir um terceiro workspace não derruba nem
  esconde as missões das outras.
- **Watchdog do orquestrador ocioso.** Orquestrador idle aguardando
  workers por 30 minutos sem nenhuma mudança agora escala a missão para
  bloqueio técnico com motivo visível e acionável (o caso real passou 33
  horas em silêncio no journal sem ninguém escalar).

## 0.32.28 — Fechar sem barulho

Data: 2026-08-17

- **Fim do flood de avisos ao fechar o app com missão ativa.** Todos os
  panes morriam juntos e cada um imprimia "process exited" + "a missão
  ainda é dona deste pane" (+ toasts de incidente). Agora: um aviso
  único no grid — "encerrando o app — as missões continuam no rail e
  retomam sozinhas no próximo boot" — e os banners por pane ficam
  suprimidos no shutdown.
- **Encerrar não é falha técnica.** O guard de runtime-closed-by-operator
  do pet valia só para `blocked_user`; numa corrida de teardown com
  `blocked_technical` cada missão virava balão de falha técnica. O
  marcador `<!-- nexus:runtime-closed -->` só é escrito pelo
  encerramento do operador — presença dele em missão bloqueada é prova
  suficiente em qualquer intent (snapshot, rail e fast-lane herdam).

## 0.32.27 — MCP pela lei física do binário

Data: 2026-08-17

Achados D–H da primeira missão real (HiperGO), todos fechados.

- **MCP pela lei física do binário (grave).** Adapter de usuário com bin
  `claude` (deepseek/qwen/sakana…) contra endpoint terceiro declarava
  `nexusMcp: none` — o worker nascia SEM o MCP do Nexus e só tinha o
  bloco NEXUS_HANDOFF de texto. `canUseNexusMcp` e
  `isThirdPartyClaudeFamily` agora reconhecem `bin === 'claude'`: HOME
  isolado + `--mcp-config` + `--settings`, igual GLM.
- **Modelo não reconhecido não compacta cedo.** O ramo third-party
  exporta `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`
  (a própria CLI recomenda): deepseek-v4-pro deixa de ficar preso na
  janela 200k assumida.
- **Sentinela de HEAD (achado #14).** O lock do same-checkout só
  serializa panes da própria missão — 27 commits de outro processo
  entraram sem barreira. O watcher agora grava o HEAD no início e
  emite evento `custom` + warn quando muda por fora: o Maestro
  revalida o chão em vez de confiar em exclusividade falsa.
- **Paralelismo com inteligência.** Doutrina nova no prompt do
  orquestrador: trabalho de leitura (review/auditoria/viabilidade)
  NUNCA em série — fatiar o escopo grande e despachar os revisores no
  mesmo turno; um escritor por vez no checkout; leitor acompanha
  escritor (físico desde 0.32.26).
- **route_task explica os preferAdapters.** O preferido derrubado em
  silêncio (não instalado/reservado, fora do ranking do tier,
  preterido no multi-score) parecia preferência ignorada. O `reason`
  agora diz o destino de cada um.

## 0.32.26 — Maestro com plano de verdade

Data: 2026-08-17

Os três bugs que o próprio Maestro reportou na primeira missão real
da 0.32.24, mais o ajuste de UI pedido pelo operador.

- **nexus_task plan existe de fato.** Deadlock triplo: a description
  prometia a action, o gate de create exigia "somente UMA chamada
  nexus_task plan", mas o enum e o servidor só conheciam
  create/update/list → `unknown action: plan`. Sem plano selado não
  havia queue, ownership nem dependsOn — o Maestro improvisava na
  lista visível. Agora a action sela o plano no registro de tasks
  contra o roster real (createPlanAtomically; replay idêntico devolve
  os mesmos ids), com mapper puro que valida categoria/agente e embute
  dependsOn/executionMode/ownership como rodapé `[plan-meta]`.
- **Revisor read-only em paralelo ao executor.** same-checkout
  serializava até leitor atrás do escritor ativo. Agora spawn
  read-only é permitido ao lado do escritor (`decideSameCheckoutSpawn`);
  a doutrina "1 escritor por vez" permanece intacta.
- **CLI travada em prompt de pasta recebe Enter sozinho.** O Kimi
  pedia "Do you trust the files in this folder?" e o worker morria no
  boot esperando um Enter que nenhum humano daria (etapa 02 da missão
  HiperGO). boot-prompt-watchdog: aperta Enter em pane de missão, só
  na janela de boot (5 min), só com prompt estável por 2 ticks, máx 2
  tentativas. Pane do operador nunca é tocado.
- **Painel de detalhes da missão fecha.** Botão "detalhes ›" no canto
  do quadro esconde o menu da direita e deixa só a visão do time;
  a preferência persiste entre sessões.

## 0.32.25 — Atualização que não pendura

Data: 2026-08-17

O download de atualização ganhou progresso visível, watchdog de stall
e retry automático com fallback de fonte — rede instável não trava
mais a atualização.

- **Progresso de verdade no botão.** "baixando…" vira "baixando 42%"
  com MB no tooltip (87 MB de 216 MB). Sem mais tela congelada sem
  informação.
- **Watchdog de stall.** 90 segundos sem NENHUM byte novo aborta com
  erro claro (timer rearmado a cada chunk — mede progresso, não tempo
  de parede; o deadline total de 10min continua valendo). A madrugada
  de "baixando…" eterno acabou.
- **Retry + fallback de fonte.** Tenta o fetch público do espelho
  (observável, com progresso), cai para o gh autenticado, e ainda tem
  uma segunda tentativa completa antes de errar.

## 0.32.24 — Missão ininterrupta + troca de conta automática

Data: 2026-08-16

A missão vai do início ao fim sem travar: o watcher nunca
interrompe sozinho, respawna o orquestrador com orçamento,
o restart do app ressuscita missões running, e worker de
missão que bate limite de conta troca sozinho para a conta
reserva e continua trabalhando.

- **Missão ininterrupta (doutrina Overclock).** Todos os panes
  morrerem não fecha a missão: o orquestrador é respawnado com
  nota de continuidade (até 3 tentativas por episódio, recarregado
  por atividade real) e consome os handoffs pendentes. O watcher
  NUNCA mais bloqueia nem completa a missão sozinho — só o
  operador para.
- **Troca de conta automática em missão.** Worker de missão
  (main-owned/headless) que bate limite de quota/rate-limit/auth
  agora troca sozinho para a próxima conta do mesmo provider: o
  Main mata a sessão exausta, coloca a conta em cooldown e
  respawna o MESMO agente da MESMA missão com a conta reserva
  pinada e nota de continuidade. Cadastre 2+ contas em
  Configurações → Contas (funciona para qualquer CLI).
- **Restart não é mais zumbi.** Reabrir o app varre as missões
  running de cada escopo aberto: runtime vivo rearma o watcher,
  runtime morto respawna o orquestrador. O servidor MCP embutido
  faz bind antes de o renderer restaurar panes — acaba o
  "MCP startup interrupted: nexus_…/codex_apps" no boot.
- **Toast "Handoff não entregue" extinto na raiz.** Falha de
  entrega é transporte, não missão: vira recuperação de runtime +
  outbox. O rebind re-enfileira entregas para a sessão nova em
  vez de bloquear (fim do NEXUS_HANDOFF_REBIND_BLOCKED). E o dedup
  do fechamento mecânico C-194.1 agora conta handoffs por
  encarnação física (sobrevive a rebind de sessão) com fail-closed
  — o handoff duplicado `[auto]` que envenenava a fila de entrega
  não nasce mais.
- **Split-brain de intent curado.** Write status-only de reativação
  deixava intent `blocked_*` numa missão viva, matando
  `canDispatchWorkers` (o erro em inglês ao Enviar orientação) e
  fazendo o reconciler de 1s assassinar runtimes respawnados.
  Agora a reativação normaliza para `executing` e a orientação
  cura a linha persistida antes de recusar.
- **Cards "Interrompido" viram "Na fila".** Turno encerrado sem
  processo físico é fila para o orquestrador re-disparar —
  interrupção era o rótulo errado.
- **Tecla em pane morto religa tudo.** Digitar em pane de missão
  morta revive a missão (retry-kickoff respawna o orquestrador) e
  religa a própria CLI do pane na mesma conta.
- **Rodapé não corta mais.** O aviso de backlog apaga a linha do
  composer antes de escrever (fim do `> [Nexus skipped hidden`).
- **Aviso `loop_control` é upstream.** O próprio Kimi CLI escreve
  `max_retries_per_step` no config dele dentro do home gerenciado
  e o binário novo dele reclama. O Nexus não edita config de
  terceiro; nada quebrou.

## 0.32.23 — GLM-5.3 no z.ai

Data: 2026-08-16

O Nexus passa a oferecer o GLM-5.3 que a Z.AI lançou em
14 de agosto, e deixa de travar a missão no fim do turno:
orientação religa o Maestro, pane vazio não interrompe, e
Tentar início novamente respawna a sessão.

- **GLM-5.3 no picker.** Default do adapter GLM/z.ai.
  5.2, 4.7, 4.6 e 4.5-air continuam na lista.
- **Roteador no 5.3.** Medium, hard e critical delegam
  para `glm-5.3` em vez de `glm-5.2`.
- **Env oficial da Z.AI.** Sonnet/Opus usam `glm-5.3[1m]`
  (janela de 1M); Haiku passa a `glm-4.7`.
- **Catálogo do z.ai estava no 5.2.** O modelo novo não
  aparecia no picker nem no roteador.
- **Missão não morre no fim do turno.** Worker com exit 0
  e pane vazio não vira Interrompido nem Precisa de reparo.
  Só o operador para.
- **Handoff entregue não mente.** O Main não bloqueia a
  missão com Handoff não entregue quando o worker já
  submeteu o handoff — recupera o Maestro e mantém
  a autoridade de dispatch.
- **Tentar início novamente respawna.** O botão deixou
  de no-opar com status running sem sessão. Digitar no
  pane dispara o mesmo caminho.
- **Orientação religa o Maestro.** Enviar orientação
  (`siga` / `@todos`) respawna a sessão e o recibo de
  kickoff em vez de falhar com dispatch authority.
- **Teclado não morre no exit 0.** O pane deixa de
  hibernar e de escrever o trio dona/pausado/cursor oco.
  Digite para religar o Maestro.
- **Aviso de backlog cabe no pane.** A linha
  `Nexus skipped hidden output` não cola no prompt.

## 0.32.22 — Turno que fecha sozinho

Data: 2026-08-14

O modelo invertido do Overclock (C-194.1) aterrissa no
idioma do Nexus: quando um worker encerra o turno sem
chamar a tool de handoff, o Main entrega a resposta
verbatim ao orquestrador — o port antigo dos Stop hooks
nunca tinha rodado e saiu.

- **Fechamento mecânico de turno.** O fim de turno chega
  pelo /hook/status; o Main colhe a resposta do payload
  (fallback transcript), aplica as guardas (papel,
  origem humana, dedup por turno) e submete pela transação
  durável. Resposta curta viaja inteira; longa viaja a
  verdade com a íntegra anexada.
- **Vocabulário único.** A tool aceita os aliases
  done/error na fronteira e a doutrina passa a ensinar o
  enum canônico — worker obediente não toma mais erro de
  validação.
- **Contrato condicional.** Worker de missão com resposta
  curta não chama ferramenta nenhuma: responde e encerra.
  Contradição entre doutrina e contrato eliminada.
- **Gate não trava mais o stop.** O stop-gate virou
  observação; a garantia de entrega é do Main.
- **Limpeza dos hooks legados.** O port .mjs do Overclock
  (que nunca rodou) é removido; o boot limpa o registro
  global da 0.32.x no ~/.claude/settings.json.
- **Orquestrador sempre delega.** Nem pergunta trivial é
  respondida no pane do orquestrador: tudo vira dispatch
  de worker.
- **Enter comido tem cura.** As lanes confirmadas ganham
  prova de turno e um CR de destravamento — texto não
  fica mais preso no composer sem sinal.
- **Pane morto é morto.** Estado "exited" sobrevive à
  evicção do buffer; o watcher da Via Rápida volta a
  decidir missão sem processo vivo.

## 0.32.21 — Lata certa

Data: 2026-08-14

Gate realtime aceita XAI_API_KEY. O box mini arrasta
na OverlayLayer. Providers mostram estado e um CTA por
CLI. Claude usa `claude auth login`. A cafeína vira
lata energética que se lê como lata. O derrame no pane
é curto — 76px, sem onda do teto ao chão.

- **Grok no gate realtime.** XAI_API_KEY deixa de ser
  tratada como Gemini. Jarvis fala com a chave oficial.
- **Box mini arrasta.** O pill mora na OverlayLayer e
  o pointer não some no meio do arrasto.
- **Login das CLIs honesto.** Cada ferramenta mostra
  conectado / precisa login e um CTA por linha. Claude
  entra com `claude auth login`.
- **Lata que se lê como lata.** Xícara vira lata nossa
  no pet, no HUD e no header da Equipe — corpo, anel
  e aba. Balança e ferve.
- **Derrame curto.** O energético no pane focado cai
  76px e some. Acabou a onda do teto ao chão.
- **Sem chave visível.** Sem credencial na cadeia, o HUD
  mostra o erro e abre as configurações no clique.

## 0.32.20 — Jarvis responde

Data: 2026-08-14

Gate realtime aceita XAI_API_KEY. O box mini arrasta
na OverlayLayer. Providers mostram estado e um CTA por
CLI. Claude usa `claude auth login`. A cafeína vira
lata energética nossa.

- **Grok no gate realtime.** XAI_API_KEY deixa de ser
  tratada como Gemini. Jarvis fala com a chave oficial.
- **Box mini arrasta.** O pill mora na OverlayLayer e
  o pointer não some no meio do arrasto.
- **Login das CLIs honesto.** Cada ferramenta mostra
  conectado / precisa login e um CTA por linha. Claude
  entra com `claude auth login`.
- **Lata energética.** Xícara vira lata nossa no pet,
  no HUD e no header da Equipe — balança e ferve.
  O pane focado vê o energético entornar (filete,
  gotas, poça) e some sozinho.
- **Sem chave visível.** Sem credencial na cadeia, o HUD
  mostra o erro e abre as configurações no clique.

## 0.32.19 — Sem pane-neto

Data: 2026-08-14

Só o orquestrador spawna pane. Servidor SSH entra uma vez
pelo apelido. Cotas e ranking deixam de inventar data ou
percentagem. Memória ganha esquecer nota.

- **Sem pane-neto.** Worker não abre neto; a rodinha no TUI
  manda PageUp/PageDown; clarify vai ao seletor da CLI e
  “agora não” adia sem loop.
- **SSH pelo apelido.** O operador registra o servidor em
  Definições → Remoto. A partir daí só o apelido circula;
  IP e senha não voltam ao modelo.
- **Cotas e ranking honestos.** Tempo e percentagem só
  aparecem quando existem. Sem `Invalid Date` nem `NaN%`.
- **Memória com esquecer.** A nota vive no app, não no
  repositório. O painel deixa apagar.

## 0.32.18 — Abrir voz abre Jarvis

Data: 2026-08-14

Abrir voz abre o painel da Jarvis em vez de devolver a
missão. Vision checa permissão sem workspace. Grok realtime
reconstrói o socket quando a XAI_API_KEY muda.

- **Painel Jarvis visível.** O overlay de voz volta a ser um
  modal fixed. Sem o shell, o clique “abria” um painel invisível.
- **Grok reconhece a key.** Salvar XAI_API_KEY reconstrói o
  transporte realtime. Mudar modelo ou voz Grok também invalida
  o fingerprint.
- **Voz não devolve a missão.** O botão de voz chamava
  `backFromSettings` e caía na última tela (iniciar missão).
  Agora só abre o painel Jarvis. “Abrir voz” no fastpath faz
  o mesmo.
- **Vision sem lease de projeto.** Checar permissão, pedir
  registro no TCC e abrir Ajustes de Gravação de Tela não
  exigem workspace aberto. Captura e consentimento de nuvem
  continuam com lease.

## 0.32.17 — Pet desliga o pin

Data: 2026-08-14

A 0.32.16 escondia o pet, mas o pin
(`visibleOnAllWorkspaces` + `alwaysOnTop`) continuava na coleção de
Spaces e o WindowServer levava o app para outro desktop. Agora o
enter desliga o pin antes do `hide()`. O updater aponta
`Hiper-nexus` e mantém o slug legado.

- **Pin off no enter.** `visibleOnAllWorkspaces(false)` →
  `alwaysOnTop(false)` → `hide()`. `visibleOnFullScreen` fica sempre
  false. Silêncio latched enquanto `isFullScreen()`.
- **Leave restaura depois.** Re-pin só após ~2,6s, quando a
  animação do Space já acabou.
- **Updater na org nova.** Feed canônico `Hiper-nexus/nexus-ide`,
  com fallback no slug legado.

## 0.32.16 — Tela cheia fica

Data: 2026-08-14

Fullscreen nativo no macOS deixa de sequestrar o Space. O pet some
ao entrar e só volta depois da animação de saída. O picker da 0.32.15
(live ∪ bundled) permanece.

- **Pet some no fullscreen.** Enter esconde o companion
  (`hide-and-silence`); leave agenda re-pin só após ~2,6s. Enquanto
  o app está tela cheia no Darwin, raise/assert viram no-op.
- **Sem sequestro de Space.** O guard antigo re-pinava no enter e
  no leave (1,2s + 1,45s) e o WindowServer trocava o Space — o
  Nexus saía de primeiro plano com slide abre/fecha.

## 0.32.15 — + Novo na Missão

Data: 2026-08-13

+ Novo abre a Missão vazia, sem reidratar Equipe. O picker une o
catálogo vivo com o bundled. Cafeína em todo pet; Revisar no estilo
Bridge, com glance e Iniciar no dock.

- **+ Novo limpo.** `openNewMission` chama `beginFreshMission` e não
  passa por `open()`, que limpava o entry context e restaurava o
  rascunho do workspace (muitas vezes ainda em Equipe).
- **Picker une o catálogo.** `readyModelsForPicker` faz
  `provider.models ∪ adapter.models.list`. AGY mostra 3.7/3.1 Pro
  mesmo com cache vivo curto; Codex além de sol/sol-wm.
- **Cafeína em todo pet.** Xícara no `ChosenPetPortrait` (HUD
  compacto 12–14px) e na Equipe (64px).
- **Revisar de relance.** Glance cards, brief colapsado, Modo só
  rótulo, guidance em Mais detalhes, Iniciar no dock. Hex só via
  `--gold`/`--accent`.

## 0.32.14 — Sair sem religar

Data: 2026-08-13

Sair e encerrar processos sela as missões running antes do quit, para
o restore não religar workers. A faixa cafeinada aparece no pane vivo
focado e some em ~3s.

- **Selo no quit.** O botão "Sair e encerrar processos" chama
  `closeMissionRuntimePreservingHistory` em paralelo, com teto de 4s,
  antes de `app.quit()`. O marker `runtime-closed` impede o reopen de
  religar a frota.
- **Cafeína no pane vivo.** Derrame SVG no pane focado
  (`.spill-corner--live`), `pointer-events: none`, some em ~3s.
  Xícara do pet e flash "cafe" maiores (52px / 32px).

## 0.32.13 — Pausa honesta

Data: 2026-08-13

Sem runtime o rail deixa de mentir Trabalhando. Missão viva não
converte o pane em shell. O chrome estreito mostra o LLM; a faixa
cafeinada fica mais viva, com um derrame leve na vaga focada.

- **Rail honesto.** Status `running` no banco sem orquestrador nem
  sessão viva vira reparo (`restore-failed`), nunca Trabalhando.
- **Pane não vira shell.** `unlockRetiredMissionPane` preserva o
  agente pausado enquanto a missão está pending/running/blocked.
  Falha de IPC é fail-closed. Retomar fica no rail.
- **Modelo no chrome estreito.** Chip compacto de família/versão
  quando o badge some (< 380px). Shell puro não inventa LLM.
- **Faixa cafeinada.** Xícara maior no pet e na mesa limpa do Git;
  derrame SVG no pane vago focado, `pointer-events: none`.

## 0.32.12 — A equipe volta depois do restart

Data: 2026-08-13

Reabrir panes e o restore após restart deixam de matar Interface,
Motor e Verificar. Gemini 3.7 entra no catálogo; as CLIs que listam
modelos renovam sozinhas.

- **Reabrir panes restaura workers.** Sem incarnation no spec (comum
  depois do restart) o Main reconcilia o dispatch do pane em vez de
  falhar com `missing pane/incarnation restart authority`.
- **Teclado no pane morto.** Posse de missão não é mudez. Digitar,
  Reiniciar ou Acordar devolve um shell; a missão continua no rail.
  O coordenador não aposenta o único leaf num loop.
- **Split do operador sobrevive.** À direita / Abaixo não some quando
  a missão sincroniza a grade.
- **Gemini 3.7 Flash.** Default do AGY e da rota trivial/easy. Preço
  de introdução no ledger.
- **Descoberta viva.** Grok, AGY, Kimi, OpenCode, Cursor, Qoder, Prime
  e OMP renovam o catálogo na abertura e a cada 5 min. Claude/Codex
  seguem o cache oficial. IDs passam pelo `isModelId`.

## 0.32.11 — Encerrar não é concluir

Data: 2026-08-13

Encerrar estaciona a missão. Concluir é um ato do operador. A segunda
missão deixa a irmã viva. Anexos do cliente entram no workspace, não
no HOME.

- **N Maestros no mesmo workspace.** Exclusivo por missão. Começar a
  segunda não mata a primeira.
- **Marcar concluída.** Depois do Encerrar, o quadro oferece concluir
  pelo MissionEngine — nunca um `done` genérico. Pet não pede atenção
  em missão que o operador já estacionou.
- **Anexos do cliente.** Drop/paste de áudio, texto e imagem de fora
  copia para `{workspace}/.nexus/attachments/mission-context/`. Express
  e wizard mostram a lista. Pane aberto não volta sozinho ao Express.
- **Setup que rola.** Review, Missão, Equipe e Expresso num scroller;
  CTA Iniciar missão sticky; sem deserto preto de `100vh`.
- **Quadro com missão viva.** Running/blocked aparece em andamento
  mesmo sem tasks. Empty-state só quando não há missão nem tarefa.
- **Ranking em faixas.** Rápido / equilibrado / profundo, doutrina
  default-DOWN. Fixture não vira nota medida. Faixa só reordena modelos
  do mesmo CLI.
- **Handoff observado no PTY.** AGY e Express promovem o bloco
  `NEXUS_HANDOFF` pintado no terminal, sem esperar MCP.

## 0.32.10 — O handoff que chega

Data: 2026-08-13

O menu do pane pedia handoff pela escrita crua. O main recusa isso em
worker de missão. O toast dizia sucesso e o worker não via nada.

- **Handoff pela lane do operador.** O clique vai pelo mesmo caminho do
  teclado, com recibo. Toast de sucesso só se o main aceitar. Soltar
  skill no mesmo pane usa a mesma rota.
- **Worktree não promete checkout.** O item copia a instrução e abre a
  missão. O motor só cria o worktree depois da cola no orquestrador.

## 0.32.9 — O pin do gate

Data: 2026-08-13

A 0.32.8 notariada não passou o candidato: o npm marcou nanoid 3.3.17
hoje. O pin 3.3.18 destrava o gate. O produto é o da 0.32.8.

- **nanoid 3.3.18.** Override da toolchain; sem isso o audit do
  candidato recusa a release.
- **⌘J pede Enter de verdade.** Hooks de permissão / waiting / blocked
  alimentam a lista; o item some quando o agente segue ou o pane fecha.
  Ping no desktop na entrada.
- **release:candidate é o gate.** O alias deixou de ser o smoke do
  `.app` solto (ENOENT) e aponta assinatura, staple, smoke no ZIP e
  receipt.

## 0.32.8 — O Enter que faltava

Data: 2026-08-13

⌘J mostra quando o agente pede Enter, e o comando de candidato de
release volta a ser o gate de verdade.

- **⌘J pede Enter de verdade.** Hooks de permissão / waiting / blocked
  alimentam a lista; o item some quando o agente segue ou o pane fecha.
  Ping no desktop na entrada.
- **release:candidate é o gate.** O alias deixou de ser o smoke do
  `.app` solto (ENOENT) e aponta assinatura, staple, smoke no ZIP e
  receipt.

## 0.32.7 — O próximo passo óbvio

Data: 2026-08-13

Um botão no Git que muda sozinho, o pet cafeinado, a lista de atenção e
o login do Kimi que para de cair sozinho.

- **Botão único do Git.** Adicionar tudo → Commit → Publicar → Enviar →
  Abrir PR → Enfileirar. Título e corpo do PR saem dos commits
  (`Fixes #N` se a issue aparecer na branch).
- **Fila de PR e auto-merge.** Card no painel + tools `nexus_pr_*`.
  PR mergeado não oferece Abrir PR; PR fechado oferece um novo.
- **Pet cafeinado.** Xícara com vapor; gole na celebração; café some na
  crise. Mesa limpa no Git usa a mesma xícara.
- **Atenção e issues.** ⌘J (Enter, PR na fila, missão travada, CLI sem
  login). Começar missão a partir da issue. Comentário no diff vai ao
  agente.
- **Kimi não queima o login.** A sonda de cota não rotaciona mais o
  refresh token nativo (`Stored token for "kimi-code" was rejected`).
  AGY no mesmo contrato.

## 0.32.6 — Qualquer pane lê o outro

Data: 2026-08-12

Na mesma missão qualquer pane lê o buffer do outro — worker, sênior e
orquestrador. Paridade Overclock: `pane_read` deixa de ser cegado pelo
allowlist vazio dos workers.

- **Leitura cruzada de pane.** `nexus_pane_read` / `pane_read_many` /
  `pane_list` / `pane_whoami` são always-allowed. O operador pede “olha o
  que o pane 7 está fazendo” e o agente lê o PTY do alvo (número falado
  ou paneId).
- **Sênior e workers se enxergam.** Worker lê worker, worker lê
  orquestrador, orquestrador lê worker. Write/spawn/close no coordenador
  e o shell do usuário continuam recusados; outra missão também.
- **Allowlist vazia não cega mais.** A authz já permitia a leitura; o
  skill-gate é que escondia a tool. Filesystem sandbox intacto.

## 0.32.5 — Handoff entra; squad não cola no GLM

Data: 2026-08-12

O relatório do worker deixa de ficar no compositor sem Enter, e o roteador
passa a escolher CLI/esforço por tipo de trabalho.

- **Handoff chega com Enter.** Paste entre colchetes, 500 ms de settle e
  Enter (com retry). O dump cru no PTY do Maestro — 280 chars + “use
  nexus_handoff_list” — saiu; só o idle-delivery acorda o orquestrador.
- **Lista do Maestro vê o rastro completo.** `nexus_handoff_list` no
  orquestrador inclui entregues por padrão; `full:true` é o alias que o
  prompt já pedia.
- **Motor de especialidade + diversidade na onda.** UI, segurança, bug,
  doc e ops ganham prior heurístico e esforço mínimo. Reservas abertas da
  missão entram na contagem, então o 2º e o 3º worker não repetem o GLM
  do 1º. Slot vazio (`resources/mission-specialty-benchmark.json` e
  `~/.nexus/mission-specialty-benchmark.json`) para o benchmark Nexus.

## 0.32.4 — Concluída mostra Remover, não Encerrar

Data: 2026-08-12

Hotfix: o quadro já dizia Concluída e o botão vermelho ainda era Encerrar.

- **O estado do quadro manda no botão.** Badge Concluída vinha do snapshot;
  Encerrar olhava panes/transcript e um runtime velho no orch-store. O main
  recusa Encerrar em missão `done`. Com snapshot `completed`/`failed`, a
  ação é Remover — mesmo se a linha do orch ainda parecer viva.
- **Remover de missão concluída não trava em transcript.** Se o collapse do
  pane falha mas nenhum processo resta vivo, a remoção segue.

## 0.32.3 — Missão concluída some; + Novo começa na Missão

Data: 2026-08-12

Dois consertos de operação no board: apagar o que já terminou, e não
pular o conteúdo quando o operador pede uma missão nova.

- **Missão concluída volta a ter Remover.** `missionHasLiveRuntime` e
  `missionListAction` tratavam panes de transcript e `orchestratorSessionId`
  velho como execução viva, então a UI oferecia Encerrar. O main recusa
  Encerrar em `done`. Com status `done`, a ação é Remover.
- **+ Novo abre na etapa Missão.** `openNewMission` chama
  `beginFreshMission`, que grava rascunho vazio com `step: 'mission'`
  mesmo quando o board está aberto e o store ainda não tem
  `workspacePath`. Handoffs (ProjectOverview, Jarvis, reabrir) continuam
  em `openMissionSetup` e preservam o objetivo.
- **Toolchain: `extract-zip` vira o fork endurecido do Electron.**
  GHSA-jmr9-qjv8-65gv (symlink traversal, sem patch upstream) apareceu
  no audit depois da 0.32.2. Override aponta `extract-zip` para
  `@electron-internal/extract-zip@1.0.4`, já usado pelo próprio
  `electron`. Só afeta o packager na máquina de build.

## 0.32.2 — Paralelismo read-only + hooks de handoff funcionais

Data: 2026-08-12

Três correções que destravam fan-out de leitura e restauram a entrega de
handoff. Mesma campanha: read-only era tratado como escritor em duas gates,
e os hooks de handoff nunca rodaram desde o commit `f6a3c5f3` (shebang com
placeholder não interpolado).

- **Paralelismo read-only destravado.** `activeSameCheckoutWorker`
  (`tools-panes.ts:173`) agora exclui panes `readOnly`/`nativeReadOnly` do
  filtro serializador. Um fan-out de leitura (mapa de viabilidade +
  auditoria cética) não fica mais serializado como se fosse escrita
  concorrente. Espelha o guard de disjointness em `mission-wave-pack.ts:392`.
- **Gate de mutação respeita read-only.** `assertMutationAllowed`
  (`context-workflow-service.ts:1955`) recebe `callerReadOnly` e faz
  short-circuit nas guards de contract/stage — read-only não escreve.
  Proteções que valem para qualquer caller (`.context/` read-only,
  merge-queue) permanecem para read-only.
- **Hooks de handoff interpolam o node path.** `handoff-stop.mjs`,
  `handoff-deliver.mjs`, `soft-status.mjs` tinham `exec process.execPath`
  como literal desde `f6a3c5f3`. Installer (`handoff-hook-installer.ts`)
  agora interpola o caminho absoluto do node em runtime, espelhando o
  sidecar do Overclock; em produção envolve com `ELECTRON_RUN_AS_NODE=1`.

## 0.32.1 — Watcher: panes fechados detectados na hora

Data: 2026-08-12

Mesmas melhorias da 0.32.0 com o fix crítico do watcher:
zero panes vivos na missão → avalia handoffs e conclui/bloqueia
imediatamente. Sem esperar 30 minutos de timeout.

## 0.32.0 — Motor limpo, paridade total

Data: 2026-08-12

Reescrita completa do motor de execução de missão com padrão de coordenação
via MCP. A Via Rápida spawna só o orquestrador; workers são invocados sob
demanda. Prompt entregue no argv de nascença para todas as CLIs. Hooks de
handoff com auto-entrega e fallback mecânico.

- **Motor limpo.** tickRun, wasBusy, markerObserver, nudge, respawn, settlement
  removidos. 590 linhas (era 989). Orquestrador coordena via nexus_pane_spawn,
  nexus_handoff_list, nexus_mission_set_status.
- **Prompt-at-birth.** Prompt no argv de nascença para TODAS as CLIs. Zero
  timing race, zero paste pós-boot.
- **Resume de worker.** nexus_pane_spawn({resume: "h-N"|"pane-N"}) retoma
  worker fechado com contexto intacto.
- **pane_wait_idle.** 15s cap, boot confirmation only. Nunca para esperar
  resultado de worker.
- **Watcher com handoff_list.** Se orquestrador morrer, engine avalia handoffs
  dos workers para decidir sucesso ou bloqueio.
- **Hooks de handoff.** handoff-stop.mjs, handoff-deliver.mjs, soft-status.mjs
  instalados automaticamente no bootstrap.
- **Worker com auto-entrega.** ≤280 caracteres = entrega verbatim automática.
  >280 = chama nexus_handoff_submit. PRONTO/BLOQUEADO removido do prompt.

## 0.31.4 — Expresso, sem regressões

Data: 2026-08-12

Reconstruído da baseline 0.31.1 + Expresso + P0-1/P0-2 + wasBusy fix + update
chip fix. Os 9 commits da sessão paralela foram removidos — eram eles que
causavam loop de respawn e conclusão falsa da missão.

- **Missão não conclui mais antes de trabalhar.** wasBusy só conta atividade
  depois que o prompt foi entregue.
- **Chip de versão nunca mais some.** Fallback offline com CURRENT_RELEASE.
- **Sem loop de respawn.** Revertido o refactor de entrega de prompt.

## 0.31.1 — A porta de atualizar voltou

Data: 2026-08-11

Hotfix de um buraco que passou despercebido por dez dias: **o app ficou sem
nenhuma superfície de atualização**. O commit `5a6cb8b8` (01/08, "harden mission
validation and pane UX") removeu `<UpdateNotifier alwaysVisible />` do `App.tsx`
e ninguém remontou; a composição sumiu junto, deixando no `UpdateModal.tsx` só
as peças soltas — hook de estado, chip e painel — sem nenhum consumidor. O motor
de update no main sempre esteve vivo; o que faltava era a porta. As releases
0.30.0 e 0.31.0 saíram assim.

- O chip voltou ao **cabeçalho** (com workspace aberto) e ao **launcher** — que
  é exatamente onde se chega para atualizar.
- Voltou como **componente único** (`UpdateNotifier`), para não depender de
  alguém lembrar de montar as três peças na mão.
- Persistência de sessão via tmux endurecida: nome por hash, skip sob sandbox e
  flag desligada por padrão (frente de paridade, ainda opt-in).

## 0.31.0 — A frota inteira na mão: login, "+ Pane" e panes com nome

Data: 2026-08-10

A 0.30.0 fez a missão começar e terminar. Esta fecha a operação em volta dela:
a frota de CLIs do operador reconhecida e logável de dentro do app, um jeito de
abrir qualquer ferramenta no meio do trabalho, panes que dá para chamar pelo
nome, e o MCP que você sincroniza finalmente chegando dentro do terminal do
agente.

### Operação da frota

- **18 CLIs reconhecidas**, cada uma com marca própria no lugar da inicial em
  caixa cinza. Adapters do operador vivem em `~/.nexus/plugins/adapters/` e
  sobrevivem a atualização do app.
- **Login pelo cartão**: a CLI que ainda não autenticou mostra "entrar"; o
  Nexus abre um terminal e roda o comando de login DELA (`codex login`,
  `opencode auth login`, `cursor-agent login`, `qwen`, `gemini`…). Nenhuma
  credencial passa pelo Nexus; quando aquele terminal fecha, o painel
  reexamina as CLIs sozinho.
- **Cada CLI entra no modo de operação livre que ela documenta** — a flag real
  de cada ferramenta, lida do `--help` dela. Onde a CLI não tem flag (qwen,
  prime-agent), o campo fica vazio em vez de inventar.
- **"+ Pane"**: botão na grelha abre terminal, browser ou qualquer CLI
  instalada, escolhendo conta e modelo na hora, com filtro por texto.

### Panes com nome

- Cada pane ganhou **nome curto e falável** (`pane 7`), estável entre
  reinícios, reusando o menor número livre. O número é endereço ADICIONAL: o
  id continua sendo a identidade em layout, PTY, missão e protocolo.
- Voz e comandos aceitam "pane 7", "pane sete", "no pane 7". Número ambíguo
  **recusa dizendo quais valem**, em vez de mandar trabalho para o pane errado.

### Missão

- **Fim do trabalho refeito em loop**: o motor lê o `PRONTO:` do próprio
  agente em vez de depender só do estado do terminal, e a recarga de prompt
  tem teto. CLI que entrega sem nunca ficar "ocupada" não é mais cutucada para
  refazer tudo. `BLOQUEADO:` carrega a frase do agente para o bloqueio.
- **Missão agendada voltou a partir**: toda ocorrência de cron morria exigindo
  um selo de revisão que só a aprovação humana carimbava.
- **Telas de primeiro run** (confiança no diretório, consentimento de dados,
  migração de CLI) são respondidas na largada. O "sim" só sai quando o
  diretório impresso é o da própria missão; consentimento e migração são
  ADIADOS, nunca aceitos.
- Coordenação AGY não larga mais em modo one-shot (`--print` fechava o pane
  antes de coordenar).
- CLI sem catálogo declarado não bloqueia mais "Adicionar papel".

### MCP

- **O hub deixou de ser registro morto**: os servidores sincronizados entram na
  configuração por sessão do pane (claude/glm/longcat, codex, opencode, kimi,
  grok) sem afrouxar o isolamento de missão.
- **Sync não sobrescreve mais o que não conseguiu ler**: config existente que o
  leitor recusava virava "vazia" e era substituída sem backup.

### Vindo da paridade Overclock

- Chip CODE/CHAT sempre visível na barra superior e modo code do ditado.
- Modo livre de agentes ao iniciar missão.
- Promover qualquer pane a orquestrador da missão.
- Doutrina de orquestração e playbook do squad no prompt de largada.

## 0.30.0 — Via Rápida: missão que começa e TERMINA

Data: 2026-08-10

O motor de execução de missão foi substituído. O pipeline cerimonial (plano
selado → claim → kickoff → receipts → merge queue → autoridade de conclusão)
saiu do caminho padrão e do código; entrou a **Via Rápida**: um terminal
interativo por agente, direto no workspace, prompt curto, conclusão observada.

### Missão real, medida nesta máquina

- Criar missão pela UI → equipe → iniciar → terminais visíveis → artefato
  correto → `Concluída` sozinha: **~90 segundos** (antes: 32 minutos no gate).
- Frota de 8 panes / 6 providers (claude, agy, codex, glm, kimi, grok)
  construiu um site de 11 stories se auto-dividindo por um arquivo de
  coordenação — cada story marcada pelo agente que a implementou.
- Retomar religa a equipe adotando panes vivos (nunca duplica sessão de auth
  exclusiva) e o observador fecha a missão quando todos assentam.

### Prontidão deixou de ser gate

- CLI instalada e não desligada participa — como coordenação e como execução.
  O "a ferramenta escolhida não está pronta" com binário logado morreu.
- Auth é conversa do terminal do agente (login aparece no pane, como em
  qualquer terminal). O diálogo de primeiro boot pedindo para editar
  `~/.claude/settings.json` (hooks de status) não é mais necessário para
  missão.
- No approve só resta forma: exatamente um Maestro.

### Operador no comando

- Terminais da equipe aparecem no grid como panes reais: clique e digite
  direto no agente (inclusive `/comandos` da própria CLI), no meio ou no fim
  da missão.
- Preset Enxuta compõe coordenação + execução + verificação válidas.
- Missões de UI recebem automaticamente o design system do projeto
  (`DESIGN.md`) e o catálogo do operador (`~/.design-references`) no prompt —
  zero configuração.

### Remoção do motor antigo

- O código cerimonial sem caller foi REMOVIDO (driver, kickoff machine,
  scheduler de dispatch, PREVC/freeze, autoridades de plano/claim/receipt,
  merge queue de missão, shims de e2e no produto) — dezenas de milhares de
  linhas a menos, junto com os vigias que re-bloqueavam missões vivas.
- O critério de release passa a ser o smoke da Via Rápida: abrir o app,
  rodar uma missão trivial e vê-la concluir em minutos.

## 0.28.1 — Bridge por fora, Nexus por dentro

Data: 2026-08-07

Esta versão fecha a primeira onda do cruzamento Bridge × Nexus: mantém SQLite,
receipts, ownership, effect policy, multi-CLI e worktrees como autoridade, mas
expõe um caminho legível e degradável para humanos e workers.

### Estado da missão que dá para inspecionar

- Cada missão ganha uma projeção derivada com `BOARD.md`, `status.json` e
  `events.jsonl`. A fonte da verdade continua sendo o journal SQLite.
- As escritas são atômicas e isoladas por instalação/missão, com permissões
  `0700`/`0600`, recusa de symlink/escape e teardown no shutdown.
- Texto vindo de agente é normalizado e redigido antes de entrar no board;
  payload bruto, segredo e saída PTY não são copiados para a projeção.

### Coordenação que não depende de MCP ou hook

- `nx-mail`, `nx-task` e `nx-notify` são injetados no `PATH` do worker.
- Cada shim recebe uma capability vinculada à missão e escreve no mesmo
  journal canônico. O caminho leve não contorna ACK físico, roster, ownership
  nem política de efeitos.
- A degradação de handoff preserva a evidência primeiro e trata falha de inbox
  como não fatal; motivos de bloqueio chegam ao gate como `reason` e `detail`
  em vez de `mission-blocked reason=none`.

### Memória Markdown segura

- Markdown passa a ser uma entrada explícita da memória, sem abandonar
  SQLite/FTS5, dedupe e auditoria.
- A identidade da missão é atribuída no processo principal. Frontmatter ou
  argumento de chamador não podem forjar o vínculo com outra missão.
- Ingestão aplica limites, normalização, redação e validação de origem antes de
  indexar; projeções geradas continuam distinguíveis de entradas humanas.

### Command refinery e interface operacional

- Blocos OSC 133 agora alimentam estatísticas por contexto com frequência,
  taxa de sucesso, recência com decay e dismiss; sugestões redigidas aparecem
  no menu de comandos.
- Handoff ganhou uma camada de overlay fora do grid, obedecendo aos tokens e
  à escala de z-index do `DESIGN.md`.
- Pergunta pendente só aparece em missão viva; Arquivar executa a ação real;
  atalhos foram unificados e os CTAs apontam para superfícies existentes.

### Limitações conhecidas

- A projeção deliberadamente não guarda transcript PTY bruto. Retenção
  transcript-first, com política própria de segredo e tamanho, continua
  pendente.
- Worker vivo porém mudo ainda não é automaticamente re-roteado para outro
  membro do roster; o sistema o detecta, cobra e explica, mas pode encerrar a
  frente como degradada.
- O tier mais amplo do command refinery ainda é limitado ao checkout local,
  não um histórico global entre todos os projetos.

## 0.28.0 — A missão anda sozinha, e o app sempre fecha

O modelo de execução mudou de dono: o caminho simples virou o padrão. Cada
item abaixo diz como VERIFICAR com as próprias mãos.

### Limitação conhecida — worker parado ainda derruba a missão

Um worker que fica **vivo mas nunca completa o turno** (processo de pé, batendo
heartbeat, sem entregar) ainda pode travar a missão até o detector de parada
bloqueá-la. Três lacunas, todas abertas e todas na 0.28.1:

- O **reroute do roster cobre falha de spawn, não parada**: um worker que sobe e
  emudece nunca é re-roteado para outro agente do mesmo roster.
- **A saída do worker não é retida** em lugar nenhum — quando ele emudece, nem
  você nem nós conseguimos ver o que o terminal dele mostrava. É por isso que
  este defeito é difícil de diagnosticar.
- O **gate trata missão degradada como falha**, então ainda não existe o
  caminho "degradou, registrou e seguiu".

Por causa disso o advisor **grok saiu da fixture do gate** nesta versão: ele
exibiu exatamente esse comportamento (17 minutos vivo sem entregar) e sem
retenção de saída não há como provar a causa. Não é falha escondida — é defeito
declarado, com correção datada.

**O que já melhorou nesta versão:** uma missão que faz **todo** o trabalho não
fica mais presa para sempre em silêncio. A conclusão passou a derivar do
trabalho concluído com recibo, e quando o sistema não consegue prosseguir ele
**para dizendo o motivo** em vez de emudecer.

- **Missão nova começa NA HORA.** Sem diálogo de aprovação, sem confirmação
  destrutiva, sem "aguarde" — você descreve, ela roda; autorização virou
  registro auditável (recibo sha256 no journal da missão). Missões que
  estavam estacionadas esperando aprovação destravam sozinhas no primeiro
  boot. *Verifique:* crie uma missão "corrija X" — nenhum modal aparece e o
  card já mostra execução.
- **O worker trabalha NO SEU workspace.** Entrega direta no checkout, sem
  provisionar worktree e sem merge ao final (worktree ficou opt-in para
  fan-out largo); o executor faz exatamente um commit local — registro
  durável e ponto de desfazer da entrega. *Verifique:* o detalhe da missão
  mostra a forma da entrega (`simple-implementation`) e o commit aparece no
  seu `git log`.
- **Planos abrem em leque por ÁREA REAL do repositório** — tipicamente 3
  frentes num projeto como o HiperGO, não 1 — e o que antes ERRAVA agora
  DEGRADA declarando o que foi reduzido (uma incógnita não afunda o plano;
  guarda de build impede bloqueio duro novo sem tier degradado).
  *Verifique:* peça uma missão ampla e conte as frentes no plano; provoque um
  bloqueio e leia a degradação nomeada no card.
- **Panes têm número curto que você fala em voz alta.** O número no header é
  NOME durável ("o pane 7 travou" aponta sempre pro mesmo pane) e ⌘1-9 foca
  por POSIÇÃO no grid, com indicador sutil ⌘N — dois conceitos, dois
  namespaces. *Verifique:* feche um pane — os nomes dos outros não mudam; o
  ⌘N muda.
- **Ação destrutiva tem VOLTA em vez de pergunta.** `rm -rf` vai para a
  Lixeira do SO; `push --force`/`reset --hard` guardam o tip anterior em
  `refs/nexus-undo/*`; mudar agenda (cron) registra o caminho de reversão; a
  frase de desfazer aparece no journal. Operação IRREVERSÍVEL de verdade
  (ex.: DROP TABLE) continua exigindo consentimento — dois CRÍTICOS achados
  e corrigidos na revisão final, verificados contra Electron, git e Lixeira
  reais. *Verifique:* mande remover um arquivo e recupere-o da Lixeira.
- **Plugins de terceiros entram com defesa, nunca com escalada.** Manifesto
  validado (spec pinada), componente desconhecido degrada DECLARANDO o que
  foi ignorado, pacote inseguro vai para QUARENTENA, e skill de plugin nunca
  alarga as próprias permissões (`allowed-tools` blindado contra escalada);
  instalar continua atrás da superfície nativa de consentimento.
  *Verifique:* `nexus_plugin_inventory` lista cada plugin com o veredito.
- **O app SEMPRE fecha.** O teto de encerramento não pode ser cancelado por
  nenhum caminho de erro; sessão que não prova a morte vira incidente
  registrado (não veto); o aviso mostra prazo e botão "Forçar encerramento
  agora"; supervisores órfãos de execuções antigas morrem no boot; diário em
  `shutdown-incidents.jsonl`. *Verifique:* feche com panes abertos — fecha; o
  aviso, se aparecer, tem countdown e saída.
- **Ditado cai no pane certo.** Segurar Espaço dita para o pane de missão
  pela lane do operador; TOCAR Espaço digita espaço; "Saída do ditado" em
  Configurações › Voz alterna inglês-execução/português-literal.
  *Verifique:* toque Espaço num pane — espaço; segure e fale — texto no pane.
- **Delegação mais barata:** briefing por ponteiro (`brief`), pane de worker
  fecha sozinho no handoff success quando declarado no spawn
  (`autoCloseOnHandoff`), fechamento por escopo explícito
  (caller_mission/caller_workspace) e busca de agente/skill por NECESSIDADE
  ranqueada em vez de despejo de catálogo.

Nota honesta: a revisão automatizada do council e o grant nativo de squad
imediato seguem como as duas últimas superfícies com pergunta fora do caminho
feliz — próxima onda da doutrina registro+reversibilidade. Os 31 fails
pré-existentes de release-script são dívida documentada, não regressão.

## 0.27.0 — O caminho simples: a missão começa quando você pede

Data: 2026-08-06

### Zero fricção — decisão do dono

- **Missão começa NA HORA.** O gate de aprovação saiu do caminho da missão:
  sem modal, sem "Enviar para aprovação", sem paredão de SHA. A autorização
  virou REGISTRO auditável — o recibo criptográfico do review integral continua
  amarrando o contrato, mas ninguém mais pergunta. Honestidade de escopo:
  restam DUAS confirmações que só disparam em ação genuinamente destrutiva
  (shell destrutivo e mudança global persistente); na 0.27.1 elas também saem,
  convertidas em reversível-e-registrado (lixeira para deletes, backup refs
  antes de force-push/reset, snapshot antes de escrita global).
- **Nada estaciona esperando humano.** O estado `awaiting_approval` ficou
  inalcançável (o evento que levava até ele foi removido da máquina de
  estados); missões antigas estacionadas SOLTAM sozinhas na primeira abertura.
- **Parar/encerrar vale na hora.** Sem confirmação — e o encerramento agora
  PRESERVA panes, scrollback e receipts: você nunca é ejetado da tela de
  panes, o card diz por que parou e Retomar desfaz.

### Execução simples por padrão

- **Worker roda no SEU workspace.** Worktree isolada virou opt-in: a entrega
  comum edita o checkout direto, sem provisionar worktree e sem cerimônia de
  merge ao final. Fan-out largo (N stories) continua isolado como antes.
- **A entrega conclui pelo caminho simples.** `same_checkout` virou forma de
  conclusão de primeira classe com recibo próprio que registra COMO a
  não-interferência foi garantida — receipts antigos seguem válidos e
  significando exatamente o que sempre significaram.
- **Pane claude nasce executando.** A tarefa vai no argv: sem colar prompt
  depois do boot.

### Motor visível e honesto (linha anterior desta série)

- Toque de Espaço digita espaço em QUALQUER pane; segurar dita; "Saída do
  ditado" selecionável (EN execução / PT literal).
- A missão diz quantas unidades são elegíveis contra o teto disponível.
- Unidade de leitura não ocupa vaga de escritor; worker trabalhando nunca é
  marcado como travado (vivacidade é atividade real).

### Verifique você mesmo

1. Missão nova "corrija X" → roda SEM nenhum diálogo; execução direta no
   workspace (sem worktree, sem merge final).
2. Missão que estava parada esperando aprovação → aparece PRONTA no build
   novo; iniciar segue direto.
3. Encerrar missão em execução → sem confirmação; panes e scrollback FICAM;
   card diz o porquê; Retomar retoma.
4. Pane claude de worker → nasce já executando a tarefa.
5. Reviewer/QA read-only → não recusa por "worktree exigida" e não ocupa vaga
   de escritor.
6. Missão wave-pack → stories seguem em worktrees isoladas (nada mudou no
   largo).
7. Detalhe da missão → forma da entrega visível (`simple-implementation` no
   caminho novo; missões antigas seguem `implementation` isolada).
8. Toque de Espaço digita espaço; segurar dita; modo de saída troca em
   Configurações › Voz.

## 0.26.1 — Hotfix do primeiro voo: voz, aprovação e missões que falam

Data: 2026-08-05

### Voz — o ditado chega de verdade

- **Ditado aterrissa no pane da missão.** Falar num pane governado (orq/worker)
  agora entrega o texto pela lane do operador, com recibo real — antes a escrita
  era recusada silenciosamente pelo processo principal e o texto sumia depois de
  transcrito.
- **Espaço só arma segurando (hold).** Um toque simples no Espaço volta a
  digitar espaço; o ditado arma apenas no push-to-talk sustentado.
- **Acentos intactos.** O app empacotado passava locale C aos CLIs e todo
  prompt pt-BR virava mojibake ("miss√£o"); o PTY agora garante locale UTF-8
  sem sobrescrever escolha legítima do usuário.
- **Voz nunca mais shipa na fé.** O smoke do empacotado ganhou probes
  OBRIGATÓRIAS de ditado: entrega ponta a ponta num PTY real, recusas de
  autoridade vivas e o contrato do Espaço hold-to-talk (toque digita o
  caractere exato; hold arma). Falhou, o make falha.

### Aprovação que fecha

- **Fim do loop infinito de aprovação.** Aprovar a missão consumava, o
  bootstrap partia — e o diálogo voltava para sempre, porque o selo do squad
  (mutação do sistema) invalidava o hash da revisão. Mutações derivadas do
  intent aprovado agora dobram no escopo da aprovação; só mudança material do
  usuário (objetivo divergente) re-pergunta. O "não perguntar de novo para esta
  equipe" segue durável.
- **Missão viva não re-pergunta.** Reabrir fluxos sobre uma missão já em
  execução não dispara nova aprovação.

### Missão que fala com você

- **Missão parada diz POR QUÊ.** O card de missão parada mostra a causa real
  (evidência durável, não estado de layout) e "Retomar" continua de onde parou
  sem perder trabalho.
- **Worker mudo não mata a missão em silêncio.** Garantia de handoff: cobrança
  independe do estado da missão, com sonda de stall antes de qualquer decisão.
- **Você nunca é ejetado dos panes.** Plano selado impede a ejeção para o
  assistente; retomar volta aos panes; e quando o assistente abre sobre uma
  missão, existe a saída "Voltar aos panes".
- **Pane do orquestrador mostra o conteúdo.** O pane orq adotado não fica mais
  preto: a repintura usa a fita local de saída, com backstop se nada pintou.

### Paralelismo de verdade

- **A frota acelera sozinha.** Escada adaptativa de workers configurável,
  honesta e coerente com o hardware — a missão não fica mais silenciosamente
  presa em 2 workers quando há tarefas elegíveis; o veredito distingue escada
  adaptativa de teto do contrato.
- **Plano de controle do piloto (fatias 1 e 2).** `nexus_mission_control` (API
  do agente) e espelho humano na UI: panes vivos com item corrente, fila com
  ondas, mapa de ownership e bloqueios nomeados — numa leitura só.

### Infra e release

- **CI verde.** Instala bubblewrap e confina testes só-macOS/arm64 ao runIf.
- **Fast lane de hotfix.** Classificador por diff + waiver durável + selo de
  segurança que aprende o waiver — hotfix cirúrgico reusa o gate verde anterior
  com registro explícito.
- **Kickoff sem parede de proibições.** O fast path do kickoff declara de quem
  é cada cerimônia, sem a parede de negativos.

### Verifique você mesmo (mapa de aceitação)

Com a 0.26.1 instalada (abra o `.app` pelo Finder — é o cenário de locale/voz):

1. **Ditado entrega:** foque um pane de missão, **segure Espaço ≥ ~250ms**,
   fale, solte → o texto aterrissa no pane; o HUD só celebra com entrega
   confirmada (`voice.log` pode mostrar `lane=operator`).
2. **Toque simples de Espaço** no mesmo pane → um espaço digitado, **sem**
   flash de ditado. *(Nota: o limiar de 250ms pode dar sensação de "prender" —
   é o discriminador de hold.)*
3. **Aprovação:** aprove uma missão; clique Start/Aprovar de novo com ela já
   rodando → **sem** loop do diálogo nativo; o checkbox "não perguntar de novo"
   sobrevive ao selo do squad.
4. **Acentos:** app aberto pelo Finder, objetivo com `missão`/`não` → glifos
   corretos no CLI filho, sem mojibake.
5. **Pane orq:** abra/adote uma missão cujo pane orq ficava preto → conteúdo
   aparece em ~1–2s (fita local).
6. **Worker mudo:** worker termina e fica idle sem handoff → cobrança
   `[NEXUS_HANDOFF_REQUIRED]` em ~20s; handoff sintético se seguir calado.
7. **Missão que se auto-para com worker calado** → o handoff ainda aparece (o
   estado da missão é diagnóstico, não botão de mudo).
8. **Parada no meio com plano selado** → o rail diz **por quê** (texto do
   handoff ou "nenhum relatório") e a pílula "Parou — aguarda você".
9. **Retomar** nessa missão → volta aos **panes** (nunca ao wizard de objetivo
   em branco).
10. **Assistente sobre missão armada** → "**‹ Voltar aos panes**" retorna ao
    trabalho.
11. **Detalhe da missão multi-worker** → o quadro de controle mostra pulso e
    fase (adaptativa/serial) — sem "mistério dos 2 panes".
12. **Plano multi-unidade em host capaz** → o teto sobe além de 2 quando as
    ondas admitem todo o trabalho elegível.

## 0.26.0 — O loop que fecha: da largura ao encerramento

Data: 2026-08-05

### Missão que fecha sozinha (integridade do loop)

- **Worker que entrega, encerra.** O TTL pós-handoff passa a vir ligado por
  padrão em missões guiadas/autopiloto, com opt-out preservado para os E2E: um
  worker que terminou e entregou o resultado é encerrado e acorda o
  orquestrador, sem depender de flag.
- **A rota vira lei, não conselho.** No caminho agêntico, o squad e a rota
  resolvidos vinculam o dispatch: o loop não consegue mais ignorar o roster
  salvo e cair em monocultura ou no tier errado. `pane_spawn` respeita o roster
  da missão.
- **Fan-out de verdade.** O plano guiado deixa de ser "um escritor por
  construção": a decomposição emite propriedade disjunta por story, então dois
  ou mais workers escrevem em paralelo sem colidir, e o merge serial passa a ser
  escolha explícita — não gargalo acidental.
- **Objetivo em linguagem natural também paraleliza.** Uma meta escrita em texto
  livre não é mais forçada ao executor único: fica elegível para a topologia de
  fan-out, alcançando a mesma cadência de ≥2 escritores.
- **Fan-out largo drena até o fim.** O dreno de ondas deixa de parar em 64 e
  fecha frentes mais largas — até as 85 stories da campanha — sem deixar cauda
  de tarefas presas depois do handoff.
- **Revisor travado não prende mais o plano.** Uma tarefa de QA/revisão
  bloqueada por dependência agora tem desfecho terminal, em vez de ficar
  `blocked` para sempre segurando uma missão inteira aberta.
- **Boot de worker que não executa é reapado.** Um pane que nasce sem levar a
  tarefa à execução vira falha tratada pelo watchdog, em vez de pane vazio que
  nunca entrega handoff.

### Sair do app sem travar

- **Encerramento confiável.** O comando de sair passou a ter prazo global e
  backstop de `app.exit`, e a finalização dos processos de terminal escala de
  forma limitada de SIGTERM para SIGKILL. Sair do app deixa de pendurar quando
  um processo filho demora a morrer.

### Voz

- **Ditado que chega no pane.** A entrega do ditado ao pane foi corrigida com
  instrumentação de confirmação: o texto ditado chega ao destino certo, com
  sinalização de que a entrega ocorreu.

### Equipe da missão — editor de squad, fatia 1

- **Seletor sempre operável.** A opção correspondente ao CLI/modelo já
  selecionado nunca é desabilitada, eliminando o picker morto; disponibilidade
  continua sinalizada por rótulo e motivo de bloqueio.
- **Trava governada vira sugestão preenchida.** Em modo governado, qualquer
  provider credenciado (instalado e autenticado) é override selecionável e
  lançável, e os flags da ladder degradam para rótulos consultivos. Provider sem
  credencial segue desabilitado com "login necessário" — nunca o catálogo
  inteiro.
- **Edição de roster não é mais descartada em silêncio.** Trocar modo ou
  política preserva as edições não salvas do operador; só uma troca real de
  squad reconstrói o roster. O roster editado fica travado à reserva de rota do
  dispatch.

### Workspace, personas e panes

- **Política de acesso explícita.** `WorkspacePolicy` passa a ser tipo de
  primeira classe, incluindo `same_checkout`, tornando a política de dispatch
  visível e ajustável em vez de implícita.
- **Personas independentes da voz.** A identidade de um agente-folha deixa de
  ser derivada da voz e passa a ser persona própria.
- **Pane não-worker ocioso fecha sozinho.** O auto-close deixa de valer apenas
  para o caminho de worker TTL.

### Instrumentos, missão e mídia

- **Chef ocioso esperando workers fica visível.** Marcador dedicado para o
  estado em que o orquestrador está parado aguardando entregas.
- **Driver de missão orientado a objetivo.** Um driver goal-driven passa a
  coexistir com o cron time-driven.
- **Cold-start instrumentado.** O caminho de voz ganha medição de cold-start e o
  scaffolding do caminho quente.
- **Degrade de mídia por tier, sem fallback silencioso.** Quando um tier não
  está disponível, a degradação é comunicada em vez de trocar de rota calada.
- **Telemetria de uso tolerante.** Erros de identidade de escopo são absorvidos
  no telemetry e o renderer tolera escopo nulo pós-absorção.

## 0.25.1 — Missão fluida, entrega sem sumir

Data: 2026-08-04

### Fluxo de missão

- Encerramento, launcher e kickoff compacto têm contratos atualizados para o
  Autopiloto, sem enfraquecer o fail-closed do modo Hardened.
- Handoff PTY fica sem atestação no Autopiloto e continua exigindo credencial
  criptográfica válida no Hardened.
- Rebind de uma mesma sessão entre missões não descarta mais filas: cada
  entrega ambígua aciona recuperação física Main-owned.
- Timeout do lifecycle lock preserva a exclusão mútua sem deixar cauda órfã.

### Fluidez e diagnóstico

- Telemetria de uso/cota usa a identidade física completa do checkout,
  eliminando colisões entre raízes.
- Readiness/Home/Launch limpam roots e listeners de teste corretamente e
  refletem o copy multi-LLM atual.
- Vitest ignora workspaces QA persistidos; benchmark multipane 4/8/10 preserva
  ordem, ANSI, backlog limitado e input responsivo.

### Release

- Suíte integral: 1.072 arquivos e 10.061 testes verdes.
- Package smoke: 20 probes, 142 tools, 9 adapters, PTYs encerrados sem órfãos.

## 0.25.0 — Autopiloto no chão — vibe first, multi-LLM

Data: 2026-08-03

### Produto (chão do vibe)

- Autopiloto é o default real no boot: `squadCliPolicy=operator-choice`,
  atestação off e sandbox de kernel desligado.
- Seatbelt/bwrap e ladder Hardened só com `governed` explícito nas
  Configurações; policy ausente/desconhecida não reativa Hardened.
- No Autopiloto, catálogo, hash/plan seal drift e identity vault avisam e
  seguem — não matam o Maestro. Hardened continua fail-closed.
- Kickoff por squad enxuto (~1,7KB): objetivo + roster + condução, sem
  manifesto gigante no caminho vibe.
- Frota multi-provedor pronta: runtime deixa de travar em um único LLM
  quando o restante está apto.

### Release

- DMG/ZIP macOS arm64 assinados, notarizados e stapled como release público.

## 0.24.0 — Wave Pack, fast path e missão que conta o que faz

Data: 2026-08-03

### Orquestração

- Mission Wave Pack: N stories em panes paralelos, templates Landing/SaaS/Fix,
  e escolha Livre / Pack / Guiado no wizard e no promote do plano.
- Fast path: `risk=normal` pula a cerimônia PREVC antes do primeiro pane
  (opt-out via `orch.fastPath`).
- Warm-up read-only de reviewer/QA na onda 1 (flag
  `feature.mission.warmupAdvisories`, default OFF até reutilizar a PTY do
  warm-up no review real) sem quebrar o single-writer.
- Fence de promote amarra Pack/Guiado, template e contagem de stories ao que
  o operador revisou no diálogo nativo.

### Experiência do operador

- Boot da missão mostra etapa viva no card de vaga (poll 5s) em vez de
  silêncio de 30–90s.
- Kickoff standard enxuto (<2,4KB) sem `promotedPlan`, com condução colapsada
  por topologia.
- Cronograma de ondas no diagnóstico (IPC read-only, detail selado intacto).
- Recuperação deixa de ser beco sem saída: timeout 120s por tentativa, contagem
  N/8, lock 30s, e escape hatch na UI (Forçar retomada / Encerrar).
- Quatro caminhos gravam causa legível na description quando a missão fecha
  sem veredito.

## 0.23.0 — Missão nasce, anda e respira melhor

Data: 2026-08-03

### Missão deixa de girar em falso

- A aprovação sela uma cópia imutável do squad para a missão; sincronização de
  catálogo/builtins no boot não invalida mais o hash já aprovado.
- Recuperação técnica ganhou teto e distingue falhas permanentes de
  indisponibilidade transitória, inclusive quando a causa terminal atravessa
  wrappers assíncronos.
- Identidade de worktree ligada a outro checkout/branch bloqueia uma vez com
  causa acionável, em vez de consumir repetidamente tentativas de bootstrap.
- Kickoff tolera boot frio de CLIs e aceita um turno físico sustentado quando o
  hook nativo não chega, sem confundir repaint de um frame com execução real.
- O Maestro pode delegar scouts/revisores read-only antes da execução PREVC,
  mantendo escrita e shell presos ao estágio autorizado.
- A evidência pós-`done` acompanha a linhagem selada do squad fonte até o
  snapshot `agentic-runtime-*`; uma missão concluída não é mais reprovada por o
  observador continuar preso ao ID mutável anterior à aprovação.
- O schema compartilhado do recibo aplica a mesma regra ao runner privado,
  mantendo `squadSourceId`, hash de origem, snapshot runtime e plano
  causalmente vinculados.
- Contenção em `checkouts.json.lock` repete com espera bloqueante limitada, sem
  falhar no primeiro `EEXIST` nem consumir CPU em busy-wait.
- O pane recém-lançado do orquestrador recebe foco depois que shells existentes
  são preservados. No Canvas, a missão volta a ocupar o topo correto do
  stacking e não fica escondida atrás de um terminal antigo.

### Orquestração de panes (performance)

- Fan-out de panes com roteamento read-only por topologia (`team-read-only-
  fanout`) e ACK de handoff por leitura física (sem deadlock de paste idle).
- MCP auth fail-fast no watchdog de login e `maxWorkers` alinhado a 12 panes.
- IPC renderer↔main coalescido por frame (syncPanes em rajada vira 1 chamada),
  memoização de contagens no Canvas e render de terminal somente para panes
  visíveis (IntersectionObserver + repaint na volta).
- Flush de pipes adaptativo por profundidade de fila: 50ms cheio, 300ms raso.

### Interface

- Modal de aprovação enxuto: hashes por linha removidos; âncora única no
  `Review integral` e identidade do squad preservada.
- Profundidade visual 2026: sombras em duas camadas e filete de luz interno em
  superfícies elevadas (menus, modais, painéis, wizard).

## 0.22.0 — O piloto aprende a pilotar

Data: 2026-08-02

O Nexus passa a saber O QUE está executando. Antes desta release, "corrigir um
bug" e "criar uma feature" seguiam o caminho byte a byte idêntico, o objetivo
em português natural não ativava o caminho visual, e um projeto novo nascia
sem contrato de design — caindo no default do modelo.

### Tipo de trabalho e grafo

- Classificador de trabalho (bug/feature/doc/visual/ops/unknown) com
  confiança e sinais; `unknown` é o caminho genérico declarado, nunca chute.
- Missão de bug ganha reprodução ANTES da correção e teste de regressão
  DEPOIS, com aceite "o teste falha no HEAD atual e passa depois".
- Documentação fica fisicamente cercada fora do código, com deny-list para
  requirements.txt e parentes (build, não doc). Classificação fraca nunca
  aplica restrição irreversível.
- O roster automático cria consultores; revisões independentes rodam em
  paralelo sobre o MESMO HEAD integrado, com a cerca de observação cobrindo
  também as lanes novas.

### Contrato de design de ponta a ponta

- Catálogo com três fontes: referências locais, getdesign (74 marcas, SEM
  chave de API) e designmd.ai; o botão Importar cai na cadeia sem chave em
  vez de morrer no 401.
- Missão de UI sem contrato materializa um sozinha, com procedência e hash;
  projeto maduro recebe contrato DERIVADO dos próprios tokens.
- Os bytes do contrato são selados no plano e chegam ao executor e ao gate;
  o revisor visual lê o arquivo que existe ou reporta a ausência.
- O sensor compara token declarado com o valor documentado — prosa não
  declara, comentário não satisfaz, cor é verificada por token.
- Uma gramática única de "isto é UI?" substitui as cinco divergentes;
  português natural ("trocar as cores do tema") ativa o caminho visual.

### Instrumentos e operação

- Cinco leituras novas para o orquestrador: cota por conta, ranking de
  modelos, MCPs, inventário de skills e de CLIs — papel-cientes, sem segredo
  por construção, honestas sobre o que o produto não mede.
- Entrega física de skills consertada no Codex e no Claude nativos, com
  marcador de reversibilidade; BMAD entregue a quem escreve PRD/stories.
- Layout: invariantes na costura de escrita — placeholder nunca cobre a
  missão, foco nunca fica órfão, teto de panes falha nomeado.
- Cota esgotada na frase da OpenAI volta a trocar de conta.
- Fila de testes do servidor: 13 fixtures de PGlite vazando fechadas.

## 0.21.0 — O agente deixou de ser texto

Data: 2026-08-01

Esta release fecha as fundações que faltavam para uma missão observável,
transportável e verificável de ponta a ponta. O trabalho não fica apenas em
documentação: o Main, o renderer e o storage participam do mesmo contrato.

### Correção adicional

- O gate de missão real usa um vault de identidade volátil, exclusivo do
  processo E2E, sem tocar o Keychain nem gravar chave privada em disco.

### Observer plane e ACP

- Hooks e sessões ACP emitem frames tipados de turno, ferramenta, status e
  lifecycle; a timeline da missão consome esses eventos sem raspar scrollback.
- Driver ACP JSON-RPC sobre stdio com handshake, timeouts limitados,
  cancelamento e kill garantido, injeção MCP via `session/new` e provenance
  `acp-stdio`.
- Settings → Runtime ACP permite escolher preset, salvar/testar BYOH custom e
  mostra permission requests em uma UI nativa fail-closed.

### Fila, receipts e identidade

- Watchdog de fila com deadline e dead-letter libera recursos e registra erro
  acionável quando merge ou dispatch ficam in-flight além do limite.
- Receipts SHA-256 agora formam cadeia verificável, com hash anterior e
  `verify_chain` no gate.
- Cada agente de handoff recebe identidade Ed25519 e atestação com escopo,
  expiração e revogação; reroute emite a identidade no Main e merge revalida a
  credencial armazenada na mesma transação do receipt.
- Reply guard, waiver e failover preservam evidência explícita quando uma task
  nunca executou; nenhum waiver transforma ausência de execução em sucesso.

### UI que executa o contrato

- Composer, wizard, journal, Ops Board, panes ACP e settings foram conectados a
  ações e estados reais, incluindo erros retryable e feedback de probe.
- Tokens, motion, densidade, foco, scrollbars e estados de seleção seguem o
  design system Nexus; a superfície ACP tem testes de comportamento próprios.

## 0.20.3 — O gate pergunta antes de gastar

Data: 2026-08-01

Uma CLI com sessão expirada ou sem chave só se revelava ~40 minutos depois de
iniciar o ciclo de release, como "worker sem atividade e sem heartbeat por 10
minutos (stalled)" — e o ciclo inteiro era perdido. Numa noite isso se repetiu
sete vezes, com degradação monotônica no mesmo commit (8/8 → 7/7 → 6/5
handoffs).

### Preflight de provedor no gate

- Antes da missão real, cada CLI exigida responde a uma sonda mínima com
  timeout de 90s: `codex exec` e `claude -p` num turno barato; `grok models`
  numa checagem de login que nem gasta turno de LLM.
- Sessão expirada, chave ausente e provedor mudo são **distinguidos** — o
  remédio de cada um é diferente (relogar, exportar a chave, esperar a cota).
  Os padrões de classificação são os TEXTOS REAIS observados nas CLIs desta
  máquina; o teste de regressão pegou um match que passava batido ("Failed to
  authenticate" não casava com "authentication").
- **CLI sem sonda calibrada nunca bloqueia** (`agy`, `kimi`, `glm` ficam de
  fora documentadamente): preflight mal calibrado reprova release boa, que é
  pior que o problema que resolve. Binário ausente também não bloqueia — o
  roster já trata CLI não instalada.
- Sonda que explode conta como não-responsiva: o gate não começa apostando que
  o provedor está bem.

### A causa da noite tinha nome

A primeira aplicação real da sonda encontrou o que sete ciclos não disseram: a
sessão OAuth do Claude expirada e irrecuperável — exatamente o provedor cuja
exaustão disparava os reroutes que reprovavam `participationIsExact` (o
substituto ficava com dois dispatches sob o mesmo `agent_ref`). Noventa
segundos de sonda contra quarenta minutos por descoberta.

## 0.20.2 — Travar deixou de ser mudo

Data: 2026-07-31

Uma missão do gate de release entregou **tudo** — 8 tasks `done`, 8 dispatches
`completed`, 8 worktrees `integrated`, 8 handoffs — e mesmo assim ficou eterna
em `running`. O gate morreu por `timeout` e o post-mortem no banco não tinha o
que ler: o workflow PREVC parado em `execution` desde o primeiro segundo, zero
recibos de step, e o drive state criado no início e nunca mais tocado.

O motivo existia. Ele só não sobrevivia ao processo.

Esta versão **não conserta a parada** — ela faz a parada dizer o nome dela.

### Os dois motivos viraram duráveis

- **Driver**: quando `decideDriveAction` escolhe `wait`, o motivo é gravado na
  missão. Antes ele existia só no snapshot em memória do tick.
- **Autopilot do PREVC**: quando a ponte pós-merge se declara `ready: false` —
  tanto na saída antecipada de autoridade quanto depois de rodar o autopilot —
  o motivo é gravado. Era o dado que faltava para saber por que uma missão com
  o plano inteiro integrado não avança de `execution`.
- Migração `028-mission-stall-diagnostics`: quatro colunas em
  `mission_drive_state`, uma linha por missão, cada motivo com o instante da
  sua própria transição.
- **Recibo garantido em todo caminho de falha**: as validações pós-PASS do
  runner rejeitam uma evidência que o processo filho declarou aprovada — e
  todas lançavam ANTES de qualquer escrita. Um ciclo de release terminou com a
  missão **selada** (`done`, 8/8 handoffs) e zero rastro em disco: nem recibo,
  nem motivo. Agora o recibo é persistido antes de relançar, com o erro de
  validação injetado no `detail` (um PASS não tem bloco `failure`, então o
  motivo precisa ser posto ali) e código `observer-invalid` — a missão pode ter
  ido bem; o que não serve para release é a evidência dela. A persistência é
  best-effort de propósito: uma falha de escrita não pode mascarar o erro de
  validação, que continua sendo o diagnóstico primário. Nenhuma validação foi
  afrouxada.
- **Observer do E2E**: `invariant-failed` pós-done nascia com `detail: null`. O
  motivo real — qual recibo não estabilizou — vivia num `console.warn`
  throttled que o gate não captura, então o arquivo de evidência que sobrevive
  à execução saía sem o "porquê". Três execuções do gate foram diagnosticadas
  no escuro por isso. O erro de estabilização passa a ser preservado no campo
  de texto livre que existe exatamente para isso.

### O que o registro deliberadamente NÃO faz

- **Não consome orçamento**: nunca toca `revision`, `attempt_count` nem
  `updated_at`. Parar não é tentativa — se contasse, uma missão parada
  pareceria estar progredindo e queimaria orçamento de recuperação sem agir.
- **Não repete**: só grava quando o motivo MUDA. A 5 segundos por tick,
  reescrever a mesma frase centenas de vezes é só I/O; o valor diagnóstico
  está na transição e no instante dela.
- **Não derruba nada**: falha de registro é engolida com aviso nas duas
  camadas. Diagnóstico não pode competir com a condução da missão.
- **Não afrouxa evidência**: nada aqui muda o que conta como verificado. O
  driver continua exigindo evidência atestada de verdade para avançar o PREVC.

### Por que uma linha por missão, e não um ledger

`mission_events` é append-only com semântica de entrega. A 5s por tick, um
motivo repetido viraria crescimento sem limite para registrar a mesma frase. O
diagnóstico útil é o motivo **atual** e quando ele mudou — não a contagem de
vezes que o loop reafirmou o mesmo impasse.

## 0.20.1 — O gateway não desloga ninguém

Data: 2026-07-31

A 0.20.0 pôs um gateway de IA local na frente das CLIs. A auditoria da
integração inteira mostrou o preço escondido: ligar o gateway fazia o Claude de
assinatura ser lido como provider de terceiro e subir sem credencial nenhuma. A
causa era mais funda que o gateway.

### Transporte deixou de responder "que plano é este?"

- Cada spawn constrói dois ambientes a partir do mesmo adapter: o de
  **transporte** (`agentEnv(adapter, gateway)`), que a CLI recebe com as base
  URLs no gateway, e o de **identidade** (`agentEnv(adapter, null)`), que é
  quem responde à pergunta do título — HOME efêmero, credencial nativa e
  classificação de terceiro saem dele.
- O gateway vazava para a segunda decisão: `isThirdPartyClaudeFamily` via uma
  `ANTHROPIC_BASE_URL` estrangeira, o Claude de assinatura ganhava HOME isolado
  com `carryNativeClaudeAuth` falso e nenhum token injetado — `/login` no meio
  da missão.
- Das três chamadas de `shouldUseEphemeralHome`, só a do `mcp-server` recebe
  `effectiveEnv`. Manter o gateway fora do env de identidade faz as três
  concordarem **por construção**, sem sincronizar argumento entre camadas.

### A URL oficial da Anthropic parou de ser "provider de terceiro"

- Bug mais antigo, achado pelo teste de regressão do item acima: QUALQUER
  `ANTHROPIC_BASE_URL` não vazia marcava a CLI como plano de terceiro —
  inclusive `api.anthropic.com`. Shells, wrappers de CLI e imagens de CI
  exportam essa variável; quando ela alcançava o processo do Nexus, a
  assinatura perdia a credencial sem nenhum terceiro envolvido.
- O host oficial passa a ser reconhecido como nativo. URL ilegível continua
  contando como terceiro (fail-closed).

### Gateway ganhou configuração, credencial e documentação

- Campo próprio em **Configurações → Orquestrador**; `NEXUS_AI_GATEWAY_BASE_URL`
  segue como fallback. Só `http(s)`, validado nos dois lados.
- `NEXUS_AI_GATEWAY_API_KEY` injeta a credencial do gateway **depois** da do
  provider — quem roteia para o gateway autentica com a chave dele. Sem ela, um
  aviso explícito diz que a credencial do provider viaja junto.
- O log diz, por adapter e uma vez por processo, quem foi roteado, quem ficou
  fora e por quê. `KIMI_MODEL_BASE_URL` fica fora de propósito: é endpoint de
  modelo, amarrado a `PROVIDER_TYPE` e `API_KEY` no mesmo trio.
- Documentação nova em [`docs/ai-gateway.md`](docs/ai-gateway.md).

### Diagnóstico da voz para de acusar a chave errada

- `realtime_unavailable` significa que NENHUMA rota da cadeia conectou, mas a
  mensagem nomeava só a credencial do transporte escolhido: com Grok
  configurado e sem `XAI_API_KEY`, quem falhava era a OpenAI e o operador era
  mandado conferir a chave do Grok.
- A ordem de degradação virou fonte única (`REALTIME_FALLBACK_CHAIN`) lida pelo
  runtime e pela UI — não há mais duas listas para divergir.
- O validador de transporte não listava `grok-realtime`: a rota oficial passava
  pelo ramo de coerção e só sobrevivia porque o default é ela mesma.

### Notas de versão e DESIGN.md dizendo a verdade

- A 0.20.0 anunciava "sombra de elevação real no card". O código rejeitou
  sombra de propósito — sobre preto ela não projeta nada, só embaça a borda, e
  ainda repintava o canvas do xterm; a elevação se lê por luminosidade.
- O "TODOS os halos" ignorava o sprite do agente, cuja luz pertence ao
  personagem (mesma família do orbe de voz e do mascote) e num elemento de 2px
  não caberia anel. Agora é exceção documentada no CSS.
- `DESIGN.md` ainda trazia a paleta azul-negra que o código trocou por cinza
  neutro.

### Cobertura

- Regressão das três camadas de decisão de HOME, endpoint oficial vs terceiro,
  credencial do gateway e encaminhamento; reroute com missão `running` (o ramo
  que as fixtures existentes não exercitavam); e prova de que o loop do
  mission-driver de fato invoca o watchdog de merge — antes só a função pura de
  decisão por idade era testada.

## 0.20.0 — Operacional de verdade

Data: 2026-07-31

A régua desta versão é a frase do operador: "se o Nexus estiver operacional de
verdade". Cada item abaixo nasceu de uma falha flagrada ao vivo nos gates de
release do próprio dia — nada é especulativo.

### Provider morto re-rota na hora, em TODAS as formas

- **Reroute imediato no primeiro 401/cota**: o failover consulta o roster
  selado ANTES de qualquer waiver ou retry e re-vincula a tarefa a outro
  agente da mesma categoria com CLI viva — com a missão ainda running, pela
  identidade física exata do worker que falhou. Soluços curtos (rate-limit,
  transient) continuam na espera-pela-irmã, que resolve em minutos sem
  descartar um agente saudável.
- **Advisor esgotado com a missão rodando**: a terceira forma do mesmo bug
  (7/8 tarefas completas, missão pendurada para sempre num advisor
  blocked-terminal) — o sweep de reroute passou a aceitar missão running.
- **Waiver é último recurso e é CONTADO**: toda dispensa por provider
  indisponível vira aprendizado durável da missão — o nome da tarefa, que ela
  **não foi executada**, qual CLI falhou e o remédio certo (login só quando a
  causa é auth). O recibo sempre existiu; agora ele chega ao operador.

### Merge abandonado tem watchdog

- Uma tentativa de merge que o próprio processo abandonou (flagrada ao vivo:
  22,7 min em candidate-validating, sem erro, sem validador existindo) é
  detectada por idade — 25 min, acima de todos os bounds legítimos — e
  reconciliada como interrompida pela mesma máquina de disposição do reinício.
  O watchdog bate nos dois loops (mission-driver e scheduler).
- **Projeções do tick isoladas**: uma reconciliação que lança não silencia
  mais todas as seguintes — cada uma falha alto e sozinha.

### Voz oficial: Grok Voice

- O transporte realtime padrão vira `grok-voice-think-fast-2.0` (voz rex) via
  `wss://api.x.ai/v1/realtime`, com OpenAI Realtime e Gemini Live como
  degradação automática. Campo próprio para a `XAI_API_KEY` nas configurações,
  seletor mostrando "Grok Voice (principal)", e versão de modelo fixa de
  propósito: alias que migra sozinho não decide a voz do produto.
- O transporte reaproveita o provider Realtime já testado (host e dialeto de
  sessão são parâmetros) — o Grok difere só no `session.update` (voz e
  `turn_detection: server_vad` na raiz) e no endpoint.

### Visual redesenhado de ponta a ponta

- **Pane**: nome do agente domina (sans 12px peso 560); badges viram metadado
  quieto em mono 10px sobre fundo lavado; ações recuam a 50% de opacidade até
  o pane receber ponteiro/foco; Fechar neutro em repouso (vermelho só no
  hover); elevação lida por LUMINOSIDADE (`--bg` → `--bg-elevated`), não por
  sombra — sobre preto a sombra difusa não projeta nada, só embaça a borda e
  ainda repintava o canvas do xterm.
- **Fim do neon**: os halos persistentes viraram anéis nítidos de 3px na cor
  do estado ou sombra escura de elevação. Orbe de voz, logo do boot, mascote,
  sprite do agente e FX de celebração seguem brilhando — atmosfera é
  deliberada, cromo não.
- **Rail**: as quatro seções deixaram de ser caixas coloridas empilhadas;
  cabeçalhos quietos com ponto de estado de 6px, contagem neutra, e a missão
  em execução é o único card aceso da coluna.
- **Barra superior**: zonas separadas por filete e respiro — frota, cota,
  missão, ferramentas e sistema lêem como grupos, não como fileira de chips.

### Gateway de IA local (OmniRoute-like)

- `NEXUS_AI_GATEWAY_BASE_URL` aponta as CLIs para um gateway local: as vars
  `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` são injetadas SÓ nos adapters que as
  declaram, e planos com endpoint próprio pinado (GLM, LongCat) ficam
  intocados por construção. O gateway troca de provider por baixo — a CLI nem
  vê a falha.

### Segurança de worktree

- **Varredura de PTY no teardown**: liberar o registro de um worktree agora
  encerra os PTYs que provadamente moram nele (prova por contenção de caminho,
  fail-closed: sem cwd ou raiz vazia, não mata nada). Era a origem do worktree
  órfão que travava missões futuras.

## 0.19.42 — A missão não para por causa de uma CLI

Data: 2026-07-31

### Uma CLI morta deixou de ser o fim da missão

- **Reroute automático dentro do time aprovado**: quando um worker esgota as
  três tentativas físicas de spawn (cota esgotada, login expirado, binário
  quebrado), o Nexus re-vincula a tarefa a outro agente da MESMA categoria do
  mesmo roster selado — com CLI viva e rota resolvível agora — e reabre a
  missão sozinho. O plano permanece imutável: o reroute é uma re-vinculação de
  despacho, nunca um replanejamento nem uma dispensa de tarefa. Cada CLI já
  provada morta fica registrada na diretiva durável, então a cadeia é finita e
  auditável. Sem candidato vivo, o diagnóstico terminal permanece como está.
- **A troca é contada ao operador**: cada reroute vira uma entrada durável nos
  aprendizados da missão — qual CLI morreu, quem assumiu, e que o plano segue o
  mesmo. Recuperação automática deixou de ser invisível.

### Missões que nasciam mortas

- **Squad salvo ganha plano selado pelo Main**: um time salvo com pelo menos um
  executor entra na política guiada e recebe plano selado. Antes essas missões
  caíam numa rota de planejamento pelo orquestrador que morria em
  `workflow_authority_revoked`, deixando a missão despachada com zero tarefas
  para sempre. Times de revisão/pesquisa (sem executor) continuam na rota
  anterior.
- **Agêntico reusa o time salvo por padrão**: o modo agêntico prefere um squad
  salvo elegível em vez de sintetizar um time novo com os modelos default do
  adapter — origem do `gpt-5.5` aparecendo em missão que ninguém pediu.

### Interface

- **Pane que está subindo diz quem está subindo**: enquanto o PTY não reporta
  sessão, o pane mostra "Subindo…" com agente, CLI e modelo, e avisa
  honestamente quando passa do tempo normal de cold start. O retângulo preto
  sem explicação era lido como "pane morto tapando a missão".
- **Frota da missão visível fora do foco**: a lista de agentes aparece sempre
  que existirem panes da missão, não só quando ela está aberta no grid.

## 0.19.41 — Missão destrava, diagnóstico aparece

Data: 2026-07-31

### O fim do "travou pra sempre"

- **Bloqueio órfão de merge não brica mais o projeto**: um bloqueio da fila
  de merge cuja missão foi removida é retirado automaticamente (na abertura
  do escopo e na remoção da missão), com evento de auditoria. Antes, UMA
  missão rejeitada e deletada condenava TODAS as missões seguintes do
  checkout a "merge diferido 12 vezes" para sempre.
- **Retomar missão volta a funcionar**: o selo do plano ignora worktrees
  terminais (failed/abandoned/integrated) do plano anterior. O reopen
  bumpava a intent, tentava selar de novo e morria com "mission task plan is
  sealed after the first worktree allocation" — matando a recuperação
  automática exatamente quando ela era mais necessária.

### Diagnóstico que finalmente mostra o erro

- **"Ver diagnóstico" abre o diagnóstico**: o toast de falha técnica navega
  direto para o detalhe da missão que falhou (o PetEvent agora carrega o
  missionId), em vez de abrir o Ops Board sem nenhum erro visível.
- **Detalhe da missão para missões travadas**: o painel de resultado agora
  também abre para `blocked`, com as notas técnicas parseadas em seções
  legíveis (sem `[NEXUS_FAILURE:terminal]` nem comentários HTML crus) e com
  o botão "Retomar missão" ao lado do diagnóstico.
- **Card do Ops Board clicável**: o título abre o diagnóstico/relatório; o
  card TRAVADA mostra a primeira linha do erro real.
- **Rail**: clicar numa missão com falha técnica abre o diagnóstico primeiro
  em vez de disparar um reopen cego que repete a mesma falha.
- **Journal de missão deixou de perder eventos**: idempotency keys longas
  eram rejeitadas em silêncio pelo limite de 128 chars; agora são
  hash-comprimidas.

### Análise vira missão de consulta (autopilot)

- **"analise…" agora sugere e aplica a lane consult** mesmo com as opções
  avançadas fechadas — com um chip visível "Modo: Só pesquisar · trocar".
  Antes, qualquer pedido de análise virava um pipeline completo de entrega
  (worktree + merge queue) que podia falhar na integração de um relatório.
- O detector de lane reconhece análise/auditoria/mapear/explicar/avaliar,
  mantendo a precedência de implementação ("analise e corrija" continua
  standard).

### Pane vazio ao abrir missão

- **Apresentação espera a hidratação do layout**: o placeholder estrutural
  persistido não substitui mais os panes reais da missão numa corrida de
  boot (a causa do "abre um pane sem nada; fecho e a missão aparece").
- Recovery de pane descarta o placeholder solitário como as demais
  apresentações; dividir/adicionar panes limpa um maximize obsoleto que
  cobria o grid.

## 0.19.40 — Sem cerimônia

Data: 2026-07-31

### Menos burocracia, mais execução

- **Fim da cerimônia PREVC do orquestrador**: em missões guiadas o Main
  congela o contrato, avança estágios, roda revisões/sensores e conclui —
  o kickoff agora ensina isso (sem freeze/Doctor/prepare_execution manual,
  sem ACK obrigatório em entregas, sem polling para um set_status proibido)
  e as tools de cerimônia falham rápido com orientação nesse caminho.
- **Aprovação em um clique**: o "Começar" do plano revisado no wizard já é
  a aprovação. O modal nativo fica só para risco destrutivo, promoção,
  modo governado e chamadas fora do wizard.
- **Roteador dentro do roster**: nexus_route_task honra o roster selado e
  nunca sugere adapter fora do plano aprovado.
- **Restore sem diálogo** e divisor visível separando scrollback morto da
  sessão viva quando uma sessão é recriada no pane.

### Correções de produção

- **Retry lane curada**: a liberação de worktree de dispatch terminal usa o
  marcador de ressurreição — bootstrap recovery re-prova a identidade e
  segue, sem "task worktree is already failed".
- **Driver desligado avisa**: missão guiada com driver inativo recebe aviso
  explícito no início em vez de nunca concluir em silêncio.

## 0.19.39 — Vibecode sem atrito

Data: 2026-07-30

### Paralelismo e caminho padrão

- **Até 8 workers por missão**: o teto aprovado é o cap da wave no
  operator-choice (o clamp adaptativo conservador ficou só no modo governado).
  Núcleos e budget de panes são lidos da máquina real, risco restringe a
  superfície de aprovação e não o paralelismo, e worktrees de uma mesma onda
  são criados sob mutex por checkout.
- **AGY como cidadão pleno**: a auth por assinatura no Keychain é aquecida em
  todos os limites de missão (squad readiness, scheduler, bootstrap,
  architect, reviewers). Briefing nativo por argv com prova física de aceite,
  parser de handoff tolerante a hard-wrap do TUI e exit pós-entrega aceito
  como conclusão.
- **Executor sem mudança completa**: zero commit + worktree limpo + HEAD
  igual à base selada gera receipt de no-change validado por reviewer/QA —
  fim do deadlock "task has no committed changes". Worktree sujo sem commit
  bloqueia na hora, com motivo claro.

### Nada trava em silêncio

- **Limites visíveis em todo retry**: falhas pré-claim de dispatch, defers de
  merge e provider sem rota têm bounds auditáveis em vez de loops infinitos.
- **Gerações órfãs aposentadas**: re-freeze do PREVC não deixa mais gerações
  antigas de tasks segurando ownership; worktrees de dono morto são liberados
  com marcador e ressurreição provada para a retry lane.
- **Retomada pós-restart**: pane de missão cuja sessão morreu com o app
  continua em contexto novo sob o contrato selado, sem pane vermelho morto.
- **Erros que dizem o motivo**: worker sem rota e falhas de merge nomeiam a
  causa concreta (login-needed, sem conta, modelo não pronto, ownership).

### Interface e estabilidade

- **Pane vazio eliminado**: placeholder estrutural é substituído pelo pane
  real no lançamento e no reopen; maximize obsoleto não esconde a missão;
  Home não cobre grid com missão montada.
- **Missão sempre visível**: fechar o último pane de uma missão em execução
  mostra toast com "Reabrir panes".
- **Shell correto**: panes abrem o login shell real da conta como login
  shell, com o PATH completo do usuário.
- **Memória contida**: buffer de gap do PTY com cap e heal, recover
  single-flight, backpressure main→renderer e throttle de escrita no xterm.

## 0.19.38 — Missões que seguem em frente

Data: 2026-07-29

### Liveness de missão e panes

- **Cada missão recebe a topologia certa**: pedidos de implementação continuam
  no fluxo executor → revisão → QA. Rodadas explícitas como “cada pane diga o
  que faz” despacham todos os especialistas em paralelo, preservam cada
  resposta e só terminam após a consolidação durável do Maestro.
- **Maestro ocupado não é Maestro quebrado**: a entrega aguarda um `idle`
  estável antes de tocar no terminal. Uma mudança transitória para `busy` não
  gasta retry, não cria prompt duplicado e não substitui uma sessão saudável.
  Missões de entrega usam o aceite físico do transporte; ACK individual
  continua obrigatório somente quando o Maestro precisa consolidar um fanout.
- **Aprovação sem espera artificial**: o clique de aprovação retorna assim que
  o Main sela e persiste a missão. Descoberta de contas, quota, PREVC e
  preparação dos agentes continuam em paralelo, sem manter o wizard em
  “Preparando aprovação”.
- **Autoridade Main-owned consistente**: spawn, recuperação e replay de panes
  usam missão, spec, escopo, sessão, encarnação e selo atuais. Reload/HMR adota
  a mesma PTY viva; uma encarnação antiga é encerrada sem apagar um replacement
  homônimo.
- **Sem panes fantasmas**: fechar ou remover missão só conclui depois do
  teardown físico exato. Estado durável e histórico permanecem recuperáveis se
  o processo não puder ser comprovadamente encerrado.
- **Recuperação não para o relógio inteiro**: cada supervisor possui
  single-flight e timeout próprios. Um reviewer ou scheduler lento por até 21
  minutos não interrompe bootstrap, lifecycle, outbox nem os demais ciclos.
- **Bootstrap resiliente**: falha transitória ao subir MCP/coordenador entra em
  retry supervisionado; bind `EADDRINUSE` rejeita corretamente e listeners
  antigos são descartados antes da nova tentativa.
- **Checkout sujo deixa de ser beco sem saída**: o Main cria um checkpoint
  assíncrono e idempotente da visão do operador antes do primeiro worktree.
  Arquivos de credencial não rastreados são recusados; conteúdo explicitamente
  staged continua sendo uma decisão consciente do operador.
- **Legado volta a caminhar**: missões bloqueadas pelo erro exato
  `primary checkout must be clean` são rearmadas em conjunto, sem duplicar a
  causa no texto. Falha técnica vira retry; apenas decisão humana real usa
  “Aguarda você”.
- **Troca de workspace à prova de corrida**: respostas atrasadas de um
  workspace não liberam nem removem panes do seguinte. Ao voltar de A → B → A,
  a sessão Main-owned viva é apresentada de novo; consultas transitórias de
  autoridade continuam em retry com backoff até uma resposta real, sem deixar
  o pane preso em “Aguarda você”. Se o layout persistido não carregar, o Nexus
  abre um shell seguro em vez de voltar para a tela inicial indefinidamente.
- **Telemetria não bloqueia a UI**: rollouts grandes do Codex são lidos em
  blocos limitados com yield para o event loop. Histórico copiado, sessões de
  outro workspace e replay de eventos não inflam mais custo/XP nem seguram
  scheduler, panes ou IPC por dezenas de segundos.

### Design system live

- **Dembrandt embutido**: skill `dembrandt` e CLI manual pinada continuam
  disponíveis; workers usam o contrato aplicado + Impeccable.
- **`nexus_design_system_extract` fail-closed**: Dembrandt v0.25.1 não expõe
  interceptação por request e pode seguir redirects/subresources. Por isso o
  MCP retorna `NETWORK_GUARD_UNAVAILABLE` por padrão e só executa com runner
  interno que imponha a policy em toda request. Preflight de URL não é tratado
  como fronteira SSRF.
- **Teardown físico**: timeout/abort encerra a árvore npx/Node/Chromium com
  grupo POSIX (`TERM` → grace → `KILL`) ou `taskkill /T /F` sem shell no
  Windows, e só então conclui a chamada.
- **Fallback sem travar missão**: use `DESIGN.md` existente ou
  `nexus_design_system_search/get/import`; a CLI raw permanece uma ação manual
  explícita, não uma extração autônoma prometida pelo MCP.
- **Reader unificado**: design mode lê `DESIGN.md` ou
  `.context/docs/design-system.md`, com truncamento `[truncated]` estável.

## 0.19.37 — Autopiloto sem becos sem saída

Data: 2026-07-29

### Missões que caminham

- **Falha técnica vira retry**: spawn, bootstrap, capacidade temporária e
  recuperação depois de reiniciar o app voltam para uma fila durável com
  backoff. Durante a troca de PTY o rail mostra `Recuperando`, mantém a missão
  entre as ativas e não chama o operador pelo pet. O comando `Parar` interrompe
  o retry sem apagar o histórico quando o operador quiser assumir a decisão.
- **Autopiloto não herda o confinamento Hardened**: a sessão física registra a
  policy realmente aplicada. Um orquestrador aprovado com
  `nativeReadOnly=false` não reaparece como `true` e não se autobloqueia por
  divergência antes do primeiro dispatch.
- **Autoridade antiga é reconciliada**: panes persistidos em estados
  incompatíveis deixam de produzir `stale persisted mission pane authority`.
  Missões são retomadas pelo Main, independentemente da preferência usada para
  terminais avulsos.
- **Objetivo natural recebe ownership**: quando o pedido não cita um caminho
  literal, o Nexus usa um inventário limitado do projeto para construir o selo.
  O erro `Nenhum caminho explícito pôde ser selado` deixa de impedir o kickoff.
- **Transações recuperáveis**: falhas após o claim revertem a transição exata,
  preservam o worktree e reprogramam a task. Candidate, integração,
  pós-validação e finalização também sobrevivem a restart.
- **Worker interrompido volta à fila**: quando o runtime físico realmente
  desaparece, o dispatch retorna a `pending` com backoff e o substituto só
  assume após rebind exato de missão, pane, sessão e encarnação. Falha de
  heartbeat ou persistência nunca duplica um worker ainda vivo.
- **Renderer só abre depois do Main estar pronto**: a janela e o Dock nascem
  cedo, mas React só navega após todos os canais IPC estarem registrados.
  Primeiro launch lento deixa de fixar stores em fallback ou imprimir
  `No handler registered` até uma recarga.
- **Finalização do wizard drena eventos já enviados**: ao concluir ou falhar,
  o gate deixa o IPC em modo inativo até o renderer terminar a cadeia do
  clique. Um `approval-returned` tardio não encontra mais handler removido nem
  cria receipt depois do veredito.

### Autopiloto multi-CLI

- **Qualquer CLI compatível pode trabalhar**: no modo Autopiloto, CLIs
  instaladas, autenticadas e capazes de entregar handoff podem executar,
  revisar e validar com acesso de rede e autoaprovação do provider. Busca e
  fetch nativos são usados quando a CLI oferece essa capacidade; pesquisa
  visual portátil fica disponível ao Maestro pelo browser Nexus.
- **Hardened continua opcional**: o padrão mantém worktree por task, identidade
  por sessão e merge validado pelo Main. Confinamento de provider/kernel e
  verificações rigorosas permanecem disponíveis no modo Hardened.
- **Auth respeita o provider**: Claude nativo reutiliza HOME e Keychain reais no
  Autopiloto; providers por token continuam isolados e adapters com
  `auth.method: none` não recebem manipulação artificial de credenciais.
- **Handoff físico independente de marca**: workers e revisores usam o mesmo
  protocolo durável no PTY, inclusive CLIs personalizadas pelo operador.
- **Canal Maestro bidirecional pelo PTY**: CLIs PTY compatíveis coordenam plano,
  operações e conclusão pelo dispatcher Main-owned, sem depender do MCP do
  provider. A autorização fica vinculada à sessão, missão, papel e contrato;
  chamadas são deduplicadas e o resultado retorna ao mesmo terminal.

### Contexto e qualidade sênior

- **PREVC em paralelo**: memória, orientação e contrato não seguram o primeiro
  worker. O gate protege a promoção e o merge do candidate.
- **Memória unificada**: SQLite FTS5 é a fonte canônica, Markdown é a projeção
  legível e fatos confiáveis entram em recall automático limitado antes de
  planejar, executar e revisar.
- **Mapa estrutural incremental**: símbolos, dependências e blast radius são
  atualizados pelos arquivos alterados, ignorando worktrees, builds e
  `node_modules`.
- **Receipts de qualidade reais**: diff, Git físico, contrato, sensores e
  revisão independente alimentam a decisão. O candidate procura código morto,
  duplicação, APIs semelhantes, violações de fronteira e lacunas de teste.

### Segurança sem atrito acidental

- **OMP removido do produto**: runtime RPC, adapters, configurações e interface
  foram eliminados; algoritmos vendor permanecem apenas com sua provenance.
- **Lease AGY removido**: o Nexus não altera mais a configuração MCP real do
  usuário, evitando bearer órfão, symlink destruído e conflito entre instâncias.
- **Teardown antes de apagar**: missão, tasks e receipts só são removidos após
  comprovação de encerramento físico; falha preserva todo o histórico.
- **Gates honestos**: risco em português recebe a severidade correta,
  requisitos explícitos desconhecidos continuam pendentes e
  `.dev-user-data/**` não contamina testes ou indexadores.
- **Smoke mantém autoridade até o resultado**: o deadline do runner permanece
  vivo enquanto o app assinado inicia. Gatekeeper lento não faz mais o Node
  encerrar com código zero e evidência vazia antes do primeiro evento.

## 0.19.36 — Bootstrap multi-CLI sem corrida

Data: 2026-07-28

### Release gate

- **Causa real do bootstrap preservada**: se a saída física do PTY vencer a
  corrida e bloquear o dispatch, o scheduler registra o erro do provider e a
  cauda redigida do terminal em vez de sobrescrevê-los com
  `dispatch sem autoridade de efeito no estado blocked`.
- **Claude-family confia somente na missão selada**: Claude OAuth e GLM/z.ai
  recebem no HOME isolado a confiança exata do cwd já aprovado pelo Main. O
  spawn falha fechado se essa projeção não estiver presente, evitando a saída
  precoce no diálogo interativo de folder trust.
- **Contrato GLM sincronizado**: schema, fixtures, cardinalidade do fan-out,
  staging de `providers.conf`, defaults Codex e testes do publish agora
  representam os sete advisors e a cadeia máxima de dez tasks.
- **Kimi expirado vira skip honesto**: strings de access/refresh token não
  bastam mais. O gate e a UI exigem access token com `expires_at` válido e
  margem mínima; sessão vencida fica `no-credential` em vez de abrir um pane
  quebrado em `/login`.

### Validação

- Typecheck verde.
- Suíte completa: 950 arquivos e 8.077 testes verdes.

## 0.19.35 — GLM no multi-CLI

Data: 2026-07-28

### Multi-CLI

- **GLM advisor no gate E2E**: adapter `glm` (binário Claude + `ANTHROPIC_*` z.ai)
  entra no fan-out consultivo; token só via `providers.conf` staged no HOME
  isolado (`glm=`/`zai=`). `reserveClaude` não se aplica (API key, não OAuth).
- Host bin: trusted-bin resolve `claude` para o id `glm`.

### Herdado da 0.19.34

Grok seal fix, fixture terra models, Claude advisor dispatch com orch Codex.

## 0.19.34 — Grok reviewer sobe

Data: 2026-07-28

Correção do bloqueio do release:candidate no advisor Grok read-only.

### Fix

- **Grok read-only sem selo Darwin pinado**: só Codex/Claude passam pelo
  `qualifyTrustedNativeConfinementLaunch` (Team ID + CDHash + versão). Grok
  confina com `--sandbox read-only` no argv do CLI e não tem authenticity root
  no Nexus — o spawn do reviewer E2E falhava com
  `adapter grok has no pinned native authenticity root` e bloqueava a missão
  após Kimi/OpenCode/executor/Codex-reviewer já terem handoff.
- **Claude advisor no dispatch com orquestrador Codex**: `resolveSealedWorkerRoute`
  recebia `orchestratorCliId` omitido e tratava `undefined !== 'codex'` como
  reserveClaude — bloqueava a missão após Kimi/OpenCode/Grok. Dispatch passa a
  ler a CLI do orquestrador do squad e permite Claude advisor quando o
  orquestrador não é Claude.
- **Handoff durável no retirement** (main): completion não aborta quando o
  handoff já está assentado.

### Herdado da 0.19.33

Multi-CLI, Claude Keychain slim, Codex default `gpt-5.6-terra`, OMP skip sem
vault, etc.

## 0.19.33 — Mais de Uma Cabeça

Data: 2026-07-28

Release de produção do multi-CLI + hardening de auth Claude (a 0.19.32 ficou
com tag/build, mas o gate E2E multi-CLI não fechou PASS no artefato final).

### Multi-CLI operacional

- **Agy half-dead não trava o wizard**: staging e auth detector exigem
  sessão Google viva (`oauth_creds` / conta active), não só item de Keychain
  ou pasta antigravity — evita "login new" desabilitando Usar este squad.
- **Gate PATH multi-CLI**: advisor bins (kimi/grok/claude/omp/agy/opencode) são
  linkados em `trusted-bin` do userData isolado — sem isso o wizard ficava com
  "Usar este squad" disabled e o gate morria em product-wizard-ready.

- **Advisors multi-CLI no gate e na missão**: Kimi, Grok, Agy, OpenCode, OMP e
  Claude (quando não for Maestro) entram como participantes com PTY, tools
  `nexus_*` e handoff; evidência registra tier (confined vs advisory).
- **Kimi headless sem `--auto` + `-p`**: o CLI rejeita a combinação; headless
  usa só prompt mode; YOLO interativo mantém `--auto`.
- **Kimi default k3** no catálogo/rota de worker.
- **YOLO advisory** preservado para CLIs advisory-unconfined.
- **Merge-council / reviewer read-only** enxerga `nexus_merge_review_submit`.
- **Timeout da missão real** alinhado ao council (~20 min).

### Claude Keychain e Maestro

- **Slim write**: vault e Keychain gravam só `{ claudeAiOauth }` (~0,5 KB), sem
  o mapa `mcpOAuth` (~11 KB) que quebrava o `security -i` (>3500 bytes).
- **Fallback de write** via arquivo 0600 se o path interativo falhar.
- **Sessão viva ≠ identidade**: email em `oauthAccount` sozinho não prova
  login; spawn governado / HOME isolado exige access token utilizável.

### Herdado da 0.19.32

Tudo abaixo (worker commit, multi-CLI confinement, prova dual Codex+Claude
orchestrator, Codex sandbox Darwin, etc.) permanece na linha 0.19.x.

## 0.19.32 — Mais de Uma Cabeça

Data: 2026-07-27

Entrega também tudo que estava preparado para a 0.19.31, que ficou retida nos
gates e nunca chegou a ser publicada.

### O worker volta a conseguir commitar

- **Commit em worktree isolado deixa de ser negado pelo sandbox**: um worktree
  vinculado guarda só um `.git` de uma linha; os objetos, refs e reflogs do
  commit vão para o repositório pai, que fica fora da raiz de execução do
  worker. O perfil Seatbelt negava essa escrita e todo commit morria em
  `Operation not permitted` — o worker então se recusava, corretamente, a
  reportar sucesso, e a missão bloqueava sem entregar. O sandbox passa a
  conceder exatamente as subárvores que um commit toca. `hooks/` e `config`
  continuam sem escrita: um daria execução de código arbitrário no host, o
  outro reescreveria remotes e filtros. Faixas somente-leitura não recebem
  nada disso.

### Todo CLI do squad entra na missão — confinado pelo kernel

- **Conselheiros de qualquer CLI**: Kimi, Agy, OpenCode, OMP, GLM, LongCat,
  Aider e Claude passam a participar como revisores e batedores
  somente-leitura, cada um com PTY próprio, ao menos uma tool `nexus_*` e
  handoff submetido. Aproveitar várias LLMs na mesma missão deixa de custar
  segurança — e usar mais modelos significa menos token gasto por modelo e
  mais pontos de vista sobre o mesmo código.
- **Sem lista para manter**: a participação é derivada da capacidade, não
  enumerada. Uma CLI que você instale amanhã entra assim que o adapter existir
  — sem editar código, sem esperar release. Os dois requisitos são técnicos e
  honestos: não se confinar sozinha (aí o Nexus confina) e ter rota de handoff
  físico (sem ela, nenhum participante consegue provar o que fez).
- **Detecção de login deixa de mentir**: três CLIs apareciam deslogadas
  estando autenticadas. O perfil do Claude só era copiado quando `oauthAccount`
  era texto, mas ele é um objeto — o campo que o Nexus lê para reconhecer a
  sessão sumia no caminho. O Agy era procurado pelo diretório de instalação em
  vez da credencial. E o Kimi recebia a credencial sem a configuração de
  modelos, então nascia e morria no start.
- **A barreira passa a ser do kernel, não do prompt**: essas CLIs não declaram
  confinamento somente-leitura próprio, e pedir por prompt que respeitem a
  faixa nunca foi uma fronteira. Em vez de afrouxar a exigência, o Nexus aplica
  o seu próprio perfil Seatbelt: a raiz de execução é montada somente-leitura
  pelo kernel, a única área gravável é o HOME privado que a sessão já cria para
  aquela CLI, e a rede fica restrita ao binário dela. Quem já traz confinamento
  verificado — Codex pelo perfil de argv, Grok pelo Seatbelt — continua usando o
  próprio.
- **Fail-closed**: se o confinamento não puder ser construído, a sessão não
  nasce. A ausência de um HOME privado nunca rebaixa a única barreira da missão
  para uma instrução de texto. Fora do macOS a faixa é recusada, não concedida
  sem sandbox.
- **A aprovação enxerga a faixa somente-leitura**: a fronteira final do main
  exigia escrita autônoma confinada de todo agente não-orquestrador, então
  qualquer missão com conselheiro morria antes de abrir o primeiro PTY. O
  executor continua exigindo Codex, e ninguém entra sem rota ativa de adapter.
- A evidência registra o tier de confinamento de cada participante.

### A prova acompanha o squad inteiro

- **Suíte real-mission multi-CLI** com recibos de participação (schema v9):
  cada advisor credenciada precisa aparecer fisicamente na evidência, e quem
  não tem credencial é registrado como pulado — nunca silenciado.
- **Variante com orquestrador Claude** fechando o ciclo completo
  (kickoff → dispatch → handoffs → integração → done) com evidência atestada
  dupla no gate.
- O wizard qualifica os advisors e o gate fecha em FAIL sem `wizardReceipt`.

### Codex e o sandbox do Darwin

- **PTY nasce do Helper (Plugin)**: a autorização de launch do supervisor só
  aceitava o Helper base e o main. O host PTY roda em `utilityProcess` e
  morria com "helper exited before authenticated exec", derrubando o kickoff
  do Codex. Agora Plugin/GPU/Renderer são aceitos com Team e identifier do app.
- **Selos do bundle liberados no launch-auth**, com falha registrada em vez de
  silenciosa.
- **Hooks selados sobrevivem ao perfil Codex isolado**: trust preservado,
  transporte silencioso e loopback permitido dentro do sandbox.
- **Espera de panes abaixo do timeout MCP do Codex**, para o orquestrador não
  ser cortado no meio do próprio boot.

## 0.19.31 — Missão Cumprida (não publicada)

Data: 2026-07-26

### Hotfix de release (quit / smoke)

- **Product-wizard E2E não morre no passo causal**: o gate físico abre o
  squad fixture e, após o clique confiável de lançamento, submete o objetivo
  exato `REAL_MISSION_E2E_GOAL` até a aprovação nativa — sem exigir que o
  operador re-digite o multi-line do release. A rejeição do main agora
  propaga o motivo real (capability, observer, binding).
- **PREVC do gate real-mission deixa de bloquear no bootstrap**: a policy do
  scratch casa com o schema atual (`requireDifferentProviderFor` vazio) e as
  attestations de contexto são seladas no prepare do fixture, antes do
  orquestrador, para o doctor de guided PREVC ficar pronto.
- **Quit com shell vivo deixa de travar na prova PTY**: o shutdown do app
  usa uma janela generosa de término; status 0 com SIGTERM residual no
  node-pty conta como recibo Darwin; e se a raiz já morreu o inventário
  main conclui em vez de prender o app no diálogo "sessões sem prova
  física". O smoke empacotado aguarda até 45s pelo `shutdown-complete`.


### Da ideia à entrega em um único fluxo

- **Uma aprovação com autoridade real**: salvar o squad deixou de abrir um
  modal obrigatório antes de outro modal. O roster exato é persistido no
  próprio lançamento e uma única revisão nativa compacta mostra objetivo,
  critérios, orçamento, runtime, squad, hashes e eventual substituição de
  Maestro. Um recibo SHA-256 integral sela também os detalhes resumidos.
- **Wizard para quem não programa**: objetivo e resultado esperado vêm
  primeiro; opções técnicas aparecem por contexto. Rail, fan-out e painel
  contextual formam uma linha de trabalho contínua, inspirada na clareza
  operacional do Orca e fiel ao design system Nexus.
- **Erros e overlays que cabem na tela**: o wizard usa a altura visual real,
  mantém somente o corpo rolável e conserva as ações alcançáveis em janelas
  baixas. Toasts ficam abaixo do dimmer e fora do caminho do formulário;
  falhas de IPC, PREVC e worktree viram orientação humana inline, enquanto o
  diagnóstico integral permanece em Operações.
- **Greenfield de verdade**: projetos vazios aceitam scaffolds comuns de web,
  Python, Go, Rust, Java/Kotlin, .NET, Swift, C/C++, Ruby, PHP, Flutter e
  containers sob uma lista finita de ownership, sem globs e sem abrir acesso a
  `.env`, `.git`, `.github`, `.npmrc` ou `.nexus`.
- **Artefato pedido entra no selo**: um arquivo novo citado de forma explícita
  no objetivo aprovado, como `resultado.txt`, é normalizado e acrescentado
  como um único caminho exato ao plano. URLs, globs, traversal, conteúdo
  citado, menções negadas, árvores ocultas/reservadas e qualquer arquivo não
  pedido continuam fora do merge.
- **Sensores que existem de verdade**: o Doctor não fabrica mais
  `npm/typecheck/unit` em uma pasta vazia. Gates de package manager respeitam
  scripts, manager e `cwd` reais; configuração incompatível não vira
  autoridade silenciosa e comandos de teste não recebem flags específicas de
  outro runner.

### Todo o squad participa, e o resultado chega ao próximo

- **Fan-out completo do roster executável**: cada identidade da cópia revisada
  recebe trabalho compatível com sua função. O wizard só distribui execução
  autônoma entre CLIs cuja barreira nativa foi qualificada; executores
  implementam, e revisores/QA consomem o resultado anterior.
- **Consumo comprovado**: cada aresta dependência→consumidor grava um recibo
  imutável somente depois que o prompt com o handoff foi fisicamente aceito
  pela sessão correta. ACK em massa não autoriza conclusão.
- **Entrega fail-closed**: a missão só conclui com handoffs físicos, tentativas
  aceitas, consumo por downstream, integração e QA. Claims de terminal sem
  provenance continuam sendo apenas dados não confiáveis.
- **PREVC antes do primeiro worker**: missões guiadas congelam no processo
  principal o contrato exato da intenção aprovada antes de qualquer worker,
  claim, worktree ou efeito de execução. Quando ainda falta contexto, somente
  um Maestro de bootstrap nativamente read-only e revisores independentes
  confinados podem preceder o freeze; nenhum deles recebe autoridade de
  entrega. No scheduler, até a resolução da conta do worker fica atrás do
  gate. Workers só nascem em `execution`; revisão pendente bloqueia sem deixar
  uma meia missão viva.
- **Dependência lógica não vira Git fantasma**: reviewers e advisors
  read-only continuam obrigatórios por receipt e handoff, mas apenas
  predecessores com worktree físico entram no grafo do WorktreeManager.

### PRD não se perde na promoção

- **Plan → standard selado**: o Nexus seleciona o handoff físico da sessão de
  planejamento, valida provenance, sela resumo, artifacts e hashes, mostra o
  conteúdo na aprovação e o persiste na nova revisão do contrato.
- **Execução recebe o plano exato**: tarefas e prompts da nova sessão carregam
  o PRD aprovado e seus digests. Corrupção, troca de sessão ou mudança durante
  a confirmação interrompe a promoção.

### CLIs reais, governadas

- **Claude Opus 5**: modelo oficial no catálogo Claude e OMP, com preço,
  roteamento e testes de integração que validam o identificador
  `claude-opus-5` nos dois adapters.
- **OMP autenticado sem segredo no Nexus**: a detecção consulta somente a
  existência da credencial local habilitada para o provider do **modelo exato**
  escolhido, no banco do OMP em modo somente leitura. Modelo ou provider
  desconhecido falha fechado; o conteúdo da credencial nunca sai do broker e
  somente o material daquele provider entra no processo.
- **Subagentes sob o roster**: Codex recebe `multi_agent` desativado, Grok
  recebe `--no-subagents` e OMP usa allowlist física sem a ferramenta `task`.
  Panes diretos permanecem completos; o confinamento vale para missões
  governadas.
- **Skills e mídia guiadas sob seal**: o Squad Architect deriva allowlists por
  papel a partir de um vocabulário Nexus conhecido/instalado e o main refaz a
  projeção na cópia runtime antes do snapshot; JSON de modelo/renderer não
  amplia skills ou tools. Somente o executor visual Codex de uma missão que
  pede asset recebe a skill main-owned `nexus-visual-media` e exatamente
  `nexus_media_providers` + `nexus_image_generate`; os demais workers continuam
  com tools vazias. A skill proíbe os caminhos incompatíveis
  `imagegen`/`hatch-pet`, API key ambiente e `generated_images`. Gerar imagem
  ainda exige a confirmação nativa de custo e permanece limitado ao workspace.
- **Worktree não finge ser sandbox**: escrita autônoma guiada fica limitada ao
  Codex 0.145.0 builtin. O main materializa o perfil privado
  `workspace-write` e remove flags de bypass, raízes adicionais e
  perfis/configs que ampliariam o processo na última fronteira de spawn. Kimi,
  OpenCode, OMP e as demais CLIs sem qualificação continuam disponíveis em
  panes diretos/manuais, mas não recebem autoridade mutante só porque o `cwd`
  aponta para um worktree.
- **Provider validado antes de executar no macOS**: o Nexus resolve o Mach-O
  nativo do fornecedor, sem executar o wrapper de descoberta, e um supervisor
  assinado o cria suspenso. Identificador, cadeia Developer ID, Team ID,
  CDHash e responsabilidade da imagem viva precisam coincidir antes do
  `SIGCONT`; até o probe `--version` passa pela mesma fronteira autenticada,
  em vez de executar o binário antes da attestation. Divergência encerra a
  coorte sem liberar código do provider. Essa garantia começa quando o
  supervisor já está em execução e não afirma que toda a cadeia anterior do
  `node-pty` esteja ligada por inode ou livre de TOCTOU.
- **Autoaprovação sem YOLO global**: depois da única aprovação nativa, o Codex
  mantém `on-request` como política global no macOS. Somente o servidor MCP
  efêmero, bearer-bound e main-owned daquela missão recebe
  `default_tools_approval_mode="approve"` no próprio namespace; MCPs
  ambientais e panes diretos não herdam essa decisão. O Codex usa
  `danger-full-access` apenas dentro do Seatbelt externo do Nexus, para evitar
  um segundo perfil aninhado; o perfil externo continua sendo a autoridade
  física sobre HOME, temp, filesystem e rede por executável.
- **Dependências sem egress remoto nesta release**: no macOS, o Seatbelt
  concede rede somente ao caminho verificado do provider Codex; shell,
  package managers e demais descendentes continuam offline. Instalação remota
  de pacotes fica indisponível em vez de abrir proxy, MITM ou fallback de
  egress. `load_workspace_dependencies` informa caminhos exatos de runtimes
  locais já disponíveis, como Python/Pillow, Node.js, pnpm e Git, sem consultar
  registry ou GitHub. A revisão nativa mostra a restrição e seu digest;
  missões read-only ou sem executor qualificado exibem rede desativada.
- **Pet Studio voltou a ser executável sem furar o HOME**: o maker usa a skill
  main-owned `nexus-pet-studio`, mídia Nexus e Pillow conhecido para construir
  o v2 no output exclusivo da missão dentro do workspace, sem rede de
  subprocessos. O handoff precisa de provenance MCP física; o main valida
  arquivos regulares por descriptor, rejeita symlink/hardlink e instala
  atomicamente um id novo em `~/.codex/pets`, com retry idempotente e sem
  sobrescrever pacote diferente.
- **MCP físico**: endpoint loopback autenticado e OMP RPC registram provenance
  assinada para handoffs. Rotas de Maestro são classificadas por evidência
  mecânica, não pelo nome do modelo.
- **Toolchain sem a falha de expansão de braces**: toda a árvore do Electron
  Forge usa a implementação corrigida `brace-expansion` 5.0.8 por um pacote de
  compatibilidade local, com fonte upstream, licença, hashes e provenance
  verificáveis. O adaptador preserva as APIs CJS/ESM exigidas por minimatch
  3/5/9 sem alterar o algoritmo; auditorias npm de produção e build ficam em
  zero enquanto os backports upstream ainda não são publicados.
- **Roster aprovado vence configuração antiga**: o Maestro selado na revisão
  da missão tem precedência sobre um default global obsoleto. Uma cópia de
  squad gerada e salva recebe id estável, reaparece no seletor e não some como
  artefato efêmero do engine.

### Autoridade e encerramento sem processo órfão

- **Troca exclusiva de Maestro**: o processo principal inventaria sessões da
  mesma família de autenticação, revoga dispatch, fecha os candidatos e só
  aprova a nova missão depois de provar a saída da árvore antiga.
- **Quit aguarda descendentes**: o desligamento encerra PTYs, filhos e
  bootstrap de recuperação com resultado auditável. No macOS, um helper
  universal assinado cria uma responsabilidade de processo própria e prova a
  ausência até de double-forks reparentados antes de sair; ausência de prova
  impede a confirmação de término. O fechamento da última janela sela a
  admissão antes da primeira espera e considera o inventário global de PTYs e
  OMP, inclusive missões headless e spawns em voo. Se uma prova falha, o app
  permanece aberto, preserva inventário, observadores e stores para retry e
  não reabre a cerca; a orquestração só fecha depois das provas físicas e da
  reconciliação das saídas.
- **Saída natural libera o próximo agente**: quando o PTY já produziu ausência
  física, mas o renderer ainda conserva por um instante a folha visual sem
  `sessionId`, o Main colapsa somente a referência única com missão, pane,
  papel, encarnação e scope exatos. Sessão substituta, duplicata, cross-scope,
  main-owned ou OMP vivo continuam fail-closed; reviewer e QA podem ocupar a
  vaga no mesmo passe do scheduler.
- **Handoff terminal não vira falso erro**: um handoff bloqueado ou falho pode
  revogar intencionalmente a própria autoridade da missão sem transformar a
  resposta já persistida em falha de transporte. Bearer, workflow, abort e
  provenance continuam sendo revalidados antes e depois do commit.
- **Retry perdido não duplica entrega**: handoff, receipt e transição do
  dispatch entram na mesma transação. Se a resposta de rede se perder, um
  retry idêntico consome seu novo receipt one-shot e apenas relê o resultado
  físico já persistido; não cria outro handoff, não reenvia delivery e não
  reabre a autoridade da missão. Payload, sessão, encarnação, HEAD ou
  evidência divergentes falham fechado.

### Prova de release e superfícies endurecidas

- **O ZIP precisa cumprir uma missão pelo produto**: o gate da release abre o
  MissionWizard visível no app empacotado e exige uma aprovação Nexus aceita,
  zero prompts de autorização MCP do Codex, quatro PTYs físicos e três tarefas
  encadeadas — executor, revisor e QA — com três handoffs e prova final de Git.
  Revisor e QA precisam chegar ao PTY com confinamento read-only real; o
  runner privado permanece um comando de diagnóstico separado, não roda no
  gate e não pode promover evidência de interface. Assim, a validação da
  release também pede uma única aprovação, sem repetir a missão inteira.
- **IPC sensível pertence à janela principal viva**: mutações de conta,
  provider, settings, squads e updater aceitam somente o `WebContents` exato
  da janela principal, no frame principal e na origem esperada. Sender
  desconhecido, navegado, destruído ou vindo de subframe falha fechado sem
  registrar path, query, fragmento ou payload potencialmente secreto.
- **Servidor e renderer com baseline verificável**: o backend remove
  fingerprint do Express, emite CSP, anti-framing, `nosniff`, referrer e
  permissions policy também em 404, que agora é JSON. O build recusa sinks
  executáveis de HTML/JS no renderer e preload; HSTS continua deliberadamente
  na borda, onde a topologia TLS completa pode ser validada.

## 0.19.30 — Encerra e Entra

Data: 2026-07-25

### O orquestrador não nasce mais deslogado

- **Pane de missão volta a abrir autenticado**: o orquestrador roda num HOME
  efêmero, e de lá o CLI do Claude não enxerga o login do Keychain — a
  credencial só chega pelo ambiente do processo. Esse token era justamente
  retirado quando a conta escolhida É o login nativo da máquina, regra correta
  para pane no HOME real e fatal para pane com HOME isolado. Como a retomada
  main-owned passou a fixar a conta em toda missão, o orquestrador abria em
  "Not logged in · Run /login" com a máquina perfeitamente autenticada — e
  ainda escrevia "Welcome back", porque a identidade viajava mesmo sem a
  credencial. A decisão agora conhece o HOME que o pane vai receber.
- **HOME real continua sem token de ambiente**: lá o CLI usa e renova a própria
  sessão. Um instantâneo estático teria precedência sobre o login e expira em
  horas — era a origem do erro de credencial expirada ao reabrir um pane.
- **Falha com motivo, nunca em silêncio**: sem credencial legível para um pane
  de HOME isolado, o Nexus recusa o spawn explicando o que fazer, em vez de
  entregar um orquestrador mudo que trava a missão inteira sem dizer por quê.

### A missão finalmente começa

- **Diálogo de confiança da pasta não trava mais o orquestrador**: o HOME
  efêmero nascia sem o registro de confiança do diretório, então o CLI abria
  "Do you trust the files in this folder?" e esperava uma tecla que ninguém ia
  mandar. A missão ficava "Ao vivo" com o agente parado na tela de boas-vindas
  para sempre. Agora o pane carrega a confiança que você já concedeu no perfil
  real — só as flags, só daquela pasta. Pasta nunca confiada continua
  perguntando: o Nexus não inventa confiança que ninguém deu.
- **Squad built-in volta a iniciar missão**: antes de despachar, o wizard
  precisa persistir o roster revisado (o bootstrap deriva o time do squad
  salvo). Ele tentava salvar por cima do built-in, que é imutável, e o
  despacho morria calado — clicar "Começar" não fazia nada nos 11 NEXUS
  ORIGINALS. Agora o built-in vira uma cópia editável com id novo, exatamente
  como o erro mandava fazer, e a missão despacha com o id da cópia.

### Terminal desenha o histórico na largura certa

- **Pane reaberto não volta mais embaralhado**: o conteúdo salvo era reescrito
  antes da primeira medição do pane, numa grade na largura padrão. Como a
  interface do agente desenha caixas com posição absoluta, a moldura caía por
  cima do texto quebrado — letras duplicadas, espaços comidos e caracteres
  soltos empilhados na borda. O histórico agora só é reescrito depois que o
  terminal conhece a largura real. Panes cujo histórico já foi salvo
  corrompido seguem feios até serem fechados: o que está estragado é o
  arquivo, não o desenho.

### Encerrar missão viva volta a funcionar

- **A confirmação não briga mais com a própria missão**: encerrar re-conferia,
  depois do modal, um selo que incluía o carimbo de atualização da missão.
  Qualquer escrita durável ocorrida enquanto o operador lia o modal — um
  aprendizado do agente, uma troca de status, um worker nascendo ou morrendo —
  invalidava a aprovação e devolvia "mission runtime changed while confirmation
  was open". Quanto mais viva a missão, mais impossível encerrá-la. A aprovação
  vale para a MISSÃO; o inventário de processos é reconferido na hora do
  desligamento, que segue exigindo prova física de saída de cada um.

## 0.19.29 — Encerrar de Verdade

Data: 2026-07-24

### Encerrar uma missão passa a ter prova física

- **Nunca mais "encerrou" sobre processo vivo**: uma sessão que a missão ainda
  aponta, fisicamente viva e sem autoridade de pane que a atribua, era pulada
  em silêncio — o encerramento devolvia sucesso e ainda apagava o
  `orchestratorSessionId`, deixando o processo órfão e sem nenhum ponteiro
  durável para alcançá-lo. Agora isso NEGA com erro nomeado, a missão vira
  bloqueio técnico e o vínculo é preservado para a reconciliação. Mesmo
  tratamento para worker vivo da missão sem pane vinculado.
- **Encerramento de operador preserva o histórico**: canal próprio com modal
  nativo, fence de runtime e preservação total de tasks, entregas, receipts e
  histórico. Idempotente quando não resta processo algum.
- **Aviso honesto**: "1 sessão encerrada" quando houve desligamento real
  versus "nenhum processo restava vivo" — antes o no-op era indistinguível do
  encerramento de verdade.
- **Lista não trava mais**: recusa da autoridade virou resultado em vez de
  promessa rejeitada; sem isso o estado ocupado ficava preso e desabilitava
  todos os botões da lista sem explicar nada.

### A lista de missões volta a esvaziar

- **Agrupamento pelo runtime físico**: missão sem sessão e sem pane sai de "Em
  progresso" e cai em "Encerradas" (fechada por padrão). Encerrar tudo e
  continuar vendo todas as missões como ativas era o velho "travado em N
  missões".
- **Arquivar**: missão despachada carrega receipts que o Nexus se recusa a
  apagar; arquivar tira do rail e do board sem tocar em nada durável, com
  desarquivar no próprio card. Runtime vivo cancela o arquivamento na vista.

### Retomada é sempre do processo principal

- **Bootstrap main-owned é o único dono**: toda missão bloqueada retoma pelo
  main, que adota o PTY ainda vivo ou limpa a identidade comprovadamente morta
  e sela um pane novo. O respawn de panes persistidos pelo renderer criava
  pane fantasma e o beco circular do "Retomar missão".
- **Reabertura forçada é recusada cedo**, antes de qualquer operação com poder
  de spawn.
- **Reload de página não mata a sessão**: uma sessão que já pertence ao MESMO
  renderer reata após HMR, Cmd+R ou recuperação de crash, em vez de morrer na
  cerca de saída física.
- **Selo de autoridade viaja com o processo** e entra no confronto de runtime
  do bootstrap.

## 0.19.28 — Retomada Real

Data: 2026-07-24

### App nunca congela com o Keychain trancado

- **Main thread nunca mais espera o SecurityAgent**: com o login keychain
  auto-trancado (máquina sem usuário), a primeira gravação do vault pendurava
  o processo inteiro num `SecItemAdd` síncrono esperando senha — timers do
  scheduler morriam e a missão travava em pleno merge. O processo do release
  gate agora roda com o vault desativado (fail-closed; as CLIs autenticam
  nativamente), e o freeze foi diagnosticado por stack sample e coberto.
- **Timers do orquestrador imunes a suspensão**: `powerSaveBlocker`
  (prevent-app-suspension) + Chromium sem throttling de timers em background
  — um IDE que orquestra agentes de longa duração não pode ter a fase de
  timers adiada quando perde o foco.
- **Observer do gate não starva o event loop**: reavaliação agendada na fila
  de timers (`setTimeout 0`) em vez de `setImmediate` re-armado por cada
  store change — output contínuo de PTY não afoga mais os timers do main.
- **Scheduler com skips nomeados**: early-returns do merge e do tick (kickoff
  ausente com merge pendente, worktree fora do registry, dispatch em estado
  inesperado, reconcile sem scheduler) agora avisam no console com o motivo —
  fim dos travamentos mudos.

### Recuperação de missão fecha o ciclo

- **Retomar funciona de ponta a ponta**: missão `blocked_technical` volta pelo
  bootstrap main-owned (re-arma pela transição sancionada, limpa identidade de
  orquestrador comprovadamente morta e refaz spawn+kickoff com recibo).
  Validado ao vivo: missões presas voltaram a rodar com sessão nova e kickoff
  aceito.
- **Remover destravado**: missão bloqueada sem sessão e sem receipts reais
  (handoffs/tasks) pode ser removida; pane rows são identidade de respawn e
  caem em cascata. Missão com sessão viva ou receipts continua preservada.
- **Cercas de autoridade com diagnóstico nomeado**: o selo do bootstrap, as
  cercas de spawn (pending/persistido) e a autoridade stale agora listam os
  campos divergentes com valores — fim dos erros mudos de comparação.
- **Selo compara autoridade canônica**: `null` e `undefined` significam ambos
  "não especificado" em tools/skills (squads desenhados pelo arquiteto omitem
  o campo); `[]` continua distinto. O modelo validado é o solicitado/selado,
  nunca o alias normalizado pelo provider.
- **Pane zumbi não bloqueia missão nova**: conflito de credencial exclusiva
  exige PTY vivo; pane com spawn falho não segura a família claude.
- **Worker entregue não é pane morto (recorrência)**: o driver decide pelo
  dispatch mais recente da identidade — histórico com replan/supersedes não
  reintroduz o respawn loop.
- **Grant de recovery vence o modo pedido**: consent de retomada correndo
  contra a recuperação fresh do driver não mata mais os dois caminhos — com
  grant pendente o main decide o modo; sem grant, fresh continua exigindo
  grant e só exact resume reanexa.

### Gate único de aprovação

- **Um gate humano por missão**: a aprovação apresenta o hash exato do
  roster/contrato; salvar squad NOVO com roster cercado (workers com
  allowlist explícita sem wildcard) não pede segundo modal. Sobrescrever,
  expandir autoridade ou deletar continuam atrás do modal nativo.
- **Modais nativos compactos fixados por hash**: salvar/launch imediato/import
  de squads mostram resumo limitado + SHA-256 do conteúdo integral (alerta
  nativo não tem scroll; o dump estourava a tela e travava o app).
- **Cercas de tamanho obsoletas removidas**: squads legítimos com instruções
  longas não são mais vetados ('squad review exceeds 6000 characters',
  'approval_review_too_large').

### Modo Agêntico

- **Time novo de verdade**: o arquiteto desenha um squad para o objetivo em
  vez de reusar silenciosamente o squad salvo mais recente (reuso virou
  opt-in). O picker não lista squads gerados pelo motor (`agentic-`/`custom-`).

## 0.19.27 — Golden Path

Data: 2026-07-23

### Orquestração com autoridade durável

- **RouteReservation obrigatória**: decisões do router passam a ser seladas
  por missão e revisão, com adapter, modelo, esforço, expiração e consumo
  atômico. Spawns fora do roster sticky precisam apresentar exatamente a
  reserva emitida por `nexus_route_task`.
- **Roteamento com diversidade**: o ranking considera tier, histórico,
  qualidade, custo, participação OMP e atenuação de repetição sem trocar um
  candidato mais capaz por um fallback inadequado.
- **Bootstrap main-owned**: plano, squad, grants, sessão e pane do
  orquestrador são derivados e revalidados no processo principal; reinício ou
  troca do renderer não transfere autoridade.

### Execução observável até o fim

- **Kickoff com aceite físico**: o prompt só é considerado entregue após uma
  janela idle injetável, envio seguro e prova de saída + borda `idle → busy`.
  Timeout, saída da sessão ou perda de autoridade bloqueiam a missão com ação
  de retomada, sem falso sucesso.
- **Dispatcher e handoff verificáveis**: tasks usam leases, incarnation,
  ownership e worktrees persistidos. Worker só termina após handoff aceito e
  a missão só conclui com receipt de integração ou validação confiável.
- **Recuperação convergente**: revogação de bearer, término físico, falha de
  merge e reinício convergem para estados duráveis sem duplicar spawn,
  kickoff ou integração.
- **Modelo padrão sem falso bloqueio**: o bootstrap valida o modelo solicitado
  e selado, não o alias normalizado pelo provider, evitando bloquear a missão
  quando o runtime aprovado usa o modelo padrão.
- **MCP autônomo sob confinamento nativo**: orquestradores Codex de uma missão
  aprovada continuam com filesystem nativo read-only, inclusive antes do
  freeze PREVC, mas não abrem uma segunda confirmação do provider para chamar
  as tools Nexus já auditadas.
- **Gate Codex sem falso aceite**: a missão empacotada prepara a confiança
  somente para seu repositório descartável e canônico, em HOME isolado e
  privado, evitando que a tela inicial de confiança consuma o primeiro kickoff.
- **Worker entregue não é pane morto**: o driver deixa de contar como "pane
  dead" um worker cujo dispatch já saiu de `running` (handoff aceito, merge ou
  completed) — o CLI sair após entregar é o ciclo esperado. Isso elimina o
  loop de respawns fúteis que bloqueava missões já integradas.
- **Conclusão destravada sob contrato congelado**: congelar o contrato PREVC
  para validar merges não torna mais a missão inconcluível. O plano verificado
  (rota, roster, receipts, entrega aceita) conclui a missão enquanto o driver
  PREVC não tiver assumido via step receipts — com receipt existente, o
  bypass continua vedado.
- **Integração por merge commit aceita no gate**: os validadores de evidência
  (app, compartilhado e script) aceitam fast-forward (2 commits) ou merge real
  (3 commits), mantendo a invariante de resultado exato descendente do commit
  inicial.

### Segurança e release

- **Electron endurecido**: limites de navegação, XSS, IPC, downloads, browser,
  mídia, SSH e companion foram revisados com validação fail-closed e testes
  dedicados.
- **Aprovação visível em telas pequenas**: a confirmação nativa foi reduzida a
  um resumo fixo de 12 linhas, mantendo objetivo, critérios, anexos, restrições,
  roster, runtime e hashes do contrato sem esconder os botões de ação.
- **Release local canônica**: Node/npm, commit, tag, SBOM, auditorias,
  assinatura, notarização, Gatekeeper, DMG/ZIP e missão E2E precisam apontar
  para o mesmo candidato antes de qualquer publicação.

### Qualidade

- **Validação local**: typecheck do app e servidor; suíte principal e do
  servidor; gates de segurança, build limpo, assinatura, notarização e missão
  E2E do artefato candidato.

## 0.19.26 — Piloto Automático sem Modal

Data: 2026-07-22

### Autopilot de verdade

- **Missão aprovada = autorização**: aprovar a missão (objetivo/plano) autoriza
  a execução inteira — o agente não para mais em modal de confirmação a cada
  comando (o stall de minutos por ação acabou). Deploy, SSH, edição de código
  e browser fluem direto, tudo auditado.
- **Piso de segurança mantido**: comandos destrutivos (`rm -rf`, `dd`,
  `mkfs`…) sempre pedem confirmação humana, mesmo com missão aprovada; ações
  fora de missão aprovada seguem com confirmação.
- **PREVC funciona sem limitar**: sem contrato congelado a missão executa
  normalmente (apenas `.context/` protegido); com contrato, todas as regras
  PREVC (stage, drift, receipts) continuam valendo. Tarefas mistas de
  infra + código funcionam — restrições de lane são opção avançada, nunca
  padrão.

### Wizard sem jargão

- **Fluxo único**: objetivo + lançar. Os "tipos de entrega" saíram da tela
  principal e viraram `Opções avançadas` colapsadas, em linguagem simples,
  com `Sem restrições (recomendado)` como default — a sugestão automática por
  objetivo nunca restringe a missão por conta própria.
- **Kickoff anti-travamento**: o orquestrador é instruído a executar direto e
  tratar freeze/bootstrap PREVC como best-effort em segundo plano, nunca como
  pré-condição.

### Qualidade

- **Validação local**: suíte integral e typecheck; testes de confirmação
  reescritos para o novo contrato (autopilot sem modal, destrutivo sempre
  confirma, revalidação pós-confirmação preservada no caminho com modal).

## 0.19.25 — Piloto Automático de Verdade

Data: 2026-07-22

### Execução sem travas

- **Lane `ops` (Operação/infra)**: missões de operação — backup em VPS, deploy,
  landing page, DNS, SSH — executam terminal/browser direto, sem exigir o
  contrato PREVC de arquitetura. Mantidos: aprovação de intenção pelo usuário,
  confirmação por ação perigosa, auditoria fail-closed. Edição de código, git e
  worktrees seguem negados nessa lane; o wizard sugere `Operação (infra)`
  automaticamente para goals de infra.
- **Fila de bootstrap destravada**: retry da mesma ferramenta (`context_doctor`)
  faz *join* na execução em voo em vez de morrer com `prompt_queue_busy`;
  watchdog de 10 min libera slot preso; awaits de orientation ganharam bound —
  uma missão nunca mais deadlocka esperando o mapa do projeto.
- **Bootstrap converge sem segundo provider**: o usuário vira o revisor
  independente — nova seção em Diagnóstico lista os rascunhos de contexto com
  `Revisar e aprovar contexto` (atestação registrada como revisor humano);
  reviewer pane que nunca vota morre após 2 tentativas em vez de loopar para
  sempre, e os hints apontam para a aprovação humana.

### Panes que sobem direto

- **Codex sem "hooks need review"**: o instalador dos hooks de status agora
  pré-semeia `trusted_hash` no `~/.codex/config.toml` (hash idêntico ao do
  codex-rs, validado ao vivo no codex 0.145 via `hooks/list`), e o spawn usa
  `--dangerously-bypass-hook-trust` em codex ≥ 0.134 para os hooks per-session.
  Panes Codex não abrem mais na tela de review de hooks.
- **Login OMP sem aba fantasma**: a autorização OAuth do oh-my-pi abre em
  janela in-app endurecida (sessão efêmera, sandbox, navegação https/loopback)
  que abre e fecha sozinha — fim da aba "Authentication Successful" pendurada
  no navegador.

### Qualidade

- **Validação local**: suíte integral (6.009 testes), typecheck e revisão
  sênior dos pontos de relaxamento (lane ops fail-closed por padrão, trust
  seeding cirúrgico preservando o config.toml do usuário).

## 0.19.24 — Terminal ao Vivo

Data: 2026-07-21

### Terminal fluido e confiável

- **Digitação visível em tempo real**: toda tecla devolve o pane ao trecho ao
  vivo antes de chegar ao PTY; o eco do shell/composer da CLI é repintado no
  mesmo frame, sem depender de Enter para aparecer.
- **Recuperação do renderer**: perda de contexto WebGL cai para o renderer de
  fallback com repaint imediato; foco, backlog e dimensões do PTY são
  sincronizados ao reabrir ou mover o pane.
- **Histórico explícito**: ao rolar para trás, o terminal sinaliza o estado e
  informa que digitar retorna ao fluxo ao vivo.

### Contexto e facilidade de uso

- **Workspace inequívoco**: a barra mostra `WORKSPACE ATIVO`, nome e caminho
  completo no seletor; `Novo workspace` permanece visível em todas as telas.
- **Piloto automático primeiro**: o modo recomendado é apresentado antes do
  controle manual, explica que o Nexus monta, executa, revisa e testa o time e
  troca jargão interno por ações claras como `Preparar missão`.
- **HUD e bloqueios acionáveis**: Jarvis inicia compacto e missões bloqueadas
  indicam como retomar o trabalho.
- **Oh My Pi legível**: painel, modelo automático, confirmações e estado vazio
  deixam de expor detalhes de transporte como NDJSON/PTTY ao vibe coder.

### Orquestração e qualidade

- **OMP single-flight por missão**: workers concorrentes não duplicam o
  auto-companion antes de sua persistência ficar visível.
- **Spawn sem vazamento**: falha ao aguardar readiness ou enviar o primeiro
  prompt encerra processo, gate e slot da frota.
- **Configuração responsiva**: controles do OMP usam duas colunas legíveis e
  caem para uma coluna em janelas estreitas.
- **Validação local**: suíte integral, typecheck, build macOS, assinatura,
  notarização e verificação de artefatos executados manualmente, sem Actions.

## 0.19.23 — Piloto Automático Real

Data: 2026-07-21

### Orquestração autônoma e recuperação

- **Entrega com prova por evento**: prompts e handoffs observam toda a borda
  `idle → busy`, inclusive turnos que terminam em menos de 400 ms, eliminando
  reenvios e trabalho duplicado causados pelo polling tardio.
- **Reviewer se recupera na mesma passagem**: panes preservados mortos,
  incompatíveis ou que recusam o brief são fechados e substituídos
  automaticamente, sem exigir uma segunda execução do Doctor.
- **Quorum honesto**: um único provider continua bloqueando review
  independente; dois providers liberam autor + reviewer e o terceiro vira
  recomendação do Review Council.

### Providers e modelos

- **OMP sem falso bloqueio de login**: o Nexus deixa o cofre multiprovider do
  próprio OMP decidir a autenticação e permite iniciar o terminal/painel para
  usar qualquer conta já conectada ou abrir o fluxo de login.
- **AGY 3.6 alinhado ao CLI real**: default publicado em
  `gemini-3.6-flash-high`, variantes medium incluídas e id inexistente do
  Sonnet removido; tarefas leves passam a usar 3.6 Flash.

### Interface e qualidade

- **Notificações responsivas**: o inbox fica contido nas quatro bordas em
  janelas estreitas/baixas, inverte para cima quando necessário e mantém
  rolagem interna sem recortar conteúdo.
- **Gate completo de release**: 5.929/5.929 testes da aplicação, 152/152 do
  servidor, typechecks e smoke do artefato aprovados em Node 22; auditoria npm
  zerada antes da assinatura, notarização e verificação macOS.
- **Sem consumo automático de Actions**: tags não disparam runners hospedados;
  o pipeline remoto permanece disponível apenas por dispatch explícito.

## Unreleased — Route brain (x-algorithm) + Oh My Pi zero-friction

Data: 2026-07-18

### Ranking / frota (padrões x-algorithm + grok-build)

- **Multi-score re-rank** em missões com histórico: quality + custo + diversity
  attenuation + omp prefer + circuit open skip.
- **Circuit breaker** por adapter (closed/open/half-open) no spawn + routing.
- **Hot cache** de adapters (~5s) com invalidação em `adapters.changed`.
- Plano mestre F1–F4: `docs/analysis/2026-07-18-master-plan-grok-build-x-algorithm.md`
  (CoW worktrees, hunks, sandbox, plan mode, bg tasks — próximas fases).

### Oh My Pi

- **Default `prefer` + `ompAutoSpawn: true`**: omp entra sozinho no primeiro
  worker não-omp da missão.
- Sticky roster, transporte auto, yolo auditado em mission rpc, Fleet + Rail.

## 0.19.22 — Jarvis Operacional + Fluxo Rápido

Data: 2026-07-21

### Jarvis realtime e voz passiva

- **Continuidade Live sem travar em `speaking`**: a fila de PCM tardia agora
  tem drenagem testável, supersessão segura e timeout; follow-up bloqueado volta
  a `idle` assim que o áudio termina.
- **Watchdog operacional de verdade**: uma fase presa invalida turno, transcript
  e deadlines, cancela captura/follow-up, descarta PCM tardio, limpa gates e
  interrompe o provider antes de liberar a interface.
- **Fallback mudo mais rápido**: Live → Classic passa de 6 s para 3,5 s sem
  alterar o caminho Live saudável.
- **TV/ambiente não alimenta STT para sempre**: assinatura de áudio contínuo com
  `forcedByMax`, verdicts observáveis e backoff 3/6/10/20/40/60 s barram o loop
  passivo localmente; pausas humanas e wake aceito resetam o estado.

### Operação, missões e paridade Orca/Overclock

- **Drop global de arquivo/código** abre o wizard agêntico com o anexo; `⌘⇧N`
  entra direto no objetivo da missão.
- **Painel contextual orientado à atividade**: Missão é a aba inicial e o
  marketplace ganhou superfície própria no launcher/painel.
- **Mission Rail mais operacional**: chip de branch Git, alterações pendentes e
  comparação fan-out dos agentes lado a lado, escopada por missão.
- **Editor e navegação refinados**: gutter de linhas, Tab com dois espaços e
  escape acessível, barra de status e auto-hide de tabs irrelevantes.
- **Companion mobile**: scaffold Expo com contrato/API inicial em `mobile/`.

### Qualidade da release

- Metadados internos, servidor, lockfile e changelog sincronizados em `0.19.22`.
- Análise de 5.081 eventos da Jarvis e snapshot rotativo do Overclock
  documentados sem apresentar telemetria anterior como prova pós-correção.

## 0.19.21 — Estúdio Seguro

Data: 2026-07-20

- **Estúdio de Mídia** para geração de imagem e vídeo com fluxo acessível ao
  usuário final, referências fail-loud, cancelamento e custo de vídeo exposto.
- **OMP cli-rpc como pane de primeira classe** no grid, preservando o modelo
  operacional dos demais agentes.
- **Hardening de auth, credenciais e acesso remoto** após três rodadas de
  revisão, reduzindo os achados de severidade crítica/alta para baixa.
- **Timeout de imagem honesto** e cancelamento consistente no motor de mídia.

## 0.19.20 — Sci-Fi de Verdade

Data: 2026-07-19

- **UI sci-fi refinada** com paridade de renderização mac/win/linux.
- **GitHub Device Flow OAuth** com erros tipados + gate push→PR (emdash W2).
- **Stack SSH colhida do emdash**: ProxyJump, `ssh -G`, proxy resiliente,
  port-forward — host key sempre nossa.
- **Cards de pane com atividade real**, zero LLM (colheita Overclock).
- **Security floor fail-closed** no router: na dúvida o tier sobe.
- **Probe de credencial pré-spawn** + watchdog de login-stuck (Overclock F-256).
- Ranking público rotula fixture como estimativa; renderer volta a montar no
  dev (QR vendor vira bundle ESM).

## 0.19.19 — Missão Que Começa

Data: 2026-07-18

Correções de produção no fluxo de missão (modo agêntico) e na Jarvis:

- **Começar no agêntico**: falso positivo do gate de evidência ("em seguida…
  do print") deixava a missão em `awaiting_goal` e o botão Começar falhava com
  `cannot dispatch from intent state awaiting_goal`. O gate agora exige ação de
  envio/anexo (ou "com prints"); approveIntent promove contrato já compilado.
- **Shell Sem objetivo**: clicar em Retomar numa missão intent-first reabre o
  wizard com o objetivo — em vez do erro "não tem panes registrados".
- **Power-off da Jarvis**: corta a fila de narração e o áudio em voo; o status
  idle não reacende a fala até o próximo wake/PTT.

## 0.19.18 — Deixa de Travar

Data: 2026-07-17

Auditoria completa das causas de freeze — "toda hora um limite diferente" tem
raiz numa pilha de gates onde quase tudo exige contrato congelado. Dois
desgates seguros (a integridade de mutação de código fica intacta):

- **Documentar e planejar não travam mais**: gerenciar a lista de tarefas
  (todo_manager) e perguntar ao usuário (clarify) caíam no bloqueio genérico e
  exigiam contrato PREVC congelado — o mesmo gate do git push. Não faz sentido:
  organizar e perguntar vêm ANTES de congelar contexto. Agora rodam livres.
- **Sensores recomendados viram aviso, não bloqueio**: exigir os sensores
  typecheck E unit trancava o freeze de qualquer projeto sem exatamente esses
  dois — e sem freeze, tudo trava. Agora é recomendação; os sensores que
  existirem seguem rodando.

Somado à 0.19.17 (draft-fantasma destravado + mais workers) e à 0.19.14 (fim do
teto de tokens), a maquinaria do Nexus para de esbarrar em limite a cada passo.

## 0.19.17 — Missão Destravada

Data: 2026-07-17

- **Fim do wedge de draft-fantasma**: um draft de contexto órfão de outra
  missão trancava o arquivo (índice único por target) mas ficava invisível na
  lista escopada por missão — sem ID, a missão não conseguia rejeitar, o freeze
  falhava e o PREVC nem começava. Agora o erro do propose já traz o ID/status/
  missão do bloqueador, e a nova tool nexus_context_draft_supersede libera o
  target por caminho — a missão se autodestrava.
- **Teto de workers menos sufocante**: como o teto de tokens virou só telemetria
  (0.19.14), o limite real é o nº de workers; os presets antigos (2 na sensível,
  3 na normal) foram calibrados na era do teto de token e travavam missões que
  precisavam de mais braços. Agora: sensível 3 workers / 400 passos, normal
  4 workers / 600 passos (destrutiva segue 1, por segurança).

## 0.19.16 — Modelo que Você Escolhe

Data: 2026-07-17

- **O modelo escolhido é o modelo que roda**: a superfície de seleção podia
  oferecer um id que o CLI não roda (ex.: `gpt-5.6` depois de a OpenAI
  renomear para `gpt-5.6-sol`/`-luna`/`-terra`); o CLI ignorava e caía
  silenciosamente no default `gpt-5.5`. Agora o roteador E o spawn resolvem o
  modelo contra a lista REAL do CLI — id exato quando roda, senão a variante
  da mesma família — e nunca emitem um modelo fantasma. Vale para o roster do
  squad, o route_task e squads salvos com id antigo.
- **Colar print (⌘V) nas evidências da missão**: cole um screenshot direto no
  compositor de objetivo e ele vira anexo de evidência, sem sair para o Finder.
- **Operador vivo (gamificação)**: XP por turnos de agente e feedback visual do
  progresso do operador.

## 0.19.15 — Login sem Terminal

Data: 2026-07-17

- **Login OAuth de assinaturas direto no painel OMP·RPC**: a nova seção
  Contas lista os provedores que o omp suporta (Claude Pro/Max, ChatGPT,
  Gemini CLI, Copilot…) com status de conexão e botão Conectar — a URL de
  autorização abre no navegador pelo app e a credencial grava no cofre do
  omp, sem abrir terminal. Antes, só `zai/glm` aparecia (única API key
  herdada do vault) e o login exigia rodar `omp auth-broker login` na mão.
- **Dropdown de modelos atualiza na hora**: ao concluir o login, o painel
  re-busca os modelos disponíveis sem reiniciar a sessão.
- **Mais API keys do vault chegam ao omp**: OPENAI, GEMINI, XAI, GROQ,
  CEREBRAS e MISTRAL agora são injetadas a partir do providers.conf.

## 0.19.14 — Sem Freio de Mão

Data: 2026-07-17

- **Fim do teto sintético de tokens**: missões travavam com "12k tokens de
  execução esgotados" ainda no bootstrap — mas esses tokens eram FICTÍCIOS
  (100-400 estimados por tool, nunca a conta real do provider). O ledger de
  steps/tokens vira telemetria pura: registra, nunca bloqueia. Missões já
  travadas por orçamento destravam sozinhas no próximo passo.
- Proteções reais permanecem: mission driver (iterações/tempo), PREVC e
  limite de workers vivos.

## 0.19.13 — Missão com Nome Próprio

Data: 2026-07-17

- **Missão agêntica não veste mais a identidade do squad reusado**: o modo
  agêntico continua honrando o roster salvo, mas a missão agora nasce com o
  título do SEU objetivo (não "Clone Overclock" numa missão de dashboards) e
  as instruções do squad são reapontadas para o objetivo vigente — o
  orquestrador não recebe mais duas missões concorrentes no kickoff.
- **Modelo escolhido na revisão persiste até o spawn**: eventos de
  adapters/providers (quota, install-check) resetavam o roster editado — o
  Fable escolhido para o orquestrador voltava silenciosamente a opus-4-8.
  O roster agora só recarrega quando o squad muda de verdade.
- **Notas internas de release sincronizadas**: a tela "O que há de novo"
  estava parada na 0.19.7; versões de server e lockfile realinhadas.

## 0.19.12 — Instala de Verdade

Data: 2026-07-17

- **Instalador de CLIs com cascata de canais**: quando o canal primário não
  funciona na máquina (sem Node/npm, sem Homebrew, ou o clássico erro de
  permissão do npm -g), o instalador cai automaticamente para o canal oficial
  alternativo — Claude usa o instalador nativo da Anthropic, Codex cai para o
  brew, Kimi e opencode tentam brew e npm. Sem nenhum canal utilizável, o
  resumo diz exatamente o que falta ("instale Node OU Homebrew") em vez de
  falhar em silêncio.
- **omp instala em máquina sem Homebrew**: o oh-my-pi ganhou o instalador
  oficial do projeto (omp.sh/install) como fallback — era brew-only e ficava
  sem rota nenhuma em máquina fresca.
- **Instalador acha o brew/npm mesmo com PATH incompleto**: app aberto pelo
  Finder pode não herdar o PATH do terminal; a seleção e a execução dos
  instaladores agora procuram também nos diretórios padrão (/opt/homebrew/bin,
  /usr/local/bin, ~/.local/bin) — fim do "sem Homebrew" com o brew instalado.

## 0.19.11 — Rota Livre

Data: 2026-07-17

- **Fim do loop de respawn**: pane que continua morrendo após 3 respawns
  consecutivos leva a missão a um estado terminal com causa acionável
  ("verifique login/credencial do adapter e use Retomar no rail") em vez de
  churnar para sempre — era o bloqueio nº 1 nas missões reais auditadas.
- **Drift de contexto deixou de ser morte**: nova tool
  nexus_mission_refreeze_contract re-congela o contrato após mudanças no
  contexto (.context/, attestations, policy) preservando objetivo, critérios
  e escopo; o workflow recomeça na rota para revalidar evidência e o rigor
  nunca é rebaixado. A mensagem de drift agora aponta a cura em vez de um
  "not ready" vazio.

Com esta release, os sete becos sem saída da família "missão travada"
mapeados na auditoria de 17/07 estão fechados.

## 0.19.10 — Máquina Nova

Data: 2026-07-17

- **Piloto automático de máquina nova**: no primeiro boot com CLIs
  ausentes, um diálogo nativo lista os comandos exatos e instala tudo em
  sequência ao aceitar — do DMG ao cockpit operacional em minutos.
- **Provisionador de CLIs**: botão único no hub de Providers instala TODAS as
  CLIs ausentes em sequência (instaladores oficiais, uma confirmação nativa
  por CLI mostrando o comando exato) — máquina fresca fica operacional sem
  caçar botão por painel.
- **Permissão de tela sem calvário**: "Pedir permissão ao macOS" registra o
  NexusIDE na lista de Gravação de Tela na hora (o macOS só lista o app após
  a primeira tentativa de captura — agora o Nexus tenta por você e o prompt
  nativo aparece). Nos Ajustes é só virar a chave, sem "+" nem buscar pasta;
  o fluxo guiado em 3 passos fica na própria tela Vision.

## 0.19.9 — Sem Fantasmas

Data: 2026-07-17

- **Login 401 do Claude morto de vez**: conta pinada que é o login nativo do
  Keychain spawna sem token env (a linhagem que o CLI mantém fresca); contas
  secundárias ganham renovação automática do OAuth no vault a cada 15min —
  respawn de failover nunca mais encontra token expirado.
- **Cooldown fantasma se auto-limpa**: leitura fresca da API do provider com
  janelas saudáveis refuta cooldown persistido (resíduo da cascata) e a conta
  volta ao pool; cooldown maior que 5h agora pinta a barra Semanal — nunca
  mais "5 Horas 100%" com reset de 10 horas.
- **Missão antiga não ressuscita sozinha**: o driver só dirige missões com
  atividade na sessão atual do app; retomar uma antiga voltou a ser decisão
  sua.
- **Nova Missão com "Planejar · PRD"**: quarto card pula direto para o squad
  de planejamento BMAD (lê o código, entrevista, entrega PRD + arquitetura
  com diagrama + stories).
- **Updates sem gh CLI**: o updater ganhou fallback para um espelho público
  de releases via API anônima — máquinas de terceiros atualizam sozinhas
  (espelho a ativar).
- **Uso e cotas**: cards com barras, percentuais e resets alinhados.

## 0.19.8 — Destrava Geral

Data: 2026-07-17

- **Fim da cascata de limite fantasma**: o detector de failover não relê mais o
  próprio continuity pack injetado na conta nova — acabou o efeito dominó que
  derrubava conta por conta até a frota inteira entrar em cooldown com cota
  sobrando. Segunda camada: leitura fresca da API do provider refuta limite
  falso antes de trocar de conta. Painel Integrações virou modal focado.
- **Terminal fluido**: contextos WebGL alugados por recência de foco (o
  terminal que você olha renderiza acelerado mesmo com 10+ panes), o zoom e a
  troca de monitor reajustam a grade na hora, e Alt+roda rola 5x.
- **Missões destravadas**: o freeze do contrato não trava mais com WIP fora da
  superfície de evidência (.context/ + docs de raiz); o limite de workers
  conta só workers VIVOS (worker morto não segura slot para sempre); o erro de
  contexto chega com remediação por blocker; e o terminal do orquestrador
  ganhou autoridade para commit, git push e merge.
- **Oh My Pi operacional**: o /login OAuth completa dentro do painel (botão
  "Abrir no navegador"), e o omp entrou no roster de todos os squads builtin.
- **Planejamento estilo BMAD**: squads novos "Planejamento & PRD" (lê o
  sistema real → entrevista você com a skill grilling → PRD e arquitetura com
  templates/checklists reais do BMAD → stories) e "Implementação por Stories"
  (SM → Dev → QA com Definition of Done). Skills archify (diagramas HTML),
  grilling e bmad-templates embutidas para todas as CLIs.
- **UI sem garimpo**: configurações numa lista plana com tudo visível
  (Companion mobile a 1 clique), botão desligar da Jarvis desliga de verdade,
  browser sem tela branca no load (fundo escuro + barra de progresso) e erros
  honestos no proxy, nas licenças e no Vision.

## 0.19.7 — Chaves Herdadas

Data: 2026-07-16

- **omp herda as API keys do Nexus**: as chaves que você já salvou (GLM/z.ai,
  Moonshot/Kimi, DeepSeek, MiniMax, Qwen, OpenRouter, Anthropic por key) são
  injetadas automaticamente na sessão do omp com os nomes que ele reconhece —
  esses providers funcionam sem nenhum login extra. Só entram chaves que
  existem no vault; nada vaza do ambiente.
- Assinaturas (Claude Max, plano Codex, GLM coding plan) continuam pelo
  /login do próprio omp — 1 clique de autorização no navegador, por design
  dos providers (token por aplicativo, revogável e dentro dos termos).

## 0.19.6 — Pet Obediente

Data: 2026-07-16

- **Pet não gruda mais no mouse**: soltar o botão fora da janelinha (ou o OS
  roubar o ponteiro) encerra o arrasto na hora via lostpointercapture; o
  watchdog de resgate caiu de 30s para 10s.
- **Pet não some mais em fullscreen**: entrar/sair do fullscreen nativo
  re-afirma o pin de all-workspaces (visibleOnFullScreen), garante
  visibilidade e reclampa o pet para a área visível.

## 0.19.5 — Frota Completa

Data: 2026-07-16

### Orquestração

- **omp em operação de background**: entra na tabela de roteamento (tiers
  medium/hard, agregando os providers logados no próprio omp) e ganha o
  assento Reviewer D no squad builtin Review P0–P3 — o pipeline é um port do
  review do próprio oh-my-pi, agora ele participa do próprio rito.
- **Editor de squad vira modal centralizado**: abria inline no fim da lista
  (fora da viewport, exigia rolagem). Agora: dialog no meio da tela com
  scrim, Esc/clique-fora, foco no primeiro campo e scroll interno.
- **Polish do painel**: painel mais largo com respiro, tab ativa com âncora
  de acento, toolbar sticky, cards com hover, campos do editor com focus
  ring e roster em cartões.

## 0.19.4 — Paridade Viva

Data: 2026-07-16

### Modo Design

- **Emulação mobile real**: o breakpoint 📱 ≤480px agora troca user agent e
  métricas de tela (com reload) — o site serve o layout mobile de verdade
  (menu hambúrguer, media queries), não só a largura estreitada. Voltar para
  ▯/🖥/⛶ restaura o navegador normal.

### Forge (GitHub/GitLab)

- **GitLab MR ligado**: criar PR/MR usa a camada forge com autorização
  explícita (escopo + expiração) e auditoria para GitHub E GitLab — token via
  NEXUS_GITLAB_TOKEN ou sessão do glab CLI.
- **"PR desta branch"**: o painel de integrações mostra o PR/MR aberto da
  branch atual, clicável — read-side getReviewForBranch finalmente com UI.

### Instalador de CLIs

- **agy, kimi e grok** entram no 1-clique com canais oficiais verificados:
  kimi via brew kimi-code / npm @moonshot-ai/kimi-code; grok via npm
  @xai-official/grok; agy pelo instalador oficial de antigravity.google,
  baixado por HTTPS e executado sem pipe de shell. 8 das 9 CLIs instalam
  pelo app.

### UX

- **Ferramentas da barra fecham as Configurações**: painéis não abrem mais
  atrás do drawer (parecia clique morto).
- **OMP RPC diz por que morreu**: saída prematura mostra o motivo real
  (ex.: falta de /login) e oferece "Abrir omp no terminal (/login)".

## 0.19.3 — Operacional para o Cliente

Data: 2026-07-16

Lote de correções guiado por bugs de operador no 0.19.2 — cada fricção
reportada virou fluxo funcional, com foco em máquina de cliente fresca.

### Contas e providers

- **Conta por login dispara o fluxo de auth** (P0): "Entrar com nova conta"
  (e "Fazer login agora" no status Login necessário) abre um terminal já
  rodando o login da própria CLI — `claude /login`, `codex login`,
  `grok login`, `kimi login`, `opencode auth login`, `agy` — e o CLI abre o
  navegador na URL do provider. Nada de URL hardcodeada; GLM/LongCat (token)
  ficam de fora por design.
- **Instalador 1-clique de CLIs**: provider ausente ganha "Instalar
  automaticamente" (e o painel OMP, "Instalar omp automaticamente" com retry).
  Receitas em código de fontes oficiais confirmadas (claude/codex/gemini via
  npm; opencode e omp via brew), confirmação NATIVA mostrando o comando exato,
  pré-check do runner com instrução honesta.
- **GitHub sem setup**: sem PAT, o Nexus usa a sessão do `gh` CLI
  (`gh auth token`, cache 60s, nunca persistido) — PRs/issues funcionam na
  hora em máquina com gh logado.
- **Kimi K3 + descoberta viva de modelos**: K3 e highspeed no catálogo, e o
  "Atualizar modelos" agora pergunta à própria CLI o que ela conhece
  (`kimi provider list --json`) — modelo novo aparece sem esperar release.

### Modo Design

- **Desligar nunca mais falha**: SPA ocupada que não confirmava o
  design_disable deixava a barra presa em "ON + erro"; o desligamento local
  virou autoridade.
- **Erros legíveis**: o wrapper cru do Electron ("Error invoking remote
  method 'br…'") vira texto curto e acionável, com tooltip da mensagem
  completa; erros de lifecycle benigno resetam a barra em silêncio.
- **Preview mobile sempre visível**: 📱 375 / ▯ 768 / 🖥 1440 / ⛶ saem de trás
  do toggle do Design e vivem na barra do browser pane, com rótulos.

### Infra de release

- CURRENT_RELEASE (notas internas) e server/package.json passam a acompanhar
  a versão — invariante que o bump 0.19.2 tinha furado (achado da suíte).

## 0.19.2 — Orquestração Destravada

Data: 2026-07-16

Auditoria senior sobre o runtime real do operador encontrou e corrigiu a
cadeia inteira que fazia toda missão morrer no bootstrap, o falso "não logado"
nos panes do Claude, o bloqueio permanente de workspace no `workspace:pick` —
e entregou o restyle visual que estava preso fora do main.

### Orquestração — bootstrap de contexto convergindo (PR #34)

- **Reviewer independente destravado** (P0): o gate MCP negava
  `nexus_context_draft_review` de panes sem missão — mas drafts de projeto têm
  missionId nulo e o reviewer é spawnado sem vínculo por design. Todo draft
  ficava `proposed` para sempre e nenhum contrato congelava. Exención estreita
  por nome (precedente `memory_retain`); a autoridade real segue no handler
  (reviewer ≠ autor, provider distinto, re-hash de fontes).
- **Fim do `sourceHash` incomputável** (P0): agentes hospedados não têm tool
  de hash; o Nexus agora computa o sha256 das fontes no propose (e re-verifica
  em review/apply). `expectedTargetHash` omitido vincula ao estado atual.
- **Review em andamento não é falha** (P0): `context_draft_review_run` devolvia
  "timed out" após 2 min com o pane revisor ainda vivo; agora responde
  `pending` com instrução de poll via `context_draft_get`.
- **`missing-structured-invariants` tem caminho** (P1): hint do autopilot e
  remediação do doctor ensinam o movimento sancionado — invariante OBSERVADA de
  fontes reais em `.context/nexus/invariants/*.json` + revisão independente.
- **`nexus_git_status` em raiz não-git** (ex.: workspace multi-projeto) devolve
  `{isRepo:false}` com nota, em vez de "Git executable-config inspection
  failed".

### Auth e identidade

- **Pane do Claude não pede mais /login com a máquina logada** (P0): o HOME
  efêmero de panes gated ganhava um `.claude.json` stub sem `oauthAccount`
  (a identidade é file-backed; o Keychain guarda só o segredo). O adapter
  Claude nativo projeta a identidade no overlay (+link de `.credentials.json`)
  e o teardown resgata login fresco feito dentro do pane. GLM/LongCat nunca
  recebem a identidade nativa.
- **`workspace:pick` não trava mais o workspace** (P0): pasta apagada e
  recriada no mesmo path deixava o registro em "checkout id collision" para
  sempre; mesma-path agora se auto-cura, paths diferentes seguem fail-closed.

### Visual e produto

- **Restyle `ui/mission-rail-polish` entregue**: onboarding Bridge-inspired
  centrado (hero, trail de steps, featured cards) reconciliado com a camada
  endorfinada (pet, saudação); MissionRail com chips de meta (ativas/aqui/
  budget compacto); MissionWizard com cards de modo badge/CTA.
- **GitHub de primeira classe**: botão inline na workspace bar (saiu do menu
  ⋯) + aviso claro de que "Entrar com GitHub" (conta Nexus) não configura a
  API — o PAT vive no painel de integrações.
- **Inbox de notificações sem corte**: nome do agente usa a largura livre com
  tooltip; rótulo "Login do CLI" virou "Contas reserva".
- **Router com gpt-5.6/gpt-5.6-sol** no catálogo e nos tiers hard/critical.

### Backend SaaS

- **Assinaturas Pro em BRL** (frente paralela): tier Free permanente + Pro
  mensal com Stripe Checkout, portal, webhooks assinados e cloud sync
  Pro-only; deploy Railway, migrações e runbooks de produção.

## 0.19.1 — Cockpit Endurecido

Data: 2026-07-16

Correções de um review senior adversarial (2 frentes) sobre o pacote Labs +
inbox de agentes recém-integrado à 0.19, com todos os achados até LOW fechados
e teste de regressão por achado.

### Inbox de notificações de agentes

- **Fim do "CONCLUÍDO" falso no respawn** (HIGH): a época de atividade passa a
  registrar sua origem — só um turno real (idle→busy) pode concluir; boot e
  respawn (spawning→busy) nunca contam. Reabrir um workspace com N agentes não
  gera mais N avisos fantasmas.
- **Painel volta a aparecer** (HIGH): a zona de status da barra é
  `overflow:hidden` e recortava 100% do popover; ele passa a `position:fixed`
  ancorado ao sino, escapando do clip.
- **Alinhado ao que a tela mostra** (MEDIUM): o bridge consome `displayStates`
  (hold de ~1,4 s), então um gap silencioso no meio de um turno não emite
  "concluído" prematuro.
- a11y: foco devolvido ao sino ao fechar; `role="status"`/`aria-live` anuncia
  avisos novos; `Esc`/`Tab` não vazam para overlays por baixo
  (`stopImmediatePropagation`); ícone de sino próprio (era o raio duplicado); os
  botões de ação carregam o nome do agente. Jump lê o layout vivo. Fecha ao
  abrir qualquer drawer maior. Teste de componente novo.

### Labs / feature flags

- **Desligar a flag do companion derruba o relay ativo** (HIGH): antes, desligar
  `feature.remote.relayTransport` com sessão aberta era fail-open (o celular
  seguia conectado); agora o override encerra o transporte, e a seção Companion
  mostra o controle **Parar** quando há sessão viva mesmo com a flag off.
- **Persistência robusta** (MEDIUM/LOW): rollback do estado vivo quando o disco
  falha (main nunca diverge do arquivo); o modo de força de dogfood
  (`NEXUS_FORCE_ALL_FLAGS`) virou camada efêmera e não vaza mais para o arquivo
  de overrides; overrides de flags que o build não conhece sobrevivem a
  downgrade→upgrade.
- **Só a janela do app altera flags** (MEDIUM): os canais de flag passam a
  validar o sender — um WebContentsView de pane de browser não muta mais o
  estado global.
- LOW: `Labs` promovido à navegação primária (o painel de descoberta não podia
  viver atrás do "Avançado"); precedência de resolução corrigida na copy
  (kill switch > canal > override > default); hints atualizados (memória tem
  painel; relay abre a seção Companion); pending por-id (Set) no toggle; uma
  única resolução por flag no list; painel de Memória re-busca ao mudar a flag.

## Não lançado — Mobile em tempo real com sessão persistente

Fecha os dois últimos degraus operacionais do companion no device (dossiê
2026-07-15 §7): o thin client deixava de parear a cada reload e fazia poll de
2,5 s num `<pre>` enquanto o stream binário existia server-side sem uso.

- **Push de terminal em tempo real**: a bridge assina `tapSessionData` e
  empurra `pane.stream.data` (terminal-stream-protocol, mesmo domínio de seq
  do `pane.read`) para os sockets autenticados que abriram
  `pane.stream.open`. Backpressure derruba frames em vez de acumular buffer
  (fail-safe ≤256 KiB por socket); o gap de seq resultante é detectado pelo
  cliente e curado com um `pane.read` de reconciliação.
- **Thin client streaming**: decodifica os frames no browser (header de 16
  bytes, opcode Output), acompanha seq, aparo de cauda para memória de
  celular, e rebaixa o poll para reconciliação de 15 s (2,5 s permanece como
  fallback em bridge antiga sem push).
- **Sessão persistente**: token guardado em `localStorage` da origem HTTPS da
  própria bridge — reload não re-pareia; revogação/expiração no desktop
  derruba o auth server-side e o cliente volta sozinho à tela de pareamento
  com o motivo.
- Compatibilidade: `handleAuthedMessage` ganha `pushTarget` opcional — o
  caminho do relay (companion-relay-transport) segue request/response
  intacto. TDD: push só para inscritos + seq monotônica + isolamento de
  sessão não relacionada; suíte remota 109/109; `tsc` limpo.
- Endurecido pela rodada de review (Codex + CodeRabbit, 7 achados):
  **remote-output-bus** unifica o tap de PTY entre bridge WS e relay do
  companion (UM encode por chunk — bridge+relay simultâneos não criam gaps
  falsos entre si); **cursor de push dedicado** (`pushSeq`) imune aos encodes
  de resposta de `pane.read`/`pane.input` (sem tempestade de resync entre
  clientes); negociação explícita `pushAvailable` (bridge antiga mantém poll
  2,5 s); inscrição única por socket + `pane.stream.close` (pane antigo não
  enche o buffer); debounce de reconciliação por gap; revogação AO VIVO
  derruba o cliente para a tela de pareamento; token só é apagado em rejeição
  explícita do auth (queda de rede preserva a sessão).

## 0.19.0 — Oh My Pi na tela

Segunda leva do crossover [oh-my-pi](https://github.com/can1357/oh-my-pi): as
capacidades que só viviam no backend/MCP ganham UI de primeira classe. Reconciliada
sobre a 0.18.0 (Cockpit Ligado).

### Adicionado

- **Painel de Memória** do workspace: stats por tipo/escopo + recall FTS5 com
  debounce, navegação por teclado, AA e estados vazio/desligado. IPC read-only
  `memory:*` escopado por gate.
- **Inventário de configs**: painel do que cada CLI enxerga no workspace
  (MCP/rules/skills/commands) por ecossistema, com shadowing destacado.
- **Preço/janela no seletor de modelo**: `ModelMetaBadge` no wizard de missão via
  IPC read-only `model:richMetadata`.
- **Companion mobile na tela**: seção de Settings inicia/para o relay E2E, exibe
  QR e links full/view com aviso de segurança; push de PTY ligado ao pty-manager.
- **Exclusividade de drawer direito** (orquestração/omp/memória), **registry de
  buffers** do editor (hashline modo buffer), botões de Memória e Configs na
  WorkspaceBar.

### Corrigido

- Reconciliação com a 0.18.0: adotado o toggle de flags `Labs` da main (canal
  único `product:flags.setOverride`), removida a implementação duplicada do
  crossover para evitar handler IPC em conflito.
- `ModelMetaBadge` tolera `window.nexus` ausente (ambiente de teste).
- Release metadata realinhada em 0.19.0.

## 0.18.0 — Cockpit Ligado

Data: 2026-07-16

Fase de operador único: capability pronta atrás de flag invisível não é
maturidade, é estoque. A 0.18.0 liga por default tudo que tem superfície
pronta, entrega o painel Labs para operar flags pela UI, resgata o inbox de
notificações de agentes (PR #20) e consolida o que estava "não lançado":
perfil de design no motor automático e anotações do Design Mode. Inclui
também todo o crossover Oh My Pi da 0.17.0 (nunca tagueada).

### Labs + superfícies ligadas por default

- **Configurações → Sistema → Labs**: painel com TODAS as feature flags do
  produto — estado real resolvido pelo main (kill switch > override > canal >
  default), descrição PT-BR, switch persistido e "Restaurar padrão" quando há
  override. Antes, o único caminho era editar `feature-flags.json` à mão no
  userData; agora é um clique, com push ao vivo para a UI gateada
  (`product:flags.setOverride` + broadcast `product:flags.changed`).
- **Default-ON** (9 flips, decisão revisada pinada em teste): blocos de
  comando do terminal (OSC 133), journal de eventos de missão, busca
  unificada, onboarding progressivo, painel contextual, editor de workspace
  (caminho textarea + guarda de hash), catálogo de skills, memória Markdown
  `.nexus-memory/` e memória agentic por workspace (FTS5).
- **Continuam default-OFF, agora ligáveis pelo Labs**: MCP Hub sync (escreve
  configs de outras ferramentas no HOME — ligar é decisão deliberada), relay
  E2E do companion (exige relay hospedado + URL `wss://` explícita) e perfis
  de autonomia (sem consumidor na UI ainda).
- Registry ganha `clearOverride` (voltar ao default) e o hook
  `useProductFlags` passa a reagir ao push de mudanças sem reiniciar o app.
- TDD: override aplicado/limpo/persistido e fail-closed para id desconhecido
  (3), contrato de defaults por flag re-pinado (shared + registry), hook com
  defaults novos, seção Labs (5: render, toggle, restaurar, kill switch,
  reasons). `tsc` limpo.
- **MCP Hub também default-ON** (pedido do operador): toda escrita em
  config de terceiros segue click-gated — dry-run → confirmação → backup;
  fill-gaps nunca deleta. Ficam OFF só relay E2E (exige relay hospedado +
  URL `wss://`) e perfis de autonomia (sem consumidor na UI) — ligá-los
  hoje seria no-op; ambos alternáveis no Labs.

### Inbox de notificações de agentes (resgate do PR #20)

- Sininho na workspace bar com CONCLUÍDO / ENCERRADO por pane de agente:
  "concluído" só após busy sustentado (≥1,5s) — idle curto não spamma;
  "Ir ao pane" foca o agente e valida se o pane ainda existe (toast quando
  não); marcar lida, marcar todas, limpar; teto de 40 itens; focus trap +
  Esc no painel.
- Bridge de transições vive fora do session-state-store (sem side-effects
  no store), é idempotente e desliga limpo no teardown do orch-bridge.
- Reimplantado sobre a main atual a partir da stack revisada do PR #20
  (#19 → #20 fechados); domínio puro + bridge com testes (8) verdes.

### Perfil de design no motor automático

- O motor que injeta a Carta de Design nos workers de UI ganha um **perfil de
  design** configurável em Configurações → Squads: **direção estética**
  (Auto / Minimalista / Brutalista / Soft) e três **dials 1–10** — ousadia de
  layout, intensidade de motion e densidade visual (conceito adaptado do
  taste-skill, MIT — ver `THIRD_PARTY_NOTICES.md`; texto injetado é nosso).
- Frugal por construção: direção Auto + dials na banda neutra (4–7) injetam a
  carta pura, byte a byte — o recurso não custa nada no prompt de quem não o
  usa. Só dials extremos (1–3 / 8–10) e direções explícitas viram linhas.
- As proibições anti-genérico da carta continuam absolutas: o perfil modula o
  gosto dentro delas (o bloco injetado declara isso ao agente), e valores fora
  da faixa em settings antigos são clampados em vez de quebrar o spawn.

### Anotações de Design (paridade Orca Design Mode)

- Design Mode ganha **anotações**: com um elemento selecionado, "＋ anotar" abre
  um composer próprio (comentário + intenção corrigir/mudar/pergunta/aprovado;
  Enter no composer anota — nunca envia nada ao agente) e fixa a nota no
  elemento — badge numerado aparece na própria página. Os badges seguem o
  elemento VIVO pelo selector (sobrevivem a reflow, breakpoints da própria
  design bar e sticky), com fallback para a geometria congelada. Teto de 20
  por página.
- Tray "📝 N" na design bar lista as anotações (excluir uma, limpar todas),
  **copia** o feedback consolidado (funciona sem nenhum agente aberto — dry
  run não exige alvo) ou **envia tudo de uma vez** pro agente: um prompt único
  numerado igual aos badges, com os dados da página no envelope não confiável
  padrão e DESIGN.md anexado como contexto confiável quando existir. As notas
  do usuário NUNCA são cortadas pelo orçamento do prompt — envelope e
  DESIGN.md encolhem primeiro (com `omittedEntries` explícito). Itens
  [pergunta] pedem resposta; [aprovado] são registro.
- Anotações sobrevivem ao toggle do modo Design (dá pra navegar a página e
  enviar depois) e morrem com o documento — por UM caminho único de
  invalidação que cobre navegação real, **rota SPA (pushState)**, crash do
  renderer da página e destruição do pane (troca de workspace): main, badges
  na página e renderer resetam juntos via evento `navigation` sintetizado
  (antes a design bar ficava "ON" fantasma após reload). Saltos só de hash
  preservam as anotações.
- O sync dos badges é enfileirado e nunca bloqueia a resposta das ações do
  tray (a página ocupada não congela mais o "＋ anotar" por até 7s).
- O store é main-owned: o renderer só envia a nota digitada; o contexto do
  elemento é o snapshot da seleção já validada por Zod. Os badges na página
  recebem SÓ geometria — comentários nunca chegam ao lado da página.
- `nexus_design_selection_get` passa a listar as anotações da página (e
  continua respondendo quando só há anotações, com o picker desligado).
- Origem: adaptado do Design Mode do Orca (stablyai/orca @ 5e10091, MIT) —
  viewport-bridge de badges, modelo de anotação e formato do feedback — com
  provenance em `third_party/provenance/orca-5e1009.json` e notas em
  `THIRD_PARTY_NOTICES.md`. Fecha o terceiro alvo do transplante Orca
  (mobile QR ✓, forge-registry ✓, design mode ✓).
- TDD: marcadores do preload (9), picker rectPage/isFixed (+1), sessão de
  anotações no main (+6), formatter (4), envio em lote (+4), tool MCP (+3),
  UI da design bar (+6). `tsc` limpo.

## 0.17.0 — Oh My Pi

Crossover com o coding agent open-source [oh-my-pi](https://github.com/can1357/oh-my-pi)
(MIT): peças maduras vendoradas e integradas ao cockpit, não reescritas do zero.
Provenance em `third_party/provenance/oh-my-pi-03c48d0.json`; análise senior em
`docs/analysis/2026-07-15-oh-my-pi-crossover-senior.md`.

### Adicionado

- **Pane omp de primeira classe** via `omp --mode rpc-ui` (NDJSON tipado sobre
  pipes): estado determinístico (sem PTY-scraping), streaming, custo/contexto ao
  vivo, troca de modelo cross-provider mid-session. Aprovações sempre no host com
  auditoria fail-closed; host tools roteadas pelo skill-gate real; spawn sempre
  com `--approval-mode always-ask`. Adapter `omp` no grid com injeção MCP por
  HOME-overlay privado por sessão.
- **hashline** vendorado como patch bus do editor (tool `nexus_editor_apply_patch`):
  edição ancorada em hash de conteúdo, all-or-nothing multi-arquivo, rejeição de
  âncora obsoleta, recuperação fail-closed. xxHash32 reimplementado em TS puro
  (paridade de bytes provada por vetores canônicos).
- **Companion mobile E2E**: relay cego + AES-256-GCM (pi-wire), chave no fragmento
  do QR, view-only vs controle por posse de write-token, endurecimentos
  multi-tenant (cap de salas/peers, rate-limit, origin, TTL). Atrás da flag
  `feature.remote.relayTransport` (default off).
- **Memória agentic por workspace** (`nexus_memory_retain/recall/stats`) sobre
  SQLite FTS5, banco por workspace + global do usuário, redação de segredo e
  dedupe. Atrás da flag `feature.memory.workspaceMemory` (default off).
- **Cooldown de failover por tier**: bloco escopado por família de modelo não tira
  a conta do pool para outros modelos; espera-pela-irmã em vez da janela longa;
  probe-after e restauração automática.
- **Catálogo rico de modelos** (preço/MTok, janela, capacidades) vendorado do omp,
  com re-sync pinável; **descoberta universal de configs** de `.claude`/`.cursor`/
  `.codex`/`AGENTS.md`/`GEMINI.md`; **squad builtin Review P0–P3** com findings
  tipados; **classificadores de rate-limit** (quota vs transitório, multilíngues).

### Corrigido

- Companion: guest view-only não derruba mais a sessão do host com um frame
  indecifrável (host descarta o quadro; fatal só para o próprio guest).
- Pane omp: caracteres multibyte (pt-BR/emoji) partidos no limite de chunk do pipe
  são remontados via StringDecoder, sem corromper texto nem argumentos de tool.
- PREVC: o gate de mutação extrai os paths de dentro do patch hashline e aplica o
  invariante `.context/` read-only a cada seção.
- Descoberta de configs não materializa segredo do ambiente no inventário
  read-only (mantém `${VAR}` literal).
- Release metadata realinhada em 0.17.0 (package/server/lockfile/changelog/notas).

## 0.16.6 — Live sem Silêncio

Data: 2026-07-15

- O caminho de transcrição final do Gemini Live não assume mais que o provider
  respondeu: ele espera evidência real de áudio ou tool-call antes de encerrar o
  turno como realtime.
- Se o prazo termina sem evidência, o mesmo texto segue para cérebro e TTS
  Classic, com Live silenciado e quiescido antes da fala para evitar silêncio ou
  duas respostas concorrentes.
- A janela de evidência considera áudio recebido desde o início do turno, não só
  depois do transcript final; uma resposta curta que já tocou não dispara um
  segundo fallback por engano.
- Turnos superseded continuam abortando, e tools nativas preservam ownership e a
  continuidade do socket Live.
- O atualizador direto da 0.16.5 continua ativo: instalações 0.15 ou 0.16.x
  selecionam a 0.16.6 em uma única atualização, com asset da arquitetura atual.
- Suíte completa validada: 665 arquivos de teste e 4.649 testes passando.
- Package, server, lockfile, changelog e release notes ficam alinhados em
  `0.16.6`.

## 0.16.5 — Atualização Direta

Data: 2026-07-15

- O fallback autenticado do atualizador consulta a lista de releases e escolhe
  a maior versão semântica estável com ZIP compatível, sem depender da ordem da
  API nem do marcador `latest` do GitHub.
- Drafts, prereleases, tags inválidas e artefatos de outra arquitetura/versão
  são ignorados; Apple Silicon recebe arm64 e Mac Intel recebe x64.
- Antes de baixar, o app revalida a oferta. Se `0.16.1` ficou aberta e `0.16.5`
  foi publicada depois, o mesmo clique passa a baixar `0.16.5`, evitando duas
  instalações em sequência.
- Cobertura de regressão reproduz o fluxo `0.15.0 → 0.16.1` cacheado e confirma
  que o download final usa somente o release mais novo.
- O watchdog da janela não reinicia mais uma navegação ainda ativa após três
  segundos. Cargas lentas — inclusive no build Intel sob Rosetta — podem
  concluir sem entrar em ciclo de `ERR_ABORTED` e piscar a interface.
- Estado visual de terminal usa histerese curta e elimina reemissões idênticas;
  bordas, toolbar e contagem da frota deixam de piscar entre pausas breves de
  output, sem atrasar o estado real usado pela orquestração.
- Objetivos, anexos, chaves de voz, anotações de diff, seleção de agente e
  navegação de Settings sobrevivem a fechamento acidental/Jarvis. Cancelar ou
  concluir continua descartando explicitamente o rascunho.
- A fala de espera por prints/áudios agora vence respostas otimistas quando a
  missão realmente está aguardando evidência; anexos já presentes liberam o
  fluxo sem falso bloqueio.
- Quando o Live aceita uma transcrição local de resgate mas não produz áudio
  nem tool-call no prazo, o turno autorizado passa para o cérebro/TTS Classic
  em vez de terminar em silêncio; turnos superseded continuam abortando.
- Suíte completa validada: 665 arquivos de teste e 4.648 testes passando.
- Package, server, lockfile, changelog e release notes ficam alinhados em
  `0.16.5`.

## 0.16.4 — Dock Persistente com Pet

Data: 2026-07-15

- Causa 1 (classificação): o companion chamava `setVisibleOnAllWorkspaces(true)`
  e o Electron transformava o processo em `UIElementApplication`. Agora usa
  `skipTransformProcessType: true` e permanece `Foreground`.
- Causa 2 (tile fantasma): vários `dock.show()` no thrash deixavam um item
  "NexusIDE" no Dock com tamanho AX `12×0` — listado, mas **invisível** até
  `killall Dock`. Agora o app aplica o ícone do bundle (`dock.setIcon`) e só
  chama `show()` se o Dock estiver escondido.
- O pet não chama `dock.show()` no hot path (evita loop de foco/piscar).
- A janela principal continua oculta durante retries recuperáveis do protocolo.

## 0.16.3 — Dock em Primeiro Plano

Data: 2026-07-15

- Corrige o desaparecimento do NexusIDE do Dock no macOS: a política `regular`
  agora é aplicada pelo bootstrap mínimo antes do runtime pesado/native ser
  carregado.
- Três rechecagens curtas de boot confirmam a política e a presença do Dock sem
  roubar foco nem recompor a janela continuamente.
- Testado em app empacotado Apple Silicon: macOS reporta `Foreground` durante
  todo o boot, em vez de `UIElement`.

## 0.16.2 — Evidências e Squads Afinados

Data: 2026-07-15

- Objetivos que dizem que prints, capturas ou áudios serão enviados depois ficam
  aguardando evidências e não geram handoff, pane ou especialistas antes da hora.
- Jarvis, wizard e o preflight principal revalidam o gate; remover os anexos
  antes de começar também bloqueia o dispatch.
- Squads aceitam prints e áudios no objetivo, com limites de quantidade/tamanho
  e caminhos injetados no kickoff para o time investigar os arquivos reais.
- Grok usa `grok-4.5` e AGY/Gemini usa `gemini-3.5-flash-high` como padrão em
  squads embutidos, persistidos, importados e novos; escolhas manuais continuam
  preservadas.
- Suíte completa validada: 660 arquivos de teste e 4610 testes passando.

## 0.16.1 — Scheduler Operacional e Merge Fail-Closed

Data: 2026-07-14

- Scheduler paralelo passa a operar após o bootstrap de orquestração: a cada
  cinco segundos e em mudanças de missão/task, ele cria worktrees e panes reais
  para tasks prontas, disjuntas e autorizadas.
- A flag `orch.parallelScheduler` fica ligada na release, mas continua protegida
  por contrato aprovado, plano selado, orçamento de workers e kill switch.
- Tasks concluídas entram automaticamente na MergeQueue serial já existente, com
  validação de contexto, sensores, revisão independente e finalização durável.
- Ownership de diretório cobre arquivos descendentes; self-dependencies,
  dependências desconhecidas e ciclos passam a falhar fechados em vez de travar.
- Metadata de package, server, lockfile, changelog e release notes é alinhada em
  `0.16.1`.

## 0.16.0 — Scheduler Paralelo (dormente), Impeccable Nativa e Auth Portável

Data: 2026-07-14

- Scheduler de tasks paralelo determinístico (ondas prontas+disjuntas por
  worktree, MergeQueue serial, enforcement de ownership fail-closed) entra no
  código atrás da flag `orch.parallelScheduler`, que permanece
  `defaultEnabled=false`: o runtime de fan-out ainda não é acionado e o gate de
  disjunção/DAG tem lacunas conhecidas a fechar antes de ligar.
- Skill Impeccable passa a ser distribuída por padrão — a árvore completa é
  bundlada como asset gerado e espelhada em toda CLI, então agentes têm a skill
  de design em qualquer máquina, sem instalação manual (Apache-2.0,
  pbakaus/impeccable).
- A Design Charter deixa de mandar rodar `impeccable detect` (Impeccable é skill,
  não CLI): invoca a skill se instalada, senão aplica a carta destilada.
- GLM e LongCat rodam o binário do Claude num HOME isolado (`~/.nexus/homes`),
  parando de corromper a sessão OAuth da assinatura Claude (que pedia /login do
  nada).
- Login de kimi/grok/agy feito dentro do pane agora persiste: o overlay efêmero
  faz sync-back das credenciais novas pro HOME real antes de ser purgado.
- Detecção de conta gerenciada do AGY via `GEMINI_CLI_HOME`; homes custom de
  Codex, Grok, Kimi e OpenCode; e PATH de login-shell com segmentos vazios
  filtrados — Nexus enxerga CLIs instaladas out-of-the-box em Macs variados.
- Status do pane não pisca mais entre Pronto/Trabalho (watchdog do hook busy) e o
  botão Instalar espera a sessão PTY viva antes de escrever o comando.
- AGY passa a usar `gemini-3.5-flash-high` e Grok `grok-4.5` como modelo padrão.
- Suíte completa validada: 656 arquivos de teste e 4585 testes passando.

## 0.15.17 — Across Tools e Cockpit Vivo

Data: 2026-07-14

- MCP Across Tools observa configs locais de Nexus, Cursor, Claude Code, Codex,
  OpenCode e Cline, mostrando presença real de servers por ferramenta sem
  retornar segredos.
- Sync fill-gaps nasce fail-closed: dry-run, confirmação, backup antes de write,
  escrita atômica, nada apagado e nada inventado para configs ambíguas.
- `feature.mcp.hub` permanece `defaultEnabled=false`; observe read-only fica
  disponível, mas import/export exige override explícito.
- Settings foi reorganizado em pilares Você, App, Agentes e Sistema, deixando
  Providers, MCPs, Tools, Squads e diagnóstico mais fáceis de achar.
- Home, rail, picker e orquestração ganharam estados vazios narrativos e feedback
  visual leve de missão, respeitando modo sóbrio e reduced motion.
- Contratos compartilhados foram decompostos: ProductApi, identidade de projeto,
  payloads de superfície e IPC de MCP sync saíram do arquivo gigante de tipos.
- Suíte completa validada: 645 arquivos de teste e 4520 testes passando.

## 0.15.16 — Orquestração Enxuta e Voz Reprodutível

Data: 2026-07-14

- Lane de consulta somente leitura completa: escolha no wizard, propagação por
  IPC, gate de ferramentas mutáveis e conclusão condicionada a aprendizado
  durável.
- Encerramento PREVC-safe, estado bloqueado acionável e recuperação com
  `markSubmitted`, sync para pane livre e confirmação de entrega.
- O kickoff permanece proporcional ao objetivo, com proveniência de voz/issue,
  rail glanceable e revisão humana encaminhada ao orquestrador.
- Sync de repositório via pane CLI e correções de dual-audio evitam TTS Classic
  e Gemini falando juntos após uma tool; recovery do orquestrador não faz spam
  no PTY.
- Pet Nico incluído no catálogo embutido; spritesheet validado abaixo de 2,5 MB.
- Pipeline reproduzível de treino de wake PT-BR, testes e documentação de
  arquitetura de voz versionados sem substituir o modelo ativo.
- Painel Source Control contextual com operações Git reais, smoke de workspace
  e scrollbars legíveis; a caixa de notificações permite saltar diretamente ao
  pane que precisa de atenção.
- Onboarding de workspace e presença visual do pet foram polidos com progresso
  explícito, CTA primário e estados online/calibrando, respeitando reduced motion.
- Smoke de release corrigido para os artefatos reais do `node-pty` no Linux e
  para o filtro de caminhos Windows do Forge, evitando pacotes sem o bundle
  principal.

## 0.15.15 — Travas de Autonomia e Revisão Humana de Missão

Data: 2026-07-14

- Trava de autonomia pinada por teste: `defaultDriveConfig` nasce em shadow
  (fail-safe sem settings), congelado e com budgets finitos; a ativação do
  driver continua decisão de runtime via `missionDriverActiveMode`.
- TOCTOU residual do orçamento de workers fechado: a reserva de slot só é
  liberada depois que o worker está durável em `missionPanes` — caso contrário
  permanece retida (fail-safe) com aviso.
- Política "soak antes de default-on" codificada em `docs/OPERATIONS.md`,
  destilada das classes de defeito da wave intent-first de 2026-07-13.
- Rail glanceable: pill entende espera humana ("Aguarda você", "Sem objetivo",
  "Pronta") em vez de esconder tudo como "Na fila"; meta fala "agentes"
  em vez de "panes" e mostra há quanto tempo a missão roda.
- Missão nascida de issue agora é auditável: cliques em issues (rail e painel
  de integrações) fluem `source: 'imported-issue'` até o contrato de intenção;
  objetivos por voz fluem `source: 'voice'`.
- Revisão humana de diff vira entrada de orquestração: as anotações do
  DiffAnnotatePanel são submetidas (paste + Enter) ao ORQUESTRADOR da missão
  ativa — não mais escritas sem envio no worker focado.

## 0.15.14 — Missão Enxuta: Prompt Proporcional e Start em Um Clique

Data: 2026-07-14

- Kickoff intent-first sem duplicação: a memória compacta só entra quando a
  missão tem progresso real, e o critério auto-derivado deixa de reencenar o
  objetivo — missão curta deixa de repetir o goal até 3× no mesmo prompt.
- Cartas de worker em camadas por papel/tarefa: scout/architect não pagam
  cartas de build (~8 KB), reviewer dispensa a escada de diff e a carta de
  design só acompanha tarefas com sinal de UI. Toggles de Configurações
  continuam sendo o gate externo; PREVC, budgets e gates intactos.
- Missão de risco normal inicia em um clique: "Começar missão" compila e
  despacha direto de `ready_to_start`; "Revisar plano" preserva a revisão em
  duas etapas e aprovação sensível/destrutiva permanece obrigatória.
- Wizard fala humano: o estado da fila vira "Processando o objetivo…" em vez
  de `exec=goal_compile:running`, e some quando não há nada em andamento.
- Kickoff legado não trava mais em mapa frio: o warm de orientação tem teto de
  4 s e cai no fallback "mapa aquecendo" (doctor recupera sob demanda).
- Playbook com proporcionalidade explícita: missão pequena é UMA tarefa e UM
  especialista.

## 0.15.13 — Dock-First Keychain-Safe Launch

Data: 2026-07-14

- Remove a consulta síncrona ao macOS Keychain do caminho de boot.
- `safeStorage` continua sendo usado e falha fechado para operações reais de
  credencial, mas não pode mais congelar o thread principal antes de o Dock e
  a janela aparecerem.

## 0.15.12 — Dock-First Visible Launch

Data: 2026-07-14

- Define política de ativação regular no macOS, mostra o Dock e chama
  `win.show()` explicitamente no lançamento.
- A janela deixa de depender do estado de ativação herdado de helpers, deep
  links ou locks de instância antigos.

## 0.15.11 — Dock-First Zero-Block Launch

Data: 2026-07-14

- Move a criação da janela para a primeira operação do callback `app.whenReady`.
- Nem o serviço de energia nem IPC de hooks podem bloquear o ícone do Dock ou a
  janela principal durante o lançamento.

## 0.15.10 — Dock-First Native Window Hardening

Data: 2026-07-14

- Instancia o `BrowserWindow` antes de registrar IPC externo e CSP.
- Falhas de integrações opcionais agora são registradas e não impedem a
  existência da janela nativa e do ícone do Dock.

## 0.15.9 — Dock-First Production Hardening

Data: 2026-07-14

- Endurece o hotfix do Dock: a janela principal é criada como primeira
  operação após `app.whenReady()`, antes de hooks, adapters, banco, keychain ou
  qualquer outra inicialização síncrona.
- Evita que qualquer atraso de bootstrap classifique o app como UIElement sem
  janela visível.

## 0.15.8 — Dock-First Production Hotfix

Data: 2026-07-14

- Corrige o lançamento no macOS: a janela principal e o ícone do Dock são
  criados antes do servidor opcional de hooks de agentes.
- Atrasos, portas ocupadas ou processos auxiliares presos agora degradam em
  segundo plano sem esconder o Nexus ou impedir o uso do aplicativo.

## 0.15.7 — Intent-First Production

Data: 2026-07-14

Esta release reúne o runtime intent-first, as proteções de orçamento e handoff,
o produto wave validado, e as correções de Jarvis, Git, pets e wake que já
estavam na `main`.

Data: 2026-07-13

### Packaged functional smoke
- Probes: `intent-first-settings`, `intent-arm` (awaiting_goal, 0 panes),
  `product-flags` (killSwitch authority visible), `search-mixer-ipc`.
- Checklist: `docs/analysis/2026-07-13-production-confidence-checklist.md`.

### Multi-workspace isolation tests
- Unit gate for SearchMixer-per-root and pane recovery scope filtering
  (stand-in until Playwright multi-window E2E).

### Product wave — shipped behind explicit flags

Data: 2026-07-13

### Shell UX
- Progressive onboarding with **open without AI** default; ModeLauncher
  (Terminal/Missions/Swarm/Board/Memory/Skills); ContextualPanel tabs.
- Progressive launch plan stash/apply after workspace hydrate.

### Editor / Search / MCP / Skills / Memory / Autonomy
- Secure editor model path (CM6 formal eval deferred — docs/EDITOR-CODEMIRROR-EVAL.md).
- SearchMixer live IPC with workspace-bound projectRoot + ripgrep fallback.
- MCP hub backup/drift/mask/rollback; skills lock + symlink-safe catalog;
  `.nexus-memory/` wikilinks; autonomy profiles; agent reap finished-only.

### Security
- Unified scoped-workspace-fs; no startsWith(path.resolve) containment gate.


### Product foundations — shipped behind explicit flags

Data: 2026-07-13

### Product flags remain default OFF
- All product-wave flags (`commandBlocks`, `eventJournal`, `searchMixer`,
  `progressiveOnboarding`, `contextualPanel`, `codemirrorEditor`, `mcpHub`,
  `skillsCatalog`, `nexusMemory`, `autonomyProfiles`) ship with
  `channel=dev` + `defaultEnabled=false` on every runtime channel.
- Explicit persisted overrides may opt in; kill switches still force off.

### Wired end-to-end
- `registerProductWaveIpc` — memory / skills / MCP hub / autonomy / editor / flags.
- Preload + `window.nexus.product` surface.
- App shell: **ModeLauncher** + **ContextualPanel** with Search / Skills /
  Memory / Editor / MCP bodies.
- SearchMixer: ripgrep + skills + mission notes + shallow workspace providers.
- Shell OSC 133 env + bootstrap inject on shell spawn when commandBlocks on.
- Mission driver journal emit with stable logical-tick idempotency.
- Terminal CommandBlock actions IPC + spawn session bind meta.

### Domain contracts
- **CommandBlock** semantic model + OSC 133 scanner + redaction + SQLite store.
- **Mission event journal** append/replay/cursor/ACK.
- **SearchMixer** multi-source cancel/generation/ranking.
- Optional shell integration snippets under `resources/shell-integration/`.

### Docs
- `docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md`
- `docs/TERMINAL-BLOCKS.md`, `docs/MISSION-EVENTS.md`, `docs/SEARCH-MIXER.md`
- SECURITY, OPERATIONS, MCP-HUB, SKILLS, MEMORY, EDITOR.

### Shell polish (follow-up)
- App body layout restored: mission-rail / files / grid as **direct**
  `.app__body` children so home-deck z-index and flex growth work again;
  ContextualPanel is a flex sibling on the right.
- **Progressive onboarding** mounted as default launch (no workspace); skip
  falls back to classic LaunchScreen; plan applies pane count / mode after
  layout hydrate.

### CommandBlock terminal UI
- Pane toolbar **Cmds** menu lists recent OSC 133 blocks (in-memory tracker).
- Actions: copy command, copy cwd, re-run (via `writeSession` policy).
- IPC `terminal-block:list` + preload `nexus.terminalBlock.list`.

### Mission journal consumer
- IPC `orch:missionEvents.{recent,replay,ack,cursor}` + preload/orch API.
- ContextualPanel **Mission** tab: select mission, list events, ACK cursor.

### Deferred (honest)
- CodeMirror 6 package install; MCP OAuth/SSE live clients; autonomy enforce
  in mcp-dispatch; worktree provider on block actions.

## 0.15.6 — Direct Operations, Voice & Pet Reliability

Data: 2026-07-13

### Jarvis e Git
- “Atualizar/sincronizar/puxar o repositório local com GitHub/origin” agora é
  uma operação direta, sem Doctor, contrato de missão, squad, pane ou terminal.
- A operação valida branch/upstream e arquivos rastreados, faz `fetch --prune`
  e somente aplica `merge --ff-only` quando o checkout pode avançar sem risco.
- Histórico divergente, commits locais, alterações rastreadas, upstream ausente
  ou possível colisão local bloqueiam com recibo claro, sem stage, commit,
  rebase, push ou sobrescrita.
- Missões, preferências do rail e restauração de panes agora são estritamente
  delimitadas pelo workspace atual; uma sessão de outro projeto não volta à tela
  ativa por engano.

### Voz em produção
- O processador PCM de wake e captura passa a ser carregado por `blob:`
  compatível com a CSP do app empacotado. Isso elimina a queda silenciosa para
  ScriptProcessor causada pelo `data:` URL do Vite e registra qualquer fallback
  real no log de voz.
- OpenAI Realtime recebe as mesmas ferramentas curtas de consulta/leitura da
  rota Gemini, para responder estado da tela sem inventar uma ação de UI.
- Quando uma chamada realtime chega durante handoff/encerramento da sessão, a
  Jarvis devolve um resultado explícito ao modelo em vez de deixá-lo esperando
  indefinidamente.

### Integridade
- A rota direta só está disponível à ação iniciada pelo usuário no renderer;
  agentes MCP continuam sujeitos à autoridade de missão.
- Metadados de release e o teste de roteamento da Jarvis foram alinhados com o
  comportamento atual para impedir uma distribuição com testes divergentes.

### Pets
- Avisos do pet não desaparecem mais por tempo: permanecem até uma ação
  explícita no balão ou no próprio pet, e a fila preserva os avisos seguintes.
- Os pets locais aprovados `Nexo` e `Nico Code` agora acompanham a biblioteca
  offline do artefato de release; os pacotes em `~/.codex/pets` continuam
  persistentes entre atualizações.
- Pets criados em spritesheet v2 ganham escala de desktop 20% maior, preservando
  a margem segura do atlas sem ocupar a tela em excesso.

## 0.15.4 — Jarvis Wake Safety

Data: 2026-07-13

### Jarvis em tempo real
- O pre-roll de áudio encaminha apenas a fala contígua ao wake, eliminando o
  contexto ambiente anterior que fazia a Jarvis interpretar televisão ou
  conversa alheia como comando.
- Detectar a palavra de ativação não inicia nem retoma missão: a mudança de
  estado exige um comando explícito do usuário pela rota auditada da Jarvis.
- Comandos de terminal em PT-BR continuam sendo classificados como shell mesmo
  quando trazem acentos nos argumentos. Entradas com quebra de linha são
  bloqueadas antes de qualquer confirmação ou envio ao pane.

### Release
- A distribuição usa a versão `0.15.4`, com os artefatos macOS assinados e
  notarizados no perfil local de produção.

## 0.15.3 — Reliable Orchestration

Data: 2026-07-13

### Ralph Loop, Doctor e panes
- O Mission Driver persiste orçamento, tentativas e receipts PREVC; uma missão
  só termina quando todos os marcos possuem evidência Nexus atual e confiável.
- Sensores e revisão final do autopilot viram handoff idempotente na revisão
  correta. Cada marco consome uma evidência própria, sem reutilização circular.
- Panes mortos são recuperados por identidade estável e CAS. O recap é entregue
  e confirmado na sessão nova antes do rebind, sem matar uma sessão vencedora.
- O Doctor deixa de anunciar travamento por silêncio normal e não encerra panes
  vivos. Timeouts de renderer e main são finitos e auditáveis.

### Jarvis em tempo real
- Wake, seleção de squad e respostas a perguntas de agentes enviam briefing com
  Enter real ao pane correto. Texto natural não é mais tratado como shell.
- O socket Live quente é reconstruído no wake para evitar o estado zumbi visto
  nos logs; áudio pendente atravessa a reconexão e o fallback permanece finito.
- Gemini 3.1 fixa fala em pt-BR e a janela de evidência de áudio acompanha o
  tamanho da resposta antes de recorrer ao TTS Classic.
- Confirmação nativa fica restrita a ações destrutivas ou de publicação; trabalho
  rotineiro dentro do projeto segue diretamente para o squad autorizado.

### Wake PT-BR, pets e release
- `ei-jarvis-ptbr.onnx` segue embutido e agora também é instalado como
  `~/.nexus/models/wake/custom.onnx` para todo cliente, com SHA-256 e escrita
  atômica; um modelo customizado pelo usuário é preservado.
- A release inclui as correções já integradas de preview/compactação da galeria,
  Pet Studio com dependências disponíveis e o alinhamento final do Home Deck.
- App, servidor, lockfile, changelog e notas internas avançam juntos para
  `0.15.3`.

## 0.15.2 — Squad Continuity

Data: 2026-07-13

### Orquestração e Doctor
- O orquestrador conserva uma autoridade estreita de delegação antes do
  contrato congelado. Quando a missão depende do WIP atual, workers operam no
  modo `same_checkout`, sem stash/reset/troca de branch e com apenas um escritor
  ativo por checkout.
- Missões de squad entram em `running` ao serem materializadas. Bloqueio e
  recuperação continuam disponíveis quando o Git impede o freeze, sem liberar
  shell ou edição direta ao coordenador.
- O Context Doctor deixa de esconder falha de commit/binding e retorna a causa
  estruturada. O supervisor conta panes vivos, respeita atividade do
  orquestrador e só classifica o segundo incidente como travamento.
- A primeira recuperação de delegação é não terminal e silenciosa; a Jarvis não
  anuncia mais que o agente sintético de supervisão está travado.

### Jarvis e squads
- “Abrir modo squad” abre o seletor de squads existentes. O passo visível do
  wizard e os nomes salvos entram no contexto de tela para a Jarvis perguntar e
  agir sobre opções reais, sem confundir seleção com criação de squad.
- Comandos já reconhecidos pelo wake/STT seguem direto para o turno Live ou para
  o fallback Classic, eliminando a segunda captura vazia e a resposta tardia.
- Transcrições duplicadas entre realtime e wake passivo são descartadas. Uma
  confirmação pendente ganha autoridade imediata, portanto “sim” e “não” são
  roteados ao gate correto e não somem no filtro acústico genérico.

### Interface e release
- Home Deck alinha títulos, ações e linhas de squad; os chips de frota, cota e
  custo compartilham altura e permanecem em uma única linha.
- O modelo treinado `ei-jarvis-ptbr.onnx` permanece obrigatório e padrão no
  pacote, com manifesto e SHA-256 verificados pelo smoke de produção.
- App, servidor, lockfile, changelog e notas internas avançam juntos para
  `0.15.2`.

## 0.15.1 — Supervision Handoff

Data: 2026-07-13

### Doctor, panes e handoff
- Revisões de contexto usam uma única passagem de até dois minutos, preservam
  o pane quando há timeout e não criam outro revisor enquanto a sessão anterior
  ainda pode ser recuperada.
- O contexto de orientação ignora artefatos internos, lockfiles e saídas de
  runtime, recarrega fontes reais e rejeita rascunhos contaminados antes de
  qualquer aplicação.
- Missões e panes expõem recuperação explícita em vez de fechar ou reenviar
  trabalho automaticamente; o Doctor continua a missão pelo orquestrador após
  as correções, sem ciclos paralelos duplicados.
- Contratos emitidos por orquestradores antigos aceitam o alias `description`
  e normalizam rótulos humanos de artefatos. Drafts aplicados substituídos são
  migrados para `superseded`, evitando loops de commit por atestação obsoleta;
  um Doctor posterior conclui automaticamente o commit quando o Git está limpo.

### Jarvis em tempo real
- “Abrir modo squad” sem nome agora pergunta qual squad salvo deve subir e
  apresenta nomes reais do catálogo; criar/desenhar um squad novo permanece uma
  intenção distinta.
- O contexto estruturado da tela, workspaces e squads é atualizado de forma
  contínua e deduplicada durante a sessão Live. O follow-up permanece autorizado
  por 60 segundos para permitir respostas naturais sem repetir a wake word.
- Cancelamento do provider, interrupção pelo usuário e barge-in antes de efeitos
  não são mais registrados como incidentes. Isso elimina o falso toast do Doctor
  e o anúncio repetido de “supervisão travada”.

### Providers e acessibilidade
- Hub de Providers reorganizado em CLIs, modelos e remotos, com detecção,
  atualização de catálogo e estados operacionais mais claros.
- Tabs mantêm foco por teclado e uma relação ARIA estável com o painel ativo.

### Galeria de pets
- A galeria mostra uma pré-visualização animada antes de aplicar qualquer pet;
  a importação só acontece após confirmação explícita no card selecionado.
- Sheets petdex `8×9` e Codex v2 `8×11` são detectados pelas dimensões reais.
  Assets acima do teto das preferências são compactados mantendo a malha, com
  limite de rede independente de 12 MB.

### Wake PT-BR e release
- `ei-jarvis-ptbr.onnx` passa a ser o wake model padrão de todos os clientes.
  Manifesto com SHA-256 é empacotado junto e o build falha fechado se modelo,
  manifesto ou hash divergirem.
- Versões do app, servidor, lockfile, changelog e notas internas avançam juntas
  para `0.15.1`; dependências nativas opcionais necessárias ao SSH têm scripts
  de instalação explicitamente permitidos.

## 0.15.0 — Autopilot Fleet

Data: 2026-07-13

### Piloto automático e terminais
- Modo autônomo passa a usar a flag nativa correta de cada CLI em todos os
  squads e serviços. O usuário só recebe confirmações interativas quando opta
  explicitamente pelo modo seguro.
- O terminal acompanha a saída em tempo real sem arrancar o usuário de uma
  posição de scroll manual.
- Retomada de panes preserva a sessão e o dono da missão, evita sessões
  obsoletas e não reenvia o mesmo comando.
- O Doctor mede atividade real do PTY, emite um único alerta de travamento e
  nunca fecha, reinicia ou duplica trabalho que continua produzindo saída.

### Pet Studio e desktop pet
- Squad fixo `Pet Studio`, com um único Pet Maker e somente a skill de criação
  de pet, substitui o pipeline de desenvolvimento para missões de imagem.
- A criação usa a imagem anexada, valida o contrato Codex v2 e só conclui a
  missão quando existe um pacote íntegro em `~/.codex/pets`.
- Pets gerados aparecem em `Meus pets`, com preview, aplicação explícita e
  exclusão local segura. O pet em uso nunca é trocado automaticamente.
- Recuperação de missão finalizada encontra pacotes válidos criados durante
  uma interrupção e evita concluir quando a autoria é ambígua.
- O companion atual avisa conclusão, falha e pedidos de intervenção. Eventos
  ocorridos antes do renderer estar pronto ficam em fila e são confirmados
  somente depois de o balão aparecer.
- Posição livre, múltiplos monitores, visibilidade no boot e click-through foram
  estabilizados para o pet não cobrir o trabalho nem sumir da tela.

### Operação da frota
- Uso e cotas reais para Claude, Codex, Gemini/AGY, GLM, Grok, Kimi e demais
  CLIs compatíveis, com janelas normalizadas e estado desconhecido honesto.
- Failover multi-conta preserva o contexto do terminal e escolhe apenas contas
  compatíveis, sem expor credenciais entre providers.
- Mission rail, Ops Board, toolbars, contas, rankings e estados vazios foram
  reorganizados com hierarquia operacional, ações visíveis e navegação por
  teclado.
- Jarvis ganhou continuidade de wake/follow-up, autoridade acústica e painel de
  voz mais legível, sem loops de áudio passivo.

### Confiabilidade e release
- O boot não consulta o Keychain de forma síncrona quando ainda não há sessão
  de autenticação em memória, evitando inicialização aparentemente travada.
- Metadados de versão, lockfile, changelog e notas internas voltaram a avançar
  juntos; o gate impede publicar uma versão com notas divergentes.
- Build macOS mantém retry controlado do timestamp da Apple e verificação
  independente de assinatura, notarização, ticket stapled, fuses e smoke do
  aplicativo extraído do DMG e do ZIP.

## 0.14.3 — Pet Operacional Completo

Data: 2026-07-12

### Desktop pet
- Aviso de intervenção por AGENTE: quando um hook reporta waiting/blocked
  (pedido de permissão/input do Claude/Codex), o pet mostra balão âmbar
  "Um agente precisa de você" com a pose waiting — fecha o ciclo
  terminou/falhou/preciso-de-você por missão E por agente.

- Galeria navegável dentro do app: "Ver galeria…" lista os pets
  publicados no petdex (sitemap ao vivo, cache de 10 min) com filtro e
  import em um clique; URLs com hash (#/pets/slug) agora resolvem e o
  domínio canônico petdex.dev virou a base primária (codex-pets.net
  respondia 404 nos installs).
- Balão no formato Codex: título em negrito + detalhe (nome da missão),
  com clamp de 2 linhas.
- Pet maior (janela 300×270; sheet 152px, pixel 128px) — dá para ver do
  outro lado da sala.
- "Importar spritesheet do Codex…" abre o dialog nativo já em
  ~/.codex/pets (mac/win/linux) com filtro de extensões.
- Pet de imagem: grade 32×32 (muito mais detalhe), feedback de sucesso
  ao criar, e botão × para remover pet criado/importado.

### Teclado
- Cheatsheet de atalhos (⌘/ e entrada "Atalhos do teclado" no ⌘K): todos
  os aceleradores num overlay, sem sair do fluxo.

### Biblioteca embutida (sessão paralela)
- Starter pack offline com 15 sprites Codex v2 em resources/pets,
  aplicáveis com um clique (NOTICE com origem/remoção; arte pertence aos
  autores da comunidade — regularização em andamento).

### Voz e mídia (sessões paralelas)
- Modelo de wake PT-BR calibrado promovido a padrão.
- Catálogo de mídia: Seedream 5.0 Pro, Veo e recuperação de jobs via
  Replicate.

### Build
- Wrapper de retry do codesign versionado em
  scripts/codesign-with-retry.sh + receita no build/notarize.md (o TSA da
  Apple derruba rajadas de --timestamp com muitos nativos unpacked).
- Release `v0.14.3` assinada e notarizada com o perfil `nexus-notary`.

## 0.14.2 — Galeria de Pets

Data: 2026-07-12

### Desktop pet
- Importar da galeria petdex (codex-pets.net / petdex.dev) por slug ou
  URL, direto no Settings → Aparência: o main baixa o spritesheet com
  Referer da galeria, tetos de tamanho/MIME e validação da malha 8×11;
  a arte é por submissão e o import mostra o autor do lado da escolha.
  Testado ao vivo contra a galeria (slug `navi`).
- Arrastar o pet agora mostra a CORRIDA do contrato v2 (linhas
  running-right/left, cadência própria), na direção do movimento — como
  no Codex.
- Pet pixel (Operador e variantes) com muito mais presença: upscale
  nítido sem blur de retina (image-rendering: pixelated), cores mais
  acesas, sombra de assentamento e tamanho maior (112px).

### Build
- Release `v0.14.2` assinada e notarizada localmente com o perfil
  `nexus-notary`.

## 0.14.1 — Navi Segue o Cursor

Data: 2026-07-12

### Desktop pet
- Look mechanics do contrato Codex v2: o pet olha para o cursor na tela
  (16 direções em passos de 22,5°, linhas 9/10 do spritesheet), volta a
  digitar quando o mouse para ou chega perto, e olha neutro dormindo ou
  durante o arrasto. Verificação visual dos estados (look, balões,
  sono) contra o bundle real.

### Build
- Release `v0.14.1` assinada e notarizada localmente com o perfil
  `nexus-notary`.

## 0.14.0 — Mission Control Vivo

Data: 2026-07-12

### Identidade visual
- Nova identidade "mission control": acento ciano operacional (#45d7ff),
  fundo azul-negro mais profundo, grade pixel sutil no Launch/Home e VT323
  nos eyebrows/badges operacionais — a linguagem pixel agora aparece no
  default, não só no modo pixel.
- Novo ícone do app e NexusMark: nó-nexus com núcleo aceso, retícula de
  radar e satélites orbitais (a frota convergindo ao nexo).
- Doutrina de cor aviônica unificada: tokens `--state-*` únicos para
  rail, Ops Board, orch panel, toolbar e borda de pane — trabalhando pulsa
  em ciano, pronto/feito em verde, bloqueado em âmbar, falha em vermelho.
- Derivados do acento (`--accent-soft/strong/hover/glow`) via `color-mix`:
  Dracula/Solarized/light herdam hovers e brilhos corretos; superfícies
  escuras hardcoded convertidas para tokens (tema claro legível em Voice
  Settings, Perfil do Operador e Settings).
- Boot screen com a marca pulsando; toasts, wizard e confirm no mesmo
  dialeto de raio; celebração de tier-up não captura mais o ponteiro.

### Frota visível
- Chip de frota na barra: trabalhando · prontos · dormindo · mortos num
  relance, clique foca quem precisa de atenção (morto primeiro).
- Borda do pane fala: agente ocupado respira ciano, morto tinge de
  vermelho, hibernado fica tracejado — visão periférica de verdade.

### Desktop pet (novo)
- Companion pixel flutuante sobre o desktop: sempre no topo, click-through
  fora do sprite, arrastável com snap de canto e posição persistida.
- Avisa em balão quando missão conclui/falha ou um agente morre; celebra
  quando o trabalho termina; dorme quando você quiser (sem balões).
- Presets do Operador (Ouro, Chama, Centurião, Prestígio), pet
  personalizado pixelizado localmente de qualquer imagem, e suporte a
  spritesheets Codex v2 (8×11) — o pet criado no Codex/hatch-pet funciona
  direto, incluindo os da galeria codex-pets.net.
- Opt-in em Settings → Aparência; fundo sólido para Linux sem compositor.

### Teclado primeiro
- ⌘K command palette: panes, missões e ações com busca sem acento.
- ⌘N nova missão, ⌘1-9 foca o N-ésimo pane; atalhos visíveis nos tooltips
  e no rodapé do Home.

### UX
- Dieta da workspace bar: só Terminal inline + ⋯; OperatorHud (XP) mudou
  para o rodapé do rail — a zona de status é só sinal operacional.
- `window.confirm` nativo eliminado: confirm da casa modal de verdade
  (fila serializada, Esc não vaza para o overlay de baixo, focus trap),
  com rótulos verbo+objeto.
- Resume dirigido por sessão de provider com feedback exact/latest no
  terminal; botão da Jarvis em "mudo" abre os controles em vez de acordar
  sem áudio.

### Correções
- Detector de rate-limit reconhece `rate_limit_exceeded` e
  `RateLimitError` sem recasar prosa de instruções de squad.
- Terminal e janela pré-paint casados com os novos tokens (sem hex-drift).

### Build
- Release `v0.14.0` assinada e notarizada localmente com o perfil
  `nexus-notary` (upload manual — Actions sem créditos).

## 0.13.13 — Account Hot-Swap

Data: 2026-07-12

### Melhorias
- Hot-swap multi-conta com homes e credenciais gerenciados para Codex, Grok,
  Kimi, OpenCode e AGY, preservando a sessão de cada CLI.
- Failover reconhece limites de uso e pode retomar a operação usando uma conta
  reserva compatível.
- Toolbar dos panes ganhou ações rotuladas, tooltips fora da área de corte e
  menu compacto para comandos menos frequentes.
- Seletor de contas informa conta ativa, disponibilidade e reinício necessário
  de forma mais clara.

### Segurança
- Material de autenticação fica isolado por conta e é aplicado apenas ao
  processo da CLI correspondente.

### Build
- Release `v0.13.13` assinada e notarizada com o perfil `nexus-notary`.

## 0.13.12 — Operator UX

Data: 2026-07-11

### Correções
- Pacotes de plataforma do `node-pty` são extraídos integralmente do ASAR,
  incluindo `spawn-helper` no Linux e bindings ConPTY no Windows.

### Build
- Release `v0.13.12` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.11 — Operator UX

Data: 2026-07-11

### Correções
- Smoke runtime resolve o executável `nexus-ide` dentro de DMG, DEB e NUPKG,
  preservando `NexusIDE` apenas como nome visível do produto.

### Build
- Release `v0.13.11` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.10 — Operator UX

Data: 2026-07-11

### Correções
- Smokes Linux e Windows e verificador de entitlements macOS alinhados ao nome
  estável do executável empacotado.

### Build
- Release `v0.13.10` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.9 — Operator UX

Data: 2026-07-11

### Melhorias
- Configurações ganhou localização persistente e ação sempre visível para
  voltar às missões, com suporte ao atalho Esc.
- Login de Claude, Codex, Kimi e demais CLIs apresenta estados explícitos,
  detalhe da verificação e conta usada no próximo terminal.
- Squads ganhou controles consistentes para disciplina sênior, design e código
  enxuto, com textos objetivos e hierarquia de operação.
- Providers, contas, formulários e menus se reorganizam em telas menores sem
  sobreposição, corte de conteúdo ou ações inacessíveis.

### Correções
- Executável Linux alinhado ao nome esperado pelos pacotes DEB e RPM.
- Rebuild nativo de macOS repete downloads transitórios antes de carregar a
  identidade de assinatura.

### Build
- Release `v0.13.9` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.8 — Realtime Operator

Data: 2026-07-11

### Correções
- Gate de release estabilizado para conexões TLS simultâneas do bridge remoto:
  cada cliente usa credencial curta própria, eliminando corrida de expiração em
  runners concorridos sem relaxar a segurança do runtime.

### Build
- Release `v0.13.8` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.7 — Realtime Operator

Data: 2026-07-11

### Melhorias
- Gemini Live pré-aquecido antes do wake, com follow-up contínuo, barge-in e
  rescue local de transcript.
- Jarvis executa ações explícitas de workspace e terminal no pane correto, com
  confirmação nativa e sem voz duplicada.
- Descoberta automática de modelos e efforts publicados pelas CLIs; Codex
  `ultra` aparece nos squads sem lista fixa no Nexus.
- Providers usam o modo automático nativo (`bypass`/`yolo`) por padrão; uma
  escolha manual por modo seguro continua persistida.
- Runtime de áudio com AEC3 e melhorias de pre-roll, cooldown e watchdog.

### Correções
- Sessão Claude Max preservada em workers com `HOME` isolado; elimina falso
  pedido de login nos squads.
- Transcript explícito atualizado antes de validar ações como novo workspace.
- Recuperação de `send_to_pane` para comandos destinados ao terminal focado.
- Status de fala e tool results não permanecem travados após o áudio terminar.
- Novo squad substitui o shell placeholder do workspace, sem terminal vazio.

### Build
- Release `v0.13.7` multi-arquitetura pelo workflow assinado/notarizado.

## 0.13.6 — Realtime Continuity

Data: 2026-07-11

### Melhorias
- Wake por voz: VAD passivo (hangover + force-emit de fala real), matcher
  Overclock (`acorda Jarvis`), threshold EN PT-calibrado (0.012 + RMS).
- Realtime full-duplex: mic offer enquanto ela fala; follow-up sem matar
  `realtimeTurnActive`; rescue STT→`liveRescueIn` no path `reply`.
- Hot session: gate anti-TV/ambiente (`isHotSessionCommandCandidate`) —
  não injeta "camelo vindo" / aplausos / música como comando.
- Prompt Live: leis anti-alucinação (só tools com intenção clara; ignore media).
- Paridade Overclock: follow-up sem re-dizer o nome; hot inject só com energia.

### Correções
- `liveInterrupt` soft no-op quando ainda não há owner (wake race).
- Tool follow-up em turno stale reabre continuidade na sessão quente.
- Boot: presença de secrets sem decrypt em massa (Keychain).
- force-emit peak alto o bastante para ignorar ambient contínuo.

### Build
- Release `v0.13.6` (tag dispara CI notarizado).

## 0.13.5 — Operator XP + security hardening

Data: 2026-07-11

### Melhorias
- Gamificação: XP `agent_turn` em cada turno Claude/Codex com output real;
  streak avança no uso quotidiano (não só pipeline/missão/voz).
- Operator FX: toasts "+XP", bursts de TIER-UP / TRANSCENDÊNCIA, achievements;
  HUD com shimmer; respeita reduced-motion e sober mode.

### Segurança
- Git panel: ProcessGitRunner + `assertSafeLocalGitConfig` + `--no-ext-diff`
  (mitiga config maliciosa de repo ao abrir status/diff).
- Browser: redacção de segmentos secretos em URLs; preload allowlist alinhado
  a scroll/press/hover.
- atomic-write: `O_CREAT|O_EXCL|O_NOFOLLOW` + temp name imprevisível.
- provider-config: ignora chaves `__proto__` / `constructor` / `prototype`.
- Teste hermético de known-hosts (pin/match/mismatch).

### Build
- Release arm64 notarizada localmente (`nexus-notary`).
- Windows: aguarda certificado Authenticode (eSigner/OV|IV); não incluído.

## 0.13.4 — Manual Mac notarized build

Data: 2026-07-11

### Melhorias
- Design systems import UI + CSS custom-property sensor (sessões recentes).
- Browser automation: scroll, press, hover.
- SSH: pin de host key (fail-closed em chave alterada).

### Build
- Release arm64 notarizada localmente (`nexus-notary`).

## 0.13.3 — Design systems shipping + Linux packaging

Data: 2026-07-11

### Melhorias

- Design Systems end-to-end: settings UI (designmd.ai), MCP tools, DESIGN.md
  reader, context ingestor adapter, sensor script empacotado.
- `ssh2` como optionalDependency + external no Vite main (desbloqueia package
  Linux; transporte continua injectável).
- Spike documentado para sandbox Windows (Job Object + ACL) antes de Setup
  em produção.

### Correções

- Build Linux não tenta mais bundlar `cpu-features`/`sshcrypto.node`.
- design-send tolera roots sintéticos ao anexar DESIGN.md.

## 0.13.2 — Design systems + CI sandbox gate

Data: 2026-07-11

### Melhorias

- Design systems: leitura de `DESIGN.md` no projeto, cliente designmd.ai e
  tools MCP de search/get/import como drafts de contexto (review obrigatório).
- Design Mode: copiar contexto (dry-run) sem injectar no PTY; prompt enriquece
  com DESIGN.md quando presente.
- CI: probe de sandbox real (bwrap/Seatbelt) e skip de exec sandboxed quando o
  runner bloqueia userns; evidence sintético válido no workflow de contexto.

### Correções

- Gate de qualidade Linux deixa de falhar por `bwrap uid map` / loopback em GHA.

## 0.13.1 — Mission Rail & safe multi-mission

Data: 2026-07-11

### Melhorias

- Activity Rail de missões (pinned / em progresso / fila / done), switcher de
  contas e drag de ficheiros para o agent.
- Multi-missão segura: soft-focus sem kill; merge de panes quando o orquestrador
  entrante não partilha login Claude; kill seletivo só em conflito de keychain.
- Integrações A–C: create PR GitHub, issues no rail, Linear, annotate diffs,
  port-forward local e SSH production (`ssh2`) com remote worktree.
- Jarvis: mute/gate de saída de voz, smoke live com ownership estável e
  avisos legais de terceiros opcionais em Diagnósticos.
- Design Mode: outline verde persistente no elemento selecionado (hover azul
  separado).

### Correções

- Reabrir missão já aberta foca panes vivos em vez de destruir e respawnar.
- Lançar squad em paralelo a outra missão deixa de matar todos os CLI por
  omissão quando não há orquestrador Claude em conflito.

## 0.13.0 — Always Awake

Data: 2026-07-10

### Melhorias

- Jarvis Live passa a configurar explicitamente VAD sensível, interrupção por
  atividade e cobertura somente de fala no Gemini 3.1, preservando compressão
  de contexto e retomada de sessão.
- Wake acústico ganha fallback textual com aliases observados no microfone,
  deadline local de quatro segundos e descarte de resultados tardios; wake
  direto continua disponível durante a fala por verificação STT anti-eco.
- A voz Gemini padrão muda de Charon para Gacrux, com migração apenas do antigo
  default e preservação de escolhas personalizadas.
- Runtime de agentes conecta hooks consentidos de Claude/Codex aos PTYs,
  mantém o Mac/Linux acordado durante trabalho real e registra breadcrumbs de
  crash sem transformar telemetria em evidência de conclusão.
- Harvest ORCA de confiabilidade de terminal: circuit breaker de renderer,
  protocolo binário de stream, scheduler de output com backpressure e
  worktree removal safety com provenance Nexus (MIT, pin 143c36e).
- GitHub/GitLab, terminal remoto, SSH e política de cliente móvel entram como
  fundação escopada. O pareamento usa TLS + prova de posse; E2EE permanece
  explicitamente pendente e não é anunciado como disponível.
- Migrations do servidor endurecidas: `timestamptz` em `cron_schedules` e
  reaper de soft-delete após 30 dias.

### Correções

- O microfone deixa de enviar áudio ao provider enquanto a própria Jarvis ou
  um TTS local ainda toca; drift entre FSM e fila WebAudio também fica coberto.
- A superfície do Gemini Live cai de mais de 60 ferramentas concorrentes para
  ações de voz de alto nível + uma fachada auditada, reduzindo escolhas erradas
  como abrir um squad quando o pedido era criar um.
- Reload/configuração do wake não pode mais liberar sessões ONNX durante `run`,
  eliminando o erro `Cannot read properties of null`.
- Hooks preservam arquivos e backups em modo privado, recebem endpoint/chave de
  sessão no ambiente do PTY e mantêm todos os agentes ativos no keep-awake.
- Replay de frame remoto não reexecuta input; Git remoto cita cada argumento e
  aceita somente subcomandos de escrita explicitamente permitidos.
- Cancelar o diálogo de saída não desmonta o keep-awake; confirmar saída não
  recria a janela e teardown de browser tolera `WebContents` destruído.
- O runtime macOS volta a usar `safeStorage` corretamente e mantém as chaves
  Gemini/OpenAI acessíveis no app assinado.
- O gate Linux instala e empacota Bubblewrap no CI sem fingir que o runner
  hospedado permite user namespaces; execução real continua gate de máquina.

## 0.12.0 — Contexto verificável e runtime seguro por projeto

Data: 2026-07-10

Esta versão transforma o Nexus em um ambiente orientado a contexto verificável:
agentes recebem o modelo do projeto antes de codar, efeitos ficam vinculados à
revisão de contexto e a conclusão depende de evidência independente. O runtime
e os dados passam a ser isolados por projeto/checkout, com diagnóstico de
prontidão e fundação explícita para operação em múltiplos computadores.

### Melhorias

- Live Design no browser pane: seleção visual com contexto DOM/framework,
  candidatos `arquivo:linha`, screenshot, envio ao agente de missão, preview
  otimista de estilos, detecção de dev server, breakpoints e clonagem de
  referências externas.
- O motor de write-back visual determinístico inclui edição byte-cirúrgica,
  CSS→Tailwind, undo/redo por hash, journal de recuperação, CAS e cleanup dos
  IDs efêmeros. Na distribuição 0.12 ele permanece fail-closed desativado;
  seleção, preview e envio ao agente continuam disponíveis. A ativação direta
  fica reservada a desenvolvimento até concluir a validação de produção.
- Harness de contexto nativo com ingestão do repositório, conhecimento do
  domínio, contratos congelados, `contextRevision`, sensores, PREVC,
  attestations e Review Council com autor diferente do revisor.
- Efeitos de agentes vinculados a projeto, checkout, missão e revisão de
  contexto; missões não podem virar `done` por um caminho paralelo sem workflow
  completo, evidência e handoff consistente com o diff atual.
- Runtime SQLite separado por projeto, stores escopados por construção e modo
  seguro somente leitura quando a persistência não pode ser garantida.
- Identidade portátil de projeto v2, registro local de checkout, worktrees
  isolados e merge queue com recuperação de crash e validação antes da fusão.
- Nexus Doctor com relatório estruturado de blockers, warnings e remediação
  para Git, manifesto, SQLite, contexto, sensores, sandbox, providers,
  filesystem e backend multi-PC.
- Cron compartilhado com lease fail-closed e contratos de sync otimista/CAS;
  rotas do control plane e guias de implantação ficam prontas para um backend
  externo, sem transformar ausência de infraestrutura em sucesso silencioso.
- Jarvis Live ganhou ownership por janela e escopo, PTT/wake isolados,
  continuidade correlacionada por turno/tool e descarte de callbacks tardios.
- Visão atual usa AX/OCR limitado e redação unificada de segredos antes de
  prompts, narração e resultados MCP; controles sensíveis não viram alvos.
- Release pipeline reproduzível para macOS arm64/x64 e Linux x64, com smoke do
  pacote real, SBOM, checksums e verificação de nativos. Windows permanece como
  preview assinado enquanto não houver sandbox de produção.
- Artefatos macOS incluem app, DMG e ZIP verificados; app/DMG são assinados,
  notarizados e stapled, e o ZIP é validado pela aplicação notarizada interna.

### Correções

- Eventos sintéticos, replay e gerações antigas do picker não provocam
  write-back; conteúdo de página é podado/redigido e chega ao agente como dado
  não confiável, e bytes de controle de terminal são recusados.
- Operações de Git e filesystem bloqueiam configurações locais perigosas,
  traversal, troca por symlink e drift de descritor entre autorização e uso.
- Stores legados de squads/contas deixam de confirmar escrita quando o banco
  está degradado; falhas de persistência entram em modo seguro explícito.
- O renderer não hidrata estado de projeto antes da autorização do workspace e
  descarta respostas atrasadas depois de troca/fechamento de projeto.
- Handoffs carregam IDs de evidência e identidade do diff; uma alteração de
  `baseSha`, `headSha` ou `diffHash` invalida revisão antiga.
- O diagnóstico Realtime só fica verde após o renderer iniciar o playback do
  PCM correlacionado; ACKs velhos, duplicados ou cancelados são descartados.
- A saída de áudio escolhida é aplicada de forma explícita em Classic e Live;
  dispositivo indisponível gera erro visível, sem fallback silencioso.
- O updater seleciona somente o ZIP Squirrel da arquitetura do Mac e fica
  `unsupported` em Linux/Windows enquanto não existir updater próprio, evitando
  instalar payload `darwin-x64` em outra plataforma.
- Wake/PTT, eventos Live, transcript, memória, conversa, custos e uso deixam de
  atravessar janelas, projetos ou checkouts por estado global.

## 0.11.0 — Voz destravada e delegação segura (Fase 0 do refactor Jarvis)

Data: 2026-07-09

Release de estabilidade e segurança da voz: os três críticos documentados morrem
(mute preso, surdez por TCC fantasma, delegação sem confirmação) e o gate de
missão ganha confirmação por voz com hardening completo.

### Melhorias

- Invariante de mute estrutural: o gate de áudio Live reabre em TODA saída de
  turno (finally token-aware) — fim do silêncio permanente pós-degrade.
- Watchdog de status preso: transcribing/routing/speaking têm saída garantida;
  fala longa (Live ou TTS clássico audível) conta como progresso, sem falso idle.
- Grant TCC fantasma do macOS detectado (rms 0 sustentado com permissão OK) com
  recuperação guiada em 1 clique: `tccutil reset` + relançamento + re-Allow.
- Delegação de código (`send_to_pane`) agora confirma por voz ("Confirmo?") e só
  aceita pane de agente/orquestrador — o fallback silencioso pro pane focado morreu.
- Hardening do gate: matcher de confirmação restrito a respostas curtas, paneId
  validado contra pergunta pendente real (main + renderer, incluindo ask_pane),
  pendência sobrevive re-wake e "sim" seco confirma; re-ask quando o eco engole
  a resposta.
- Observabilidade "duas vozes": identidade da instância no boot e início de cada
  playback local registrados no voice.log para atribuição de áudio duplicado.
- Spec + planos do refactor Jarvis (fases 0-4) versionados em docs/superpowers.

## 0.10.35 — Jarvis Live wake e catálogo de modelos

Data: 2026-07-08

Release de paridade operacional Live: wake mais confiável, um único caminho de voz,
catálogo remoto de modelos e ações de workspace/squad.

### Melhorias

- Reset de sync no wake Live e rebuild forçado de socket zumbi no transporte realtime.
- Caminho Live unificado (Charon) com menos corrida contra o Classic STT/brain/TTS.
- Latência de wake, retenção de mic e coalescer de contexto de tela sem corrida no turno.
- Fluxo de confirmação de squad e ações nativas de workspace na Jarvis.
- Catálogo de modelos com refresh remoto (`NEXUS_MODEL_CATALOG_URL`), grok-4.5 e fable api-only.
- Correção de crash de hooks no MissionWizard.

## 0.10.8 — Jarvis mais operacional

Data: 2026-07-07

Hotfix de paridade operacional: a Jarvis ganhou mais controle nativo do app,
limpeza de sessão MCP por turno, fala em uma única voz por resposta e seleção
explícita do transporte realtime.

### Correcoes

- Novos fast-paths sem LLM para abrir configurações, configurações de voz,
  entrar no modo canvas e voltar para a grade.
- O cérebro agora reconhece essas ações nativas no JSON, então a Jarvis não cai
  em `action:none` quando a LLM decide operar a UI.
- O executor renderer abre os painéis reais e alterna canvas/grade diretamente,
  mantendo os resultados no transcript live/tool result.
- Cada turno da Jarvis limpa a sessão MCP ao fim da ação, evitando permissões e
  confirmações reaproveitadas entre comandos.
- A fala da Jarvis voltou a usar uma chamada TTS por resposta, evitando troca de
  timbre entre primeira frase e resto quando um provedor degrada no meio.
- O painel de voz agora permite escolher OpenAI Realtime ou Gemini Live,
  persiste a escolha imediatamente e mostra a credencial correta no diagnóstico.

## 0.10.7 — Jarvis operacional

Data: 2026-07-07

Hotfix operacional de voz: a Jarvis agora usa realtime como transcript rapido,
mas fala e executa pelo executor auditavel do Nexus; preserva fala colada ao
wake word, limpa eco da saudacao e mantem tratamento "patrao" tambem nos
caminhos rapidos.

### Correcoes

- Live sem voz dupla: o provedor realtime deixa de falar por fora do executor da
  Jarvis. O transcript rapido volta para o brain/action executor unico, evitando
  troca de timbre e respostas que prometem acao sem operar o app.
- Wake/click mais operacional: o pre-roll e congelado antes da saudacao, o clique
  nao herda audio antigo e a janela de escuta fica aberta tempo suficiente para o
  comando chegar sem fechar no "Pois nao, patrao?".
- Transcript live encerra a captura assim que chega final do usuario, entao o
  modo realtime nao precisa esperar todo o timeout/silencio do WAV classico para
  acionar o executor.
- Wake mic com pre-roll curto: comandos como "Hey Jarvis, abrir terminal" nao
  perdem o inicio da ordem enquanto o wake word e a saudacao acontecem; frames
  semeados agora contam como fala real.
- Filtro de wake/ack: prefixos como "Hey Jarvis" e "Pois nao, patrao?" sao
  removidos antes de chegar ao fast-path/brain; ack puro vazado pelo alto-falante
  e descartado.
- Anti-loop ajustado: quando a Jarvis nao entende depois do wake, ela pode
  reabrir uma vez para correcao; capturas automaticas de resposta nao resetam o
  contador, entao eco/confusao repetida nao entra em loop.
- Fast-paths de acao e estado recebem o `userName` da persona, evitando respostas
  secas nos comandos criticos "abrir terminal" e "que horas sao".
- Drawer de configuracoes corrige o rodape "Fechar" para nao cobrir itens do
  catalogo expandido.
- Nova analise em `docs/analysis/2026-07-07-jarvis-operational-gap.md`
  documenta os gaps operacionais restantes do Nexus.

## 0.10.6 — Jarvis te ouve

Data: 2026-07-07

Correção da causa raiz da "Jarvis surda": o `autoGainControl` do Chromium (ligado por padrão quando qualquer constraint de áudio é pedida) achataba o sinal do microfone USB (fifine) perto de zero — o macOS ouvia o microfone, mas o app recebia frames mudos e nenhuma detecção de "Hey Jarvis" disparava.

### Correções

- Stream do wake word com `echoCancellation`, `noiseSuppression` e `autoGainControl` desligados — o openWakeWord/KWS quer PCM cru; o processamento corrompia as features do modelo. O eco é controlado pela pausa existente (`suppressWakeDetection`) enquanto a JARVIS fala.
- Instrumentação decisiva no wake mic: loga o dispositivo de áudio realmente capturado (`audioTrack.label` + `getSettings()`) e o RMS do primeiro frame — prova se o app pegou o microfone certo e se o sinal chegou, validando o fix no build real.

## 0.10.0 — Billing, times e operação refinada

Data: 2026-07-06

Billing/Team completo de ponta a ponta, checkout real via Stripe, licenças assinadas no app, times com convite/assentos e melhorias de operação no canvas, pipes e perfil de operador.

### Melhorias

- Backend SaaS completo para Billing/Team: checkout Pro/Team, portal Stripe, webhook idempotente, espelho de assinatura, grace `past_due` ancorada, entitlement pessoal vs time e licença JWT com TTL 30d/7d.
- Fluxo de time no app: bloco de Conta mostra owner/member, assentos usados, membros, geração de convite, entrada por código, saída e remoção de membro.
- Checkout Team no app agora envia nome do time e número de assentos ao backend; plano Free não vira checkout Pro por fallback indevido.
- Páginas web mínimas para `/billing/success`, `/billing/cancel` e `/join/<code>`, com código de convite sanitizado.
- Pipes entregam mensagens imediatamente ao criar uma conexão `onIdle`, com logs e badge de entregas na edge.
- Canvas evita drag acidental ao selecionar texto dentro de terminal/browser panes.
- Perfil de operador ganhou atalho e estado vazio mais claro.

### Correções

- Webhook Stripe reprocessa eventos não concluídos sem duplicar eventos já processados.
- Checkout Team reutiliza time pendente do owner e o reaper remove órfãos antigos, evitando travar o usuário quando o pagamento falha.
- Join de time usa advisory lock e guarda de assentos para corrida no último assento.
- LGPD: owner com assinatura de time viva não consegue apagar a conta antes de cancelar o time.
- UI de Conta não renderiza CTA de checkout inválido para Free e mostra erro retornado pelo backend.

## 0.9.0 — Auto-update & missões confiáveis

Data: 2026-07-06

Auto-update visível de ponta a ponta + conserto completo do ciclo de vida de missões + fim do spam de handoff fantasma.

### Melhorias

- Auto-update com UI: checagem no boot e a cada 6h via `gh` autenticado (repo privado; `NEXUS_UPDATE_FEED` tem precedência quando existir), badge ⇪ na WorkspaceBar (disponível/baixando/pronto/erro) e painel com atual→nova, notas do release e ações por fase. Download servido em feed Squirrel localhost — assinatura validada e swap seguro pelo Squirrel.Mac.
- Registro de missão nasce no lançamento (IPC `orch:missions.create`, orquestrador incluso na composição) — a missão nova aparece na hora no rail/board; kickoff instrui `nexus_mission_set_status` na missão já criada.
- Missões deslocadas por um novo lançamento viram "travada" (visíveis com Retomar) em vez de "rodando" fantasma.
- Retomar com resume direcionado: o `paneId` original persiste na composição (coluna `pane_id`, migração aditiva) e é reusado no reopen — cada pane volta à SUA conversa, não à mais recente do cwd.

### Correções

- Spam de handoff fantasma: o eco/repaint do bloco-exemplo do contrato de kickoff era parseado como entrega real e drenado em loop para o orquestrador (mesmo após fechar o terminal do worker). Caminho legacy agora aplica a régua anti-placeholder da tool MCP + dedupe por repaint (10min).
- `paneMissions` append-only: bindings de panes mortos marcavam a missão deslocada como "aberta" para sempre (clique no-op, sem Retomar). Prune por panes vivos a cada mudança de layout.
- Pane do orquestrador nunca era vinculado à própria missão (bind no-op com `undefined`) — a missão viva oferecia Retomar e o clique matava/recriava ela mesma. Bind por `orchestratorSessionId` + guarda de missão-já-aberta no painel.

## 0.8.2 — JARVIS operacional

Data: 2026-07-06

Refatoração sênior de confiabilidade da JARVIS + HUD flexível, guiada por análise de causa raiz e benchmark interno (benchmark de voz em tempo real, benchmark de ditado/benchmark de workspace).

### Melhorias

- Deadline duro em toda borda do pipeline de voz (STT cloud 12s, TTS 15s, cérebro 15s, whisper local 30s, piper 20s) com erro falado — fim do busy travado que deixava a JARVIS surda para sempre.
- Microfone do wake resiliente: `track.onended` + watchdog de frames (8s) + reconstrução com backoff (1s/3s/8s) + resume de AudioContext suspenso; esgotou → aviso visível.
- Retomada de turno preso: um novo "Hey Jarvis" após 20s de turno travado derruba o turno e atende.
- Wake-lock por PID (`~/.nexus/jarvis-wake.lock`): instâncias dev + empacotada não disputam mais o "Hey Jarvis".
- HUD da JARVIS compacto (300px) e flexível: arrastável pelo cabeçalho com snap de canto, redimensionável, modo mini (pill) e modo só-áudio (zero visual, voz segue); prefs persistidas + seletor nas configurações de voz.
- Novas ações de voz: `close_pane` ("fecha esse terminal") e `open_board` ("abre o quadro"); `run_command` avisa em voz que a confirmação está na tela.
- Ícones pixel refinados no toolbar/deck/board (grade 10px), botão visível do Ops Board e estados do quadro (fundação `--accent-strong`).
- Servidor: fundação do billing + team (schema subscriptions/teams/invites/stripe_events + migration).

### Correções

- Filtro anti-alucinação do Whisper consciente de contexto: "valeu/oi/tchau" em conversa ativa são resposta legítima, não lixo descartado.
- Barge-in agora mata a fala do fallback `say` no processo principal — sem vozes sobrepostas.
- Acks/fillers ("Sim?", "Deixa comigo.") fora da janela anti-eco — não censuram mais a resposta curta seguinte do usuário.
- whisper.cpp/piper deixaram de rodar síncronos no main (congelavam todo o app durante transcrição/síntese local).
- Captura de voz com deadline por timer: mic morto no meio da fala fecha o turno em vez de pendurar a escuta.

## 0.8.1 — Ops Board & identidade pixel

Data: 2026-07-06

Glow-up visual completo + novo ícone do app, em cima da fundação de contas.

### Melhorias

- Ops Board: pipeline espacial de missões (a fazer → executando → review → pronto → cancelado), trilho colorido por status, drag = planejamento, "retomar" restaura os panes. Atalho ⌘B.
- Icon set pixel unificado (NexusMark) substituindo emojis e glyphs Unicode no toolbar, deck e board.
- Novo ícone do app: diamante-nó pixel com core aceso sobre o console navy, no lugar do gradiente genérico.
- Escalas de token (`--space`/`--text`/`--radius`/`--shadow`) — espaçamento e acabamento consistentes em toda a UI.
- Orb do Jarvis reage à amplitude real do microfone (visualizador de verdade, respeitando reduced-motion).
- Settings reagrupado por intenção (Conta · Operação · Arsenal · Catálogo) + campo de busca.
- Logomark pixel (NexusMark) substitui o placeholder `◈` nas telas de entrada.

### Correções

- About mostrava a versão `0.7.1` fixa; agora acompanha o pacote.
- `textDim` revertia para um cinza que falha WCAG AA; corrigido no tema.
- Cores Material cruas no toolbar e vermelho semântico nos presets "Originals" trocados por tokens da paleta.
- Botão de fechar unificado (fim do `x` minúsculo e das 4 variantes).
- PT-BR no seletor de agente, nas fases do HUD de voz e no teste de voz.

## 0.8.0 — Contas, gamificação e glow-up

Data: 2026-07-06

Fundação de contas (OAuth) + gamificação de operador + início do glow-up visual. Saiu assinada e notarizada; changelog consolidado aqui por ter ficado para trás.

### Melhorias

- Backend de auth: login Google/GitHub (PKCE), exchange por código, sessão + rotação de refresh com detecção de reuso, licença Ed25519, `/me` e `DELETE /me` (LGPD), rate-limit por IP.
- `auth-client` no app: code → tokens no Keychain + licença; botões "Entrar com Google/GitHub"; deep-link `nexus://auth`.
- Gamificação power-scaling: XP por valor entregue (nunca consumo), tiers, prestígio, streak, conquistas, skins, mascote pixel no HUD e modo sóbrio.
- Hardening da voz Jarvis e da prontidão de providers.

## 0.7.0 — Squad CLI sync

Data: 2026-07-06

Release focada em deixar squads, providers e contas previsíveis.

### Melhorias

- AGY substitui Gemini CLI nos defaults, built-ins, squads, roteamento e remote spawn.
- Orquestrador de squad permanece no Claude; workers são distribuídos entre as CLIs instaladas.
- Providers iniciam em modo hands-free por padrão: YOLO quando suportado, senão Bypass.
- Contas novas passam a ser ativadas imediatamente.
- Contas Claude por assinatura restauram a credencial salva no Keychain antes de marcar “em uso”.
- Tela de contas mostra login local, conta em uso, cooldown, credencial ausente e ação de sincronizar.
- Review de squad foi reorganizado para evitar texto sobreposto e melhorar leitura dos controles.
- Workers Codex, AGY, Kimi e Grok preservam o `HOME` real do Mac, mantendo logins locais sincronizados dentro dos panes.
- Skills instaladas agora são espelhadas para os namespaces de Claude, Codex, AGY, Kimi e Grok; o Nexus também cria a skill `ponytail` a partir da regra interna.
- Prompts de confiança de workspace agora são tratados pelo harness: AGY é confirmado automaticamente quando mostra o diálogo conhecido, e Grok já abre com `--trust-folder`.

### Compatibilidade

- Squads antigos com `providerId: gemini-cli` passam a normalizar para `agy` quando `cli` não está explícito.

### Correções

- AGY usa `--dangerously-skip-permissions` como modo hands-free; `--yolo` não existe na CLI instalada e fazia o pane sair em `code 2`.
- AGY e Grok deixam de ficar bloqueados esperando confirmação manual de confiança do workspace/pasta em panes criados pelo Nexus.
