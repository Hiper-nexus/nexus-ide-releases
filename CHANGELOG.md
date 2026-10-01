# Changelog

## 0.76.154 — Motor que usa todo mundo

Uso real no Mac em 30/09 e 01/10. Inclui a 0.76.153 (Segunda conta Grok). Primeira build com a licença ligada ao `api.nexuside.app`.

- **Todas as CLIs entram na rota (F-226/F-232).** Em 7 dias medidos, codex/kimi/glm/devin/mimo levavam 100% das reservas e muse, grok, openclaude, minimax e deepseek ficavam com zero. Agora cada adapter elegível ganha assento na missão antes de qualquer um repetir, e o uso dos últimos 7 dias em todas as missões desempata: quem ficou para trás passa à frente. Critical, segurança, UI e menção explícita de modelo continuam fora da rotação.
- **Só modelo de ponta julga (F-233/F-237).** Revisão, auditoria, QA, veredito e parecer vão para Fable 5.1 → Opus 5.5 → Sonnet 5.5 → Sol 6.1 → Astra. Sem nenhum deles disponível, o Maestro julga no próprio pane em vez de delegar a um modelo barato. A doutrina passa a dizer: escreva com o barato que o roteador escolher, julgue com o caro, e o caro corrige só o que o veredito apontou.
- **UI e jogos nos melhores de visual (F-227).** Trabalho de interface, design e jogo (Godot, Unity, Phaser, Three.js…) vai para Opus 5.5 → Sonnet 5.5 → Sol 6.1; o Astra só por pedido explícito.
- **Duas contas Claude, dois panes (F-235).** Com o Maestro no Claude, nenhum worker Claude era roteado. Agora cabem tantos panes Claude quanto contas com credencial, cada um numa conta distinta.
- **DeepSeek de verdade (F-236).** Deixa de ser só um endereço de upstream e vira CLI roteável no host Claude (`deepseek-v4-pro`, `deepseek-flash`), com a chave já cadastrada.
- **Worker reaproveitado volta a entregar (F-239).** Um pane só podia entregar uma vez: a segunda entrega do mesmo worker (o Maestro mandou corrigir os achados, ou o fecho automático do turno seguinte) era recusada como "replay" — 36 vezes em 14 dias, entregas perdidas. Entrega anterior já recebida pelo Maestro + conteúdo novo = rodada nova; pendente continua protegida contra repetição.
- **Qwen Code entra na rota (F-238).** A CLI `qwen` (fork do Gemini CLI, instalada e configurada com `qwen3.8-max`) era só um endereço de API e nunca foi chamada. Vira CLI roteável: `qwen3.6-flash` nos tiers leves, `qwen3.7-plus` no médio, `qwen3.8-max` no pesado; catálogo lido do `~/.qwen/settings.json`; credencial fail-closed (uma `OPENAI_API_KEY` solta só vale com `OPENAI_BASE_URL` na Alibaba); conversas isoladas por checkout; MCP do Nexus por `--mcp-config`; o painel de Providers avisa quando a chave do Token Plan está recusada (401).
- **Veredito de ponta antes do push (F-234).** `nexus_git_push`, o push automático ao concluir e o `git push`/`gh pr` digitado no terminal de uma missão só rodam com um veredito "approve" de modelo de ponta (Fable 5.1, Opus 5.5, Sonnet 5.5, Sol 6.1, Astra) registrado para o HEAD exato, árvore limpa — `nexus_review_verdict`. Modelo barato pode registrar, mas não satisfaz o portão.
- **Portão de regressão compara com a base (F-246).** Teste que também falha no commit-base (ambiente, sandbox, suíte já quebrada) vira "pré-existente — não conta contra você" em vez de devolver a entrega; o worker não gasta a noite consertando o que não quebrou.
- **Hub MCP não entra inteiro em pane de missão (F-247).** Os 22 servidores do hub iam para todo worker: boot lento (16 `npx`) e workers mortos em "mcp auth failure" por servidores que pedem login. Worker só recebe o que o Maestro pedir em `allowedTools`; o Maestro recebe os locais e os remotos autenticados; panes do operador seguem com tudo.
- **"+ Pane" dentro da missão (F-231).** Numa aba de missão o picker pergunta o destino: **Nesta missão** (o pane nasce pelo Main como participante — aparece no Quadro, entrega no ledger, o Maestro lê e escreve nele, mas só você fecha), **Nesta aba (solto)** ou **Nova aba**. Pane solto ganha carimbo persistente e não é mais puxado para "Terminais".
- **PTY com a grade certa (F-248).** Se a grade do pane mudava durante o spawn (1–5 s), o terminal nascia com a largura antiga e a TUI desenhava torta até um "Redesenhar" — 154 ocorrências registradas. O resize sai assim que a sessão liga.
- **Gemini 4 Argon com nota oficial.** DeepSWE v1.1 77,9% (anúncio do Google, 30/09) entra no roteador.
- **Worker Devin/Kimi não morre em 2 s (F-230).** O brief era colado enquanto o terminal ainda pintava a tela inicial; as duas tentativas queimavam em milissegundos e o pane era fechado com "O agente não ficou pronto a tempo". Agora a entrega espera o terminal ficar pronto.
- **Pane AGY não cai por link interno (F-229).** A CLI do AGY consolida atalhos de configuração dentro do próprio estado gerenciado; a guarda de credencial lia isso como adulteração e abortava o spawn.
- **Diagnóstico não é entrega (F-227).** Pane que só lê e sinaliza é mandado resolver no mesmo pane — sem abrir outro.
- **Gate longo não para a missão (F-714).** Enquanto um validador ou suíte de horas roda, os workers adiantam as próximas unidades.
- **Fechar o app não trava mais por 45 s (F-240).** O orçamento para encerrar cada terminal (10 s + 20 s + 20 s) era maior que o teto do quit; uma CLI que ignorava o sinal levava o encerramento inteiro ao limite e deixava supervisores órfãos (50 incidentes desde 07/08). Orçamento agora 5 s + 8 s + 8 s, e cada fase do encerramento passa a ser medida — o incidente diz onde travou.
- **Maestro recebe a saída no erro (F-241).** "unknown pane" lista os panes vivos da missão; "cwd escapes workspace" explica que o worker roda na worktree da missão e como pedir outra (`isolatedWriter:true`).
- **Worker travado acorda o Maestro (F-242).** Na noite de 30/09 um worker GLM pendurou no meio do turno às 21:25; ninguém avisou o Maestro, e às 23:25 o relógio de ociosidade bloqueou a missão e matou os dois — 7 horas paradas. Agora worker `working` sem ferramenta nem saída por 20 min gera um handoff `[travado]` para o Maestro decidir (ler, destravar ou fechar e re-despachar), renotificado a cada hora; a missão não bloqueia.
- **Maestro com contexto de 400 k (F-243).** O Maestro relia ~860 k tokens em cache a cada turno (Fable 5.1, ~US$ 533 estimados num dia). O orquestrador Claude de missão passa a compactar em 400 k; workers e panes do operador não mudam.
- **Missão parada explica o reparo (F-244).** O Quadro dizia só "bloqueio técnico" e os terminais já tinham morrido. Agora o header nomeia a causa e o próximo passo, a aba Atividade começa com "Por que parou" e guarda a **última tela de cada pane** capturada antes de encerrar; eventos repetidos viram uma linha (×N) com nome legível em vez de "Evento personalizado registrado"; o botão passa a ser "Retomar o coordenador".
- **Missão pausada tem saída (F-245).** "Tentar início novamente" resolvia sem erro e sem efeito quando o pane do coordenador tinha sido fechado, e "Retomar" recusava bloqueio sem marcador de dispatch — a missão pausada por ociosidade não tinha como voltar. Agora o Quadro oferece **Retomar o coordenador** para qualquer bloqueio técnico (remount com nota de continuidade), e o caminho mecânico avisa em vez de calar.
- **Failover honesto (F-249).** O Nexus dizia "conta atingiu limite, trocando" sem ter atingido nem trocado: (a) um limite que a API do provider não conseguiu confirmar já respawnava o pane na conta irmã — texto citado no terminal podia destruir uma sessão sã; agora a conta fica 15 min em pausa, o pane segue na mesma conta e uma re-sonda decide de verdade. (b) O evento "trocou" saía antes da troca — em worker de missão o respawn podia falhar e o toast já tinha mentido; agora o sucesso só é emitido depois do religamento real, e pane ausente avisa "Troca de conta não aplicada". Toda decisão de troca passa a sair no `main.trace.ndjson` (`account-failover`) — audita o que aconteceu de fato. E o recibo de rota não diz mais "não instalado" para uma CLI reservada ao Maestro.
- **Chave pública de licença vai no repo.** `resources/license-pubkey.pem` (par de produção do `api.nexuside.app`) é a fonte padrão do build; `NEXUS_LICENSE_PUBKEY` continua como override. Build de Windows/Linux/CI não precisa mais de variável de ambiente — a chave pública viaja dentro de cada binário mesmo, não é segredo.
- **Licença sem lockout falso (F-228).** Tela de bloqueio não pisca a cada renovação, resposta boa não vira "sessão expirou" quando outra requisição renovou a sessão, relógio até 5 min atrasado não invalida token novo, e o token é gravado antes de avançar a cerca de replay. Chave do selo nunca é regenerada quando o decrypt falha (histórico anti-replay preservado), o boot com sessão guardada mostra "Consultando seu acesso" em vez da tela de login, e criar pane sem acesso avisa em vez de devolver id vazio.
- **Smoke de release licenciado de mentira (F-250).** O gate de candidato falhava no probe `mission-prepare` (`license_access_denied: login-required`): o app do smoke abre sem conta nem selo e a missão passa pelo gate de licença novo. Como `--smoke-test` nunca vira produto utilizável (roda os probes e encerra), a avaliação de licença concede `pro` só nesse modo — mesma concessão que vault, updater e microfone já tinham.
- **Chrome bloqueado pelo macOS explica o que fazer (F-225).** Em vez de EPERM cru, o painel pede Acesso Total ao Disco em Ajustes do Sistema.

## 0.76.153 — Segunda conta Grok

Uso real no Windows em 30/09. Inclui a 0.76.152 (Jev que ajuda) e dois commits do Mac ainda sem versão própria: o erro do provider só vira toast no desfecho do failover (F-222), e saem o modo canvas e as notas adesivas.

- **Conta Grok gerenciada volta a abrir (F-710).** A conta Grok gerenciada liga cada entrada ao `~/.grok` nativo, e `bundled` é um link para pasta. No Windows, `linkEntry` tratava todo link como arquivo: tentava hardlink e depois cópia de diretório (`EPERM copyfile …\bundled`). Todo pane daquela conta morria com "failed to prepare the isolated grok agent runtime" desde que a conta foi criada. Agora o link segue o destino, e pasta vira junção para a pasta real.

## 0.76.152 — Jev que ajuda

Plano de uso do Jev, a partir do mapa de 30/09 (826 decisões em 8 dias, 55% delas na guarda e zero nas superfícies que aceleram o trabalho). Inclui a 0.76.151 do Mac.

- **Revisão de entrega calibrada (F-707).** Em 82 revisões houve 45 devoluções. Só 5 voltaram "ok" e 22 nunca foram reenviadas: a devolução recusa o `handoff_submit`, e a entrega sumia até o Maestro cobrar. O sinal "admite pendência" disparava para o revisor que relata NÃO PASS. A rubrica foi reescrita e medida com o Jev real nas 105 entregas de sucesso do HiperGO: devoluções caem de 98 para 3, todas justas. Achado de revisor e pendência admitida entram com `[evidência fraca]`, sem devolução.
- **Maestro recebe a divisão do pedido (F-708).** O pedido que o operador digita no Maestro passa pelo mesmo Jev de delegação do "+ Pane". Com 2+ partes, vira "abra N workers (R de leitura, W de escrita) em paralelo e encerre o turno".
- **Guarda não julga `pane_close` (F-709).** Eram 132 das 450 decisões da guarda, todas aprovadas, cada uma segurando o Maestro até 3 s. Spawn, write e terminal seguem julgados.

## 0.76.151 — Mac em dia com o Windows

Primeira build para macOS desde a 0.76.146. Traz ao Mac as correções da 0.76.147 à 0.76.150, publicadas só para Windows. Inclui a 0.76.150.

- **Valem também no Mac.** As CLIs do Mac estão nas mesmas versões medidas no Windows: Claude Code 2.1.285, AGY 1.2.14, Devin 3000.11.3, Muse 1.4.1 e Kimi 2.1.1. Com isso chegam ao Mac: GLM sem o aviso de Bypass e com os hooks (F-693), Kimi na rota e com cota (F-694/F-695), Muse, AGY e Devin com o MCP do Nexus nas missões (F-696/F-697/F-698), GPT-6 Astra só pelo nome (F-700), Maestro que mantém a doutrina de delegar (F-701), worker que não para para perguntar (F-702), entrega confirmada pelo Maestro virando memória (F-703) e AGY sem "invalid model selection" por esforço (F-705). O `agy mcp list` e o `devin mcp list` do Mac têm o mesmo formato que os parsers do F-697/F-698 leem. F-704 e F-706 só mudam o Windows.
- **Testes sem mexer no perfil real (F-219).** A suíte rodava o `agy mcp add` de verdade e gravava `nexus` no perfil do AGY de quem testa. Os registros de AGY, Devin e Muse ficam mockados, e dois testes que exigiam o AGY sem MCP seguem o contrato do F-697.
- **Audit do toolchain em zero (F-412).** Os overrides `fast-uri` 3.1.7 e `ip-address` 10.5.1 ganharam três alertas moderados. Subiram para 3.1.8 e 10.7.2, publicadas em 15/09.

## 0.76.150 — Hooks de volta no Windows

Uso real no Windows em 30/09, achado ao mapear o uso do Jev. Inclui a 0.76.149 (memória do projeto).

- **Hooks do Nexus inteiros no Windows (F-704).** O Claude Code do Windows roda hooks pelo Git Bash. O MSYS convertia o `/d /c` do `cmd.exe /d /c echo NEXUS_HOOK_STATUS>NUL&&powershell…` em caminhos, o `cmd` abria interativo e engolia o JSON do stdin, e o PowerShell postava corpo vazio. Em três dias de panes Claude/GLM houve 349 falhas de Bash e zero triagens, zero conselhos de delegação e zero memórias de preferência; o portão de regressão e o lembrete do Maestro (F-701) também chegavam vazios. Agora o comando é só `powershell.exe -EncodedCommand`, com prelúdio fixo: marcador, UTF-8 no stdin, no stdout e no corpo, e barra de progresso desligada. A limpeza reconhece o formato novo e o antigo. O teste roda o hook de verdade via `bash -c` no Windows.
- **AGY sem "invalid model selection" (F-705).** No AGY 1.2.14 o esforço mora no id (`gemini-3.8-flash-low|medium|high`), e `--effort` diferente do sufixo derruba o pane. O spawn troca para a variante do esforço pedido ou tira o `--effort`. A tabela deixa de pedir `flash-high`/`medium` e `xhigh`.
- **Muse recebe a tarefa no Windows (F-706).** `muse.cmd` chama um launcher PowerShell. Como `.cmd`, o brief saía do argv para a colagem pós-boot, que o Muse nunca recebia: workers ficaram até 2h56 parados, sem handoff. O spawn abre `muse-bin-<versão>.exe` direto, como o launcher faz, e o brief vai no argv.

## 0.76.149 — Memória que enche

Uso real no Windows em 30/09. Inclui a 0.76.148 (Maestro delega).

- **Entrega confirmada pelo Maestro vira memória (F-703).** Depois de dois dias de missão HiperGO, a tela Memória estava vazia e o Jev nunca tinha sido chamado para destilar memória. As gravações automáticas exigiam um trilho que a missão da aba não percorre: tarefa do plano selado, evidência verificada pelo Main, fila de merge ou prompt no "+ Pane". Os 118 handoffs não tinham nenhum desses. Agora o `nexus_handoff_ack` do Maestro a uma entrega de sucesso fora do plano leva o resumo à mesma barreira do aceite: filtro de diretiva e Jev `instruction_free` + `worth_retaining`, numa linha de até 400 caracteres. O que o Jev aprovar aparece em Memória. Resumo descartado não grava nada, e as entregas antigas não são reprocessadas. A memória continua local de cada máquina.

## 0.76.148 — Maestro delega

Uso real no Windows em 30/09, numa missão de dois dias no HiperGO. Inclui a 0.76.147 (todas as CLIs na rota).

- **Maestro volta a delegar (F-701).** A doutrina "delegue, não execute" só viajava no kickoff. Depois de compactar o contexto, o Maestro passou a implementar sozinho, e o operador teve de pedir "solta mais panes". Agora a doutrina curta vai nas `instructions` do MCP de todo orquestrador de missão, que ficam no prompt de sistema e sobrevivem à compactação. O hook do prompt também relembra a cada 30 min, inclusive na entrega de um worker. O Codex recebe a doutrina inteira pelo hook.
- **GPT-6 Astra só pelo nome (F-700).** Com o Claude reservado ao Maestro, a regra de topo punha o Astra em toda revisão e todo critical: 20 de 76 workers em 24 h. Ele custa $10/$50 e perde do GPT-6.1 Sol no DeepSWE (74,1 × 75,2). Saiu das tabelas e da ordem de topo e é honrado só quando pedido pelo nome. O slot Codex de hard/critical é o Sol 6.1.
- **Worker não pergunta ao humano (F-702).** Workers Codex paravam em `request_user_input_async` quando o brief (clone WSL, publicar branch) conflitava com a autoridade de execução do Nexus: foram 4 travas em 3 dias. O contrato de todo worker agora diz que não há humano no pane, que o Nexus vence o conflito (e ele volta como bloqueio no handoff) e que não se abrem subagentes internos da CLI.
- **MiniMax não é estacionado trabalhando (F-699).** Manifesto de tela para o `mcode`: `Running <tempo>` com `Esc stop`, ou `<n> background active`, contam como trabalho, e o guardião de memória deixa de estacionar o pane no meio de uma tarefa.

## 0.76.147 — Todas as CLIs na rota

Uso real no Windows em 30/09. Regra do operador: nenhuma LLM fica sem operar no Nexus. Inclui a 0.76.146 (Sol 6.1 em todo pedido).

- **AGY (Gemini 3.8) nas missões (F-697).** Em 48 h o AGY abriu 1 pane, e o Maestro relatou que o Nexus o rejeitava. `canUseNexusMcp` forçava `false` para o AGY com base no AGY 1.1. O AGY 1.2.14 lê o perfil nativo e herda o ambiente em servidores stdio; `agy -p` provou `initialize`, `tools/list` e `tools/call` autenticados pela ponte do Nexus. O Nexus registra a ponte pela própria CLI (`agy mcp add`, idempotente). Registro falho num worker de missão derruba o spawn em vez de deixar o worker sem como entregar.
- **Devin nas missões (F-698).** Mesma correção: `devin mcp add --scope user` (nunca o escopo `local`, que grava dentro do repositório), provado com `devin -p`.
- **Kimi volta à rota (F-694).** O Kimi Code 2.1.1 guarda o login em `credentials/kimi-code-env-<hash>.json`, e a detecção só procurava `kimi-code.json`: nenhum spawn de Kimi em 48 h. Agora aceita as variantes.
- **Cota do Kimi (F-695).** A cota lê a credencial da CLI e, quando o servidor rotaciona o refresh token, grava de volta no mesmo arquivo de onde leu.
- **Muse nas missões (F-696).** O Muse Code 1.4.1 lê `mcpServers` do `settings.json`; o Nexus registra a ponte uma vez, e o Muse Spark 1.3 (gratuito, DeepSWE 75,4) entra em todos os tiers.
- **GLM sem o aviso de Bypass, com os hooks de volta (F-693).** O filtro de skills gravava `skillOverrides: "off"`, mas no Claude Code 2.1.285 esse campo é um mapa. O valor inválido descartava o `settings.json` do HOME efêmero inteiro, e com ele o `skipDangerousModePermissionPrompt` e os hooks de gate e de status. Provado em PTY real (A/B).

Com a release, 12 CLIs ficam roteáveis e com MCP: Claude, Codex, Kimi, Grok, GLM, GLM Flash, AGY, OpenCode, MiMo, MiniMax, Muse e Devin.

## 0.76.146 — Sol 6.1 em todo pedido

Pedido do operador em 29/09: "entrou o Sol 6.1, não devo usar o Sol normal; quando preciso de modelo bom devo usar o Sol 6.1". Inclui a 0.76.145.

- **Modelo pedido pelo nome também sobe para o mais novo (F-218).** A 0.76.144 (F-217) subia de versão a rota automática e o padrão do pane, mas o modelo que um agente pedia pelo nome continuava na versão pedida. O Maestro Claude não conhece o GPT-6.1 Sol, lançado hoje, e pedia o GPT-6 Sol. Agora o modelo passado em `nexus_pane_spawn`, o do template de squad e o citado no texto da tarefa usam a versão mais nova da mesma linha que a CLI oferece. O recibo do spawn mostra `modelUpgrade` com o que foi pedido e o que rodou. Ficam como estão: rosters selados de missões já criadas, panes retomados e o modelo que você escolhe no "+ Pane".

## 0.76.145 — MiniMax livre

Uso real no Windows em 29/09. Inclui a 0.76.144 (O modelo mais novo, sempre).

- **MiniMax Code roda livre (F-692).** O operador relatou que o MiniMax Code "fica pedindo permissão toda hora". A TUI do `mcode` não tem flag nem variável de ambiente de permissão: o modo vem só da chave `permissionMode` do `~/.minimax/config.yaml`, e o padrão (Ask) pede aprovação a cada ferramenta. As demais CLIs já nascem em modo livre pela sequência verificada de cada adapter. Antes de abrir um pane MiniMax gravável, o Nexus agora garante `permissionMode: bypassPermissions` ("Full access") nesse arquivo. A edição é textual e idempotente: só a linha de topo muda, e o resto do arquivo fica como estava. Panes somente leitura não são liberados.

## 0.76.144 — O modelo mais novo, sempre

Pedido do operador em 29/09: "qualquer modelo novo deve ser usado; os novos são os melhores". Inclui a 0.76.143.

- **Modelo novo que a CLI anuncia é usado sem cadastro (F-217).** A 0.76.142 (F-691) aplicou a regra aos modelos que o Nexus já conhecia: o MiniMax M3.1 Flash Preview virou o padrão e o primeiro de todo tier. Faltava o modelo que a CLI passa a oferecer depois. Agora a versão mais nova da mesma linha (só os números mudam, como `gpt-6.1-sol` → `gpt-6.2-sol` ou `claude-opus-5-5` → `claude-opus-5-6`) substitui a antiga na rota automática e como padrão do pane assim que a CLI a lista. Sem benchmark publicado, ela herda a nota da versão anterior. A versão nova de um modelo de topo continua tratada como topo em revisão e trabalho crítico. Modelos bloqueados pelo catálogo, recusados pelo provider ou citados no texto da tarefa ficam como estavam. Uma linha nova de verdade (outro nome, não só outro número) ainda precisa ser cadastrada.

## 0.76.143 — Terminal sobe rápido

Pedido do operador em 29/09: terminais que embaralham e pane novo que demora quase um minuto para subir. Inclui a 0.76.142.

- **Pane novo sobe em segundos (F-215).** Os writers isolados do Maestro levaram de 47,7 a 52,4 s para abrir, quase tudo copiando o node_modules do saasbarbearia (331 mil entradas) arquivo por arquivo. O 1º pane de uma aba nova do "+" passa pelo mesmo caminho. Agora o Nexus clona a pasta inteira numa chamada só do macOS: 32 s caem para 4 a 6 s, medidos na máquina ociosa. O node_modules do app nativo (`apps/mobile`) também passa a vir clonado, desde que o git o ignore; antes o writer precisava criar o link à mão para rodar os testes.
- **Terminal no tamanho certo (F-216).** No pane GLM do print, a CLI desenhava num tamanho diferente do pane: linhas quebradas na largura errada e restos abaixo da barra de status. Ao focar ou voltar a ver um pane, o Nexus agora reafirma o tamanho dele para a CLI. Se ela estava em outro tamanho, a tela é redesenhada inteira. O trace passa a registrar quando isso acontece. O toolbar do pane ganhou "Redesenhar tela", para quando algo ainda sair embaralhado. A causa exata do seu print não foi reproduzida.

## 0.76.142 — Codex no Windows

Uso real no Windows em 29/09. Inclui a 0.76.141.

- **Codex não morre com o Nexus elevado (F-689).** Às 18:47 e às 18:48 dois Codex saíram com código 0 em 12 a 20 s, e o disjuntor tirou o Codex da missão. Reproduzido num PTY real: o Codex 0.159 do Windows sobe um servidor compartilhado em segundo plano e sai com "start the Windows daemon from a non-elevated terminal" quando o cliente é elevado. O Nexus aberto como administrador passa a elevação a todo pane. No Windows, todo pane Codex agora abre com `--no-daemon`, colocado depois da reconstrução governada do argv. A flag só entra quando o `--help` do Codex instalado a anuncia.
- **Codex só abre com ferramentas que rodam (F-688).** O Codex ≥ 0.157 roda toda ferramenta por `codex-code-mode-host.exe`, dentro do pacote npm. No prefixo do Node portátil do WinGet esse caminho chega a 262 caracteres, e o Windows recusa com `os error 3`. O spawn troca esse `codex.cmd` pela instalação curta em `%USERPROFILE%\.local\bin` ou recusa com a correção exata, e o "Atualizar CLI" reinstala nesse prefixo curto.
- **Helper reaproveitado não é fechado (F-690).** O TTL pós-handoff fecha o worker ocioso 30 s depois de todos os handoffs dele serem consumidos. O Maestro reaproveitava o helper com `nexus_pane_write` segundos depois do consumo; o handoff antigo seguia consumido e, na primeira pausa do trabalho novo, o Nexus o matava. Aconteceu três vezes em 29/09, às 16:06, 16:57 e 18:14, e o Maestro relatou "encerrou sem entregar". Trabalho iniciado depois do último consumo agora adia o fechamento até sair um handoff novo.
- **O modelo mais novo sempre (F-691).** Regra do operador: todo modelo novo que entra no Nexus é usado e vem na frente, com ou sem benchmark. O MiniMax M3.1-Flash-Preview vira o padrão e o primeiro de todo tier (M3 e M2.7 de reserva), e uma versão nova sem número herda a nota do antecessor como piso. O tier trivial do AGY passa do Gemini 3.7 ao 3.8. Um teste-guarda reprova rota mais velha que um modelo da mesma linha no catálogo.

## 0.76.141 — Sem piscar

Uso real no Windows em 29/09. Inclui a 0.76.140 (GPT-6.1 Sol).

- **Cabeçalho dos panes para de piscar (F-686).** Na gravação das 18:08 todos os cabeçalhos alternavam juntos entre título ("pane 1 · Claude · Orquestrador") e botões a cada quadro. A densidade do cabeçalho seguia o limite exato de largura; no Windows a barra de rolagem ocupa ~17 px, e trocar de densidade fazia a barra da grade aparecer e sumir, empurrando todos os panes de volta pelo limite. Encolher continua imediato; voltar a um modo mais largo exige 32 px de folga.
- **Codex sem "Hooks need review" no Windows (F-687).** O pane Codex parava em "8 hooks are new or changed / Trust all and continue". A flag `--dangerously-bypass-hook-trust` depende da versão do Codex, e a versão era lida por `execFileSync('codex')`. No Windows o Codex do npm é um `.cmd`: ENOENT pelo nome, EINVAL pelo `.cmd`. A versão agora sai pelo mesmo lançador verificado do spawn (`node.exe` + `codex.js` do pacote). Quando não dá para saber a versão, a flag continua de fora.
- **Nexus Shot no Windows (F-685).** O ingest recusava todo caminho que não começasse com "/", e toda captura voltava `path-not-absolute`. Agora aceita caminhos com letra de unidade; UNC e `\?\` continuam recusados. As raízes passam a ser Imagens e Vídeos, mais as pastas conhecidas do Electron (OneDrive).

## 0.76.140 — GPT-6.1 Sol

Lançamento da OpenAI em 29/09. Inclui a 0.76.139.

- **GPT-6.1 Sol é o modelo de trabalho do Codex.** Mesmo preço do GPT-6 Sol ($2/$10 por milhão de tokens; cache $0,10), DeepSWE 75,2 contra 68,8, e empata com o GPT-6 Astra a um quinto do custo, segundo a OpenAI. Panes, squads e a rota automática do Codex passam a usá-lo, e o Jev passa a chegar nele sempre que a tarefa pede o modelo de trabalho da OpenAI. O Codex que ainda não lista o 6.1 continua no GPT-6 Sol. O Astra segue reservado para revisão, alto risco e trabalho crítico.

## 0.76.139 — O Nexus orquestra sozinho

Pedido do operador em 29/09: o Nexus deve saber orquestrar sozinho e saber qual modelo usar para cada tarefa. Inclui a 0.76.138.

- **Orquestração automática no Autopilot (F-200).** Às 13:21 o pedido "coloca nativo e no pwa e web" chegou a um pane comum, e o Jev julgou 0,56 de chance de dividir, abaixo da régua de 0,6. O pane trabalhou sozinho por 10 minutos, até você torná-lo orquestrador; aí ele abriu os dois writers em 2 minutos. Agora o critério do Jev conta "a mesma mudança em apps ou superfícies separadas". Com confiança de 0,7 ou mais em Autopilot, o Nexus torna o pane orquestrador e manda abrir um helper por parte. No Hardened ele só sugere. Na avaliação com 18 pedidos reais, o critério novo acerta 4 dos 6 pedidos divisíveis (o antigo, 3), sem nenhum falso alarme nos outros 12. O hook também deixa de julgar mensagens que não foram escritas por você (avisos do Nexus, entregas de helper, notificações de tarefa).
- **Revisão e trabalho crítico com modelo de topo (F-214).** As duas revisões sênior do diff de tenant/migration de 29/09 foram para o MiMo V2.6 Pro, com o GPT-6 Astra em 2º. Nos benchmarks oficiais que o roteador usava, todos já marcam perto do máximo, então o custo decidia. No Terminal-Bench 4.0, que separa os modelos, o próprio card da Xiaomi dá 34,9 ao Pro e 28,8 ao Flash, contra 66,4 do Opus 5.5. Agora revisão em tarefa difícil e todo trabalho crítico vão para GPT-6 Astra, Claude Fable 5.1 ou Opus 5.5, de qualquer CLI disponível. O restante segue distribuído entre todas as LLMs, com Flash no rotineiro e Pro no difícil.
- **Electron 43.7.4 (F-411).** O gate de segurança barrou a publicação: o Electron 43.0.0, que roda o app desde julho, tem quatro alertas altos novos. Os quatro tratam de sandbox, de leitura entre origens e do preload. Todos estão corrigidos na 43.7.4, publicada há 7 dias. A 0.76.138 ainda roda o 43.0.0.

## 0.76.138 — Várias missões lado a lado

Pedido do operador em 29/09: abrir mais uma missão pelo "+ Pane", tornar o segundo terminal orquestrador e ver as duas operando. Inclui a 0.76.137.

- **Aguardando, não Dormindo (F-198).** O Quadro só contava o Maestro como vivo quando ele estava ocupado. Parado no prompt, o estado normal logo depois de "Tornar orquestrador" e entre um pedido e outro, a missão aparecia como "Dormindo", com a orientação do Quadro desligada e só "Tentar início novamente". Agora a barra lateral e as abas mostram "Aguardando", o Quadro mostra "Aguardando sua instrução" e a orientação fica liberada. "Dormindo" fica só para missão sem processo.
- **Aba com missão dormindo aceita outra (F-373).** "Tornar orquestrador" numa aba cuja missão dormia ou tinha parado tentava entrar nessa missão, o Nexus recusava e aparecia "Não foi possível definir o orquestrador". Agora o pane novo abre uma missão nova, com nome próprio ("Missão · Checkout 2"), e a antiga continua na barra lateral até você retomá-la. A aba volta a oferecer "Criar missão desta aba" e a fechar pelo ×.
- **O segundo orquestrador pergunta (F-374).** Numa aba com missão rodando e Maestro vivo, "Tornar orquestrador" em outro pane tomava a liderança em silêncio e o Maestro anterior deixava de coordenar. Agora você escolhe: "Nova missão deste painel", em paralelo, ou "Assumir a liderança".
- **Writers voltam a entregar (F-199).** Na missão do saasbarbearia de 29/09, os três writers GLM tiveram a entrega recusada duas vezes cada pelo portão de regressão, com "seu diff quebrou 36/63/69 arquivos de teste". O portão rodava o Jest sem a config do projeto (`tests/jest.config.js`), e nenhum teste TypeScript chegava a ser lido. Agora ele usa a config que os scripts do projeto passam em `--config`. Arquivo que não carrega por erro de parse fora do diff vira "não verificado"; erro de parse num arquivo do diff continua barrando.

## 0.76.137 — Sem clique, sem relogin

Uso real no Windows em 29/09.

- **Panes sem clique no início (F-681).** O Codex 0.157 para em "Trust this folder? / Trust and continue / Quit" em pasta sem decisão, e o Claude Code novo desenha o aviso de Bypass Permissions sem números e com o cursor já em "Yes, I accept" — nos dois casos o pane ficava esperando Enter. O trust do Codex é respondido só em pane não governado (o perfil de missão mantém a pasta restrita do F-666); o aviso de bypass lê o cursor desenhado; o aceite forçado prefere a assinatura que casa inteira.
- **operatorChoice só com prova (F-682).** O Maestro marcava `operatorChoice:true` sozinho e abriu 4 de 4 helpers em Claude. A flag agora exige que o operador tenha nomeado a CLI no pane ou numa orientação do Quadro nos últimos 30 min; sem isso o pin vira preferência (`operatorChoice-sem-pedido-do-operador` no recibo).
- **Modelo recusado sai da rota (F-683).** "Upstream request failed: Model access is disabled" (OpenCode Zen) passa a ser modelo recusado: o pane troca de modelo e o roteador deixa o par CLI+modelo em quarentena por 12 h.
- **Grok mantém o login no Windows (F-684).** O auth.json renovado dentro do pane (hardlink desfeito pelo rename da CLI) volta ao perfil de origem durante a vida do pane — só da mesma conta e mais novo, no próprio arquivo — inclusive em pane governado e sem depender do fechamento.

## 0.76.136 — Agente trabalhando não cai

Uso real no Windows em 29/09. Inclui a 0.76.135 (Todas as LLMs de verdade, com o Jev enxugando).

- **Chef-idle não derruba missão com agente trabalhando (F-680).** Duas vezes em 29/09 (00:15 e 10:21) os três panes da missão viraram "processo caiu" com "Precisa de reparo". O trace F-212 mostrou a cadeia: o chef-idle escalava a missão para bloqueada ("60 min sem progresso") e o reconciliador de autoridade encerrava todos os runtimes da missão no mesmo segundo. Só que num caso o Maestro estava no meio de um comando longo e silencioso, e no outro um worker Claude trabalhava até 1,5 min antes. O relógio agora ignora o Maestro com turno aberto e recomeça quando um worker está ocupado ou em turno.

## 0.76.135 — Todas as LLMs de verdade, com o Jev enxugando

Pedido do operador em 29/09. Inclui a 0.76.134.

- **CLI fixada pelo agente vira preferência (F-195).** De 25/09 a 28/09, 26 dos 71 panes abertos pelos agentes tinham a CLI fixada, 21 deles em Claude. O Maestro da saasbarbearia abriu todos os writers e revisores em Claude. Agora, sem pedido seu, a CLI fixada é só uma preferência e a rota decide pelo benchmark oficial e pela diversidade. A CLI que você digitou no pane (por exemplo "solta pane swe grok agy mimo") continua valendo.
- **Jev classifica a tarefa pelo trabalho real (F-194).** O texto antigo mandava 60 de 78 tarefas reais para o tier mais caro. O novo, testado com o Jev nas mesmas 78 tarefas, manda 32 para o tier caro e 39 para o médio. No tier caro, um modelo barato com nota de benchmark próxima agora vence o caro.
- **Maestro lê menos e decide igual (F-196).** A leitura de pane pelo Maestro vem resumida: linhas de erro, teste e pergunta, as últimas 30 linhas e o estado do pane julgado pelo Jev. A lista de handoffs não repete os artifacts de entregas antigas. Texto inteiro sob pedido (`mode:'full'`, `detail:'full'`).
- **Helper parado recebe a continuação (F-197).** Quando um helper da mesma CLI está parado com o contexto certo, o Jev entrega a tarefa a ele em vez de abrir outro pane, economizando a abertura e o briefing. Revisão independente nunca vai para quem escreveu o código. Há um toggle em Ajustes.

## 0.76.134 — Revisão completa

Revisão de todas as mudanças da 0.76.126 à 0.76.133, com a suíte inteira de testes verde. Inclui a 0.76.133.

- **Orientação a um agente específico da missão da aba (F-193).** A revisão achou uma regressão da 0.76.132: com o Maestro e os helpers da missão da aba no seletor do Quadro, orientar um agente específico falhava. Agora a orientação vai ao Maestro com a indicação do helper escolhido, e as recusas da caixa de orientação aparecem em português, dizendo o que fazer (esperar o briefing, Retomar ou «Religar a missão ao Maestro»), em vez da mensagem técnica em inglês.

## 0.76.133 — Orientação chega ao Maestro da aba

Correção do uso real de 29/09. Inclui a 0.76.132.

- **Orientação pelo Quadro na missão da aba (F-192).** Em missão aberta a partir de um pane, enviar uma orientação pelo Quadro ("@todos: …") falhava com "Mission direct requires the current kickoff receipt": o Nexus exigia um recibo de início que essas missões nunca têm. Agora a orientação vai direto ao Maestro da missão, com as demais checagens de sessão e autoridade mantidas.

## 0.76.132 — Equipe da missão da aba no Quadro

Correção do uso real de 29/09. Inclui a 0.76.131.

- **Quadro mostra quem trabalha na missão da aba (F-191).** Missão aberta a partir de um pane não tem equipe planejada, e o Quadro dizia "Não foi possível carregar a equipe desta missão" mesmo com o Maestro e os helpers trabalhando. Agora o grafo mostra o Maestro e cada helper pelos panes da missão; sem nenhum pane ainda, o aviso explica que os agentes aparecem quando o orquestrador abrir panes.

## 0.76.131 — Pane órfão volta a abrir

Correção do uso real de 29/09. Inclui a 0.76.130.

- **Pane com missão órfã volta a abrir (F-190).** Um pane que o layout ainda ligava a uma missão que não existe mais não abria nunca: Reiniciar e Retomar terminavam em "renderer payload does not match main-sealed persisted pane request". Agora o Nexus usa a missão que ele próprio tem gravada para aquele pane; sem registro nenhum, o pane abre como pane comum. Uma missão real diferente continua sendo recusada.

## 0.76.130 — Maestro religado lidera de novo

Correção do uso real de 29/09. Inclui a 0.76.129.

- **Missão reconhece o Maestro religado (F-372).** Quando o processo do Maestro saía e o Nexus o religava no mesmo pane, a missão continuava apontando a sessão morta: o Quadro ficava em "O orquestrador reiniciou e a missão não o reconhece" para sempre e as entregas dos agentes não chegavam a ele. Agora o religamento também religa a missão, e quem já está nesse estado tem o botão "Religar a missão ao Maestro" no Quadro.

## 0.76.129 — Catálogo em dia

Uso real no Windows em 29/09. Inclui a 0.76.128 (Todas as LLMs pelo benchmark oficial).

- **Catálogo local velho não sobrescreve o do app (F-679).** `~/.nexus/model-catalog.json`, semeado numa versão antiga, nunca era regravado (o refresh remoto dá 404 no repo privado) e, sendo a última camada, vencia o catálogo publicado: aqui dizia `gemini-3.8-flash-high` custo low (hoje high) e a rota do F-189 escolhia o AGY no lugar do glm-5.3. Cópia com data anterior ao catálogo do app vira a camada de baixo e só acrescenta modelos que o app não conhece; cópia sem data ou mais nova continua mandando.

## 0.76.128 — Todas as LLMs pelo benchmark oficial

Pedido do operador em 29/09. Inclui a 0.76.127.

- **Rota por todas as CLIs disponíveis (F-189).** O Maestro fixava Claude ou Codex e excluía CLIs saudáveis (Grok, AGY, Kimi), a heurística por especialidade empurrava Claude e Codex, e a posição na tabela pesava mais que o benchmark. Agora a rota vem do benchmark oficial publicado por cada LLM, com peso dobrado; modelo sem benchmark publicado entra com nota neutra em vez de ficar sempre por último; a preferência do Maestro só desempata e a exclusão de uma CLI saudável é ignorada (e avisada no motivo da rota). O resultado espalha as tarefas por MiMo, MiniMax, Kimi, GLM, Grok, Gemini, Codex, Claude e as demais CLIs prontas, inclusive nos panes abertos pelo operador sem missão.

## 0.76.127 — Troca de projeto sem perder agentes

Correção urgente do uso real de 29/09. Inclui a 0.76.126.

- **Trocar de workspace não mata mais os agentes (F-188).** Ao sair de um projeto, o Nexus encerrava helpers cujo plano tinha sido revisado; ao voltar, encerrava qualquer pane da missão que não passasse numa checagem de apresentação. Depois de algumas trocas só sobrava o Maestro, e os panes mortos pareciam vivos: cada tecla dava "o main recusou a digitação neste pane" e Reiniciar não fazia nada. Agora a troca nunca encerra agente vivo e, quando um agente para fora da tela, o pane mostra que ele parou e aceita Retomar e Reiniciar.

## 0.76.126 — Volta inteira

Correções do uso real de 28/09: missões em dois projetos ao mesmo tempo, troca de aplicativo e ditado. Inclui a 0.76.125.

- **Conversa do Codex retomada (F-211).** Os panes Codex gravam as conversas no estado do Nexus por checkout, mas o leitor de uso só olhava `~/.codex/sessions`: nenhuma conversa Codex ficava vinculada ao pane e todo religamento abria uma conversa nova — foi o que aconteceu com o Maestro Codex de uma missão da aba em 28/09. Agora o Nexus lê essas conversas e grava o vínculo com a conta do pane; religar, acordar ou retomar volta à mesma conversa. Conversas iniciadas antes desta versão não têm vínculo e ainda abrem uma nova.
- **Maestro vivo não é substituído (F-187).** Um religamento automático (tecla num pane morto, autoridade de spawn vencida, reabertura do projeto) decidia respawnar quando não reconhecia o Maestro como líder e encerrava o processo vivo antes de abrir outro. Agora a remontagem automática adota o Maestro que está vivo; só o Retomar do operador substitui o Maestro.
- **Pane de helper encerrado fala a verdade (F-367/F-368).** Uma tecla no pane de um helper encerrado não promete mais "o Maestro abre em outro pane" sem que nada aconteça: com o Maestro vivo, o pane diz que é histórico e aponta onde escrever, sem religar a missão. A dica "tentativa recente em curso" aparece no máximo uma vez a cada 15 s, em vez de uma linha por tecla.
- **Tela da TUI volta inteira (F-369/F-370).** Quando parte da saída de um agente é descartada (limite de 2 MiB) ou o pane hiberna, o Nexus pede à CLI para redesenhar a tela ao revelar o pane, em vez de deixar fragmentos num fundo preto. No macOS, voltar de outro aplicativo agora remede e repinta os panes visíveis.
- **Ditado com andamento no pane (F-371).** Depois de soltar o Espaço, o pane focado mostra "Transcrevendo áudio…" com o tempo decorrido até o texto chegar, ou "Transcrição falhou — veja Voz". Medido em 28/09: STT ~1,5 s, refino do modo CODE ~4 s e entrega ~0,75 s.
- **Diagnóstico gravado (F-212/F-213).** `main.trace.ndjson` passa a registrar a saída de cada PTY de agente (código, sinal, tempo de vida e quem pediu o término) e o tempo de cada etapa do nascimento de um pane (espera do renderer, preparo da conta, permissões, rota, isolamento e criação do PTY). Com o que a 0.76.122 registrava, a causa das mortes e das aberturas lentas de 28/09 não pôde ser determinada.

## 0.76.125 — Frota de contas

Uso real no Windows em 28/09.

- **Troca de conta com frotas de 10–100 contas (F-676).** O disjuntor de "sessão que morre de auth" era do provider inteiro: duas contas expiradas quaisquer paravam a troca de todas. Agora é por conta (a mesma conta morta duas vezes), e o provider só trava com cinco contas distintas mortas. Cada limite percorre a frota até 12 contas e tira da frente, por 5 min, a conta que não prepara. A sondagem de cota roda no máximo seis contas por vez e uma rajada de limites divide a mesma leitura feita depois do hit.
- **Conta AGY por pane no Windows (F-677).** O AGY 1.2 do Windows autentica pela vaga única `gemini:antigravity` do Gerenciador de Credenciais e ignorava a pasta da conta — todo pane usava a mesma conta e "Salvar conta" falhava. O Nexus captura a sessão da vaga e, antes do spawn, guarda o que está nela no cofre, grava a conta escolhida, confere a identidade e dá uma folga entre contas diferentes.
- **MiniMax Code com o MCP do Nexus (F-678).** Uma ponte stdio registrada uma vez em `~/.minimax/mcp.json` recebe URL e token da sessão só por ambiente. O MiniMax passa a entregar handoff e entra nas rotas da missão da aba. Fora do Nexus a ponte não expõe ferramenta nenhuma.
- **Roteamento pelos benchmarks oficiais (F-675).** Sem avaliação do Nexus, a qualidade de cada modelo vem dos números publicados pelo fabricante (DeepSWE v1.1, Terminal-Bench 2.1, SWE-bench Verified), com a fonte; o recibo da rota diz `quality=benchmark-oficial`.

## 0.76.124 — Todas as LLMs

Uso real no Windows em 28/09. Inclui a 0.76.123 (Helpers variados de novo).

- **Panes sem texto sobreposto no Windows (F-673).** O xterm.js era criado sem saber que o PTY é o ConPTY do Windows: quando um pane ganhava linhas (a grade redimensiona ao abrir/fechar panes), ele puxava o histórico para a tela enquanto o ConPTY criava linhas vazias e repintava por cima — as TUIs (Claude Code) apareciam com trechos antigos misturados, texto sobreposto e colunas desalinhadas. Agora o terminal nasce com `windowsPty` (backend ConPTY + build do Windows), ligando as regras de ConPTY do próprio xterm.
- **Helpers distribuídos entre as LLMs (F-674).** Sem o operador pedir, o orquestrador abria todos os helpers em Claude. Na missão da aba, quando ele fixa uma CLI que já tem dois ou mais helpers vivos, o Nexus redistribui pelo roteamento da missão (Jev + tabela com penalidade de diversidade) e diz no recibo o que redistribuiu. Quando o operador pediu uma CLI específica, o orquestrador marca `operatorChoice: true` e ela é respeitada. A instrução da ferramenta passa a dizer que o padrão é deixar o Nexus escolher.

## 0.76.123 — Helpers variados de novo

Uso real no Windows em 28/09. Inclui a 0.76.122 (Sonnet 5.5 e Jev com medição).

- **Aviso de diversidade no spawn (F-672).** Depois de ver um helper Codex falhar (problema já corrigido na 0.76.119), o orquestrador passou a fixar `adapterId: "claude"` em todo helper, e o roteamento pelo Jev nunca mais foi consultado. A escolha explícita continua valendo, mas quando a CLI pedida já tem dois ou mais helpers vivos na missão o recibo do `nexus_pane_spawn` traz um aviso para omitir `adapterId`/`model` e deixar o Nexus distribuir o trabalho entre as CLIs prontas.
- **Brief inteiro no Windows, sem exceção (F-670/F-671).** A decisão de mandar o brief no argv agora é tomada com o executável e o argv finais: se a CLI ainda cairia num atalho `.cmd`/`.bat` não verificado, ou se a linha de comando inteira (executável, flags, config de hooks e brief, com aspas) passaria do limite do Windows, o brief sai do argv e é colado no pane depois do boot, com a mesma prova de turno das colagens do orquestrador.

## 0.76.122 — Sonnet 5.5 e Jev com medição

Inclui todas as correções da 0.76.121.

- **Sonnet 5.5 oficial.** Modelo disponível no catálogo Claude e no roteamento do Nexus/Jev, com contexto de 1M, saída de 128K e preço próprio. Uso, cotas e Redline preservam a identidade do modelo e as janelas informadas pelo provedor. Sonnet 5 continua disponível.
- **Uma consulta para rotear.** Classificação da tarefa e sugestão de skill compartilham um lote Jev, preservando permissões, esforço e fallback.
- **Leituras focadas do navegador.** O parâmetro `focus` seleciona trechos da página na mesma consulta de julgamento. Texto completo permanece quando a resposta é insuficiente; leituras idênticas reutilizam o julgamento por até 15 segundos. O formato compacto preserva os trechos selecionados.
- **Medição visível.** O painel Jev mostra consultas evitadas, triagens resolvidas sem LLM e bytes antes/depois da seleção. Essas medidas não são apresentadas como tokens faturados economizados.

## 0.76.121 — Brief inteiro

Correção do uso real no Windows em 28/09. Inclui a 0.76.120 (Instalação e tarefas recuperadas).

- **Helper recebe a tarefa inteira no Windows (F-668).** Com uma CLI instalada pelo npm (ex.: `claude.cmd`), o brief do helper passava pelo atalho `.cmd` e o `cmd.exe` cortava o argumento na primeira quebra de linha: o helper recebia só "## Nexus execution authority" ou morria em segundos. O `cmd.exe` também expandia `%VARIÁVEL%` dentro do texto e limitava a linha a 8 mil caracteres. Agora o Nexus abre o executável verificado do pacote (o `.exe`, ou `node` + script) direto para toda CLI embutida, inclusive quando a CLI mora num prefixo npm separado como `~/.local/bin`.
- **Brief longo não derruba o helper (F-669).** O Nexus aceitava até 64 KB de brief na linha de comando, mas o Windows aceita 32.767 caracteres na linha inteira: helpers com briefs longos morriam com "Linha de comando muito longa" e o religamento repetia o erro. Acima de 20 mil caracteres o brief agora é colado no pane depois do boot.

## 0.76.120 — Instalação e tarefas recuperadas

Consolida as correções da candidata 0.76.117 e as de retomada da 0.76.118, com revisão sênior e os problemas encontrados durante a validação.

- **Claude no macOS (F-210).** O Nexus encontra binários nativos válidos quando o atalho está ausente ou quebrado, preserva a instalação selecionada no PATH e prefere o instalador nativo. A instalação só anuncia sucesso depois de verificar o executável; arquivos e credenciais pessoais não são removidos.
- **Kimi recebe a tarefa (F-186).** A colagem aguarda o composer, evitando perder o briefing no menu de migração. A migração continua sendo deixada para depois.
- **Retomada e limpeza (F-663/F-664).** Falhas na inspeção de links abortam a limpeza recursiva. Falhas transitórias no vínculo do pane são reconciliadas, mantendo o acompanhamento e a conversa correta na retomada seguinte.
- **Memória útil preservada (F-180).** Resumos destilados ficam antes de listas extensas de evidências, para sobreviver ao limite de contexto.

## 0.76.119 — Codex na worktree

Correção do uso real no Windows em 28/09. Inclui a 0.76.118 (Retoma e continua).

- **Helper Codex em worktree trabalha no Windows (F-666).** Quando o orquestrador soltava um helper Codex numa worktree isolada, o Codex 0.157 abria a tela "Folder access" (a pasta é marcada como restrita de propósito) e ninguém respondia: o brief caía na tela e o helper morria em segundos. Passando dela, cada comando falhava com "code-mode host is disabled", porque o perfil do Nexus desligava o executor que o Codex usa para rodar ferramentas. O Nexus agora responde "Open restricted" (nunca "Trust and continue") e liga o executor no Windows; as permissões de arquivo e rede do perfil continuam valendo.

## 0.76.118 — Retoma e continua

Correção do uso real no Windows em 28/09. Inclui a 0.76.117 (Missão no seu ritmo).

- **Retomar continua o trabalho (F-665).** Um "Pedir um ajuste" feito horas antes deixava a missão da aba marcada, e toda retomada abria com "AGUARDE O OPERADOR": o orquestrador voltava com a conversa inteira, mas parava sem dizer onde estava. Agora só um ajuste pedido nos últimos minutos faz esperar; nos outros casos a conversa retomada abre com um resumo curto do que estava sendo feito e do próximo passo, e continua.

## 0.76.117 — Missão no seu ritmo

Inclui no macOS as correções de preservação de conversas e retomada da 0.76.116.

- **Missão da aba permanece aberta (F-185).** Pausas do orquestrador e entregas de helpers deixam de concluir a missão antes do pedido inteiro, inclusive uma release solicitada. O orquestrador pede a conclusão explicitamente; a revisão existente continua valendo.
- **Abertura dos panes (F-209).** A manutenção automática das CLIs espera 60 segundos de inatividade e libera o launcher validado antes de procurar atualizações das outras CLIs. Uma atualização já em curso ainda precisa terminar.
- **Memória ligada à tarefa (F-176–F-181).** O contexto acompanha o pane promovido, a busca prioriza a tarefa e seus símbolos, recibos vazios não ocupam o resumo e o scanner compara código existente mesmo em projetos com muitos documentos.
- **Ajustes e regressões (F-175, F-182–F-184, F-366).** Retomar preserva missões paralelas e recupera a orientação de delegação. O modelo de negócio atestado acompanha a checagem de regressões nas worktrees, a captura de teste usa pasta temporária privada e a missão sem terminal oferece retomada.

## 0.76.116 — Conversa preservada

Correção urgente do Windows em 28/09. Inclui a 0.76.115.

- **Conversas não somem mais no Windows (F-663).** O runtime do Electron 43 (Node 24) atravessa junctions ao apagar uma pasta recursivamente. A pasta temporária de cada pane liga as conversas guardadas do projeto por junction, então fechar, reiniciar ou retomar um pane apagava todas as conversas daquele projeto — e o "Retomar" abria um agente vazio. Toda remoção recursiva do Nexus agora tira os atalhos antes de apagar e nunca segue nenhum.
- **Retomar continua da conversa certa (F-664).** Cada "Retomar" da missão da aba voltava ao mesmo pane antigo (o registro deduplicava o pane novo), com o modelo padrão da CLI. A missão agora acompanha o pane retomado e usa o modelo do pane que você abriu pelo "+ Pane".

## 0.76.115 — Worker que responde

Correções do uso real no Windows em 28/09. Inclui a 0.76.114 (CLIs no canal certo).

- **Missão da aba sem worker mudo (F-662).** Depois do "Retomar", o orquestrador da aba pedia rota com `nexus_route_task` e recebia o AGY, que no modo one-shot (`--print`) não mostra nada até terminar. A regra de só abrir helper em CLI com o MCP do Nexus agora vale para a missão da aba inteira, qualquer que seja o pane que pede a rota.
- **Pergunta a pane one-shot responde na hora (F-662).** `nexus_pane_ask` esperava o prazo inteiro e voltava vazio num pane AGY que estava trabalhando — o orquestrador concluía "infraestrutura quebrada". Agora responde na hora que o pane é one-shot e que a entrega chega quando ele terminar; `nexus_pane_write` avisa o mesmo no recibo.
- **Codex no Windows (fora do Nexus).** O Codex 0.157 instalado pelo npm do Node do WinGet não consegue abrir o próprio executor (caminho acima de 260 caracteres) e toda ferramenta dele falha, dentro ou fora do Nexus. Instale-o num prefixo curto: `npm i -g --prefix %USERPROFILE%\.local\bin @openai/codex`.

## 0.76.114 — CLIs no canal certo

O botão Atualizar CLI volta a funcionar para o Codex instalado via npm com atalho externo e para o launcher nativo atual do Grok. A atualização automática usa o mesmo reconhecimento. No macOS, esta versão também inclui as correções de missão e pane publicadas no Windows em 0.76.113.

- **Codex (F-364).** Um atalho como `~/.local/bin/codex` é aceito somente quando resolve para o binário do prefixo npm que será atualizado. A confirmação continua mostrando o comando exato.
- **Grok (F-365).** O launcher `~/.grok/bin/grok` agora reconhece o binário versionado em `~/.grok/downloads` e executa `grok update`.

## 0.76.113 — Pane destravado

Correções do uso real no Windows em 28/09. Inclui a 0.76.112 (Smoke test).

- **Pane não trava mais no Windows (F-659).** O `node-pty` do Windows recusa qualquer sinal no `kill`, então nenhum encerramento de pane se provava: o pane recusava digitação, "Retomar" e "Pedir ajuste" terminavam em "O agente não ficou pronto a tempo" e processos ficavam órfãos. No Windows a raiz do PTY agora é encerrada sem sinal.
- **Missão espera a sua resposta (F-660).** Com o orquestrador parado numa pergunta a você, o pane fica ocioso e a missão era dada como concluída no meio da conversa. Pergunta pendente (rodada aberta com o CLI esperando input) conta como orquestrador ocupado.
- **Retomar a missão da aba traz a sua conversa (F-661).** Depois de reiniciar o Nexus, "Retomar" subia o Maestro padrão como um Claude novo e vazio. A missão nascida do "+ Pane" agora retoma a conversa do pane que a liderava, com a mesma CLI, modelo e conta.

## 0.76.112 — Smoke test

Pendências do 0.76.110 (e do 0.76.111) e tudo que o smoke test no app instalado (28/09) encontrou, revisado em cruz por GPT-6 Astra e Claude Fable 5.1 antes de sair.

- **Rodapé da barra lateral no lugar.** Em Configurações, "Configurações · chaves · voz · Local" ficava no meio da barra com um vazio embaixo: a lista e as utilidades somem nesse modo e a colocação automática do grid puxava o rodapé para a faixa elástica. Agora cada faixa tem posição fixa; provado no Chrome headless (botão a 9 px do fundo, antes 328 px).
- **Revisão de código vai para modelo de topo.** "Revisão sênior, somente leitura" era classificada como trivial (sem alteração de código) e ia para o grok em esforço baixo. Revisão de código tem piso hard também sobre o tier do Jev, e o modelo e o esforço citados no texto ("com o GPT-6 Astra, esforço xhigh") são honrados quando a CLI está instalada — com guarda de negação ("não use o Astra") e de ambiguidade.
- **Navegador do Jev emula de verdade.** A emulação de dispositivo morria na navegação e o `nexus_browser_responsive` media a mesma largura nos três dispositivos. A emulação é reaplicada no commit de cada navegação e a auditoria espera o relayout.
- **Kimi abre com sessão e com o briefing.** A preferência antiga `kimi-k2.7` ia no `--model` e o Kimi Code recusava a sessão inteira; os ids da era kimi-cli migram para os aliases `kimi-code/*`, as listas e o catálogo perdem os ids mortos, o `config.toml` do Kimi Code vira fonte de descoberta e um alias fora dele não viaja no `--model`. O briefing do helper pendente deixa de morrer na autoridade da chamada MCP já respondida.

## 0.76.111 — Helpers variados

Os helpers que o seu pane do "+ Pane" abre voltam a se espalhar por CLIs diferentes, e só em CLIs que falam com o Nexus. Inclui tudo da 0.76.110 (Nexus consciente).

- **Sem três panes pretos no mesmo agente (F-658).** Na 0.76.110 o primeiro helper cria a missão da aba e os seguintes passavam por uma rota que não excluía CLI sem o MCP do Nexus nem enxergava os helpers já abertos: três revisores caíram no AGY, que no modo one-shot (`--print`) não mostra nada até terminar. Agora a missão conta os helpers vivos para diversificar, e o pane do "+ Pane" só abre helper em CLI com MCP do Nexus.

## 0.76.110 — Nexus consciente

Tudo que o operador pediu em 27/09, revisado em cruz por GPT-6 Astra e Claude Fable 5.1 (por frente e no conjunto) e corrigido antes de sair. Inclui a 0.76.109.

- **Portão de regressão (ligado).** Antes de aceitar qualquer entrega de escrita — handoff de missão, "+ Pane", encerramento mecânico e fim de turno do pane do operador — o Nexus roda só os testes impactados pelo diff (inclusive os alcançados pelo banco: arquivo → tabela → teste de outra feature), no mesmo sandbox do writer, sem credenciais. Falhou → volta ao agente. Nunca aprova o que não rodou: diff grande não é cortado, pytest é lido por arquivo (JUnit), falha do git nunca vira árvore limpa e uma execução cancelada gera uma única substituta.
- **Modelo de negócio no `.context`.** Fluxos, invariantes, tabelas e testes extraídos de forma determinística (migrations, funções, AGENTS.md, specs), atestados pelo Main (fora do checkout) e injetados em todo pane de toda CLI como dado citado — também nos panes que rodam em worktree antes de o doc ser commitado. Invariante tocado entra no portão.
- **Code map ligado ao banco.** Tabelas, funções, triggers e RLS de migrations/Prisma/Drizzle, arestas código↔tabela, blast radius com testes, alias do tsconfig — com lexers lineares.
- **Memória automática pelo Jev.** O Jev decide o que guardar (resumos aceitos, fim de sessão com evidência do Main, preferências digitadas pelo operador) e todo pane recebe a memória do projeto — inclusive Kimi e Grok. Sem teto diário. Texto de agente só vira memória confiável sem diretivas.
- **"+ Pane" com poder de missão.** Writers em paralelo em worktrees isolados, escolha explícita de CLI/modelo respeitada, missão livre sem squad, missão sob demanda no 1º helper (do grupo do pane, sem roubar a coroa de ninguém), um orquestrador por aba que sobrevive ao reinício, retomada na worktree original. Trocar de coroa devolve o anterior à mão do operador com tudo que tinha.
- **Navegador do Jev.** `nexus_browser_responsive` (celular/tablet/desktop num chamado, com overflow e prazo por carga), emulação de dispositivo por MCP, viewport decente para agentes, extração pt-BR, redação de OTP/sessão corrigida. Uma navegação sua durante a análise nunca é sobrescrita.
- **Modelos estudados.** Roteamento com ids vivos (Grok 4.7, Gemini 3.8 Flash no lugar do 3.1 Pro, que sai do catálogo do agy), política de modelos de topo (Astra/Fable 5.1 em revisão e alto risco) e trava contra tabela velha. Estudo datado em `docs/models/estudo-2026-09.md`. Polimento do ditado no grok-4.7-build-fast.
- **Failover no limite de sessão da CLI Claude.** "You've hit your session limit · resets 8:10pm" — também quando vem de um `claude -p` filho, emoldurado pela ferramenta de shell — agora troca de conta em vez de deixar o pane preso; o reset é lido no horário e fuso impressos. Sem leitura de cota fresca a quarentena é curta (15 min), não uma supressão da troca.
- **Tokens e custo honestos.** O Nexus volta a ler o uso real dos panes Claude (pasta certa); tok/s mede o modelo, não o despejo da tela.
- **Correções de pane.** Helper concluído não reabre como shell vazio; Enter chega no Codex; Kimi recebe o brief também no "+ Pane"; `nexus_mission_create` atômico; painel lateral sem corte nem rolagem; ações da aba pelo teclado (F-363); GC de worktrees assíncrono; reaper respeita diálogo aberto.

## 0.76.109 — Sessões estáveis

- **Failover sem repetir o próprio erro (F-511).** O motivo do handoff é sanitizado como o histórico. A linha antiga do Nexus também é reconhecida sem cabeçalho, evitando que um erro citado seja tratado como falha da nova conta. Erros novos continuam detectáveis.
- **Orquestração para qualquer LLM (F-171–F-174).** Candidatos das 16 CLIs, desempate entre opções comparáveis pelo uso e descarte de rotas com falhas. Leitura somente não rebaixa a dificuldade de uma investigação. Auth, rosters selados e Hardened preservam suas regras.
- **Helpers previsíveis.** Delegação respeita o aviso padrão de limite de panes (F-574); workers não roubam foco e helpers concluídos fecham depois da saída da sessão.
- **Ditado técnico (F-657).** Vocabulário canônico para Jev, Nexus e nomes de CLIs; comandos, caminhos e identificadores preservados na reescrita. A acurácia acústica depende do áudio e do provider.
- **MiniMax conectado.** Consulta da cota pelo access token vigente do login nativo, sem refresh pelo Nexus. Falta de cota não aparece como falta de conta.
- **Barra lateral alinhada.** Configurações, chaves e voz compartilham os controles e tokens existentes.
- **Carimbo Windows configurável (F-656).** Inclui a correção já integrada em main para o servidor de timestamp da assinatura Windows. Esta publicação é do canal macOS.

## 0.76.108 — MiniMax Code

O MiniMax Code (a CLI oficial `mcode`) entra no Nexus como provedor nativo. Inclui a 0.76.107 (Abas no Windows).

- **MiniMax Code nos Providers, no "+ Pane" e no Jev (F-655).** O Nexus detecta a CLI `mcode`, instala e atualiza com os scripts nativos que ela exige, mostra o login (`mcode login`) e abre panes com os modelos oficiais (M3, M3.1 Flash Preview, M2.7 Highspeed e M2.7). O Jev pode escolhê-la, o benchmark roda o modo headless e o Redline mostra a cota do Token Plan quando há Subscription Key. A rota antiga "MiniMax via Claude" passa a usar o endpoint e o modelo atuais. Limites: sem MCP do Nexus no pane (só via ACP), uma conta por máquina e modelos ainda não avaliados no ranking.

## 0.76.107 — Abas no Windows

As abas com pasta própria (F-162) também funcionam no Windows. Inclui tudo da 0.76.103 à 0.76.106 (Diff sem confusão, Missão até o fim, Perfil e logins, Navegador em segundo plano). A importação de sessões do Chrome segue só no macOS; no Windows, entre nos sites pelo Perfil Nexus.

- **Worktree que o Git aceita no Windows (F-654).** O Git para Windows recusa criar uma worktree com mais de ~215 caracteres ("'$GIT_DIR' too big"), e o caminho montado pelo Nexus passava de 400. Toda aba nova do "+" falhava ao abrir a pasta, e escritor isolado e missão planejada nunca tinham funcionado no Windows. Agora elas moram numa raiz curta dentro dos dados do app (~110 caracteres). No macOS e no Linux o caminho não muda.

## 0.76.106 — Navegador em segundo plano

O navegador do agente continua vivo quando você troca de projeto, e o agente segue usando-o enquanto você trabalha noutro lugar.

- **Navegador sobrevive à troca de projeto (F-168).** Antes, ir a outro projeto destruía o navegador: o agente recebia "unknown pane" e, na volta, a página tinha recomeçado. Agora o navegador fica afastado, como os terminais: a página e o login continuam, o agente do projeto segue navegando, lendo e clicando, e na volta você encontra a página onde ela estiver, sem recarregar.
- **Screenshot com o navegador fora da tela.** A primeira captura de uma página carregada com a vista escondida falhava; o Nexus agora tenta de novo uma vez e a imagem sai com a página atual (medido no Electron). Vale também para navegador escondido por um painel aberto por cima.
- **Encerramento previsível.** Fechar o projeto encerra os navegadores dele; tirar o projeto da lista encerra os que ficaram afastados; fechar pelo agente um navegador afastado o tira do layout quando o projeto volta. A revisão automática de design continua encerrando na troca.
- **Mensagens que apontam o caminho.** Com a janela noutro projeto, `nexus_browser_open` explica que dá para seguir no navegador que o projeto já tem; "unknown pane" de navegador agora significa pane fechado.

## 0.76.105 — Perfil e logins

O navegador interno ganha um perfil próprio com importação seletiva de sessões compatíveis do Chrome. Reúne também as correções de panes e missões da 0.76.104.

- **Perfil e logins.** Botão na barra do navegador para escolher Perfil Nexus ou Isolado, selecionar o perfil do Chrome e os sites. Importação compatível no macOS, sem modificar o Chrome; resultados parciais são explícitos. Senhas, extensões e Google Sync não são importados.
- **Compartilhar com agentes é uma escolha.** A opção vale para novos navegadores dos agentes. Panes existentes preservam seu modo; sessões ficam no cofre cifrado e cada pane mantém sua própria política de rede.
- **Busca na barra (F-362).** Palavras como `coolify` viram pesquisa; URLs, domínios e localhost continuam navegando com a validação de segurança do Main.
- **Helpers na janela correta (F-164/F-165).** A abertura segue o pane pai e o projeto autorizado, mesmo com outra janela em foco.
- **Alertas falsos removidos (F-169).** `internal_error` mencionado no pedido e rótulos como `Failure|rate-limit` não são mais tratados como falhas do provider.
- **Retentativa com horário real (F-170).** Avisos acompanham cada agendamento e deixam de prometer horários vencidos.
- **Verificação.** Suíte completa: 1.533 arquivos, 16.309 testes aprovados e 10 skips. Fluxo do navegador verificado no Electron com banco Chrome e sessões sintéticos.

## 0.76.104 — Missão até o fim

A missão só conclui quando o worker termina, e o pane de uma missão pronta volta a aceitar o seu ajuste. Inclui tudo da 0.76.102 (Mão livre) e da 0.76.103 (Diff sem confusão), que não chegaram a ser publicadas.

- **Missão não conclui no meio do trabalho (F-166).** A Via Rápida marcava a story como feita nos primeiros arquivos gravados e fechava a missão com o worker ainda trabalhando. Agora o Pronto espera todo worker ativo parar.
- **Pane de missão pronta aceita intervenção (F-167).** Se a missão concluía com você noutro projeto, o pane voltava preso a uma sessão encerrada e cada tecla virava "o main recusou a digitação". O encerramento agora chega ao pane, e digitar no Maestro de uma missão concluída faz o mesmo que "Pedir um ajuste".
- **Navegador do agente volta com o projeto (F-168).** Depois de trocar de projeto e voltar, o agente perdia o acesso ao navegador que ele mesmo abriu. O navegador aberto por você pelo "+ Browser" também passa a servir aos seus agentes do mesmo projeto; workers de missão continuam sem acesso.
- **Nenhum vigia de terminal preso (F-208).** Com uma janela do Ghostty ou do Terminal aberta, o processo que vigia cada pane podia ficar vivo para sempre gastando CPU depois que a CLI saía.
- **Barra lateral compacta (F-533).** Início, Projeto, Quadro e Memória em duas colunas, Terminais na linha inteira e "Abrir projeto" ao lado de "Novo pedido". Sobra mais altura para projetos e missões, e a borda direita não é mais cortada em barras estreitas.
- **Abas com pasta própria (F-162).** Cada aba nova ganha uma worktree com pasta e branch próprias; panes da mesma aba compartilham essa pasta. Abas antigas continuam na pasta do projeto.
- **Esforço pela tarefa (F-163), helpers na janela certa (F-164) e leitura da interface do projeto certo (F-165).**

## 0.76.103 — Diff sem confusão

O Claude deixa de atribuir ao próprio comando alterações feitas por outro pane na mesma pasta. Inclui tudo da 0.76.102 (Mão livre), agora também na distribuição macOS.

- **Diff com autoria correta (F-161).** A comparação automática de arquivos ao redor de comandos Bash captava edições concorrentes de outros agentes, até durante uma consulta de CI. A configuração privada do pane desativa essa atribuição. Hooks e diffs de edições explícitas continuam funcionando; o perfil global não é alterado.
- **Limite do isolamento.** As abas organizam os panes; arquivos e branch continuam compartilhados quando os agentes usam a mesma pasta. Para trabalhos independentes, use worktrees distintas. A correção vale para panes iniciados ou retomados com esta versão e não apaga o histórico já mostrado.

## 0.76.102 — Mão livre

O pane que você abre pelo "+ Pane" nunca mais fica preso a uma missão. Se o agente dele criar uma missão, ela nasce pronta para abrir workers, e quando termina, falha ou para, o pane volta a ser seu. Inclui tudo da 0.76.101 (Motor leve).

- **Missão criada pelo pane abre workers.** Ela nascia sem contrato e presa a um squad que ninguém pediu: cada worker era recusado (contrato ausente, CLI fora do roster, reserva de rota) e o agente pedia um "despacho em modo livre" que o Quadro não oferece. Agora nasce rodando, em Escolha livre de agentes e sem squad imposto.
- **Missão encerrada devolve o pane.** Depois de uma missão falhar ou concluir, o pane que a criou seguia preso a ela: não abria panes nem criava outra missão. Agora volta a ser a sua mão na chamada seguinte.
- **Missão parada tem saída.** Missão bloqueada pelo próprio agente pode ser retomada por ele, e toda recusa diz ao agente a chamada exata para retomar ou encerrar, em vez de pedir a você um clique que não existe.

## 0.76.101 — Motor leve

O Nexus abre mais rápido, gasta menos RAM e CPU parado e não trava mais ao fechar um pane depois de reiniciar. Os panes "+" e os helpers ganham o motor que só as missões tinham.

- **Boot e panes mais leves.** O processo principal carrega 83% menos JavaScript no boot: as skills embutidas saem do bundle para o disco, e voz, ONNX, AEC e o TypeScript da revisão carregam só quando usados. Abrir um pane prepara as skills em 6 ms quando o overlay já existe (antes, 39 ms).
- **Reiniciar não trava mais.** Depois de um restart, retomar um Claude relia o histórico de uso inteiro de forma síncrona e travava o app: fechar um pane ficava girando. Agora a leitura é incremental e retoma de onde parou, e a atribuição de uso por conta deixou de ser apagada a cada reinício.
- **Menos CPU parado.** O pet não acorda à toa quando está parado, a detecção de limite do failover deixou de rodar a cada pedaço de saída do terminal, os polls do renderer dormem com a janela oculta e o feixe do pane ocupado só anima enquanto ele trabalha (e respeita "reduzir movimento"). O `nexus.db` roda em WAL.
- **Panes "+" com o motor das missões.** Pedido de interface recebe a regra de design do projeto (o DESIGN.md ou, sem ele, a referência certa do seu catálogo `~/.design-references`, com o import do contrato em uma chamada) e a Carta de Design contra a "cara de IA". Pedido de código lembra a skill ponytail. O Codex passou a receber esse contexto também, e a doutrina do operador não é mais colada em cada tool dele (cerca de 37 mil tokens por pane).
- **Helpers que entregam.** O helper acha o pane pai mesmo com a janela noutro workspace, nasce com a memória do projeto, só leva os servidores MCP que pediu e fecha sozinho só se ainda for a mesma sessão. O Jev não escolhe mais para helper uma CLI sem MCP do Nexus, e a entrega de um helper não é tratada como pedido novo. Pesquisa somente leitura não carrega mais as cartas de código.
- **Ponytail em YAML válido.** A skill voltou a carregar em CLIs com YAML estrito, como Kimi e OpenCode.

## 0.76.100 — Pasta reconhecida

No Windows, abrir um projeto com `.nexus/project.json` voltou a funcionar.

- **Workspace com manifesto abre no Windows (F-647).** O aviso "o manifesto .nexus/project.json não bate com este repositório" aparecia em todo projeto com manifesto, mesmo com o manifesto certo. A causa era o git: o Nexus o rodava com `GIT_CONFIG_GLOBAL=\\.\nul`, que o Git para Windows 2.55 recusa. Agora usa `/dev/null`, que o Git mapeia no Windows, e a prova de linhagem continua isolada da sua config global.
- **Mesma pasta, outra grafia (F-648).** `c:\users\…` ou `C:\Users\ADMINI~1\…` é reconhecido como a mesma pasta e abre o mesmo checkout, em vez de cair em quarentena ou virar "token de checkout duplicado".

## 0.76.99 — Jev no comando

Os panes que os seus agentes abrem passam a ser escolhidos pelo Jev, e todo pane seu aprende a dividir o trabalho em vez de fazer tudo sozinho.

- **O Jev escolhe a CLI dos panes que os seus agentes abrem.** Quando o Claude (ou qualquer agente seu) abre um pane, quem decide CLI, modelo e esforço é o Jev com a tabela de rotas — o `adapterId` que o agente pediu é ignorado e aparece em `route.ignored` no recibo. Retomar um pane (`resume`) mantém a CLI dele. No empate, vence a CLI que ainda não está aberta por aquele agente; um vencedor claro nunca é trocado.
- **Jev fora é visível.** Sem chave, desligado, tempo esgotado ou erro: o pane abre pela heurística e o motivo aparece no recibo, no `nexus_route_log`, num chip "sem Jev" no cabeçalho e num aviso único por motivo. Quando o Jev decide, o cabeçalho mostra "Jev".
- **Delegação automática.** Todo pane seu nasce com a regra "delegue o que dá para dividir; leitura em paralelo; quem escreve, um por vez; faça sozinho o que é pequeno", e a cada mensagem longa o Jev avisa quando ela se divide em partes. Liga e desliga em Configurações › Equipes › Piloto automático Jev › "Delegação automática".
- **Helpers organizados.** O helper nasce na aba do pane que pediu; helpers que escrevem entram em fila no mesmo checkout; o helper fecha sozinho quando entrega com sucesso (falha fica aberta); e o teto de panes recusa spawns pedidos por agentes para não abrir panes em cascata — o seu "+" continua só avisando.

## 0.76.98 — Linhagem única

A conta Claude que é o seu login nativo não ganha mais uma segunda cópia do refresh token.

- **Um dono só para o login nativo (F-645).** Toda conta Claude escolhida no "+ Pane" ganhava um escopo gerenciado semeado do vault. Para a conta que é o próprio login nativo, isso deixava o mesmo refresh token em dois lugares, e quem renovava primeiro matava o outro: o pane dizia "A sessão expirou" (caso da 0.76.97) ou, quando o pane ou a sonda de cota renovavam antes, caía o Claude que você usa fora do Nexus. Agora essa conta abre pelo login nativo, como um pane sem conta, e a cota lê o perfil nativo. Contas que não são o login nativo continuam isoladas no escopo delas.
- **Windows: renovação no arquivo real (F-646).** A CLI regrava a credencial por temporário + rename, então o link do overlay virava uma cópia na primeira renovação do pane e o `~/.claude/.credentials.json` real ficava com o token consumido. Agora o pane com login nativo grava direto no `~/.claude` real; as conversas continuam isoladas no overlay.

## 0.76.97 — Sessão renovada

Pane Claude não é mais recusado por token vencido, a cota das contas Claude volta a ler no Windows e o que a 0.76.96 prometia passa a ser verdade.

- **Token vencido não é sessão perdida (F-639).** Pane de conta Claude gerenciada parada há mais de 8 h dizia "A sessão expirou — entre novamente" mesmo com refresh token válido. Agora o Nexus deixa a própria CLI renovar no escopo da conta (ela é a dona da renovação), prova a identidade no token novo e só então decide. "Entre novamente" aparece só quando nem a CLI conseguiu.
- **Cota Claude no Windows (F-640).** A sonda procurava a CLI em caminhos de Mac/Linux e nunca rodava no Windows — sem cota das contas e sem a renovação de fundo. Agora acha o `claude` pelo PATH e troca o shim do npm pelo `claude.exe`.
- **Skills de papel embarcadas de verdade (F-641).** `oc-pilot`, `oc-builder`, `oc-scout` e `oc-conveyor` não entravam no pacote, e `nexus_skills install` recusava toda skill embarcada. Agora saem do bundle como as demais, são espelhadas por CLI e o install copia do cache do app.
- **Warm pool honesto (F-642).** O pool só adota um pane pré-aberto quando o pedido é o mesmo contrato com que ele nasceu (pane do operador, sem restrição, mesmo projeto). Antes trocava só o rótulo: um worker `readOnly` podia herdar um processo gravável de outro projeto. Continua desligado por padrão.
- **Arms do `npm start` (F-644).** Pane da instância de desenvolvimento fala com ela, não com o app instalado.
- **Testes de scripts no Windows (F-643).** `.mjs`/`.cjs` sempre em LF: o teste do conector Arms e mais três suítes voltam a rodar no Windows.

## 0.76.96 — Harness declarado

Paridade Overclock 1.4: decisão de harness visível e persistida, folga de conta honesta, identidade de pane no MCP e resiliência de listagem.

Novo desde a 0.76.95:

- **Harness por tarefa (`nexus_harness`).** Tabela categorias × tipos com CLI, modelo, conta, effort e skills. `apply` all-or-nothing (worker só `propose` com reason; a assertiva do agente nunca é aprovação). O recibo do spawn declara `▸ harness` / `▸ decisor` / `▸ origens`. Tabela persistida em `orch.taskHarnessTable` — sobrevive a restart.
- **Skill gate por declaração (OVKA-713/747).** Ausência de filtro libera; filtro declarado é whitelist dura e, no overlay Claude, esconde skills pessoais/projeto fora do conjunto (`skillOverrides: off`).
- **Folga de conta (`nexus_account_windows`).** Janelas por conta com status `ok` / `queimada` / `sem leitura` e a idade da leitura. Missing ≠ zero.
- **Identidade de pane no Arms (OVKA-529/543).** O wrapper carrega `callerPaneId` só em casa; `--descriptor` alheio apaga a identidade. Worker não herda orçamento de "bootstrap do humano".
- **Warm pool com retarget.** Pane em boot é re-destinado à missão; sem `startKey` real nada entra no pool.
- **tools/list perdida não silencia (OVKA-754).** Listagens idempotentes repetem em transporte perdido; `tools/call` nunca repete. Placeholder `nexus_reconectar` + recovery com `list_changed`.
- **Skills de papel** `oc-pilot` / `oc-builder` / `oc-scout` / `oc-conveyor` embarcadas e espelhadas por CLI.
- **`nexus_skills`** install/remove por CLI (só skill embarcada; nome é slug — path traversal recusado). Precisa de allowlist explícita.
- **Briefing por ponteiro (OVKA-750).** Brief longo citando card/task file ganha aviso soft com o ponteiro de uma linha.

## 0.76.95 — Voz medida

- **O ditado mede a sua voz antes de transcrever (F-638).** No Windows o ditado trocava palavras e no Mac acertava. Medido: com o ganho do Windows no máximo, a voz chegava a −45 dBFS e com só 2,8% de agudos (voz limpa tem 7–9%) — um fone ligado na entrada rosa estava fazendo papel de microfone. Sem agudos a voz perde as consoantes e qualquer serviço de transcrição adivinha palavras. Agora cada ditado grava no voice.log quanto de fala houve, em que nível e com quantos agudos (`stt.audioQuality`), e voz abafada gera, uma vez por sessão, o aviso "Microfone chegando abafado" com o caminho: microfone USB ou adaptador que separa microfone e fone, e o botão Abrir Voz.

## 0.76.94 — Abas de feature

- **Terminais em abas.** A barra de cartões (missões, "Painéis soltos", pinos A/B e "Todos") virou uma barra de abas de editor: cada aba é uma feature, com os panes dela e a missão que um deles começou. A aba ativa é o mesmo chão da grelha, com um fio de acento em cima; o estado da missão vai no glifo e na palavra. O "+" abre o picker de sempre e o pane escolhido nasce numa aba nova. Duplo clique (ou F2) renomeia — inclusive a aba "Terminais", que vira um espaço com esse nome. ⌘/Ctrl+Alt+→/← troca de aba.
- **Missão começada pelos panes fica na aba deles.** Quando o agente de um pane seu cria a missão, ou você torna o pane orquestrador, a missão, o orquestrador e os workers que ele abrir ficam na aba desse pane — não numa aba separada ao lado dos panes que a começaram. Missão lançada pelo assistente continua com a aba própria.
- **Ver ao lado.** Clique direito numa aba (ou o botão de dividir) mostra duas abas na tela, cada metade com o nome dela e divisória ajustável. Pane da aba ao lado já está na tela: focar nele não troca de aba. A visão geral (ícone de grade) mostra todos os painéis e não é mais desfeita pelo foco ao abrir.
- **Fechar aba** pede confirmação e encerra só os painéis dela. Aba com missão viva não tem ×: a missão se encerra pelo Quadro.
- **Uma missão nunca mistura workspace (F-634).** Trocar de projeto com qualquer pane abrindo ou fechando carregava todos os panes de missão do projeto que saía para o que entrava — e a gravação seguinte os salvava lá. Agora o que está na tela quando a troca começa é do projeto que sai e não atravessa. Ditado, anexo e Jarvis não digitam mais no terminal escondido de outro projeto; recuperação de missão e "Retomar missão" desistem se o projeto mudou durante a espera.
- **Criar missão pelo pane não trava mais os panes (F-635).** Em Autopilot a missão que o agente do seu pane cria nasce rodando: antes ela ficava pendente e todo pane novo voltava `dispatch_required` até alguém achar "Despachar". Hardened continua pedindo o despacho.
- **O Quadro mostra o que o terminal faz (F-636).** Missão sem plano não desenha mais os oito papéis do squad "Na fila". Se o orquestrador reiniciou em outra CLI (failover Claude → GLM), o card do Maestro aponta o pane vivo e a missão aparece como "O orquestrador reiniciou e a missão não o reconhece", só com Encerrar — tentar de novo abriria um segundo orquestrador (religar a liderança fica para o F-637).
- **Ícones de dividir legíveis.** "À direita" e "Abaixo" na barra do pane eram um quadrado cheio; viraram uma moldura dividida com a metade nova cheia.

## 0.76.93 — Ditado no lugar

O Mac sobe com o lote 0.76.85–0.76.92 (que já estava no canal Windows) e seis correções novas.

Novo desde a 0.76.92:

- **Ditado entrega no pane do campo focado.** Trocar de campo leva o foco. Antes o foco ficava no campo anterior, agora fora da tela, e o texto dito olhando para um campo caía no agente de outro — um pedido de outro projeto foi parar no Claude errado. Ditado, Jarvis e anexos seguem o foco; o fallback do ditado filtra pelo campo do foco, não pelo campo visível.
- **Ditado CODE faz uma tradução só.** A STT transcreve literal (rota mais rápida do Gemini) e a reescrita CODE traduz uma vez, a partir do original. Antes eram duas chamadas em série e a segunda recebia um texto já traduzido: 5,8–8,2 s entre parar de falar e o texto chegar, com pico de 17 s. O voice.log passa a registrar `sttMs` e `polishMs`.
- **CODE nunca entrega português.** Se a reescrita falhar (chave expirada, timeout, saída suspeita), a STT transcreve o MESMO áudio de novo já pedindo tradução — só o caminho de falha paga esse tempo. A transcrição literal ganha priming em português (o priming em inglês fazia o Whisper puxar inglês, cortes e texto inventado). O pós-processamento do CODE virou módulo puro testado (`code-dictation.ts`).
- **tok/s sem número falso.** Terminal parado redesenhando a tela não conta token; contagem real sem submit visto tem janela honesta e, sem ela, vira "—" (antes publicava ~1.667 ou até 35 mil tok/s). Janela e taxa num lugar só (`#rateFor`); teto de sanidade 2.500 → 6.000 (Cerebras/Groq cabem); a UI mostra a `rateWindowMs`.
- **Failover que fica na conta.** Erro 5xx do provider não troca mais de conta em ping-pong A↔B. Depois do backoff o Main confere se a CLI voltou e retoma a missão na MESMA conta; o transient não arma mais o rearm de 30 s. A recuperação de missão parada NÃO respawna mais: o processo vivo no prompt recebe um "continue" na mesma sessão (um falso positivo custa um continue, não um restart). Limite de verdade esperando a conta vence: o 503 não abre episódio. O aviso de erro promete só o que o Main faz: pane do operador ouve "mande continue".
- **Foco pedido num pane de outro campo não é desviado.** O efeito "campo leva o foco" só age quando o CAMPO mudou e o FOCO não; se o foco mudou (login, ⌘K, notificação, voz), quem manda é o efeito que leva o campo até o pane. OAuth e ditado deixam de parar no agente errado.
- **Repaint do prompt e linhas de retry não contam como resposta.**

Do lote 0.76.85–0.76.92 que este pacote do Mac ganha (detalhe nas datas acima):

- **Voz Gemini 3.8 Flash-Lite TTS** como padrão da Jarvis, com escolha de voz e modelo em Ajustes › Voz; modo CODE entrega prompt em inglês pronto para o agente.
- **Missão começada pelos panes fica junta:** painéis soltos entram no campo do coordenador local; barra de campos alinhada, sem linha repetida.
- **Workspace aberto é pasta confiada** para Claude/GLM/LongCat (só no perfil isolado do pane); a continuidade espera o menu de confiança em vez de escolher "No, exit".
- **Main thread mais leve** com saída contínua de terminal (o piso de cópia por pedaço cai para o tamanho do pedaço).
- **Falha de microfone explica o que fazer**, em português; o log do ditado mostra quem transcreveu e o que ouviu antes do CODE.
- **Cota do Claude ligada à conta certa (F-615)**; atualizar CLI mexe na instalação que o pane usa (F-360) e a atualização automática é com consentimento (F-633).
- **Configurações organizadas por tarefa**, linguagem simples e caminhos "Configurações › Contas de IA"; menus, foco visível e alvos de 24 px.
- **Xiaomi MiMo Code** no catálogo de contas, modelos e uso.

## 0.76.92 — Pasta confiada

- **O Claude não para mais no "Quick safety check" no Windows.** O Claude grava as pastas confiadas como `C:/Users/...` e o Nexus procurava `C:\Users\...`: a confiança que você já tinha dado nunca era achada e todo pane perguntava de novo. A busca agora aceita as duas formas.
- **Workspace aberto no Nexus é pasta confiada.** Pane Claude, GLM ou LongCat cuja pasta está dentro do workspace aberto nasce com a confiança da pasta, só no perfil isolado do pane; o seu `.claude.json` real não muda. Pasta fora do workspace segue perguntando.
- **A continuidade automática não fecha mais o pane.** Ela mandava Enter com o menu de confiança na tela, o cursor estava em "No, exit" e o Claude saía com code 1. Com um menu de confirmação na tela, a continuidade espera.

## 0.76.91 — O microfone explica

- **Falha de microfone diz o que fazer, em português.** No Windows um app de desktop não recebe pedido de permissão: sem microfone ativo (USB desconectado, P2 vazio) o ditado só falhava com "Mic unavailable: Requested device not found". Agora aponta Configurações › Sistema › Som › Entrada, o interruptor de privacidade dos apps de desktop ou o outro app que está usando o microfone, conforme o caso.
- **O log do ditado mostra quem transcreveu e o que ouviu.** Cada ditado grava no voice.log o serviço que transcreveu, o texto cru antes da reescrita e, no modo CODE, o texto final. Dá para saber se um erro veio da transcrição ou da tradução.

## 0.76.90 — Atualização que não trava

- **Instalar ou atualizar o Nexus no Windows não fica mais parado.** Durante a instalação o Windows abre o Nexus rapidamente para registrar atalhos. O app seguia o boot, reabria o Nexus Redline, e o instalador esperava ele fechar para sempre (a 0.76.89 parou em "Squirrel Enabled Apps"). Agora o Nexus só responde ao instalador e sai.

## 0.76.89 — Voz Gemini 3.8

- **O Jarvis fala com o Gemini 3.8 Flash-Lite TTS.** Lançado em 22/09, ele vira a voz padrão pela mesma chave Gemini da transcrição; OpenAI, Piper e say seguem de reserva. Quem trocou a cadeia de voz recebe o Gemini só como opção, e cadeia só local não muda.
- **Escolha de voz e modelo.** Em Ajustes › Voz, com o Gemini na frente, "Voz por etapas" lista as vozes do Gemini e "Modelo da voz" alterna entre Flash-Lite (rápida) e Flash (qualidade).
- **A voz de reserva da OpenAI não recebe mais o nome de uma voz do Gemini** nas migrações antigas de configuração.

## 0.76.88 — Tudo no mesmo campo

- **Missão começada pelos panes fica junta.** Quando você usa "Tornar orquestrador" num pane sem missão, os painéis soltos entram no campo desse coordenador. Antes o orquestrador ficava em "Meus terminais" e a equipe em "Painéis soltos". Espaços nomeados e missões criadas pelo campo de missão seguem separados.
- **Barra de campos alinhada.** Todos os cartões com borda sólida, mesma altura e texto à esquerda; "Todos" não corta mais, e a coluna A/B tem a mesma largura em todos. A segunda linha que repetia nome, contagem e orquestrador do cartão ativo só aparece enquanto você renomeia o espaço.
- **Modo CODE entrega prompt em inglês pronto para o agente.** Depois da transcrição, o ditado é reescrito em inglês claro, no imperativo, com passos numerados quando há vários pedidos, sem mexer em nomes, caminhos e comandos e sem acrescentar nada. Funciona também com o Grok Voice, que só transcreve (o chip deixa de mostrar CODE·PT). Se falhar ou demorar, o texto transcrito segue como veio.
- **Terminal parado não conta mais token.** Redesenhar a tela (resize, barra de status, foco, voltar ao workspace) mostrava tok/s e "gerando" num pane ocioso. Agora só texto novo conta.

## 0.76.87 — Mais leve no Windows

- **O Nexus não trava mais com agente escrevendo sem parar.** O processo principal passava a maior parte do tempo copiando a saída dos terminais: cada pedaço de texto recopiava 256 KB do buffer de detecção e percorria toda a janela de replay. Agora cada pedaço custa só o próprio tamanho. Sob a mesma carga, o main foi de 11% para 60% de folga, e cliques e menus respondem na hora.
- **O pane de missão volta a aceitar digitação depois de trocar de workspace.** Ao voltar, o Codex ou o Claude da missão mostrava "o main recusou a digitação neste pane" e a tela congelava. O Nexus agora devolve a sessão ao pane quando você volta ao workspace da missão.
- **Botões das contas no lugar.** Em Conexão e contas, os botões desciam por cima do nome e o "Remover" saía do cartão numa coluna estreita. Agora eles quebram de linha alinhados ao texto.

## 0.76.86 — A CLI cuida do próprio login

- **A cota do Claude não mexe mais no login nativo do Windows.** O Nexus só lê o `.credentials.json` da CLI, sem renovar o token por conta própria. Antes o Nexus e a CLI podiam renovar ao mesmo tempo e um derrubava o login do outro. Se o token estiver vencido, a cota diz isso até a CLI renovar.

## 0.76.85 — Configurações no lugar, também no Windows

- **Configurações organizadas por tarefa.** Sete áreas em vez de nove categorias por módulo, modo foco que devolve a largura ao conteúdo e páginas longas bem mais curtas (Comparar modelos, Uso e cotas, Loja, Equipes).
- **Linguagem simples e caminhos certos.** As mensagens apontam “Configurações › Contas de IA”. A conta não mostra verde falso: aparece “a confirmar” ou “sessão expirada”, com “Entrar de novo” e Cancelar.
- **Menus e acessibilidade.** “Tornar orquestrador” vai para o menu “…” do pane, “+ Pane” não corta nomes, foco visível, alvos de 24 px e botões na fonte do app.
- **Atualizar CLI mexe na instalação que o pane usa (F-360)**, e o Nexus pode manter as CLIs em dia sozinho, se você deixar (F-633). Versão igual ou não verificada não vira “atualizada”.
- **Cota do Claude ligada à conta certa (F-615).** A identidade da credencial é confirmada antes de mostrar a cota ou abrir um pane gerenciado. Token de outra conta pede novo login em vez de copiar a cota da irmã. A leitura da cota não renova o token das contas gerenciadas em paralelo com a CLI.
- **Saída do terminal preservada entre janelas do Nexus (F-361).**
- **Continua desta linha Windows:** CLIs de nvm/pnpm/Volta/scoop, seletor de pasta que responde, cofre que para de verdade e Git/gh em todo pane gravável.

## 0.76.84 — CLI certa, janelas vivas

- **Atualizar CLI atua na instalação usada pelo pane (F-360).** Nexus escolhe o canal pelo executável ativo: Claude nativo usa o próprio updater, Homebrew usa o prefixo dono da CLI, npm usa o prefixo global correto, uv recebe seus diretórios e instaladores oficiais mantêm o perfil. Depois, lê a versão do launcher do próximo pane; versão igual ou não verificada não vira um falso “atualizada”.
- **Atualização automática com consentimento (F-633).** O Nexus oferece manter CLIs instaladas em dia pelos canais locais reconhecidos. As tentativas são serializadas, esperam não haver pane ativo da CLI e verificam a versão do executável usado pelo próximo pane. Canais que exigem script, WinGet, cask, caminho personalizado ou privilégio continuam no botão manual; “Agora não” adia a oferta por sete dias.
- **Dois workspaces em janelas Nexus podem trabalhar ao mesmo tempo (F-361).** No macOS, uma janela coberta por outra continua processando os timers do terminal; saída sustentada deixa de ficar retida só por causa da oclusão e chegar ao aviso de backlog de 2 MiB. Panes de workspace estacionado também mantêm a última grade válida para drenar em segundo plano. A proteção de memória contra rajadas reais permanece.
- **Suite raiz ignora worktrees de runtime (F-631).** `npm test` não coleta cópias de testes em `.nexus/worktrees/`.
- **Cotas Claude ligadas à conta certa (F-615).** Nexus confirma a identidade da credencial no servidor antes de mostrar percentuais ou abrir um pane gerenciado. Se o token salvo pertence a outra conta, a leitura fica indisponível e a interface pede novo login, sem copiar a cota da irmã.
- **Limite conhecido:** num mosaico de 24 ou mais panes, um pane que já estava virtualizado fora da tela ainda conserva apenas um buffer curto de saída até voltar; isso é distinto do caso de duas janelas com um pane visível em cada uma.

## 0.76.83 — Configurações no lugar

- **Configurações organizadas por tarefa.** Nove categorias sob quatro pilares seguiam os módulos do código ("Ferramentas" em três lugares, chaves em quatro). Agora são sete áreas: Conta e acesso a IAs, Jarvis e voz, Aparência e teclado, Equipes e modelos, Biblioteca, Integrações e Segurança e manutenção. Aba, caminho e título da página vêm do mesmo cadastro; abas técnicas ficam depois de "Avançado".
- **Modo foco nas Configurações.** O rail do app esconde Projetos, Recentes, Limpar e Cotas enquanto você configura; o conteúdo ganha a largura que as três colunas de navegação roubavam.
- **Auditoria reúne as Decisões do Jev** como subseção; links antigos caem nela. O atalho duplicado "Meus pets" sai do rodapé.
- **Páginas enxutas.** Comparar modelos (47k → 3k px), Uso e cotas (6,3k → 2,8k px, contas sem cota num grupo recolhido), Loja (5,2k → 1k px, 12 por vez), Permissões (missões antigas ocultas por padrão), Equipes ("Piloto automático" e "Equipes salvas" separados, nomes repetidos agrupados em "N cópias", "Apagar" depois de um separador) e Ações dos agentes (descrição real em uma linha).
- **Linguagem simples.** "fixture", "η" e "suite" viram "estimativa"; "Hub canônico" vira "Configuração principal"; o alerta âmbar de pendências dos Fluxos vira contagem neutra com o motivo; Experimental separa o que dá para experimentar do que já faz parte do app.
- **Celular num lugar só**: "Celular na rede local" sai de Máquinas remotas e vai para a página Celular.
- **Conta sem verde falso**: o selo mostra "a confirmar" ou "sessão expirada" quando é o caso, com "Entrar de novo" (e Cancelar).
- **Menus.** "Tornar orquestrador" sai da fileira de ícones do pane para o menu "…", depois de um separador; menu de clique direito com uma linha por ação e grupos; "+ Pane" não corta nomes nem o motivo de indisponível; menu de branch do Git fecha com Esc e tem itens de 24 px; foco visível na paleta ⌘K.
- **Mensagens com o caminho certo**: "Configurações › Providers/Contas" viram "Configurações › Contas de IA" no app inteiro.
- **Acessibilidade e controles.** Subtítulos das Configurações em h3 (a hierarquia pulava de h2 para h4), botões e campos na fonte do app (saíam em Arial), chip "NÃO CONFIGURADA" acima de AA, alvos pequenos em 24 px, piso de texto de 10 px.

## 0.76.82 — Nada escondido no Windows

- **CLIs instaladas por nvm, pnpm, mise, Volta e scoop não somem.** A busca cobre essas pastas no Windows. Se a sondagem do boot falha, o Nexus tenta de novo sozinho e reexamina as CLIs.
- **Botões e hovers que sumiam.** Ícones pequenos demais e tokens de cor que não existiam deixavam o “+” e os hovers da barra mortos. O HUD de voz em repouso fica só o orb e não cobre o terminal.
- **Abas e alvos de clique.** Hover e foco nas abas, botões do pane em 24 px, e o 401 com conta conectada diz que a sessão expirou.
- **O cofre fecha todas as portas depois da primeira falha.** Leitura e gravação param juntas. Antes cada leitura voltava ao cofre.
- **Git, SSH e gh entram em todo HOME privado de CLI gravável**, não só no Claude. O keychain do macOS continua só no Mac.
- **O brief não é colado no meio da migração do MiMo**, mesmo se ela passar de 25 segundos.
- **A faixa de várias missões segue o tema.** Pino de missão encerrada deixa de ser botão morto e o nome do orquestrador não repete.
- **Continua desta linha Windows:** pasta que responde, Claude pelo executável, MiMo em `.local\share`, terminal em UTF-8 e o hook que não abre o `.env`.

## 0.76.81 — Nada escondido

- **CLIs instaladas por nvm, pnpm, mise e cia. não somem mais em outras máquinas (F-630).** App aberto pelo Finder via só pastas fixas quando o shell de login (oh-my-zsh + nvm) passava do prazo de 4 s. A busca agora cobre todas as versões do nvm, `~/.claude/local`, fnm, mise, proto, pnpm, `/snap/bin` e, no Windows, `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, Volta e scoop; uma sondagem que falhou no boot é refeita em background (20 s) e reexamina as CLIs sozinha. A mensagem aponta "Reexaminar CLIs"/caminho do binário antes de "instale".
- **Ícones de 9–10 px e tokens fantasmas.** A grade 11×11 com `crispEdges` perdia traços abaixo de 11 px (o "+" ao lado de Terminais sumia; 36 ícones). Tokens usados e nunca definidos (`--surface-hover`, `--text-muted`, `--text-primary`…) invalidavam a declaração — os hovers da barra lateral estavam mortos. Aliases derivados do tema e `css-tokens.test.ts` como guarda.
- **HUD de voz em repouso vira só o orb**; rótulo e controles no hover/foco. O pill "PRONTA" cobria terminal, cartões e planos.
- **Abas, menus e alvos de clique.** Abas dos Providers e do Git com hover e foco; botões do pane e lixeira do projeto em 24 px; ação por arquivo do Git não colapsa em 14 px; primário desabilitado vira contorno; chips de repo/branch e LED do cockpit seguem o tema.
- **401 com a conta conectada** diz que a sessão Nexus expirou, não "entre na sua conta primeiro".


## 0.76.79 — Chaves no lugar

- **Fim do modal «Chaves Não Encontradas» vindo dos panes (F-629).** Todo HOME privado que o Nexus cria para uma CLI (overlay Claude, Codex, Grok, MiMo, cursor, droid, command-code) enxerga o keychain real do macOS. gh, git osxkeychain, SDKs e o refresh das próprias CLIs deixam de abrir o modal cujo botão «Reajustar Para Padrões» apagaria o keychain. GLM/LongCat e workers gated usam `CLAUDE_SECURESTORAGE_CONFIG_DIR` privado e nunca leem nem sobrescrevem o item Claude nativo. Spawns em Seatbelt ficam de fora.
- **Agentes não pedem mais `gh auth login` com a máquina logada.** Lanes graváveis recebem a identidade de git/SSH/gh do operador (F-579 tier 1) em qualquer CLI, não só no Claude.
- **Veneno de sessão do cofre em todas as portas.** A primeira falha do safeStorage desliga get/set/setKey/delete pelo resto do processo; antes só a gravação respeitava a trava e cada leitura voltava ao keychain (21 idas medidas onde devia haver 1). Export/import do vault multi-PC com passphrase (PBKDF2 + AES-GCM).
- **Ditado só envia ao soltar a tecla.** Space/PTT não entrega a transcrição prematura; o hold-to-talk tem teto de segurança e não encerra no silêncio da fala.
- **Prompts de boot e migração não colidem no auto-responder.** Hold da migração MiMo fica separado do banner de menu (early-accept), e o brief espera a migração terminar mesmo passando do prazo de 25 s.
- **Multi-missão no mesmo workspace.** Lane bar por escopo, pinos A/B com isolamento de campo e o nome do orquestrador no crest de cada campo. Segue os tokens do tema (antes ficava preta no tema claro) e pino de campo encerrado não vira botão morto.
- **Claude Opus 5.5 e GPT-6 Sol/Luna** no catálogo, preços, roteador, OMP e defaults do orquestrador (Opus 5.5 substitui o 5; `gpt-6-sol` é o frontier Codex).
- **Jev no caminho de pesquisa e no navegador.** `researchTriage` no search mixer e `browser_find` com desempate por confiança; `browser_read` com judge ligado por default (`judge: false` desliga).
- **Escrita do desktop-control presa ao app da frente.** `SCRIPT_KEY` só vai para o frontmost e apps de terminal (incluindo Termius) ficam na denylist, então o conteúdo não vaza para o terminal externo do operador.

## 0.76.80 — O lote do Mac no Windows

- **Ditado só envia ao soltar a tecla.** Space/PTT não entrega a transcrição no meio. O hold-to-talk tem teto de segurança e não encerra no silêncio da fala.
- **Prompts de boot e migração não colidem.** A espera da migração fica separada do aceite cedo do menu. O prompt inicial do CLI espera trust/bypass sem cair no fluxo errado.
- **Várias missões no mesmo workspace.** Faixa por escopo, pinos A/B isolados e a marca do orquestrador no header.
- **O cofre para de se envenenar.** A primeira falha do safeStorage desliga a escrita pelo resto do processo, então o modal de chaves perdidas não volta. O vault exporta e importa entre PCs com senha.
- **Claude Opus 5.5 e GPT-6 Sol/Luna** no catálogo, preços, roteador e padrão do orquestrador. Opus 5.5 substitui o 5. `gpt-6-sol` é o frontier do Codex.
- **Jev na pesquisa e no navegador.** Triagem no mixer de busca e desempate por confiança no browser_find.
- **A escrita do desktop fica no app da frente.** A tecla de script não vai para o terminal de fora.
- **No Windows desta leva:** seletor de pasta que responde, pane do Claude pelo executável real, login do MiMo em `.local\share\mimocode`, terminal em UTF-8 e o hook que não abre mais o `.env`.

## 0.76.79 — A pasta do workspace abre

- **O seletor de pasta deixa de travar no Windows.** O diálogo nativo estava preso à janela do Nexus e o Windows marcava «Não está respondendo», com a lista vazia em «Nenhum item corresponde à pesquisa». Agora abre solto e a lista responde.
- **O pane do Claude volta a abrir.** O instalador npm no Windows é um `claude.cmd` que aponta para o `claude.exe`. A checagem lia só o atalho, não achava `CLAUDE_SECURESTORAGE_CONFIG_DIR` e recusava a conta isolada. Agora lê o executivo que o atalho abre.
- **O login do MiMo deixa de sumir.** A CLI grava a sessão em `%USERPROFILE%\.local\share\mimocode\auth.json`. O Windows procurava em `%LOCALAPPDATA%` e a conta ficava em «precisa login».
- **O terminal do Windows nasce em UTF-8.** Sem `LANG`, o Git Bash contava o texto em bytes e o launcher `ai` morria em `BANNER_GRAD[i] unbound`. O pane passa a definir `C.UTF-8`.
- **O Windows para de pedir um programa para abrir `.env`.** O hook do Claude fazia `call` no arquivo de endpoint, e o Windows trata isso como “abrir este .env”. Agora o script só lê a porta e o token.

## 0.76.78 — Cota do Claude no Windows

- **Claude deixa de ficar em «Sem leitura»** — o access token do arquivo vence e a renovação existia, mas a leitura seguinte ainda pedia `claude /usage`, que no Windows não devolve número. Agora a cota sai do token renovado, no mesmo endpoint do Mac.

## 0.76.77 — O Mac 0.76.76 no Windows

- **Re-login da mesma conta abre o terminal.** «Entrar novamente» deixa de morrer em «Não consegui guardar a conta atual» quando a sessão viva é a própria conta e o snapshot não grava. Outra conta viva, com e-mail diferente, continua protegida e o login não começa.
- **A conta em uso não cede o pane antes de acabar.** Folga maior numa irmã não troca a conta ativa. A troca espera disponibilidade medida zero, cooldown ou hit real. Sem medição, a ativa permanece.
- **O total de assinaturas deixa de fingir que duas contas são a frota.** Os $400 eram só Claude Max 20× e ChatGPT Pro. O cartão soma apenas planos com preço de lista e diz quantas contas conectadas ficaram de fora. Google AI Ultra entra só quando o plano informa 5× ($100) ou 20× ($200).
- **MiMo V2.6 continua no Windows**, com a sessão em `%LOCALAPPDATA%\mimocode`, o login do Codex que abre e o painel opaco do Redline.

## 0.76.76 — Redline abre neste macOS

- **Nexus Redline não pede mais um macOS que não existe (F-628)**: o companheiro passa a ser compilado para macOS 14.0, o piso já declarado no app. A versão 0.76.75 tinha sido carimbada com mínimo 27.2 e o sistema recusava abri-la no macOS 27.0.
- **Re-login da mesma conta abre o terminal.** «Entrar novamente» deixa de morrer em «Não consegui guardar a conta atual» quando a sessão viva é a própria conta e o snapshot não grava. Outra conta viva, com e-mail diferente, continua protegida e o login não começa.
- **A conta em uso não cede o pane antes de acabar.** Folga maior numa irmã não troca a conta ativa. A troca espera disponibilidade medida zero, cooldown ou hit real. Sem medição, a ativa permanece. Cada conta do vault segue com a própria linha de cota.
- **O total de assinaturas deixa de fingir que duas contas são a frota.** Os $400 eram só Claude Max 20× e ChatGPT Pro. O cartão agora soma apenas planos com preço de lista e diz quantas contas conectadas ficaram de fora. Google AI Ultra entra na soma só quando o plano informa 5× ($100) ou 20× ($200); sem esse número, o preço não é inventado.

## 0.76.75 — Xiaomi MiMo no Nexus

- CLI oficial `@mimo-ai/cli` integrada a Providers, instalação, login, contas salvas, panes, MCP, skills e retomada por sessão.
- MiMo V2.6 Pro e Flash no catálogo, roteamento e comparação interna. UltraSpeed exige API separada; Token Plan conserva seu endpoint regional e seus modelos autorizados.
- Cota do Token Plan no Nexus/Redline após conexão explícita do console Xiaomi da mesma conta. Autorização persistente, sem reutilizar cookies de navegadores externos.
- Tokens reais por conversa e conta, com cache/raciocínio e atualizações idempotentes. Custos informados pela CLI são estimativas, não fatura do plano.
- Modelos sem medição ficam como não avaliados. Benchmarks automáticos não usam Token Plan.
- A assinatura MiMo Desktop é independente da CLI. A conexão do console e o uso autenticado continuam dependendo do login do usuário.

## 0.76.74 — A segunda conta entra no Redline

- **«Login successful!» grava a conta nova** — o Claude no Windows termina o login com essa frase, e o Nexus não reconhecia. A primeira conta ficava salva e a segunda não aparecia no Redline. Agora a frase dispara a prova, salva a conta nova e atualiza a cota.

## 0.76.73 — Cada conta com o seu limite

- **Multi-conta não mistura a cota** — a conta A e a conta B do mesmo provedor são linhas separadas. Cada uma lê o próprio token. O limite de uma não aparece na outra.

## 0.76.72 — Cota do Claude e do Antigravity no Windows

- **Claude logado volta a ter cota** — no Windows o access token do arquivo vence e a sonda não renovava, mesmo com refresh válido e a conta conectada. Agora renova o arquivo e lê os limites.
- **Antigravity usa o mesmo `agy --print /quota` do Mac** — o binário fica em `%LOCALAPPDATA%\agy\bin\agy.exe`. Sem esse caminho a cota nativa nunca rodava.
- **O painel do Redline para de piscar** — o redesenho a cada 2s e o ícone recriado na bandeja faziam a janela em camadas piscar. Só pinta quando a cota ou o cronômetro mudam.

## 0.76.71 — Cota de quem está logado

- **Redline no Windows deixa de dizer «Sem credencial» para conta logada** — o Devin é lido em `%APPDATA%\devin` e o Antigravity no Gerenciador de Credenciais (`gemini:antigravity`). Antes a cota só olhava `~/.local/share` e `~/.gemini`.

## 0.76.70 — O clique no Redline abre

- **Clique no ícone da bandeja abre o painel** — o Windows manda dois avisos por clique. O primeiro abria e o segundo fechava na hora, então parecia que o Redline não respondia.

## 0.76.69 — Grok conectado também no Redline

- **Cota Grok após expirar o access token (F-626)**: renovação pela própria CLI via ACP, somente initialize/authenticate com sessão salva; sem prompt, conversa ou `grok models`. Credenciais nativas e gerenciadas continuam vinculadas à conta certa.
- **Uma renovação por sessão compartilhada**: panes e sonda coordenam cópias do mesmo grant dentro do Main, reutilizam a credencial renovada e recusam troca de identidade ou time durante a espera.
- **Aviso antigo de login removido após prova real**: resposta válida da API limpa apenas o cooldown de autenticação. A publicação ao Redline usa as contas atualizadas na mesma consulta; quota real e bloqueios por tier permanecem protegidos.
- **Falhas temporárias**: indisponibilidade da CLI/rede não é tratada como grant revogado. Falha ao salvar a limpeza de um aviso não descarta o consumo que já foi medido.
- **No Windows**: Devin é lido em `%APPDATA%\devin`, e o Redline da bandeja deixa de ser um quadrado preto.

## 0.76.68 — Grok 4.7

- **Grok 4.7 no catálogo**: disponível no seletor e como padrão de novas escolhas Grok, inclusive com cache local de modelos antigo. Escolhas já salvas são preservadas.
- **Quatro níveis de raciocínio**: low, medium, high (padrão) e xhigh, enviados à CLI pelas opções da sessão.
- **Estimativa de custo atualizada**: preços-base de US$ 2/M de entrada e US$ 6/M de saída, conforme a [documentação oficial](https://docs.x.ai/developers/grok-4-7). O medidor continua sendo uma estimativa, sem preços específicos de contexto longo ou da variante Fast.

## 0.76.67 — Cota e login de cada conta

- **Login Codex por código no Nexus**: o comando padrão abre o fluxo de dispositivo no pane existente; preservação e validação da conta continuam valendo. Métodos de login personalizados permanecem respeitados.
- **Criar PR fora de worktrees**: `nexus_pr_create` permite ao operador criar PR de uma branch publicada no checkout atual. Usa a conexão GitHub existente e informa como autenticar quando falta credencial; não faz push implícito.
- **Reautenticação pela linha de cota (F-359)**: preserva a sessão anterior e salva a nova sessão exatamente na conta escolhida, somente após a prova de login.
- **Claude com consumo por conta (F-615)**: config e cache isolados, validação do UUID do cache e recuperação da leitura nativa somente após confirmar a identidade no servidor. Contas diferentes deixam de herdar os mesmos percentuais.
- **Codex e Grok usam credenciais atuais (F-621)**: seleção por identidade e frescor entre cofre, perfil gerenciado e login nativo; arquivos sem tokens ou sem identidade comprovada não substituem uma sessão válida. Codex consulta cotas pelo app-server da própria CLI quando precisa renovar; grant revogado pede reautenticação.
- **Antigravity sem pane aberto (F-619)**: consulta estruturada da própria CLI, sem turnos de modelo, com limite de tempo e saída e uso restrito à linha nativa.
- **Login e troca preservam as contas (F-620)**: retry mantém a conta escolhida; reautenticação preserva a sessão anterior e exige prova de conclusão. Outro workspace do mesmo e-mail não pode sobrescrever a conta selecionada.
- **Bloqueios não somem por metadados (F-622)**: e-mail no perfil não prova login, não oculta credencial revogada e não remove cooldown real de quota.
- **Keychain com menos tentativas repetidas (F-617/F-624)**: consultas concorrentes são reunidas por item; acesso negado fica desconhecido sem sondar outra CLI. A escrita por stdin não recorre mais a shell, evitando segunda tentativa e segredo em argumentos de processo. Permissões e sandbox não foram afrouxados.

## 0.76.66 — Multi-conta: o login novo gruda, em qualquer LLM

- **Frescor de credencial deixa de ser só-Codex (F-614)** — `authBlobFreshness`/`compareAuthFreshness` leem emissão e expiração em qualquer formato (ISO, epoch em s/ms/µs, JWT embutido, `__nexusDirSnapshot`). Antes, o formato real do Grok (`<issuer>::<uuid>` + `create_time` + JWT) era invisível: `shouldWriteAuthFile` recusava atualizar o managed home E `readBackFresherAuth` promovia o token velho de volta ao cofre — a conta ficava irrecuperável por login. Emissão vence expiração, empate não reescreve, e `compareAuthBlobIdentity` impede que a sessão de outra conta entre no cofre desta.
- **Escopo Claude vazio não empresta a cota da sessão nativa (F-615)** — `hasManagedClaudeAuth` só afirma que o diretório existe, e validar já o cria; com escopo vazio o `claude /usage` cai na credencial nativa. Medido em campo: duas contas exibindo 3% / 73% / 48% idênticos, uma com a sessão morta. `managedClaudeAuthHasCredential` passa a exigir arquivo OAuth utilizável ou item de Keychain com escopo — sem prova, a linha fica em «Sem leitura» e o hint vira `no-credential`.
- **Muse Spark logado deixa de aparecer «não verificado» (F-616)** — com `credential_backend: keychain` o `auth.json` guarda só identidade e o segredo vai para `ai.meta.dev.credentials` (conta = nome do provider). A sonda confere apenas os ATRIBUTOS do item (`find-generic-password` sem `-w`), então prova a sessão sem custar prompt.
- **O Keychain para de pedir permissão em laço (F-617)** — `find-generic-password -w` devolve o segredo, passa pela ACL e roda em caminho quente (cota, spawn, sondas). Sem cache, cada negação virava «não logado» → dispara login → lê de novo. Agora há cache curto (15s) para leitura válida ou ausente, recuo de 5 min para ACL indisponível, bypass pós-login que nunca ignora negação, e seed do cache após captura/escrita confiável — nos dois caminhos (sync e async).
- **«Signed in as» conserta exatamente a conta clicada (F-618)** — a frase real da CLI não era reconhecida como fim de login; e, quando passou a ser, encerrar ali perdia o login porque o Keychain ainda não refletia a troca. O watcher agora só é liberado por prova, fechamento ou timeout, refaz sonda perdida por corrida, usa fingerprint opaco do blob Claude para provar reautenticação do mesmo e-mail, e leva o `accountId` até o Main — que recusa credencial comprovadamente de outra linha em vez de adivinhar por e-mail.
- **No Windows o fingerprint do Claude sai do arquivo** — fora do macOS não há Keychain; a prova é `~/.claude/.credentials.json`. A sonda devolve esse blob para o mesmo fingerprint opaco, senão reautenticar o mesmo e-mail não gruda. O Redline de bandeja, ao ser aberto de novo, mostra o painel em vez de sair calado no mutex.
- **Redline no Windows deixa de empilhar o rodapé** — o tipo estava em pontos e as três linhas do rodapé caíam umas sobre as outras e sobre a última conta. Cada linha mede a própria altura, o cromo pinta por cima da lista, e o painel ganha vidro acrílico (cantos, blur e brilho no topo).

## 0.76.65 — Grok e Kimi dizem «Entrar novamente» e o Kimi nativo lê de verdade

- **Grok: credencial morta vira CTA** — o 401 real do billing xAI (`~/.grok/auth.json` vencido) colapsava em «Sem informação»; `probeGrokUsageWindows` expõe `authFailed` → `auth-expired` → «Entrar novamente» na linha, no rail e no Redline (`needs-relogin`).
- **Kimi: refresh rejeitado vira auth-expired** — `probeKimiRefresh` (400/401/403 do token endpoint) e `probeKimiCodingUsageWindows` (401/403 do `/usages`) distinguem grant morto de falha transitória; conta vault marcada via `markAccountAuthExpired` (agora cobre grok/kimi, não só claude).
- **Rotação Kimi respeita a linhagem** — grant rotacionado de conta vault voltava para `~/.kimi-code` (sessão nativa de outra identidade): `persistRotated` + `persistKimiRotatedCreds` escrevem o grant novo no blob vault da conta; a linha nativa mantém `persistOnRotation` no arquivo do CLI.
- **Linha nativa do Kimi finalmente sondada** — `canProbeQuota` vetava provider `subscription` não-roteável com upstream declarado (`moonshot` é a família da API, não rota para outro vendor): a linha nativa passa a ler o uso real (16% semanal verificado ao vivo).
- **Redline honesto para linhas sem conta** — `readHint` da sonda vira `excludedReason` no snapshot: `needs-relogin`/`no-credential` chegam ao companheiro de menu bar mesmo sem `AccountInfo`.

## 0.76.64 — Sessão morta vira botão, plano por conta e menus internos redesenhados

- **«Entrar novamente» na linha nativa do Claude**: o hint `auth-expired` agora chega da sonda à UI — 401/403 do endpoint OAuth, `expiresAt` vencido do token nativo, stderr do CLI (`OAuth session expired…`) e a evidência `oauthAccount` em `~/.claude.json` distinguem «sessão morreu» de «nunca conectou» e de «falha transitória».
- **Cache HTTP do Claude Desktop (Codenotch)**: leitor do Simple Cache com zstd, freshness-gated e ancorado por `organizationUuid` — cobre a conta mesmo com a credencial do CLI morta, sem cruzar contas.
- **Bridge AGY local**: quota do language-server Antigravity via `lsof` + `x-codeium-csrf-token`; o processo do Windsurf/Devin (mesma família Codeium) é rejeitado — sem contaminação entre providers.
- **Planos de assinatura por conta**: Claude `organizationRateLimitTier`, Codex `chatgpt_plan_type` (JWT do id_token) e AGY `currentTier` viram selo na linha (`Claude Max 20× · $200.00/mês`) e a frota soma o total mensal — remover uma conta remove o custo; plano desconhecido não entra.
- **Perfil do Operador global**: «Entregas · todos os projetos» soma os contadores de XP de todos os checkouts com piso monotônico persistido — apagar um checkout não rebaixa o total.
- **Menus internos de Configurações revistos**: seis frentes de polish (shell, conta, catálogo, sistema, agentes, mídia) — agrupamento acessível, chips de plano/conexão, estados vazios consistentes, reduced-motion, 0 findings Impeccable.

## 0.76.63 — Cota Claude por conta, pet nos cantos de verdade e consumo real no perfil

- **Cascata por conta Claude (Codenotch)**: contas vault saem do «Sem leitura» — cada conta tenta managed-auth scoped (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, o CLI renova o próprio token), perfil de disco com o mesmo e-mail e materialização do cofre, sem nunca emprestar a leitura de outra conta.
- **Pet chega nos cantos físicos**: arrasto, settle, boot e patrulha agora usam os bounds reais do display — o pet flutua acima da menubar/Dock (screen-saver), então o sprite encosta na extremidade inteiro, sem corte. Zona morta entre monitores de alturas diferentes é recusada por cobertura, não por bounding-box.
- **Pet parado por padrão**: a patrulha autônoma virou opt-in no menu («Passear pela tela»); parado ele mantém bob, olhar que segue o cursor e reações locais, e move só no arrasto. Placement recalculado ao vivo durante o gesto, com dedup de IPC.
- **Consumo real no Perfil do Operador**: a área do «recruta» mostra tokens torrados, USD-equivalente em API paga, panes, turnos, mídia e missões — a prova de quanto a assinatura economizou. A mesma faixa aparece no cockpit Cotas do rail e em Ajustes → Uso e cotas (hook `useLifetimeUsage` compartilhado, IPC `usage:lifetime`).
- **Menu do pet com scrollbar slim** no tema escuro; ticker de stats continua girando tokens/USD/panes.

## 0.76.62 — Cotas reais por CLI, contas isoladas e terminal que não some

- **Cota deixa de mentir «Não informado»** (Codenotch): Grok lê `billing?format=credits`; Kimi e AGY refrescam o access em memória; Claude cai em `claude /usage` print-only se o OAuth falha; Devin usa GetUserStatus; Cursor usa `autoPercentUsed` (nunca `plan.used/limit` do free). GLM/Codex intocados.
- **Quem mais gastou fica em cima**: faixa do Redline (máx. 6), painel e Ajustes → Uso ordenam pela maior `%`; contas sem leitura vão para baixo.
- **Contas Claude isoladas (F-153)**: cada conta tem perfil OAuth próprio; a seleção do Nexus não reescreve o Keychain global nem pinta a credencial B no cofre A.
- **Codex refresca a conta materializada (F-207)**: a trava de spawn espera o `auth.json` da conta escolhida, não o perfil nativo.
- **Terminal Codex não apaga texto no resize (F-356/F-357)**: um único resize após medir; ANSI sobrevive à fila drenada.
- **Redline depois do update (F-612/F-029)**: copia o binário novo, relança, painel escuro com logos, faixa compacta.
- **Pane manual não estaciona no TTL (F-150)**; segundo login guarda a sessão atual (F-358); Kimi overlay leva `models`/`providers` (F-611); AGY aliases/esforço (F-151/F-154).

## 0.76.61 — Redline no menu bar, tok/s visível e abas de espaço

- **Redline no menu bar**: companheiro nativo macOS com barras 5h/semana por conta, cores de urgência, cronômetro até o reset e Fleet Pulse em Uso e cotas. Snapshot em `~/.nexus/redline-last-good.json` (sem segredos, e-mail mascarado); a escolha de conta no spawn continua aritmética de folga, não o Jev.
- **Chip de tok/s deixa de sumir na toolbar (F-607)**: custo e velocidade saem do recorte do meta e ficam em `toolbar__telemetry`, ao lado das ações. No pane largo com rótulos cheios o operador via `$` e "Trabalhando" e nunca a velocidade.
- **Renomear a aba do espaço (F-606)**: duplo clique no chip "Meus terminais" edita o nome (Enter/blur grava, Esc cancela). Missão e "Painéis soltos" não entram em edição.
- **Login do Kimi pergunta o site (F-354/F-595)**: kimi.ai vs kimi.com antes de abrir a CLI; cancelar a escolha não pinta erro de login.
- **Muse é a CLI `muse`, não Claude (F-596/F-599)**: o pane deixa de injetar `--mcp-config`/`--settings` (help + exit 2). `muse-claude` (Spark) fica opcional.
- **Codex do operador não mistura url+stdio no mesmo MCP (F-594)**: spawn da mão do operador pula chaves do hub que já existem no `config.toml` preservado.
- **Colar em pane morto não mente "cópia falhou" (F-593)**: o arquivo já estava no disco; o toast passa a dizer que o pane não tem sessão.
- **Cota GLM volta a pintar (F-608)**: a API Z.ai passou a rotular as janelas como `CREDIT_LIMIT`; o parser aceita o nome novo e o antigo.
- **Pane vivo não some ao sair dos Terminais (F-603)** e páginas de Ajustes (MCP/Harness/Conectores) deixam de vazar em 171 linhas (F-601/F-602/F-604).

## 0.76.60 — Pacing EAGAIN no PTY e resume verificado do uso Codex

- **Retry EAGAIN com pacing no node-pty (F-591)**: porte do Orca #15319 — o retry de escrita que travava o thread do PTY a ~100% de CPU quando o leitor parava de drenar agora espera 1ms (medido: 121k→805 EAGAIN/s), e o `dispose` aposenta o master fd com drop da fila (Orca #17914), impedindo escritas pós-dispose em descritores reutilizados.
- **Resume verificado do scanner de uso Codex (F-592)**: offsets e snapshot do ingestor persistem entre restarts com verificação por digest duplo (head+boundary, piso 12KB); restart no meio de rollout preserva totais idênticos sem revarrer megabytes, e qualquer dúvida cai para reparse integral (porte do desenho Orca #21102; 8 achados do code review corrigidos com regressões pinadas).

## 0.76.59 — Paridade de Git com Orca, empty states amigáveis e velocidade de tokens contínua

- **Paridade de Git / Source Control com Orca (F-584)**: menu interativo de branches com alternância imediata e criação de nova branch (`git checkout` / `checkout -b`), botões dedicados de pull e push com badges de contadores na barra de ferramentas, descarte seguro de arquivos modificados ou untracked (`git checkout --` / `git clean -f`) e ação primária inteligente que assume pull quando o branch local estiver atrás do repositório remoto.
- **Painéis Laterais Acolhedores e Funcionais (F-584)**: estados vazios dos painéis contextuais de Missão, Busca, Skills e Git agora trazem cartões explicativos com botões de ação direta: "+ Armar Nova Missão", busca guiada de arquivos/símbolos e botão para abrir o catálogo de skills diretamente no Marketplace.
- **Velocidade de Tokens Sempre Visível nos Agentes (F-585)**: o chip de medição de velocidade (tok/s e TTFT) permanece visível nos panes de IA em estado pronto (`⚡ — tok/s`) com estilo discreto e tooltip explicativo, mudando para ativo com destaque em acento assim que a LLM entra em streaming e encerra rodadas.
- **Correção de Modelos do Google Gemini 3.8 (F-586)**: remoção do modelo inexistente `gemini-3.8-pro` e promoção de `gemini-3.8-flash-high` como default oficial do Antigravity/AGY, corrigindo o catálogo de modelos, definições de squad, prompts Jarvis e garantindo migração transparente de IDs legados em tempo de spawn.
- **Padrão de 1M de Contexto para LLMs de Grande Janela (F-587)**: o Nexus estabelece 1.000.000 de tokens como padrão oficial nos overlays do Codex (`model_context_window = 1000000`, `model_auto_compact_token_limit = 950000`) em squads, missões e helpers isolados, elevando automaticamente o teto conservador de 256k de fábrica sem necessidade de ajustes manuais no `config.toml`.
- **Estacionamento de Panes Ociosos sob Pressão e Otimização para Máquinas Inferiores (F-588)**: o reaper de emergência e a varredura pós-TTL agora podem estacionar (`parkPane`) panes de agentes ociosos (inclusive workers de missão e panes de operador), encerrando os processos CLI/PTY e recuperando ~1 GB de memória por pane imediatamente, sem destruir o histórico nem o pane visual no grid. Em máquinas com pouca RAM (<= 8 GB), o teto de admissão foi calibrado para 2 panes seguros (e 3 em 12 GB), prevenindo travamento do sistema.
- **Resiliência Adaptativa no Envio de Enter / Correção do "Pane Dormindo" (F-589)**: resolução do problema onde prompts, briefings e cutucadas de handoff ficavam parados no composer aguardando um Enter manual do usuário. Implementada escada adaptativa de retentativas progressivas com backoff (600ms, 1200ms, 2000ms) alternando `\r` e `\r\n` até a confirmação da transição para `busy`, garantindo avanço autônomo das missões mesmo sob alta carga da máquina.
- **Paridade de Cron de Automações com o Orca (F-590)**: correção da expansão de passos com valor inicial aberto `N/step` (ex: `5/15` gerando `5, 20, 35, 50` em vez de apenas `5`) e adoção de restrição lexical POSIX/vixie para dias do mês e da semana (expressões como `1-31` restringem via união OR com o dia da semana, enquanto passos sobre curinga como `*/2` preservam a interseção AND), alinhando a execução de agendamentos ao padrão de referência.

## 0.76.58 — Resiliência de failover no Claude e organização das abas no grid

- **Resiliência e Desacoplamento no Failover Claude (F-583)**: contas secundárias com renovação de token OAuth falhando/pendente são filtradas antes da escolha no failover automático, prevenindo loops de erro. O toast de erro não acusa mais a conta ativa com o motivo da secundária, e a janela de quarentena de refresh foi reduzida para 2 minutos.
- **Legibilidade e Ações Rápidas nas Abas do Grid (F-583)**: a barra de abas dos terminais separa a contagem de painéis com badge visual dedicada (evitando aglutinações confusas como `[Meus terminais 2 1]`), desambigua automaticamente títulos idênticos com sufixos (#1, #2), exibe indicador de status dot para missões ativas e adiciona o atalho rápido `+ Nova missão` direto na barra.

## 0.76.57 — Jev sugere a skill

- **Skill sugerida pelo Jev no roteamento**: `nexus_route_task` devolve `skillSuggestion` — o catálogo das skills bundled (impeccable, archify, superpowers e suas sub-skills, bmad-templates, dembrandt, typesafe-ai e as skills nativas do Nexus) é levantado em código a partir do frontmatter de cada SKILL.md, e UMA pergunta `choice` deixa o Jev escolher no máximo uma skill claramente útil ("none" quando nenhuma). Aceita só com confiança ≥ 0,6, filtrada pelas skills permitidas ao chamador (por pacote ou por nome); registrado no diário de decisões (surface `taskRouting`); sem chave TypeSafe, null.
- **A dica chega ao pane do fan-out**: quando `nexus_pane_spawn` roteia sozinho (sem `adapterId`), o recibo `route.skill` traz a sugestão e, com confiança ≥ 0,7 e skill permitida ao filho, uma linha é acrescentada ao prompt — "Skill sugerida pelo Nexus: \<skill\> — leia a SKILL.md dela antes de começar". Nunca inventa prompt nem instala nada: o Jev sugere, o pane decide.
- **Extração do browser em uma chamada**: `nexus_browser_extract` resolve em código o que é determinístico (JSON-LD, candidato único, nenhum candidato) e manda TODOS os campos que precisam de julgamento numa única consulta ao Jev — a latência de N campos vira a de um. Booleano indeciso (0,4–0,6) devolve null em vez de cara-ou-coroa.
- **Correções do code review**: a sugestão de skill respeita grants por pacote (`superpowers`) e por nome, como o skill-mirror; probabilidade booleana entre 0,4 e 0,6 devolve null na extração em vez de false; `description: >` dobrada das skills é lida inteira no catálogo.

## 0.76.56 — O browser fala de volta

- **Toda ação devolve o depois**: `click`, `fill`, `press`, `scroll`, `hover` e `navigate` respondem com `after` (url, título, carregando) e `changed` (`navigated: none | same-document | new-document` — o Main espera o `did-stop-loading` numa navegação real). `read: true` embute a página resultante na mesma resposta, em JSON ou no `format: "compact"` (outline com `[e12] link "Ver squads" → /squads`); `viewport` e `atBottom` dizem se ainda há página abaixo.
- **Alvo por texto, nunca por seletor**: `nexus_browser_find` busca elementos visíveis pelo nome acessível (e pelo caminho do link), sem CSS nem JavaScript. `click` e `fill` aceitam `text`/`label` no lugar do `ref`: um vencedor claro age; empate devolve os candidatos sem fazer nada — e o Jev desempata só com 2 a 5 candidatos e confiança ≥ 0,7, registrado no diário de decisões.
- **Ver erros pelo browser**: cada resposta traz `errors` desde a última ação — erros de console JS, respostas HTTP ≥ 400 e falhas de carregamento capturados no Main (redigidos, no máximo 5 itens) — mais os `alerts` da página (`role=alert`, `aria-invalid`). `judge: true` anexa o julgamento Jev: erro visível, bloqueado por humano (login, captcha, 2FA), ainda carregando e o tipo de página — opt-in, fail-open, superfície `browserTool`.
- **`nexus_browser_extract`: da página para campos tipados**: o agente declara os campos (nome, tipo `string|number|boolean|date|enum`, hint); o código levanta candidatos limitados e redigidos — JSON-LD embutido, tabelas, label→valor, números, datas, e-mails — e resolve: JSON-LD bate direto, candidato único vale 0,8, dois ou mais vão ao Jev (confiança ≥ 0,6); booleano e enum são perguntas tipadas. Números pt-BR/en e datas normalizados em código; `null` quando não há candidato confiável. Valores digitados em campos nunca saem da página.
- **Correções do code review**: `nexus_browser_find` e `nexus_browser_extract` passam pelas mesmas checagens de superfície e URL do `read` na revisão automatizada; os rótulos dos candidatos de extração também passam pela máscara de redação; uma extração com várias colunas não repete a chamada ao Jev depois da primeira falha; a assinatura posicional legada do `console-message` do Electron volta a ser lida no campo certo.
- **Canal macOS**: a 0.76.55 saiu só para Windows; esta é a primeira build macOS com o browser do agente completo.

## 0.76.55 — Grok escuta (canal Windows)

- **O canal Windows x64 alcança a 0.76.54**: cada canal publica a própria próxima versão estável — a v0.76.54 já está pública com assets macOS, e o publicador recusa anexar assets de outro sistema a release pública, então o Windows avança com a 0.76.55 carregando o código assinado do main atual. Para quem vem da 0.76.53, a atualização traz exatamente a seção 0.76.54 abaixo.
- **Os itens entregues são os da seção 0.76.54 abaixo**: Grok Voice Transcribe 2.0 (xAI) no seletor de transcrição da voz, recibo da escolha de conta no `nexus_pane_spawn`/`whoami` (quem decidiu, conta mascarada, folga da vencedora, motivo da perda de cada alternativa) e consumo do Jev por janela (consultas · custo estimado · sem resposta, e "N pelo Jev · M pela regra" por superfície), mais as correções do code review da 0.76.53.

## 0.76.54 — Grok escuta

- **Grok Voice Transcribe 2.0 no seletor de transcrição**: novo provedor `xai` em Ajustes → Voz → Transcrição da fala — `POST api.x.ai/v1/stt` com `grok-voice-transcribe-2.0`, `language=pt` + `format=true`, `keyterm` como viés de vocabulário (jargão do modo CODE; a wake word no passive-wake) e o arquivo por último. Usa a `XAI_API_KEY` já configurada para o Grok realtime. Só transcreve — o modo CODE mostra `CODE·PT`. Cadeia padrão: Gemini → Grok → Groq → OpenAI → whisper.cpp; instalações existentes ganham o link após o último provedor cloud, nunca no lugar do escolhido; cadeias só-locais ficam intactas.
- **Recibo da escolha de conta no spawn**: `nexus_pane_spawn` devolve `harness.account` e `nexus_pane_whoami` devolve `account` — quem decidiu (pinada, regra de folga, ativa, fallback na ativa, linhagem nativa ou legado), a conta com rótulo mascarado, a folga medida da vencedora e as alternativas com o motivo de cada perda. A regra continua decidindo — Jev não escolhe conta.
- **Consumo do Jev por janela**: "Decisões do Jev" ganha "Consumo do Jev (TypeSafe)" — Hoje, 30 dias e desde sempre × consultas · custo estimado · sem resposta, e por superfície "N pelo Jev · M pela regra". O diário grava a consulta que falhou (só a categoria, nunca o texto) e a leitura sobrevive à rotação. Custo = tokens de entrada × US$ 0,042 por milhão, preço público da TypeSafe; chamada direta, sem OpenRouter.
- **Correções do code review**: custo abaixo de US$ 0,0001 aparece como "< US$ 0,0001" em vez de US$ 0,0000; o recibo de conta só é registrado depois que o spawn se firma no Main; a máscara de conta guarda só o sufixo público (`.com.br`, nunca subdomínios internos); linhas sem resposta ficam com tokens e custo nulos em vez de zero fabricado.

- **Canal macOS**: a 0.76.53 saiu só para Windows; esta é a primeira build macOS com as três novidades.

## 0.76.53 — Push sai do pane (canal Windows)

- **O canal Windows x64 alcança a 0.76.52**: cada canal publica a própria próxima versão estável — v0.76.51 e v0.76.52 já estão públicas com assets macOS, e o publicador recusa anexar assets de outro sistema a release pública, então o Windows avança com a 0.76.53 carregando o código assinado do main atual. Para quem vem da 0.76.41, a atualização traz de uma vez as seções 0.76.43 → 0.76.52 abaixo — pane guardian e sessão de CLI isolada por checkout, pane dormindo com "Acordar", hub MCP compartilhado, **pane Claude logado de primeira (o F-576 é fix de Windows)**, cache MCP durável, a era Jev e o push saindo do pane — e o endurecimento do medidor de velocidade pós-0.76.51.
- **Git push de dentro do pane (F-579/F-580/F-581)**: o HOME privado da família Claude nascia sem `~/.gitconfig`, `~/.ssh` e `~/.config/gh` — credential helper sumido, SSH sem chave, todo push pedindo usuário. Panes graváveis passam a receber a identidade de desenvolvedor do operador (teardown remove os links sem segui-los); o runner de git do Main volta a honrar a config global e de sistema (`gh auth git-credential`, GCM, `user.name/email`) com a config local executável do repo seguindo recusada; e `nexus_git_sync` fica alcançável pela mão do operador em vibe.
- **Pane Claude no Windows abre logado (F-576)**: o spawn escrevia `CLAUDE_CONFIG_DIR=""` para neutralizar um path herdado, só que vazio não é ausência — o resolver do binário aceita `""` via `??` e resolvia `.credentials.json` **relativo ao cwd do pane**. Todo pane novo nascia em "Not logged in · Run /login" na máquina perfeitamente autenticada. `AgentSpawnDecoration` ganha `envRemove` (remoção real da chave do env do filho); sem a var, o resolver cai no overlay linkado e o `/login` feito no pane atravessa para a credencial de verdade.
- **Pane sobe a quente (F-578)**: os servidores MCP `npx`/`uvx` do perfil herdado resolviam o cache pelo `$HOME` — e o HOME do pane é descartável. Medido: **~475 MB baixados em <1 min** dentro de cada overlay, main a ~99% de CPU em callbacks de fs durante o spawn. Agora `npm_config_cache`, `XDG_CACHE_HOME` e `UV_CACHE_DIR` apontam para `<userData>/provider-cache/<adapter.id>/`: baixa uma vez por máquina, todo pane seguinte sobe a quente — com isolamento por domínio de confiança.
- **Jev decide, Nexus executa**: guarda Jev no despacho MCP (injeção ≥ 0,8 → `deny` auditado; destrutivo incoerente → modal de volta), `nexus_tool_pick`, `nexus_route_task` calibrado, `nexus_judge` e o cofre `jev-env:TYPESAFE_API_KEY`; o fluxo "abra X panes e faça Y" sem missão roteia pelo motor do `route_task` com guarda só-injeção nos filhos. Sem chave TypeSafe as ferramentas Jev somem do `tools/list` e o Nexus é o clássico. `nexus_computer_do` é macOS nesta entrega.
- **Pane dormindo, guardião e hub MCP compartilhado (F-572/F-573)**: pane ocioso sem dono é estacionado após 30 min (ou na hora sob pressão) e FICA no layout com scrollback e "Acordar" retomando a mesma conversa; teto de panes vira aviso com bloqueio só sob pressão real (limites proporcionais à RAM), reaper de emergência, custo por pane no cabeçalho e os servidores stdio do perfil subindo UMA vez no main, expostos por HTTP.
- **Velocidade do modelo (tok/s e TTFT)**: Ajustes → Diagnóstico mede geração por segundo na rodada aberta, latência até o 1º token, média/pico e curva — uma linha por LLM, com o chip de tok/s na barra do próprio pane ao lado do badge de custo. Métrica sem lastro vira travessão, nunca zero falso. Endurecido nesta build: o parser de input respeita Backspace, Ctrl+U, Ctrl+W e CRLF, ignora Enter vazio, preserva respostas curtas reais (pontuação, emoji) e o filtro de TUI separa zero-width dos glifos de moldura sem quebrar cluster de grafema.
- **Colar mídia no pane volta — e diz o motivo (F-582)**: paste aceita qualquer tipo, lê `text/uri-list`, imagem embutida em HTML e o pasteboard do sistema; arquivo com caminho real vai path-first em stream até 256 MiB; recusas mostram a causa real em toast.
- **Swap em uso não trava pane novo (F-574)**: o teto de 1 GB de swap recusava todo spawn após um pico antigo — no Windows o "commit" do relatório é memória prometida, não pressão viva. O gate de swap nasce em 0 (`NEXUS_PANE_MAX_SWAP_MB` arma por máquina) e o sinal de admissão passa a ser a memória disponível de fato.

## 0.76.52 — Push sai do pane

- **Git push de dentro do pane (F-579)**: o HOME privado da família Claude nascia sem `~/.gitconfig`, `~/.ssh` e `~/.config/gh` — credential helper sumido, SSH sem chave, push pedindo usuário. Panes graváveis passam a receber a identidade de desenvolvedor (`.gitconfig`, `.git-credentials`, `.netrc`, `.ssh`, `.gnupg`, `.config/git`, `.config/gh`); a lane sem gate hooks recebe o HOME real menos estado de conversa Claude, `.nexus`, `Library` e `.Trash`. Lane readOnly não recebe nada; teardown remove os links sem segui-los.
- **`nexus_git_push` e o push antes do PR voltam em HTTPS (F-580)**: o runner de git do Main zerava config global/sistema e matava `gh auth git-credential`, osxkeychain, GCM e `user.name/email`. Config global e de sistema voltam a valer; a config local executável do repo segue recusada, com hooks/fsmonitor/gpg/protocolos pinados por argv.
- **`nexus_git_sync` na mão do operador (F-581)**: fast-forward verificado, subconjunto do `git_pull` que o pane do operador já executa em vibe. Só `ui_action` mantém autoridade de origem renderer.
- **Jev no fan-out sem missão**: `nexus_pane_spawn` sem `adapterId` roteia `task ?? prompt` pelo motor do `nexus_route_task` e devolve recibo `harness.source auto-route`; filhos do operador herdam o allowlist dele em Autopilot, sempre com `--strict-mcp-config`/`preserveUserMcp=false`; a guarda Jev cobre os filhos em modo só-injeção; handoff sem missão passa pela revisão de evidência; e `PostToolUseFailure` com matcher Bash posta em `/hook/triage` (triagem volta como `additionalContext`, sem bloquear).
- **Colar mídia no pane volta a funcionar — e diz o motivo (F-582)**: paste aceita qualquer tipo, lê `text/uri-list`/`DownloadURL`, imagem embutida em HTML e o pasteboard do sistema (`public.file-url`) via Main; arquivo com caminho real vai path-first em stream até 256 MiB (base64/downloads seguem em 14 MiB); `text/plain` nunca é interceptado; recusas mostram a causa real, incluindo a dica de Privacidade do macOS para `~/Downloads`.
- **Correções do code review**: espelho `~/.nexus/attachments/mission-context/` só até 14 MiB; triagem ignora `PostToolUseFailure` sem `tool_input.command`; falha ao consultar o pasteboard do sistema vira toast em vez de silêncio.

## 0.76.51 — Jev decide, Nexus executa

- **Guarda Jev no despacho MCP**: toda chamada `nexus_*` com efeito dentro de missão (fora da mão do operador) passa por três nouls — coerente com o objetivo (`intentContract.goal`), argumentos injetados, efeito irreversível. Injeção ≥ 0,8 → `deny` auditado com hint; coerência ≤ 0,35 e destrutivo ≥ 0,6 → o modal de confirmação volta mesmo em missão aprovada; o resto passa. Read-only e o conjunto isento (handoff_*, heartbeat, clarify, waits, reads, judge, rank, tool_pick, route_*) nunca são julgados. Args compactados (string > 300 chars redigida e cortada, JSON ≤ 2 KB) e nunca persistidos; cache de veredito por sessão+args originais por 60 s; serviço fora = fluxo de hoje.
- **`nexus_tool_pick`** (read-only, ALWAYS_ALLOWED): recomendação semântica entre as ferramentas visíveis ao chamador — pré-filtro lexical pt-BR→en, top 24, uma `choice` com `none`; devolve top-N com probabilidades e margem 1º–2º.
- **`nexus_route_task` via Jev**: tier e especialidade calibrados por campo (≥ 0,6, senão heurística); `specialtyOverride` aditivo no `RouteContext`; resultado com `classifierSource` e `escalate`.
- **`nexus_computer_do` (macOS)**: piloto automático de desktop — árvore AX do app com fallback de OCR local (pixels nunca saem), Jev decide, System Events executa; uma confirmação por objetivo, irreversível para em `needs_confirmation`, trava de app, campos sensíveis recusados, só operador/orquestrador, exige Acessibilidade; capturas de confirmação expiram em 24 h.
- **Interruptores** `dispatchGuard`, `toolPick`, `taskRouting` em `orch.jevSurfaces` (Ajustes → Squads) e decisões no painel "Decisões do Jev". Sem chave TypeSafe as ferramentas Jev somem do `tools/list` e a skill bundled não é espelhada.
- `browser_do`/`computer_do`: descrição passa a exigir verificação independente do `done`.
- **Velocidade do modelo na barra do próprio pane**: o chip de tok/s da última resposta (TTFT no tooltip) fica ao lado do badge de custo, pintando no acento enquanto o modelo gera. Busca ESTRITA por pane — sem amostra própria, o chip não ocupa espaço (nunca exibe o número de outro pane).
- **Design**: o card de velocidade e o aviso de transporte ACP perdem a barra lateral de acento — `--accent` volta a ser só ESTADO (foco, agente ativo, item selecionado, streaming), como o `DESIGN.md` manda; a hierarquia entre os números vem da escala tipográfica.

## 0.76.50 — Panes a quente

- **Pane deixa de re-baixar ~500 MB de MCPs a cada abertura (F-578)**: os servidores MCP `npx`/`uvx` do perfil herdado (hub do operador + conectores da conta) resolviam o cache pelo `$HOME` — e o HOME do pane é descartável. Resultado medido no Mac do operador: **~475 MB baixados em <1 min** dentro de cada overlay, com o processo principal a ~99% de CPU em callbacks de fs durante o spawn — o "tudo fica carregando". Agora `npm_config_cache`, `XDG_CACHE_HOME` e `UV_CACHE_DIR` apontam para `<userData>/provider-cache/<adapter.id>/`: o download acontece uma vez por máquina e todo pane seguinte sobe a quente.
- **Jev (TypeSafe): julgamento tipado dentro do produto**: triagem de intake no router de intents (`routeWithJev`, opt-in pelo toggle `orch.jevAutopilot` ou `NEXUS_JEV_AUTOPILOT=0`; sem chave TypeSafe cai na cadeia de provedores como antes), tool MCP `nexus_judge` (read-only, 30/min/sessão, state ≤ 32 KB), revisão de evidência dos handoffs (1 devolução, depois `[evidência fraca]` + artifact `nexus.jevReview`), triagem de saída de terminal, cofre `jev-env:TYPESAFE_API_KEY` em Ajustes → Chaves de API (a chave chega pelo shell do usuário pelo ENV_ALLOWLIST, nunca pelo `process.env` do Main) e skill `typesafe-ai` bundled. Testes do router ficaram herméticos: não chamam a API real quando a máquina do operador tem chave no shell.
- **"Enviar para o NexusIDE" passa a fazer algo dentro do IDE (F-577)**: o shot-bridge recebia o arquivo do Nexus Shot e o evento `shot:files-received` morria no renderer — nenhum consumidor assinava `onShotFilesReceived`. Agora o IDE confirma a entrega com um toast ("Nexus Shot: <nome>" ou a contagem do lote) com ação **Abrir** (app padrão) / **Abrir pasta**; falha de abertura vira toast de erro. A validação de caminho (realpath sob as raízes do Shot) continua no Main; nenhum canal IPC novo.
- **Velocidade de geração por LLM (tok/s e TTFT)**: Ajustes → Diagnóstico passa a medir quanto cada modelo gera por segundo na rodada atual, a latência até o 1º token, média/pico das últimas N e uma curva — com uma linha por LLM, somando panes que usam o mesmo modelo e mantendo separado o histórico de quem troca de modelo no meio da sessão. Métrica que a medição não sustenta aparece como `—` (nunca zero falso); Claude e Codex substituem a estimativa por bytes pela contagem exata do transcript. O observador de input do PTY é read-only: não altera a escrita, e o texto do prompt fica só em memória volátil para separar eco de TUI de token do modelo — nada de conteúdo entra em snapshot, IPC ou disco.
- **Isolamento mantido por domínio de confiança**: a raiz do cache é por `adapter.id` — um pane third-party (GLM/LongCat) nunca escreve no cache que a toolchain do pane nativo executa. Os demais adapters já isolavam seus homes duráveis; só a família Claude herdava o churn.
- **Sem mudança de política de auth**: a correção do F-575 (keychain linkado) segue intacta — este release ataca o boot lento, não a autenticação.

## 0.76.49 — O Claude entra no Windows também

- **Pane Claude no Windows abre logado (F-576)**: a 0.76.48 curou o macOS (keychain invisível no HOME privado), mas no Windows o "Not logged in · Run /login" continuava — causa raiz diferente, mesmo sintoma. O spawn escrevia `CLAUDE_CONFIG_DIR=""` para neutralizar um path herdado, só que vazio não é ausência: a variável continua no env block e o resolver de config dir do binário aceita `""` via `??` — `.credentials.json`, `projects` e `sessions` passavam a resolver **relativos ao cwd do pane**, não ao HOME privado. Todo pane novo lia `<cwd>\.credentials.json` (inexistente) em vez do `<overlay>\.claude\.credentials.json` linkado.
- **Login completava sem nunca persistir**: o `/login` fechava o OAuth em memória (o `.claude.json` do overlay atualizava `oauthAccount` — seu resolver usa `||`, que trata `""` como unset e cai no homedir) mas a credencial ia parar num path relativo ao cwd. A divergência `??` vs `||` dentro do próprio binário mascarou o bug: identidade projetada ok, credencial nunca lida.
- **`envRemove`: remoção real, não esvaziamento**: `AgentSpawnDecoration` ganha `envRemove` — a chave é deletada do env do filho no merge (`delete env[key]`, mesmo contrato do `suppressEnv` de providers). Sem a var, o resolver cai em `join(homedir(), '.claude')` → `<overlay>\.claude` → credencial linkada. A garantia original do F-567 (não herdar um path custom, ex.: passthrough declarado por adapter de usuário com bin `claude`) fica preservada pela remoção pós-merge. Prova controlada: `CLAUDE_CONFIG_DIR=` + cwd com credencial → `loggedIn:true`; cwd sem → `false`; var ausente + HOME do overlay → `loggedIn:true` com e-mail e org.

## 0.76.48 — O Claude volta a entrar

- **Pane Claude abre logado de novo (F-575)**: desde a 0.76.45 (HOME privado por checkout, F-567) todo pane do Claude nascia em "Not logged in · Run /login" com a máquina perfeitamente autenticada. A causa é do macOS, não do CLI: a lista de busca de keychains é resolvida por `~/Library/Keychains` **relativo ao $HOME do processo** — no HOME efêmero do pane, o login keychain real some da busca e "Claude Code-credentials" fica invisível. O overlay agora linka os `*.keychain-db` reais, então o pane enxerga a sessão viva da assinatura exatamente como no HOME real.
- **Login dentro do pane passa a segurar**: sem o keychain real na busca, um `/login` feito no pane gravava a credencial num `login.keychain-db` descartável dentro do overlay — apagado no teardown, sem chance de sync-back. Com o link, a escrita atravessa direto para o keychain de verdade: o login persiste e o refresh de token continua compartilhado entre pane, CLI nativo e demais panes (sem rotação cruzada).
- **Superfície deliberada**: só panes não-gated (a sua mão e operator-choice) recebem o link; workers e orquestradores seguem autenticando por `CLAUDE_CODE_OAUTH_TOKEN` injetado — o keychain inteiro num worker seria exposição sem ganho. Overlays de terceiro (GLM/LongCat) nunca recebem identidade nem keychain. Linux/Windows não mudam: lá o segredo já é o `~/.claude/.credentials.json` linkado no overlay.

## 0.76.47 — Swap não é pressão

- **Abrir pane não trava mais por swap (F-572)**: o teto de 1 GB de swap recusava **todo** pane novo até reiniciar o app depois do incidente de 16/09 — a recusa que o operador viu (`Swap em uso alto (8535 MB > 1024 MB)`) aparecia com a máquina saudável. No macOS `vm.swapusage` "used" guarda o **pico**, não o agora: medido na máquina do operador, 8.151 MB de swap com `kern.memorystatus_vm_pressure_level` = 1 (NORMAL) e 62 % de RAM disponível — e o mesmo Mac já chegou a 16 GB de swap. Cada máquina tem a sua medida, então não existe número universal.
- **Gate de swap vira config por máquina**: `maxSwapUsedMB` nasce em 0 (o swap não gera nem aviso de paginação); quem quiser o gate numa máquina específica arma com `NEXUS_PANE_MAX_SWAP_MB`, e a mensagem nomeia essa variável.
- **Reaper de emergência para de estacionar panes sem necessidade**: o guardian usava o mesmo `isUnderMemoryPressure`, então com swap acima de 1 GB estacionava um pane ocioso **por minuto, para sempre** — tratando um pico de swap parado como pressão viva. Agora ele só age com a memória disponível de fato baixa.
- **O sinal de memória passa a ser o do agora**: memória disponível do kernel no macOS (o mesmo sinal do jetsam), `available` no Linux e memória livre no Windows.

## 0.76.46 — Otimizar, não limitar (canal Windows)

- **Mesmo conteúdo da 0.76.45, agora no canal Windows x64**: a 0.76.45 saiu só para macOS; cada canal publica sua própria versão estável, então o Windows avança com o número seguinte recebendo o mesmo código assinado. Para quem vem da 0.76.41, a atualização também traz o conteúdo da 0.76.43 (pane guardian, sessão de CLI isolada por checkout, liderança única de missão).
- **Os itens entregues são os da seção 0.76.45 abaixo**: pane dormindo em vez de fechado, hub MCP compartilhado, teto de panes como aviso, custo por pane no cabeçalho, reaper de emergência e limites proporcionais à máquina (F-572/F-573).

## 0.76.45 — Otimizar, não limitar

- **Pane dormindo em vez de fechado (F-573)**: pane ocioso sem dono (helper aberto pela sua mão ou worker sem missão) tem o CLI encerrado após 30 min — ou na hora sob pressão de memória — mas FICA no layout com o scrollback e um botão "Acordar" que retoma a mesma conversa (`resume` exato por sessão, F-567). `requestPanePark` no main, `state: 'parked'` no snapshot, `ORCH_CHANNELS.paneParkRequest` para o renderer. Memória de pane dormindo: zero.
- **Teto de panes vira aviso; bloqueio só por pressão real (F-573)**: acima do teto proporcional à RAM (4–12: 16 GB → 6, 24 GB → 12) o spawn passa com aviso nomeando os ociosos. Bloqueia só com menos de 15 % da RAM disponível (`kern.memorystatus_level` no macOS) ou mais de 1 GB de swap. `NEXUS_PANE_CAP_HARD=1` restaura o bloqueio por contagem.
- **Reaper de emergência (F-573)**: sob pressão, um pane ocioso elegível por minuto, o mais parado primeiro, sem esperar o TTL; vetos intactos (orquestrador, worker de missão, pane aberto pelo humano, `expect` armado, `awaiting-input`).
- **Hub MCP compartilhado (F-573)**: os servidores stdio do seu `~/.claude.json` sobem uma vez no main e são expostos por HTTP (`/hub/<key>`, auth pelo token do pane) para os panes da sua mão; `hooks-gen` emite `{type:'http'}` em vez de copiar `command/args`. Fim dos 19 `npm exec` por pane. Flag `feature.mcp.sharedHub` (ligada); sem bridge, cai na herança antiga.
- **Custo por pane no cabeçalho (F-573)**: o host PTY mede o RSS da árvore de cada sessão a cada 30 s (`perf:paneFootprints`) e o `PaneToolbar` mostra "512 MB" no slot de largura fixa do F-568, com tom de aviso acima de 1,5 GB.
- **`nexus_pane_spawn { resume: "pane-X" }` retoma de verdade a conversa do pane antigo (F-573)**: o valor era descartado e o pane novo nascia sem contexto. Agora a sessão do provider do pane antigo é copiada para o pane novo antes do spawn e o `--resume` exato (F-567) a encontra — vale para pane dormindo e para pane já fechado. Pane `aider` (sem resume por id) é fechado em vez de estacionado.
- **Guardian sem ping-pong**: 5 min de carência depois de acordar antes de o reaper de emergência poder estacionar o mesmo pane; aviso no log quando a amostra de memória some por 3 varreduras (gate cego).

## 0.76.43 — Cada pane com a própria sessão

- **Pane guardian: nada mais fica aberto sem fazer nada (F-572)**: em 16/09 um orquestrador abriu 33 panes e fechou 6; ~25 workers sem missão ficaram parados após um handoff recusado, e 22 panes × ~1 GB (CLI + servidores MCP filhos) esgotaram a RAM de um Mac de 24 GB até o freeze. O auto-fechamento de pane ocioso existia desde 05/08 e **nunca tinha sido ligado**; agora liga no boot, cobre worker SEM missão e helper aberto pela mão do operador (nunca orquestrador, worker de missão, pane aberto pelo humano ou pane com contrato de entrega armado), e ganhou varredura do PTY a cada 60 s para CLIs sem hooks. TTL 30 min.
- **Teto e gate de memória no spawn de agente (F-572)**: `pty-manager.spawnAgentSession` (único ponto físico: "+ Pane", `nexus_pane_spawn`, Via Rápida, respawn, revival, main-owned) recusa o 13º pane de agente ou qualquer spawn com < 1024 MB disponíveis / > 2048 MB de swap, nomeando os panes ociosos a fechar. macOS usa `kern.memorystatus_level` (o sinal do jetsam), não o `free` cru. Env: `NEXUS_PANE_CAP`, `NEXUS_PANE_MIN_FREE_MB`, `NEXUS_PANE_MAX_SWAP_MB`, `NEXUS_PANE_GUARD=off`. Fail-open em defeito interno.
- **`nexus_perf_snapshot` enxerga os panes (F-572)**: o host PTY responde `footprint-probe` com o RSS da árvore de processos de cada sessão; o snapshot traz `panes.footprints`, `systemMemory` e `paneAdmission`. Antes só o Electron era medido — no incidente o app somava ~450 MB enquanto os panes esgotavam a máquina.
- **Worker e orquestrador não herdam mais o perfil MCP global (F-572)**: só a mão do operador (`role user`) herda os ~19 servidores MCP do `~/.claude.json`; agentes nascem só com o MCP do Nexus, como já era em modo `hardened`. Um pane Claude cai de ~1,1 GB para ~0,5 GB.
- **Liderança única: líder agindo pelo próprio token não é "unproven"; engine sem registry não vaza erro cru**: a suíte completa pegou 23 regressões das ondas 1/3 antes da release. O gate de líder passa a aceitar o próprio líder registrado quando o runtime ainda não o observou (pós-restart do host), negando só morte conhecida (token replayado de sessão `exited`); os leitores (pronto civil, conclusão de entrega, snapshot do motor) degradam à ligação durável da missão quando o engine está indisponível, em vez de lançar "project-scoped domain stores are not initialized". O gate de autoridade deixou de importar o leader-gate estaticamente (o leader-gate se registra no boot): esse edge fechava um ciclo ESM que deixava `BUILTIN_SQUADS`/`NEXUS_GUIDED_SKILLS` em TDZ.
- **Sessão de CLI isolada por checkout, fim do vazamento pra terminal externo (F-566/F-567)**: um painel de Grok/Kimi dentro do Nexus vazava a conversa para qualquer `grok -c`/`kimi -c` aberto fora do Nexus no mesmo diretório de trabalho, porque o histórico ficava dentro do `~/.grok`/`~/.kimi-code` real. A auditoria (F-567) cobriu os 13 adapters builtin: família Claude (claude, glm, glm-flash, longcat, deepseek) ganhou HOME privado por pane; Codex, OpenCode, AGY e Devin pararam de resolver "sessão mais recente" e passaram a guardar estado por checkout; os TUI restantes (droid, cursor, copilot, amp, goose, pi, prime-agent, hermes, command-code) ganharam o gancho equivalente em `pty-manager.ts`. Toda conversa durável mora em `<userData>/provider-state/<adapter>/<checkoutId>/…`; resume só acontece por id explícito.
- **Handoff sem missão funciona de ponta a ponta (F-565)**: `nexus_handoff_submit` de um painel-filho do operador sem missão ativa deixa de ser recusado — `resolveWorkspaceHandoffParent` persiste o handoff com `mission_id` nulo e entrega no painel pai por `pane_write`.
- **Cabeçalho do painel parou de tremer (F-568)**: `normalizePaneTitle` separa título de indicador de atividade (spinner), o terminal-host deduplica e limita a frequência de atualização, e o indicador ganhou slot de largura fixa no `PaneToolbar`.
- **Motor de liderança única de missão em produção, fundação (F-562)**: `MissionLeadership` (origem spawn/adopt/respawn/promote/create, `takeover` explícito só na UI do operador) religado em três ondas — leitores sem efeito (`resolveMissionLeader`), espelho do renderer (`leadership-reflect.ts`) e gates de efeito (`requireMissionLeaderSession`). Promover por cima de um líder vivo continua recusado por padrão.
- **Fan-out de escritores paralelos, cerca endurecida antes de usar (F-563)**: `isolatedWriter` ganha worktree própria; git limitado a add/commit/status/diff/log na worktree/branch do registro do Main (push/stash/reset/HEAD destacado/repo aninhado recusados); `nexus_terminal_run` desses writers não abre shell, só traduz argv Git literal; write/close entre workers exige a mesma `executionScope.rootRealPath`.
- **Grant de sandbox governado só cobre o material de auth (F-569)**: sessão governada de Grok/Kimi não recebe mais leitura+escrita no home do provider inteiro — só os caminhos reais que o overlay linka (`auth.json`/`.lock` no Grok; `credentials/`/`oauth/` no Kimi).
- **Provider-state do checkout some quando o workspace some (F-570)**: `<userData>/provider-state/<adapter>/<checkoutId>` é purgado no evento de remoção do workspace, para todos os adapters.
- **Spawn paralelo não revoga mais o refresh token do Codex (ciclo 5)**: `managed-auth-spawn-gate.ts` serializa o refresh entre painéis da mesma conta gerenciada (líder assume, seguidores esperam a reescrita com lock e teto de 12s) em vez de deixar N painéis rotacionarem o mesmo `auth.json` ao mesmo tempo.
- **Grok não roda mais `grok models` (ciclo 5)**: esse binário rotaciona o refresh token a cada chamada; descoberta de modelos passa a ler `~/.grok/models_cache.json` + catálogo bundled, e a cota usa o JWT já presente em `auth.json` direto contra o endpoint de billing.
- **Devin sobe pelo PTY (ciclo 5)**: spawn deixa de reportar "did not start after prompt delivery" no caminho read-only.
- **Limpador de hooks legados cobre HOMEs de CLI e todo workspace registrado**: varredura de sobras do Overclock (`~/.overclock-app`) alcança também `~/.codex`, `~/.grok`, `~/.kimi-code`, e roda por workspace registrado, não só pelo cwd do app.
- **Contrato da liderança fechado antes de religar**: `MissionLeadershipError` com códigos tipados (`split_brain`, `existing_session`, `target_not_live`, `write_incomplete`, `scope_mismatch`, `busy`, `mission_missing`); sessão `exited` não trava mais a resolução; origens `create`/`release` completam o vocabulário.
- **Publicação `--macos` pelo caminho oficial (F-564)**: `npm run release:publish -- --macos` consome só a candidata local aprovada pelo gate, sem build nem espera por candidato Windows.
- **Gate de release não trava mais com app preso em exit do kernel**: smoke copia o app via `ditto`, desmonta a imagem antes do smoke, e trata processo em `STAT` de saída do kernel (E/Z) como encerrado, com teto de 60s.

## 0.76.42 — Orquestrador num clique, cofre sem modal

- **"Tornar orquestrador" num painel solto volta a ser um clique**: sem missão ativa, o painel vira coordenador na hora, como antes do F-527, sem abrir o assistente de Novo pedido. A sessão do operador já tem todos os poderes sem missão; a coroa é só o papel na tela. Quem quer uma missão a partir do painel usa "Nova missão deste painel", que marca o painel para adoção — a marca automática saiu do caminho sem missão para a próxima missão nunca adotar um painel velho.
- **O cofre não insiste com o Keychain**: `encryptSecret` sonda `isEncryptionAvailable()` antes de cifrar; se o macOS recusar, o resultado é nosso (`OS secure storage is unavailable; secret was not persisted.`) em vez de repetir `encryptString` até o sistema abrir "Chaves Não Encontradas" — o modal cujo botão azul apaga o keychain inteiro. A cifra saiu do lock exclusivo do cofre e `getSecret` não tenta decifrar quando o backend já recusou.
- **O read-back de contas não força reescrita**: quando o decrypt falha com a chave presente no índice, o sync da credencial mantém o snapshot e tenta de novo na próxima leitura, em vez de disparar `SecItemAdd` no pior momento. Era o caller mais frequente do cofre.
- **`nexus_pane_spawn` nunca mais reporta falha de um painel que nasceu**: quando o CLI demora mais que o teto do MCP para ficar pronto, a resposta é um ACK pendente com o `paneId` (`pending: true`); a prontidão é do `nexus_pane_wait_idle`. Acabou o segundo worker nascido de um retry sobre um pane vivo. `allowPending` é opt-in interno: reviewers, Via Rápida e recuperação continuam exigindo sessão concreta.
- **Recusa do handoff sem missão sugere só o que aquele painel alcança**: a dica de "mission effect blocked" é recalculada pela allowlist do painel — um pane somente-leitura ouve `nexus_pane_ask`, não ferramentas que o próprio gate barra. A cerca de autoridade não mudou.
- **Quit não espera backend de cron pendurado**: `stopCronLoop`, primeiro passo do encerramento, ganhou teto de 3 s; o tick em voo segue em background e o diário reconcilia na sessão seguinte. Fim do "quit excedeu o teto de 45000ms".
- **"Entrar novamente" no painel de cotas é um botão de verdade**: quando a conta pede novo login, o selo abre o terminal de login da conta pela mesma rota do gerenciador de contas. Antes era um texto inerte na posição de botão.
- **Limpador de hooks legados cobre três alvos e caminho morto**: sobras do Overclock em `~/.claude/settings.json`, `<workspace>/.codex/hooks.json` e `<workspace>/.agents/hooks.json` apontando para `~/.overclock-app` são removidas no boot quando o executável não existe no disco. Fim do "Hook failed — exited with code 127" a cada tool e do modal "1 hook needs review" do Codex.

## 0.76.41 — Panes Windows sem eco e sem limite

- **Codex abre de fato no Windows (F-206)**: o Nexus reconhece o launcher npm padrão `codex.cmd`, valida o `node.exe` e o `codex.js` adjacentes e inicia o Node diretamente. Isso elimina o erro `Linha de comando muito longa` causado pelos argumentos de hook atravessando o limite do `cmd.exe`.
- **CLIs instaladas voltam ao terminal (F-205)**: `Path` e `PATH` são a mesma variável para a allowlist do Windows; o shell volta a encontrar CLIs globais como Claude, Codex e outras instaladas pelo npm, sem ampliar o ambiente permitido.
- **Uma tecla, uma escrita (F-353)**: recuperar um pane que encerrou limpa o listener antigo antes de criar o shell novo, eliminando a duplicação de caracteres como `CCCOEE`.
- **Caminho isolado por SO**: o desvio de launcher e a normalização de ambiente só executam em Windows; macOS/Linux continuam usando seus caminhos nativos e os planos sandbox não são alterados.

## 0.76.40 — Cada pedido no seu espaço, marca Nexus no Windows

- **Os painéis do "Novo pedido" ganham espaço próprio (F-560)**: cada painel pertence a exatamente um escopo — missão, espaço do operador ou soltos — e os Terminais passam a ter abas, com contagem. Detalhe completo na 0.76.39 abaixo, que nunca chegou a ser publicada.
- **A missão adota o painel vivo (F-561)**: "Tornar orquestrador" deixa de ser beco sem saída; a missão nova assume o painel em que você já trabalhava, sem abrir terminal novo nem encerrar o seu.
- **Filtro de escopo que cobre tudo volta a ser no-op**: um `Set` com todos os panes fazia o grid reconstruir a árvore com ids novos a cada atualização de missão, remontando o mosaico e matando a sessão de PTY por baixo. O gate de release pegou isso no app empacotado.

- **Ícone Nexus em toda a experiência Windows (F-548)**: o mesmo cristal Nexus multi-resolução agora acompanha o executável, o instalador, a janela e o atalho Squirrel. A janela declara o AppUserModelID do produto antes de abrir, evitando o tile genérico do Windows após instalar ou atualizar.
- **Pacote de teste não finge instalação quebrada (F-549)**: a validação empacotada continua sem rede por segurança e não mostra mais o aviso falso de `Update.exe` ausente. Uma instalação Squirrel real com arquivos faltando continua sendo diagnosticada corretamente.
- **Smoke por plataforma é validável no Windows (F-550)**: a suíte do pacote não pressupõe caminhos POSIX nem o comando `ps` ao simular macOS/Linux; a garantia estrutural continua separada para cada SO.

## 0.76.39 — Cada pedido no seu espaço

- **Abas nos Terminais (F-560)**: cada painel pertence a exatamente um escopo — missão, espaço do operador ou soltos — e a vista desenha um escopo de cada vez, com a contagem de painéis em cada aba. `visiblePaneIds` nunca mais desliga o filtro inteiro: escopo inexistente devolve vazio, não a árvore toda. "Todos" continua disponível. `PaneModel` ganhou `spaceId`/`spaceTitle`, declarados em `paneModelSchema` para sobreviverem ao restart.
- **"Novo pedido → Montar meus terminais" abre um espaço separado (F-560)**: o assistente mina um espaço, carimba os painéis criados e foca esse escopo antes de navegar. Antes os painéis nasciam sem dono nenhum e a vista global — que desligava o filtro quando não havia missão elegível — desenhava tudo junto com a missão que já estava aberta. Dividir um painel mantém o irmão no mesmo espaço; o "+ Pane" aberto dentro de um espaço entra nele.
- **O painel focado está sempre na tela (F-560)**: são 35 caminhos que levam aos Terminais depois de criar ou escolher um painel — login de CLI, instalação de ferramenta, voz, ⌘K, caixa de atenção. Em vez de cada um lembrar de trocar a aba, a regra mora num lugar só: quando o painel focado muda e está em outro escopo, a aba acompanha. Clicar numa aba não é desfeito pelo foco antigo.
- **Pins por escopo (F-560)**: os painéis fixados pelo operador deixaram de vazar entre escopos — os pins da missão A já entravam no conjunto visível da missão B no mesmo render.
- **A missão adota o painel vivo (F-561)**: `mission.start` aceita `adoptOrchestratorPaneId`. Uma reserva de um uso só (TTL 2 min) liga a camada IPC, que concede autoridade de missão, à Via Rápida, que manda na sequência de arranque. A adoção acontece depois da transição para `running/executing`, prova no store que a missão aponta para aquela sessão, cola o briefing no painel que já roda e grava o recibo de kickoff. Nenhum painel é morto — o oposto do respawn, que termina fisicamente o orquestrador registrado antes de subir o seu.
- **Adoção é fail-safe numa direção só (F-561)**: sessão morta, CLI que não sabe coordenar, reserva vencida ou autoridade recusada caem no arranque normal. A missão sempre arranca, e a recusa vira aviso nomeado, nunca silêncio. Depois da concessão a adoção é irreversível: falha de briefing vira bloqueio técnico com a causa, nunca um segundo Maestro.
- **O layout sabe que o painel foi adotado (F-561)**: o main adota depois que `mission.start` responde, então o renderer pergunta quem é o orquestrador até o main confirmar. O main é autoridade, o layout é espelho — sem confirmação, nenhuma estrela de coordenador aparece.
- **Fim do orquestrador órfão (F-561)**: a promoção passou a honrar a recusa do processo principal. Antes a estrela aparecia na tela mesmo quando o motor não reconhecia líder nenhum. Vínculo morto ou missão inexistente também deixaram de virar destino silencioso.


- **Comandos de voz continuam funcionais durante a hidratação**: se a lista transitória de vínculos de missão ainda estiver chegando do runtime, um shell ou agente comum abre normalmente na grade global; o Jarvis não interrompe o comando com erro de estado parcial.
- **Isolamento de missão preservado**: quando o vínculo existe, rail, atalhos, paleta e Jarvis continuam abrindo exclusivamente os terminais da missão dona do pane.

## 0.76.38 — Terminais Windows com launchers nativos

- **Panes de IA no Windows**: a resolução de executáveis agora ignora scripts POSIX sem extensão instalados ao lado de CLIs npm e seleciona o launcher nativo `.cmd`, `.bat`, `.exe` ou `.com` compatível com ConPTY. Isso impede que a abertura de um pane de Codex/Claude/Kimi/Grok derrube o host de PTY com `code -1`.
- **Recuperação de configuração salva**: um caminho antigo que aponte para o shim inválido é descartado no momento do spawn e resolvido novamente, sem exigir que a pessoa usuária reinstale ou refaça login na CLI.
- **Missões isoladas ao navegar**: focar um agente pelo rail, paleta, atalho ou Jarvis respeita também o vínculo transitório do runtime e abre somente os terminais da missão correspondente, sem misturar panes de outra missão na mesma grade.

## 0.76.37 — Contrato de entrega, hooks vivos e conector por instância

- **Contrato de entrega no spawn (`expect.schema`)**: `nexus_pane_spawn` aceita `expect: {schema, retries?}`. Num `nexus_handoff_submit` com status success, os `artifacts` do worker são validados contra o JSON Schema declarado (validador próprio em `src/shared/json-schema-lite.ts`, sem dependência empacotada). Divergência devolve ao worker exatamente o que falta, até `retries` vezes (padrão 1); esgotadas as devoluções, o handoff entra como `blocked` com as violações em `artifacts`. Schema inválido falha no spawn, visível para quem declarou.
- **Régua do summary (280/400) e receipt de harness**: summary acima de 400 caracteres é condensado na última fronteira de frase entre 280 e 400 e a íntegra vai para o artifact `overclock.fullText`; o Maestro lê a conclusão, não o relatório. A resposta do spawn traz `harness {adapterId, model, effort, source}` para o chamador saber o que foi decidido.
- **Hooks de worker vivos de verdade (F-536/F-555)**: o script de hook gerado é `.mjs` e usava `require()`, então o relato do Stop nunca chegava ao gate. Agora é ESM, escreve `{"continue":true}` no stdout do Stop (o runner do Codex marcava o hook como FAILED sem JSON), relança o neto com `windowsHide` e tenta a porta publicada em `~/.nexus/arms-runtime.json` quando `NEXUS_GATE_URL` aponta para porta morta. `pretool` segue fail-closed.
- **Conector Arms por instância (`--descriptor`)**: com prod e dev abertos os dois escreviam o mesmo `~/.nexus/arms-runtime.json` e o cliente externo falava com a instância errada. Dev passa a escrever `arms-runtime.dev.json`; o descritor leva `instance` e `descriptorPath`; o snippet de Configurações › Conectores passa `--descriptor <caminho>` e o conector aceita `--descriptor` > `NEXUS_ARMS_DESCRIPTOR` > padrão.
- **Recusas de tool que instruem o agente**: allowlist/papel, autoridade read-only e perfil de reviewer interno carregam um `hint` (não tentar de novo, não reportar como bloqueio, entregar com o que tem e declarar no handoff). O campo `error` segue idêntico.
- **Dívidas de evidência da 0.76.35 pagas**: `ensureDefaultInstalledPets` e a visibilidade de panes soltos na vista global ganharam testes reais; o manifesto do mascote Nivu deixa de levar texto pessoal; os cards F-545/F-546 citam só evidência existente.
- **Aviso de CLI ausente endurecido**: o texto do catálogo (`label`, `installCommand`) é citado com aspas simples POSIX antes de ir ao terminal, então nada dele é interpretado pelo shell.
- **Smoke empacotado mais honesto e mais tolerante**: as sondas de ditado passam a reportar um motivo fechado de falha (`discriminator`, `write-refused-exited`, `echo-timeout-alive`…) em vez de só o nome da sonda, e a espera pelo eco de um shell real subiu de 5 s para 15 s com prazo próprio de 20 s, porque num Mac carregado o gate reprovava artefato bom.
- **gpt-5.5 sai do catálogo; o GPT leve é o gpt-5.6-luna**: o modelo deixa de existir e foi removido de codex/aider, do catálogo, do picker de sessão e dos specs de commit-message (default → `gpt-5.6-luna`). Squads, rotas e migrações salvas com `gpt-5.5` são redirecionados para `gpt-5.6-luna` em vez de falhar no spawn; o pricing mantém a linha só como custo histórico.
- **Publicação Windows com waiver nomeado**: o publicador exigia uma prova de upgrade instalado N→N+1 que o coletor Windows ainda não produz (`installedUpgradeVerified=false` fixo), o que recusava toda release. `NEXUS_WINDOWS_UPGRADE_PROOF_WAIVER` aceita só o caso "prova não produzida", nunca prova reprovada ou desvinculada, e grava `windows-upgrade-proof-waiver.json` na release canônica. `scripts/windows-upgrade-proof-manual.ps1` faz a prova manual na máquina Windows do operador.
- **Docs**: destilação do Overclock 1.3.23 (delta vs 1.3.18, matriz do harness e hooks remontados) em `docs/analysis/overclock-1323-*`.

## 0.76.36 — Paridade multiplataforma e release Windows determinística

- **Fixtures por sistema operacional**: testes de MCP/Cline agora resolvem os caminhos nativos de Cursor/VS Code em macOS, Linux e Windows, sem carregar dependências macOS-only em runners Linux/Windows.
- **CLI Devin no Windows**: a expectativa de instalação passa a refletir o canal oficial PowerShell, mantendo bash apenas em macOS/Linux.
- **Anexos selados contra substituição same-inode**: snapshots guardam `ctimeNs`/`mtimeNs` para impedir que um arquivo recriado ocupe o mesmo inode e seja liberado como se fosse o original.
- **PTY daemon resiliente**: resets assíncronos de probes são absorvidos sem `ECONNRESET` não tratado.

## 0.76.35 — Desktop Pet fluido e integrado, recuperação fail-safe de panes e distribuição universal

- **Desktop Pet Fluido e Livre (F-545)**: Substituído o travamento rígido em bordas e presets de 64px por posicionamento contínuo e suave (`clampPetDragFreeDesktop`) em qualquer coordenada dos monitores. O pet agora transita livremente por toda a tela, respeitando apenas o overhang de segurança.
- **Utilidade de Sistema e Integração com Goal Governor (F-545)**: O pet agora reage em tempo real às ondas e metas operacionais (`goal-wave-started`, `goal-wave-completed`, `goal-gate-passed`, `goal-finished`), com balões acionáveis que navegam diretamente para o terminal (`open-terminal`) e para o painel de operações, além de suporte nativo a `prefers-reduced-motion`.
- **Distribuição Universal de Mascotes (F-545)**: Os mascotes "Codex Companion" e "Nivu" agora vêm embarcados no pacote (`resources/pets/sheets/`) e são provisionados com segurança em qualquer Mac (`ensureDefaultInstalledPets`), sem sobrescrever customizações existentes nem reviver mascotes excluídos.
- **Recuperação Fail-Safe de Panes ao Reiniciar (F-546)**: Eliminação de deadlocks no fechamento de panes após reinício mid-mission ou queda da sessão subjacente. Sessões zumbis são liberadas de forma graciosa sem bloquear a interface.
- **Modo Palco / Foco Restaurado (F-546)**: Ação do Modo Palco restaurada como botão de destaque primário na barra de ferramentas de cada pane.
- **Alinhamento de Modais e Cards (F-546)**: Diálogos e modais agora utilizam `position: fixed; inset: 0;` para que fiquem perfeitamente centralizados e alinhados na viewport, independentemente do container pai.
- **Botão "Abrir panes de IAs" Operacional (F-546)**: Panes de IA iniciados a partir da criação de nova missão agora se tornam imediatamente visíveis e prontos para interação.

## 0.76.34 — Goal Governor autônomo e motor de ondas para panes do grid

- **Goal Governor & Autonomous Wave Engine (F-544)**: Motor supervisor no processo principal do Electron (reconciliador adaptativo de 3s) que conduz a execução de ondas sequenciais (ex: Onda 4 -> Onda 5 -> Onda 6) em panes soltos no grid de terminais. Elimina paradas do orquestrador após o primeiro turno, monitora encerramento e entregas dos workers, avalia gates automáticos (`npm test`, `npm run typecheck`, arquivos e comandos customizados) e injeta os comandos e tarefas da onda seguinte diretamente via PTY nudge (`orchWriteSession`).
- **Prevenção de suspensão noturna (Anti-Sleep)**: Bloqueio automático de suspensão do sistema operacional via `powerSaveBlocker` e asserções de plataforma (`MacosSystemSleepAssertion` e `LinuxLidSleepAssertion`) enquanto houver metas e ondas ativas, garantindo execução contínua durante a madrugada.
- **Supervisão e controle MCP (`nexus_*`)**: Ferramentas expostas para orquestradores (Codex Astra, Claude Code, Antigravity, Devin, Kimi, OpenCode): `nexus_goal_register`, `nexus_goal_status`, `nexus_goal_bind_pane`, `nexus_wave_advance`, `nexus_goal_control` e `nexus_goal_task_update`.
- **Circuit Breaker protetor contra queima de tokens**: Pausa automática com alerta acionável ao operador após 3 falhas consecutivas de gate, prevenindo loops infinitos em caso de erros não resolvidos.
- **Skill dedicada do Goal Governor**: Adicionada `.devin/skills/nexus-goal-governor/SKILL.md` com guia completo de uso e exemplos práticos para orquestradores e pilotos.

## 0.76.33 — Releases separadas por SO e CLIs Windows nativas

- **Instaladores por plataforma**: Antigravity e Devin usam os instaladores oficiais PowerShell no Windows; os scripts bash continuam restritos a macOS/Linux. Aider usa `uv` sem shell POSIX e Muse informa honestamente quando não há instalador Windows nativo.
- **Matriz de release explícita**: Squirrel/Setup somente em `win32`, DMG/ZIP somente em `darwin` e DEB/RPM somente em `linux`, evitando artefatos cruzados.
- **Overlay alinhado**: o modal de atualização volta a resolver `position: fixed` contra a viewport, sem ficar preso no canto esquerdo.

## 0.76.32 — Windows: terminal visível e diagnóstico Jarvis seguro

- **Terminais sem projeto**: clicar em “Terminais” antes de escolher uma pasta agora mostra uma ação clara para abrir o workspace, em vez de uma tela preta.
- **Jarvis nas configurações**: o teste manual funciona antes do primeiro projeto, usando uma rota diagnóstica sem memória, escopo ou ações; a rota normal continua protegida por workspace.
- **Multi-pane**: preservado o modo adaptativo com fila/backpressure, leases WebGL e hibernação de panes ocultos; benchmark Windows de 4/8/10 panes validado.

## 0.76.31 — Eliminação de falsas exaustões (Codex), Nexus Mobile 100% testado e contratos compartilhados

- **Refutação viva e eliminação de falsas exaustões de cota no Codex (F-539)**: contas com uso saudável (como 72% de uso semanal com 28% livre) não entram mais em quarentena de 12 horas nem exibem toasts falsos de cota esgotada. Hardening de expressões regulares de `limit_reached` para nunca casar com valores de negação (`false`, `null`, `0`), expansão da refutação viva para sinais do observer e resolução segura de tokens do Codex via `~/.codex/auth.json`.
- **Nexus Mobile Companion completo com 100% de testes verdes (F-540)**: monorepo atualizado com todos os contratos transitivos sob `src/shared/`, suporte a streaming de terminal e screencast do navegador móvel em `src/main/runtime/`, ícones offline em `src/shared/agent-icons/` e 581 suítes de teste passando integralmente (5.026 testes no app móvel).
- **Ajustes de limites do LSP sidecar e mocks de teste (F-541)**: teto de arquivos de projeto do LSP sidecar elevado para 4.000 para acomodar o crescimento de tipos do monorepo, mock de `getAgentSessionInfo` adicionado e asserções de contratos visuais alinhadas com o piso de 240px.

## 0.76.30 — Palco estável, orquestração afinada (GLM/Devin/Kimi/AGY), Nexus Mobile v1.4.201 e Windows operacional

- **Palco estável sem tremor e cabeçalho único (F-535, F-536)**: o modo Foco/Palco (Stage Focus) agora mantém o painel principal travado em `stagePaneId`, impedindo que cliques ou digitação em terminais da coluna lateral invertam posições e disparem redimensionamentos descontrolados com tremor violento na tela. O cabeçalho duplicado nos cards de companion foi removido, unificando a barra de ferramentas com botão explícito de promoção para o Palco e aceleração por GPU dedicada (`translateZ(0)`) eliminando z-fighting com o WebGL do xterm no macOS.
- **Orquestração confiável de LLMs e entrega de prompt (F-537)**: GLM passa a receber `--permission-mode acceptEdits` e detecção abrangente de confiança de diretório no boot, eliminando travamento no spawn. Devin recebe prompt posicional via `-- <prompt>` de acordo com a CLI oficial, garantindo absorção imediata. Kimi e Antigravity (AGY) têm bracketed paste desativado (incompatível com Ink TUI) e o envio de prompts não apaga mais o texto com `Ctrl+U` após submissão do Enter.
- **Nexus Mobile Companion completo herdado do Orca v1.4.201 (F-538)**: aplicativo móvel moderno (Expo 55 / React Native 0.83) com suporte a streaming de terminal em tempo real, pareamento remoto via QR Code, monitoramento contínuo de tarefas em segundo plano e supervisão de agentes da frota.
- **Instalação de CLIs no Windows**: npm e demais shims `.cmd` agora são resolvidos por caminho absoluto e executados pelo interpretador nativo, eliminando `spawn npm ENOENT/EINVAL` no app empacotado.
- **Paridade de descoberta e diálogos no Windows**: sondagem de modelos e Kimi usam o mesmo caminho absoluto e PATH efetivo da frota Windows. O seletor nativo de pasta confiável é associado à janela principal do NexusIDE, evitando abrir atrás do app. Assets de skills têm ordenação determinística.

## 0.76.29 — Multi-conta de cotas limpa, resolução de segredos e sidebar polida sem cortes

- **Multi-conta de cotas limpa sem duplicações (F-532)**: elimina duplicação de cards de cota ("Conexão atual" vs "Conta salva no Nexus" com mesma porcentagem) quando uma conta salva no cofre cobre o login nativo. Descriptografa segredos sob demanda em `provider-usage-auth` para sondar contas secundárias do cofre em tempo real e renova tokens OAuth Claude expirados automaticamente via `refreshClaudeOauthBlob`.
- **Barra lateral ampla e cockpit de cotas para até 4 contas (F-533)**: largura mínima elevada para 240px e padrão para 280px, adicionando margem de respiro contra a borda divisória nos elementos alinhados à direita (`[⌘K]`, `+`, `[🟢 Local]`). O cockpit agora comporta até 4 contas e formata janelas de tempo de maneira compacta (`Sem 29% · 6d9h`) para eliminar quebras de linha e cortes por reticências.

## 0.76.28 — Instalador Windows Nexus e atualização resiliente

- **Branding do instalador Windows**: Setup e pacote interno usam o ícone Nexus e uma tela de carregamento da marca; o artefato instalado mantém a identidade visual no Windows.
- **Updater sem falso erro em feed vazio**: mirror sem artefato Windows (404/Not Found) passa a ser tratado como “nenhuma atualização”, sem exibir erro de rede ao usuário.
- **Paridade da sidebar**: a largura ajustável até 480px, o badge `ATUAL` preservado e os rótulos longos com reticências seguem incluídos nesta release.

## 0.76.27 — Trust direto GLM/Kimi, Enter garantido, sidebar sem cortes e motor inteligente

- **Trust de workspace direto sem telas de confirmação (F-520)**: panes de GLM, Kimi e Claude entram diretamente no workspace sem travar na tela "Yes, I trust this folder" ou "Quick safety check". O Nexus pre-seeda o aceite no `.claude.json` e nas pastas governadas do Kimi (`workspace-trust` e `workspaces.json`), passando caminhos canônicos com realpath.
- **Enter garantido após injeção de prompt no pane (F-521)**: prompts longos colados no terminal de workers não ficam mais parados aguardando confirmação manual. A detecção de turn start ignora o eco da colagem (`postSubmitBusy`), e o envio do Enter reenvia se o TUI engolir o primeiro caractere durante a transição. CLIs com suporte a prompt posicional (como Codex) recebem o prompt inicial diretamente nos argumentos de inicialização.
- **Sidebar ampla e sem cortes de conteúdo (F-530)**: largura máxima da sidebar expandida para 480px (padrão 260px). O badge "ATUAL" não encolhe para "ATU" (`flex-shrink: 0`, `white-space: nowrap`), o atalho [⌘K] mantém espaçamento limpo e títulos de workspaces longos truncam com reticências.
- **Orquestrador inteligente com reuso de squad salvo (F-531)**: o orquestrador respeita os modelos escolhidos no squad pelo usuário em vez de forçar o fallback para `gpt-5.5`. A ferramenta `nexus_route_task` agora está liberada para qualquer modo e a doutrina proíbe o orquestrador de executar missões complexas sozinho sem autorização, delegando tarefas aos CLIs especializados da frota.

## 0.76.26 — O pane GLM abre de verdade: trust respondido nas duas bordas

- **Pane da família Claude não fica mais "Aguardando" no trust (F-529)**: abrir um pane GLM deixava o terminal parado para sempre no "Yes, I trust this folder" (relato ao vivo: pane 1, glm-5.3, status Aguardando). Duas causas no `CliPromptAutoResponder`: (1) a janela de observação de 20s era contada do SPAWN, e o cold start do GLM/Z.ai — binário node pesado nascendo num home isolado sem trust por projeto salvo — pinta o diálogo depois disso, com o watch já desistido em silêncio; (2) a resposta era digitada UMA vez e o estado encerrado na hora — a tecla perdida na race do desenho do diálogo nunca era reenviada, e o caminho com fallback (`forceAccept`) só existia quando havia brief de missão para injetar, nunca no pane aberto pelo operador.
- **Diálogo de trust com janela própria (F-529)**: as assinaturas de confiança (claude-workspace-trust, quick-safety-check 2.1.220/2.1.267, agy, grok, kimi) ganham `watchMs` de 60s; menus de boot rápidos (bypass-ack) seguem no default de 20s — a sessão longa continua sem pagar stripAnsi para sempre, e o trust de cold start deixa de nascer morto.
- **Resposta com prova de aceite (F-529)**: todo envio do autoresponder agora arma uma verificação — um TUI que aceitou a tecla SEMPRE repinta a tela, então silêncio completo de 1,8s é a prova de que a tecla se perdeu: reenvia a mesma tecla (idempotente e segura — nunca um chute), a última tentativa usa o fallback numérico quando a assinatura tem um (`2\r`), o repaint comprovando o aceite encerra o estado na hora, e esgotadas as tentativas o diálogo é devolvido ao operador com log claro. O tap de PTY continua entregando chunks durante a verificação (`isVerifying`) — sem isso a prova do aceite nunca chegaria e os reenvios disparariam às cegas. Injeção de missão segue adiada enquanto há resposta aguardando prova.
- **Vale para toda a frota com diálogo de confiança**: claude, glm, glm-flash, longcat, agy, grok e kimi — pane do operador e pane de missão, mesmo caminho.

## 0.76.25 — Missões separadas por pane, mídia do WhatsApp de verdade e limpeza sempre à mão

- **Missão por pane, separada por construção (F-527)**: "Tornar Orquestrador" num pane sem vínculo nunca mais anexa silenciosamente à "missão padrão" (`find(running|blocked) ?? missions[0]` — o mecanismo exato da bagunça). Com missões ativas, um diálogo da casa pergunta qual missão o painel lidera, com a opção "Nova missão deste painel" que abre o Caminho Expresso; sem missões, oferece abrir a primeira. Vínculo direto (pane, missão aberta ou binding) continua promovendo direto. Os três pontos de entrada (toolbar do pane, menu de contexto, paleta ⌘K) compartilham a mesma resolução (`pane-mission-promote`).
- **Promoção não contamina mais missões vizinhas (F-527)**: `promoteMissionPaneRole` só rebaixa o orquestrador anterior DA MISSÃO promovida — panes sem vínculo (shells do operador, panes soltos de outro fluxo) e panes de outras missões ficam intocados. Antes, promover um pane reescrevia role/missão de tudo que não estivesse vinculado a outra missão.
- **Vista Terminais com foco por missão (F-527)**: com duas ou mais missões vivas na mesma árvore de panes, a vista Terminais abre focada numa missão e mostra chips para trocar de missão ou ver "Todas as missões" — o grid global deixava panes de missões diferentes misturados sem separação alguma. Com uma missão só, nada muda.
- **Nova missão em 1 clique com outra rolando (F-527)**: botão "+ Nova missão" direto no quadro da missão (MissionBoard), ao lado de Terminais — antes era sair da superfície e achar o rail. O Caminho Expresso segue sendo uma tela (objetivo + iniciar).
- **Imagem do WhatsApp pelo caminho real do Electron (F-526)**: o relato da 0.76.24 ("nada foi solto no terminal") era a promessa de arquivo não materializada — o WhatsApp entrega mídia pelo flavor `DownloadURL` do Chromium (mime:nome:url) ou como caminho absoluto em `text/plain`. O `resolveDropUris` agora entende os dois (além de uri-list, HTML com data:URI e File real), o dragover aceita o flavor, e o aviso de "nada solto" lista os tipos recebidos para nunca mais ser um mistério.
- **Limpar panes/missões sempre à mão (F-528)**: "Fechar todos os panes" e "Apagar todas as missões" estavam escondidas atrás de um disclosure recolhido no rodapé do rail — voltaram como linha compacta permanente ("✕ Panes"/"✕ Missões"), com a confirmação completa (contagem + consequências) antes de agir.
- **Rail sem cortes em largura ajustável (F-528)**: o atalho ⌘K da busca ganha `flex-shrink: 0` (cortava seco como o "54%" das cotas), e o título do CTA "Novo pedido" e o placeholder da busca ganham ellipsis. Anti-pattern de `transition: max-height` no brief da revisão substituído por `grid-template-rows` (audit de UI limpo: zero achados em todos os arquivos tocados).

## 0.76.24 — Cotas com a verdade do provider, ditado resiliente, workers distribuídos e mídia sempre aceita

- **Cooldown nunca mais fabrica 100% na análise de cotas (F-522)**: a barra do cockpit e os contadores da frota passam a vir SOMENTE da telemetria real do serviço — um cooldown/limit-hit não pinta mais "100%" falso por cima de uma leitura fresca (o caso real: conta Codex em pausa com `Semanal 54%` exibindo barra vermelha 100%). Conta pausada mostra o percentual real com selo "pausa" e barra hachurada; a quarantena continua valendo onde é decisão (ranking de contas, failover e aviso de spawn), agora separada da exibição (`entryDisplayWorstRatio` vs. `entryWorstRatio`).
- **Cooldown fantasma destravado por leitura fresca (F-522)**: `providerApiRefutesCooldown` passa a refutar cooldowns persistidos quando TODA janela conhecida está abaixo do limiar de uso elevado (0.8) em leitura com menos de 10 min — antes o gate era 0.5 e mantinha contas comprovadamente com folga travadas por horas. Cooldown com `cooldownUntil` vencido nunca mais é reportado como ativo (defesa no próprio quota-service, independente do account-store).
- **GLM/Z.ai confia nas contagens exatas (F-522)**: quando o endpoint `/api/monitor/usage/quota/limit` devolve `usage` + `currentValue`/`remaining`, o percentual vem das contagens; o campo `percentage` (arredondado, por vezes defasado) vira só fallback — mesma prática documentada pela comunidade (CodexBar/zai.md).
- **Cota viva em sessões longas (F-522)**: reconsulta silenciosa a cada 5 min no renderer (sem piscar "Consultando…" e sem derrubar o snapshot em erro) e countdowns de renovação recalculados a cada minuto a partir de `resetsAt` — o "5d" não fica mais congelado no instante do fetch, no cockpit e no painel Uso e cotas.
- **Pane pinado não mostra mais a cota de outra conta (F-522)**: `entryForAccount` só devolve a entry exata da conta pinada (ou a linha nativa quando o pane não é pinado) — o tooltip do CostBadge não mistura mais credenciais diferentes.
- **Rail sem cortes (F-523)**: percentuais de cota nunca mais truncados ("54" corte seco de "54%"), e-mail da conta com ellipsis de verdade, "Ver" e o indicador "Local" cabem inteiros no rodapé, label de Configurações encolhe com ellipsis em rail estreito e a barra de cota anima com `transform` na GPU em vez de `width` (anti-pattern de layout apontado pelo audit de UI).
- **Ditado resiliente com Gemini e transparência total (F-524)**: o STT do Gemini ganha rota universal — o Interactions API (preview) continua como etapa literal de alta acurácia, mas chave sem acesso ao preview (403/404), interação incompleta ou modo inglês agora caem para `generateContent` com áudio inline, disponível para QUALQUER chave AI Studio e capaz de TRADUZIR PT→EN (o transcription_config não traduz; o modo CODE entregava português). O chip do ditado anuncia qual API vai atender ("via Groq"), o HUD mostra "Transcrito com {provider}" a cada turno e a falha virou mensagem acionável em português: qual provider falhou, por quê e o caminho de correção (chave ausente → onde configurar; preview sem acesso → ativar Groq; whisper.cpp ausente → comando de instalação).
- **Workers de missão distribuídos entre os CLIs da máquina (F-525, decisão do dono)**: a lane governada abre para os CLIs builtin writáveis (Codex, Claude, AGY, Grok, GLM/GLM Flash, Kimi) — o Codex mantém seu sandbox nativo probe-verified e os demais escrevem sob o boundary já provado do Autopilot (worktree isolada por tarefa + merge validado pelo Main). O fallback final do roteador ("nenhum candidato da tabela instalado") passa a escolher o CLI MENOS USADO da missão em vez do primeiro disponível, e o pool multi-CLI faz o multi-score de diversidade, o first-wave spread e o round-robin do squad-architect finalmente distribuírem os panes em vez de concentrarem tudo em `gpt-5.6-sol`.
- **Modelos sempre atuais (F-525)**: default do Grok promovido de `grok-4.5` para `grok-4.6` no catálogo publicado (o builtin já era 4.6 — o publicado estava defasado e vencia na carga) e nos defaults de squad; adapters fora do conjunto release-qualified continuam bloqueados nos gates (fail-closed preservado em camadas: gate de spawn, autoridade de assento e argv).
- **Imagem do WhatsApp aceita sempre, no pane e na missão (F-526)**: mídia arrastada/colada do WhatsApp e de apps Electron que chega sem arquivo materializado — apenas como HTML com `data:image/...` embutido — agora é extraída, salva no mission-context e injetada com caminho absoluto no terminal, e estagiada como anexo no wizard/missão; o dragover da janela passa a aceitar esse formato (antes o navegador nem entregava o drop). Texto formatado de páginas (html+plain) continua fora do intake.

## 0.76.23 — Rotação automática de modelo, agy no Gemini 3.8 Pro e orquestrador sempre em foco

- **Rotação automática de LLM quando o provider rejeita o modelo (F-520)**: pane que morre com "modelo requer versão mais nova da CLI" (erro 400 do Codex com `gpt-6-astra` em CLI antiga), `model_not_found` ou modelo não suportado agora rotaciona automaticamente para o modelo ativo da linhagem (migração de id aposentado ou default curado do catálogo) e religa na MESMA conta — a credencial não é punida com cooldown, porque as contas continuam operacionais. Sem alternativa no catálogo, o pane recebe orientação acionável para atualizar a CLI.
- **AGY sempre na geração mais recente do Gemini (F-520)**: default do adapter `agy` promovido de `gemini-3.7-flash-high` para `gemini-3.8-pro-high` (catálogo builtin, catálogo publicado e defaults de squad). Panes e squads legados em `gemini-3.1-pro-high` são migrados automaticamente no spawn — todo pane agy abre sempre no modelo mais recente da linhagem pro com reasoning high.
- **Atualização de CLIs pelo próprio Nexus (F-520)**: Configurações → Providers ganha botão "Atualizar CLI" por provider instalado e "Atualizar N CLIs" em lote — reexecutam a receita oficial (npm/instalador oficial) que instala a última versão, cada uma com a confirmação nativa mostrando o comando exato. CLIs desatualizadas são a causa raiz de modelos novos rejeitados com erro 400.
- **Orquestrador mantém o foco com pane novo (F-521)**: com o orquestrador em modo foco (pane ampliado), workers abertos pela orquestração entram no grid POR TRÁS — não roubam mais o foco nem derrubam o zoom. O zoom agora só cai por pedido explícito (apresentação de pane/restore) ou quando o pane ampliado sai da árvore; o `focus: false` do `addShellPane`, que era silenciosamente anulado pelo invariante antigo, volta a funcionar de fato.
- **Default do Codex de volta ao frontier oficial**: corrigido drift pré-existente em que o adapter abria em `gpt-5.6-luna`; volta a `gpt-5.6-sol` (`CODEX_FRONTIER_MODEL`), alinhado ao catálogo publicado e à doutrina de produto.
- **Correções de saúde da suíte**: `muse` passa a ser oferecido pelo adapter builtin (o catálogo publicado já o listava); mock do `app.on` no teste do UpdateManager (quebrou com a F-517 e matava os 5 testes de update); rótulo da seção "Chaves de API e Conta" atualizado no teste de navegação.

## 0.76.22 — Preços de API em tempo real, aviso proativo de atualização e anexos duráveis no terminal

- **Auditoria e atualização de custos e preços de APIs oficiais (F-518)**: Preços por 1 milhão de tokens (USD/M) alinhados às tabelas oficiais para Anthropic (Claude Fable 5.1/5, Opus 5/4.x, Sonnet 5/3.7/3.5, Haiku), OpenAI/Codex (GPT-6 Astra, GPT-5.6 Sol/Luna/Terra, GPT-5.5, GPT-4o, o1, o3, Codex), Kimi/Moonshot (K3, K2.8, K2.7 HighSpeed, Moonshot v1), Cognition Devin (SWE-2 Max/High/Medium), Meta Muse (gratuito), Google Gemini (Gemini 3.8 Pro/Flash, 3.7, 2.5, 2.0), DeepSeek (Reasoner R1, Chat V3, Coder, Flash), xAI Grok (4.6, 4.5, Code-Fast-1), Zhipu GLM (5.3, 4.7), Alibaba Qwen, Xiaomi MIMO, LongCat e modelos comunitários. Adicionado cálculo exato de custos de leitura/escrita de prompt cache (`cacheReadPerM` / `cacheWritePerM`), e corrigida a resolução de modelos com namespace e barras.
- **Aviso proativo de atualização disponível na interface (F-517)**: Card flutuante (`UpdateBannerNotice`) exibe de forma proativa quando uma nova versão do NexusIDE estiver disponível, acompanhado de beacon luminoso animado e ação direta de 1 clique ("Atualizar agora" / "Reiniciar agora"). Botão de status no cabeçalho ganha animação pulsante de alta visibilidade e rechecagem inteligente ao focar a janela.
- **Caminho absoluto e espelho home para imagens coladas no terminal (F-519)**: Capturas de tela coladas (⌘V) ou arquivos soltos no terminal agora injetam o caminho absoluto no prompt, permitindo que agentes CLI (como Claude Code, Kimi e Devin) encontrem o arquivo mesmo trabalhando em subpastas. Além disso, foi criado espelho de compatibilidade automático em `~/.nexus/attachments/mission-context/` para modelos que procuram diretórios de configuração iniciados por ponto na home (`~/`).

## 0.76.21 — Rei da Parada: Feixe rotativo do orquestrador e distinção real

- **Destaque visual do terminal orquestrador ("Rei da Parada") (F-516)**: O terminal líder que atua como orquestrador agora exibe um feixe luminoso perimetral animado (`.pane__crown-beam`) que circula continuamente pela sua borda. O efeito utiliza gradiente cônico em rotação suave e máscara de exclusão CSS (`mask-composite: exclude`), executando com aceleração total no compositor da GPU sem repintar o canvas do xterm e com zero interferência no input.
- **Insígnia da coroa e comandos de liderança**: O badge `orq` na barra de ferramentas do terminal foi aprimorado com uma coroa dourada (`crown`) luminosa com drop-shadow, e o botão líder recebe realce de destaque ativo em tons de ouro e magenta.
- **Acessibilidade**: Fallback gracioso para usuários com `prefers-reduced-motion: reduce`, substituindo a rotação por um gradiente estático elegante.

## 0.76.20 — Orquestração estável, terminais transparentes e modelos de fronteira

- **Foco estável e cursores protegidos no grid multi-painéis (F-513)**: A reorganização da grade (`setPanes`) agora preserva o terminal em que o operador está trabalhando caso ele permaneça na tela. Além disso, a montagem em background de workers secundários não rouba o foco do cursor nem interrompe a digitação ativa.
- **Início direto em terminais ao selecionar workspaces**: Ao abrir ou selecionar um workspace, o Nexus entra diretamente nos terminais interativos em vez de ficar preso na tela de criação de missão. A vaga livre no grid oferece ações diretas para abrir um terminal ou montar grade multi-IA.
- **Instalação de CLIs via terminal e correção do Meta Muse (F-514)**: Adicionado botão "Instalar via terminal" no painel de Provedores para executar receitas de instalação em um painel interativo visível, permitindo acompanhar o download e permissões. A receita do Meta Muse no macOS foi atualizada para o Homebrew Cask oficial (`brew install --cask muse-code`), e o login alerta com segurança antes de tentar rodar binários não encontrados no PATH.
- **Expurgo de modelos legados e migração transparente (F-515)**: Modelos descontinuados pela OpenAI que retornavam erro 400 em contas ChatGPT (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3`) foram expurgados dos catálogos ativos e ganharam mapeamento automático transparente para `gpt-5.6-luna`.
- **Novos modelos e Jarvis direcionada**: Catálogo atualizado com Kimi K2.8 e K3, Devin SWE-2, Gemini 3.8 Pro e Flash, e suporte a modelos DeepSeek, com o assistente Jarvis direcionado aos modelos de alta capacidade.

## 0.76.19 — Chaves de API unificadas, Jarvis visível e resguardo de terminal

- **Central de Chaves de API unificada (F-350)**: Novo painel dedicado "Chaves de API" em Configurações para gerenciar com facilidade as chaves dos provedores (Google Gemini, Grok, Groq, OpenAI, Claude, ElevenLabs, DeepSeek, Moonshot/Kimi, Replicate, OpenRouter). As chaves são armazenadas com segurança no Keychain local do sistema e propagadas automaticamente para a assistente Jarvis, adaptadores de CLI e Estúdio de Mídia. Inclui banner de acesso rápido na aba de Providers.
- **Jarvis embutida e configurável nas configurações internas (F-350)**: A assistente Jarvis agora vive de forma visível e nativa na seção "Jarvis & Voz", com acesso imediato à conversa contínua ao vivo (Grok Voice, Gemini Live, OpenAI Realtime), personalização de nome e instruções, timbre, modo de atendimento e microfone, sem depender de popup modal.
- **Orientação em português para bundle apagado ou movido (F-204)**: Quando o aplicativo em disco é removido ou substituído enquanto está em execução, o Darwin PTY Supervisor não cospe mais erro cru de ENOENT; ele instrui o operador em português a fechar e reabrir o app para religar os terminais.
- **Drenagem de saída de terminal pré-exit (F-204)**: O evento de encerramento do processo drena o buffer pendente no xterm antes de estampar o banner de saída, eliminando corrida que deixava caracteres embaralhados na tela.

## 0.76.18 — O terminal deixa de ficar escondido na tela de criação

- **A tela de criação só sabia iniciar missão**: para abrir um terminal era preciso sair para "Terminais", e não havia como escolher quais IAs abrir em cada painel. Agora, abaixo do formulário, a seção **"Prefere trabalhar nos terminais?"** oferece duas portas: **Montar meus terminais** (assistente que deixa escolher a pasta, a quantidade de painéis e uma IA diferente em cada um) e **Terminal sem IA** (terminal direto, sem assistente). Isto era **regressão, não ausência**: a seção existia no antigo `Launcher` — hoje código morto — com estas mesmas duas portas, e o store que a servia ficou órfão, sem nenhum chamador.
- **Seu pedido não se perde ao ir para os terminais**: voltar para a criação mantém o texto digitado no campo. Verificado ao vivo.
- **O CTA continua sendo um só**: os dois cartões são secundários e neutros; "Iniciar criação" segue como a única ação primária da tela.

## 0.76.17 — O pane estreito para de encher a tela de lixo

- **Pane com muitos panes abertos enchia de lixo do spinner**: o CLI dentro do pane redesenha a linha de status no lugar com `\r`, assumindo que ela CABE. Quando a linha é mais larga que `cols`, ela quebra — e o `\r` seguinte volta à coluna 0 da linha **de baixo**, não da original. O cursor desce um degrau a cada tick e cada quadro deixa resíduo: lixo permanente no scrollback. Medido ao vivo (janela 1280, célula 7,74px): 3 panes lado a lado dão **28 colunas**, 4 dão 21, 5 ou mais dão **8** — e a linha de status realista de um agente tem **51 caracteres**. Agora a grade não desce abaixo de 60 colunas enquanto há sessão viva: o TUI passa a ver largura suficiente, para de quebrar a linha e para de subir lixo. O excedente fica cortado pela borda do pane — corte se recupera alargando o pane; o creep corrompia o histórico de forma permanente.
- **Um único caminho de medição**: o fit do terminal passa a ser sempre pelo mesmo wrapper, então nenhuma das seis rotas de resize (observer por host, refit global, reveal, spawn) escapa da regra.

## 0.76.16 — O ditado para de perder palavra e o pane prova que está ouvindo

- **As barras de nível do microfone não apareciam**: elas existiam só dentro do HUD flutuante, e o HUD em modo "só áudio" devolve `null` — quem escondia o HUD ficava sem nenhuma prova visual de que o áudio estava entrando. Agora as barras vivem também na barra superior, ao lado do chip CODE/CHAT, independentes do estado do HUD.
- **Gemini 3.5 Transcribe como provedor de ditado**: transcrição LITERAL com `mode: verbatim` — o modo `smart` remove muletas de fala, que era exatamente a queixa de "a palavra que eu falei não entrou no texto". O vocabulário técnico do modo code viaja como `custom_vocabulary` para o decoder. Vem ligado quando existe `GEMINI_API_KEY`; sem a chave a cadeia Whisper (Groq → OpenAI → whisper.cpp) assume sozinha, e o provedor segue escolhível em Configurações › Serviços.
- **O chip não mente sobre o idioma**: o Gemini transcreve e não traduz — com ele ativo o modo CODE entrega português, como decidido. Como tooltip não avisa quem já está ditando, o próprio rótulo denuncia: `CODE·PT`.
- **Panes mais baratos em rajada de redesenho**: o debounce de refit sobe de 60ms para 150ms. A troca de colunas dispara reflow do scrollback inteiro, e a 60ms cada pane grande refazia esse trabalho ~2,5x mais vezes por rajada.
- **Respawn adiado não tenta para sempre em silêncio**: um slot que nunca ficava mensurável reagendava de 2 em 2 segundos indefinidamente, deixando um timer vivo e um pane vazio sem explicação. Agora há teto de 60s e, ao estourar, o próprio pane diz o motivo.
- **Terminal assume a largura nova antes da pintura**: quando a sidebar abre e os panes esticam, o fit roda dentro do layout effect — o container já tem o tamanho novo e o terminal não aparece com a grade antiga. Sem isso o debounce maior deixaria as colunas velhas na tela por mais tempo.
- **Modo do ditado não é mais apagado por upgrade**: a migração que instala o Gemini escrevia os defaults por cima de TODOS os campos do topo da cadeia — e o modo CODE/CHAT mora justamente ali. Quem tinha escolhido CHAT voltava para CODE, e como o arquivo é reescrito a perda era permanente.
- **Head fixado de propósito é respeitado**: a mesma migração só checava "o Gemini está ausente?", nunca "esta é a cadeia de fábrica". Quem fixou `local-whisper` para manter o áudio na máquina ganharia o Gemini na frente — e como o Gemini também é o brain padrão, a chave costuma existir: a fala iria para a nuvem sem ninguém pedir. Agora a migração só age sobre a cadeia padrão.
- **Interação que falhou não vira transcrição**: resposta com status de falha mas com texto parcial era aceita como sucesso e injetada no pane como se fosse fala. Agora só passos de saída concluídos contam.
- **Vocabulário técnico não vaza para o modo CHAT**: o viés de vocabulário passou a ser ligado pelo mesmo sinal que o caminho Whisper usa (o prompt de priming), para os dois provedores não discordarem sobre o que o modo significa.
- **O wake não gasta o orçamento com modelo generativo**: a cadeia do wake foi reordenada para os provedores de transcrição rápida virem primeiro — uma chamada generativa entre a Groq e a OpenAI queimava a fatia apertada do orçamento numa tarefa de duas palavras.

## 0.76.15 — O pane não congela no redesenho e o crash report conta tudo

- **TUI que redesenha sem parar congelava o pane visível**: o scheduler de saída segurava o frame aberto (hold) e, ao chegar o fechamento, esperava mais um pouco (coalesce) — e cada um cancelava o timer de segurança do outro. Num stream que alterna os dois sem parar, o pane nunca voltava a drenar. Agora um prazo único vale para o episódio inteiro: seja lá quantas vezes o modo vire, a tela pinta no fim dele (orca#8754).
- **Fila de saída prendia buffers gigantes na memória**: uma fatia de 16 KiB de uma leitura de 2 MB mantinha os 2 MB inteiros vivos no V8 enquanto qualquer resto ficasse na fila, e slots já drenados seguravam a string até a compactação. Fatias parciais passam a ser copiadas quando o resto cai à metade do que ainda está retido, e slot drenado solta na hora (orca#13402). A montagem dos chunks deixou de ser quadrática em floods de chunks pequenos.
- **Crash reports mais fiéis**: breadcrumbs coalescidos com o payload pendente e crumbs retidos por limiar; janela rolante no fallback de GPU; dedupe por webContents com claim/release; classificação por plataforma (SIGTERM de namespace no Linux); amostragem pré-morte de métricas e memória do host; wait status POSIX e assinatura do minidump no texto; notas do usuário preservadas. Store com `attachDetails`, leitura que espera a escrita em voo e temporário sempre removido.
- **Manter acordado com três modos**: off/auto/on; no macOS a assertion do sistema tem precedência sobre o `powerSaveBlocker`, e o status passa a ser assinável. Turnos injetados pelo harness só são reconhecidos por tags observadas, com detecção de continuação de compaction; hooks ganham estado `skipped` com motivo e marcador de transporte raw-json.
- **Protocolo de stream do terminal com teto**: um frame JSON gigante ou profundamente aninhado chegava sem limite ao `JSON.parse`; agora há cap de 8 MiB e limite estrutural e de aninhamento, mais os opcodes novos do upstream. Parser de `ssh_config` com a semântica do OpenSSH (primeiro valor vence quando a diretiva se repete no mesmo bloco) e expansão do token `__PROGRAMDATA__` no Windows, que antes virava ENOENT silencioso e escondia um `known_hosts` administrado.
- **Proveniência do código herdado do Orca em dia**: o verificador passa a ler todos os ledgers `orca-*.json`; oito arquivos com header no pin `93334dc5` sem ledger algum e uma entrada malformada foram regularizados; cinco ondas de resync para o pin `f352b6b` (v1.4.200) registradas com hash real de cada blob.

## 0.76.14 — O terminal sobrevive à troca de projeto

- **Trocar de projeto matava o que estava rodando**: ao hidratar o projeto novo, todo host fora da árvore era descartado e `disposeHost` matava o PTY com `force:true`, pulando o lease — a única guarda protegia sessão de agente de missão, e o shell do operador nasce com `agent:null`. Na volta, o scrollback salvo era reexibido e a tela fingia que o terminal tinha voltado, vazio. Agora `open()`/`pick()` **estacionam** os panes do projeto que sai: saem do DOM e devolvem o lease de WebGL, mas mantêm xterm, PTY e estado, e voltam ao lugar quando o operador retorna. Só o fechamento explícito mata — pane ✕, Fechar projeto e remover da lista.
- **Pane de missão encerrada era apagado do layout, para sempre**: quando a Main negava autoridade de restore, o gate fechava o pane e `close()` **persistia** o layout sem ele. O estado seguro já estava armado nesse instante (spawn segurado, pane inerte), então a linha do `close` jogava fora o que já protegia. Em campo isso custou 7 panes de uma missão `done` e 2 de uma `blocked`, com a Main ainda dona de todos. Agora o pane é aposentado: fica no layout, com o histórico, e o hold garante que não executa sozinho. A varredura irmã de missão terminal parou de fechar workers pelo mesmo motivo — `getPaneSessionId` responde "sem sessão" enquanto os hosts estão drenados numa troca de projeto, então pane **vivo** era classificado como cadáver.
- **Um projeto gravava os panes de outro**: se uma mutação local caísse na janela do `layout.load` da troca, o app carimbava posse do projeto novo sem hidratar. Como a posse é o único respondedor de "de quem são estes panes?", a debounce de 300 ms gravava a árvore do projeto que saía sob a chave do que entrava — terminal de um projeto aparecendo dentro de outro. O teste que devia cobrir isso liberava o load depois da debounce, ou seja, só exercitava a ordenação segura. A troca agora **hidrata o projeto que entra preservando os panes de missão que aterrissaram na janela**: nem grava a árvore alheia, nem deixa o projeto novo sem posse — posse ausente fazia `persist` e `flushLayout` pularem **toda** gravação daquele projeto, e os terminais sumiam em silêncio.
- **Arrastar/soltar/colar na tela Iniciar missão**: o aviso "Solte para anexar contexto à missão" ficava preso na tela (inclusive em outro projeto) porque o estado vive no App e só era limpo por um listener de `window` em bolha — e a zona de anexos e o pane param a propagação nos próprios handlers. Arrastar mídia do WhatsApp não anexava nada porque o shell exigia `Files` em `types`, então nem chamava `preventDefault` no `dragover` e o navegador não disparava `drop`. E colar só funcionava com o wizard montado. O intake passou a ter um dono só, em captura para limpar o overlay, com watchdog de 1,2 s, fallback por endereço quando o arraste traz a promessa do arquivo em vez do arquivo — e nunca silencia: se não der para anexar, diz o que chegou.
- **Navegar para um projeto pelo rail abre nos terminais dele**: trocar de projeto com o wizard aberto deixava o destino colado em "O que você quer criar?". O caminho do Finder já abria nos terminais; o rail passou a fazer o mesmo.

## 0.76.13 — Pane não morre no trust, o assento é do CLI que você pediu

- **Pane travava — ou morria — no "Yes, I trust this folder"**: o Claude Code 2.1.267 tirou a numeração das opções e deixou o cursor parado em "No, exit". O autoresponder mandava `1` (ignorado) seguido de Enter, que confirmava o *cancelar* e encerrava o pane — o operador via a tela parada e o pane parecia não abrir. A resposta passa a ser lida da própria tela: se o aceite está abaixo do cancelar, o app desce o cursor antes de confirmar; se a tela não prova qual item está focado, nada é digitado.
- **Pedir Kimi abria Sonnet**: o gate pré-spawn decidia o assento do Kimi por uma cache de processo aquecida apenas em Configurações › Contas, kickoff e bootstrap — nunca no spawn direto do operador. Cache fria (ou corrida com o fold do PATH no boot) virava "sem credencial" e a cadeia de sucessão sentava o Claude, com o modelo default. Agora a sonda `kimi provider list` roda na hora do spawn e o binário é resolvido por caminho absoluto.
- **A troca de assento agora aparece**: quando o CLI pedido não senta e outro assume o pane, o app avisa na tela com o nome dos dois e um atalho para Providers. Antes a troca existia só num `console.warn` do processo principal.
- **O logo da IA sobrevive a pane estreito**: abaixo de 380 px o badge do agente era escondido inteiro, e não havia como saber qual IA estava em cada pane. Agora só o texto sai (já saía em 460 px); o logo fica em qualquer largura.
- **GLM Flash**: adapter dedicado (binário do Claude Code contra a z.ai) com upstream próprio, quatro slots pinados em `glm-5.3-flash[1m]`, aliases de credencial `glm-flash → glm → zai`, catálogo só-Flash, roteamento em trivial+easy, quota e logo.
- **Devin CLI**: adapter embutido como worker (MCP `none`), com receita de instalação darwin/linux, sonda de autenticação, credencial gerenciada e logo próprio.
- **"+ Pane" virou um índice de CLIs**: uma linha por provider com logo, meta e chevron; a matriz conta×modelo aparece no drill-in. Busca global intacta, Esc em escada, e Grok e demais CLIs não ficam mais enterradas sob dezenas de linhas de conta×modelo.
- **Ranking de modelos por família**: famílias frontier (Fable/Mythos/Astra) acima do Opus; modelos api-only ganham o selo "restrito" e seguem fora do auto-routing, com a mesma régua no select de modelo do roster.

## 0.76.12 — impeccable 0.1.5 executável, skills que se atualizam e o pane do macOS 27

- impeccable 0.1.5 embutido: o skill passa a trazer o CLI empacotado (launcher + binário darwin-arm64 + índice de fontes) em vez dos scripts soltos, e os verbos do `SKILL.md` chamam o binário direto.
- Bit de execução preservado no empacotamento de skills: o bundling gravava tudo como leitura, então o CLI do impeccable chegava ao pane sem poder rodar. O bit agora faz parte do pacote e é reparado mesmo quando o conteúdo já estava certo — o que conserta também a cache já quebrada no disco.
- Cache de skills podada: arquivos que saíram da fonte não sobrevivem mais em `~/.nexus/generated-skills`, o que impedia uma instalação nova de receber um impeccable híbrido (versão nova + arquivos mortos).
- Skills instaladas se atualizam sozinhas: as skills embutidas (impeccable, archify, bmad-templates, superpowers, dembrandt) são sincronizadas na cópia de cada CLI a cada spawn de agente, então uma instalação antiga recebe a versão nova sem reinstalar o app. A sincronização só remove o que o próprio Nexus escreveu, comprovado por um registro com o hash de cada arquivo entregue — skill criada por você, ou arquivo que você editou, fica intacto.
- Pane volta a abrir no macOS 27: o `/usr/bin/perl` do sistema ganhou um terceiro slice (`arm64e.x1`) e o supervisor de PTY comparava o hash de um slice diferente do que o kernel carrega, recusando todo lançamento com `stage0: helper exited before authenticated exec`. A validação passa a identificar a arquitetura do processo vivo, o que de quebra fecha um buraco latente sob Rosetta.

## 0.76.11 — Stage Focus, Síntese DAG, Roteador por Especialidade e Jarvis Instantâneo

- Stage Focus Mode (Cmd+Shift+F): foco visual com proporção 72%/28% colocando o terminal ativo no palco principal e mantendo os demais agentes monitorados em um companion rail com cards interativos.
- Context DAG no Handoff: os handoffs do Maestro e workers agora transmitem a cadeia causal de execução (conquistas, bloqueios, próximos passos e DAG de contexto) para preservação do fio da meada.
- Sensor Mecânico de Cobertura de Testes: pair review adversarial automático que audita a presença de testes irmãos para arquivos de código modificados, bloqueando finalizações cegas.
- Roteador por Especialidade no "+ Pane": mapeamento e busca inteligente de agentes e modelos por aptidão técnica (frontend, lógica, contexto, raciocínio, rápido) no catálogo de spawn.
- Jarvis Direto sem Hesitação: comandos locais e ações de rotina por voz executam sem atraso ou modais repetitivos, mantendo feedback sonoro assertivo.
- Herdr Manifests: contagem sincronizada de manifestos embutidos para 20 após a aposentadoria da CLI Gemini legada em prol do AGY.
- Segurança de dependências: atualização do smol-toml para 1.8.0.

## 0.76.10 — Modo vibe sem cabresto, paste humano em pane governado e Kimi desbloqueado

- Modo vibe para o operador: panes abertos pelo operador sem missão executam efeitos de código (`nexus_terminal_run`, `nexus_file_write`, `nexus_git_commit`, etc.) diretamente via MCP sem barreira de intent gate ou modal de confirmação.
- Paridade na missão aprovada: comandos destrutivos em missões com contrato aprovado deixam de exigir confirmação modal a cada passo — a reversibilidade continua sendo preparada em background sem bloquear o fluxo.
- Paste humano (Ctrl+V): a lane do operador em panes governados passa a aceitar bracketed paste, permitindo colar código sem recusa pelo processo principal.
- Kimi Code 0.41+: a tela "Trust this folder?" é detectada e aceita automaticamente pelo autoresponder de PTY no boot, impedindo que a CLI fique travada antes do composer.
- Teclado do operador em panes secundários: panes criados por agentes sem missão passam a receber a digitação humana direta do xterm.
- Ferramentas de pane do operador sem modal: `nexus_pane_close`, `nexus_pane_write` e `nexus_pane_ask` deixam de pedir consentimento a cada chamada.
- Uma CLI Google (AGY): Gemini CLI deixa de ser instalada ou descoberta separadamente em favor do Google Antigravity (AGY CLI).
- Codex atualizado: o modelo padrão do Codex passa a apontar para `gpt-5.6-sol`.
- Contas Claude: recuperação robusta de sessões e failover priorizando panes fortes.

## 0.76.9 — O picker mostra o mais forte primeiro, e o rail mostra onde você está

- "+ Pane" agrupa cada CLI por conta (conta A, conta B) com o estado da conta em chip (ativa, sessão expirada, em pausa, sem credencial), em vez de intercalar conta×modelo. Sem conta salva, o bloco diz que a CLI usa a credencial ativa dela.
- Dentro de cada conta, os modelos vêm do mais novo e mais forte ao mais leve: geração embutida no id, depois o custo do catálogo (ou a família do id — opus/pro acima de mini/flash), utilizáveis antes dos restritos. Chips dizem a faixa (Profundo · Equilibrado · Rápido), o padrão da CLI e o acesso restrito — e entram na busca ("rapido" acha o haiku).
- Cada conta mostra os 4 mais fortes e dobra o resto em "mais N modelos"; a busca sempre vê tudo, e reabrir o menu volta dobrado. A grade de terminais lista "modelo · conta".
- Rail: o projeto aberto leva o selo ATUAL e uma borda de acento, independente do que está selecionado — selecionar a missão de outra pasta não apaga onde você está.
- Pasta do projeto apagada com o app aberto (worktree removido por outra ferramenta) deixava todo pane novo morrer com `ENOENT … lstat` cru. Agora o pane diz que a pasta não existe mais e por onde sair; o Nexus sonda a pasta ao focar a janela e a cada spawn que cai por isso, avisa uma vez, o rail troca ATUAL por "pasta sumiu", o cabeçalho ganha o chip e o toast oferece "Abrir outra pasta". O workspace não é fechado sozinho — panes vivos continuam e decidir é seu.

## 0.76.8 — A lista de projetos para de encolher, e o pane do operador manda

- Terminal aberto pela opção de pane já pode, sem missão nenhuma, abrir outros panes (`nexus_pane_spawn`, inclusive por nome de agente do roster), ver todos eles (`nexus_pane_list`) e falar com eles (`nexus_pane_write`/`nexus_pane_ask`). Antes cada um desses caía em `mission effect blocked`, e a lista voltava vazia até para o próprio pane. Worker e orquestrador seguem presos à missão; shell, arquivo e git seguem exigindo missão.
- Pane que cria uma missão e depois a descarta volta a poder criar outra. A promoção `user → orchestrator` era porta de mão única: o pane ficava estéril até ser fechado.
- Pane aberto enquanto o canvas de terminais estava oculto (por exemplo a partir do Início) passa a nascer sozinho assim que fica visível. Antes o spawn adiado dependia só do ResizeObserver e podia ficar em branco para sempre.
- Toda recusa de efeito sem missão agora diz o caminho que funciona (ex.: handoff sem missão aponta para `nexus_pane_write`/`nexus_pane_ask` ou `nexus_mission_create`).
- Árvore de spaces no rail: a branch do worktree vira o nó da árvore (`⑂ feat/mf-103-…`) com a missão embaixo — missão sem worktree fica direto sob o projeto. Cada projeto pode ser recolhido, e o rail lembra. Ações da linha (lixeira) aparecem só no hover/foco.
- Soltar num pane algo que veio como endereço (`file://` de um app nativo, ou um link `http(s)`) agora funciona: o Nexus lê o arquivo local ou baixa o link (até 14 MB, 20 s), guarda em `mission-context` e cola o caminho no terminal — antes só arquivo arrastado do Finder entrava.
- `nexus_pane_write_many` virou broadcast com recibo por alvo: `submitted | skipped (pane_dead | agent_not_ready | pane_hibernated) | failed`. Pane morto nunca recebe; um alvo recusado nunca para os outros.
- Quadro de missões por status derivado: Construindo · Validando · Precisa de você · Pronto, com a gaveta Arquivo recolhida no rodapé. Antes, falha e sucesso caíam na mesma coluna e missão bloqueada sumia entre as vivas. Cada card mostra estado em palavra e idade curta; nada se arrasta entre lanes — a lane é consequência, não escolha.
- Inspector da missão com largura ajustável (360–440 px) que persiste, e um trilho fino na borda quando recolhido — clique, arraste ou Enter reabre. Antes, recolher escondia o inspector até você achar o botão.
- Panes se apresentam como `NexusIDE <versão>` (`TERM_PROGRAM`) em vez de herdar o terminal que abriu o app.
- A lista de projetos do rail ganha piso de altura: em uma janela de 700px são 4 pastas visíveis no lugar de 1. Antes ela era a única faixa elástica e cedia toda a altura para o cromo fixo.
- Cada projeto mostra o menor trecho do caminho que o distingue dos outros abertos — dois `web` viram `…/lupygo/apps/web` e `…/volare/apps/web`.
- Largura do rail ajustável entre 200 e 280px, por arraste ou teclado, com duplo clique voltando ao padrão; a escolha persiste.
- Limpar projeto volta a ficar recolhido e o cartão de cotas sai do rail em janelas baixas; os dois seguem a um clique.
- Imagem colada não vai mais duplicada: o mesmo print chegava pelos dois acessores do clipboard e escapava da deduplicação.
- Arrastar para o terminal algo sem arquivo (promessa de app nativo, link ou só texto) agora explica o que chegou em vez de não fazer nada.

## 0.76.7 — Space que avisa

- Ditado por Space desarmado (atalho global ou captura bloqueada) mostra toast acionável em vez de morrer em silêncio.
- Copy do preset Ditado EN corrigida: toque rápido digita espaço, só o SEGURAR dita.

## 0.76.6 — Failover que assenta e voz que mostra

- Failover multi-conta (F-511): conta com token vencido e sem renovação é pulada com motivo acionável em vez de queimar uma sessão nova num 401 garantido; conta vencida-mas-curável renova no momento do pin.
- Fim do ping-pong entre contas saudáveis: o trecho citado no pack de failover não re-dispara o detector de limite.
- HUD de voz com barrinhas de nível do mic durante a captura (ditado e Jarvis).

## 0.76.5 — Multi-conta e panes que respondem

- Providers e menu de panes com quantas contas você quiser por CLI — segunda conta Codex inclusa — com prova de login novo (fechar ou estourar o tempo nunca conta como sucesso).
- Adapter Muse entra na lista: Providers, Contas, Cotas e login pelo terminal.
- Claude Max com sessão Keychain-only passa a ser reconhecido no app empacotado.
- Grok não pede mais device-login em loop quando a conta gerenciada está com credencial expirada.
- Teclar num orquestrador encerrado após o done sempre responde (religa ou orienta).

## 0.76.4 — Tema claro de verdade, e nada de perder o que você escreveu

- `nexus-light` agora é claro por inteiro: cartões, rail, filtros e o gutter do diff ganham superfícies próprias, e as cores de status passam a ser legíveis sobre fundo claro. Antes o tema herdava as superfícies quase pretas do Pink City e os pontos de estado ficavam abaixo do contraste mínimo.
- A ideia escrita antes de escolher a pasta não some mais quando a pasta já tem um rascunho: os dois textos são mantidos, em vez de o que você digitou ser descartado em silêncio.
- Fechar um projeto não leva mais os arquivos anexados nele para o projeto seguinte.
- Uma tecla num terminal de missão concluída — mas ainda não revisada — não desfaz mais o vínculo entre o painel e a missão. O canal de revisão sobrevive até você aprovar.
- Painel hibernado continua acordando pelo botão; uma tecla não o converte mais em shell vazio.
- A auditoria de dependências passa a impedir a conclusão quando não consegue rodar (projeto que não usa npm, ou contagem crítica sem detalhe legível), em vez de registrar a entrega como verificada.
- Falha na análise automática de qualidade agora aparece no registro e na nota da entrega; antes era silenciosa.

## 0.76.3 — Configurações mais claras

- Limpar projeto: fechar todos os panes ou apagar todas as missões, com confirmação única e resultado parcial em caso de falha.
- Panes estreitos preservam o botão de fechar; grades extensas ganham rolagem.
- Pedidos duplicados de remoção não empilham confirmações; exclusões já concluídas são verificadas antes de mostrar erro.

- Kimi passa a usar --yolo; plugins antigos do Kimi e Qwen recebem a opção automática nativa.
- Fluxos de trabalho com selos compactos e papéis legíveis em janelas menores.
- Configurações reorganizadas em nove áreas, com navegação local e busca integrada.
- Acesso permanente a Meus pets, inclusive com o mascote flutuante desligado.
- Logos do Claude e Codex também no resumo de cotas da barra lateral.
- Textos em português, filtros, detalhes técnicos recolhidos e melhor apresentação em janelas menores.
- Logos locais para identificar ferramentas e serviços de IA.
- Recuperação de falhas em mídia, referências de design e consulta de atualizações.
- Regra permanente de leitura do contrato visual nas tarefas de UI, com suporte ao DESIGN.md e ao contrato importado aplicado.

## 0.76.1 — Motor de missões e Settings confiáveis

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **Motor de missões com receipts reais**: perguntas para a equipe exigem respostas do elenco aprovado, recusam falso sucesso parcial e preservam bloqueios técnicos recuperáveis quando panes não nascem.
- **Roteamento e credenciais consistentes**: o router usa o mesmo resolvedor de credenciais dos providers, respeita providers desativados e evita fan-out indevido para chaves de outro fornecedor.
- **Settings e cotas honestas**: Uso/Cotas mostra janelas conhecidas antes das desconhecidas, não inventa barras para quota indisponível e evita deduplicar identidades nativas/salvas incorretamente.
- **UI interna revisada**: onboarding, Providers, Harness, Catálogo, Squads, páginas internas e ações de pane ganharam estados de vazio/erro/retry, navegação estável e responsividade verificada.
- **Limpeza de recursos mortos**: controles Ralph/GoalDriver sem runtime ativo foram removidos; Squads mantidos com aplicação real no preparo e aviso quando o time antigo está incompleto.

## 0.76.0 — Herança Orca: ModelPicker unificado

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **ModelPicker unificado estilo Orca**: um grupo por provider com logo, linha de uso e modelos ordenados por sessão pronta, custo e quota livre. Modelos sem sessão aparecem bloqueados com o comando de login.
- **Sidebar com logos e quota de duas janelas**: agentes mostram o logo da LLM, missão selecionada abre com agentes visíveis, rodapé com as duas janelas e barra na pior janela. Layout 250px e alinhamento macOS (F-118).
- **Reroute desvia de quota alta**: falha de spawn re-roteia para CLI fresca da mesma categoria quando a original está ≥ 80% de quota; quota desconhecida nunca desvia sozinha.
- **Code review pré-release**: comparador à prova de Infinity, trim bilateral no auth, linha de modelo salvo indisponível e lookup de quota com semântica explícita.

## 0.74.4 — Sidebar Orca, Grid Livre e Digitação Desbloqueada

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **Sidebar Cockpit padrão Orca (`stablyai/orca`)**: Rail integrado com status de missões, gauges de cotas de IA proporcionais em tempo real, branch Git ativo, árvore de subagentes com LEDs de atividade e atalho direto para o grid de terminais.
- **Grid de Terminais com Seletor de Quantidade**: Diálogo modal para abrir 1, 2, 3, 4, 6 ou número customizado de terminais, com atalho rápido e promoção de qualquer pane para orquestrador na toolbar, no context menu e no ⌘K.
- **Digitação do operador 100% desbloqueada**: O operador humano no teclado físico tem autoridade incondicional de digitação; status de erro de missão nunca mais bloqueia o terminal PTY ativo com mensagens de recusa (`[nexus] o main recusou a digitação neste pane.`).
- **Paridade de modelos e flags 2026**: Suporte aos modelos `grok-4.6`, `gemini-3.8-flash-high`/`gemini-3.8-pro-high`, `claude-opus-5` e flags não-bloqueantes (`--permission-mode plan`, `--mode plan`, `--effort`).
- **Fim do deadlock de dispatch de missões**: O intent gate agora aceita transição de pending para running e autoriza o spawn de workers (`canDispatchWorkers`) no próprio grid do Nexus sem recorrer a terminais externos.
- **Correção de contas e login (F-114)**: Erro 401 de autenticação não exibe mais falsamente como "esgotada" e o botão "Entrar novamente" fica sempre visível para reautenticação imediata.

## 0.74.3 — Sem conta morta selecionável

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **Botão Nova missão na sidebar**: cartão hero no topo do rail abre o fluxo simples no workspace atual.
- **Seletores ignoram sessão expirada**: Maestro, default do orquestrador, linha de cota e picker; erro do Maestro cita o re-login.
- **Resets do code-review**: cura do refresh emite, re-login zera o disjuntor, trip sempre emite evento.

## 0.74.2 — Pane abre, login aparece

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **Pane manual em todas as CLIs**: builder único do spawn limpa strings vazias que o validador rejeitava (muse sem catálogo); erro de validação cita o campo.
- **Sessão expirada visível**: status + "Entrar novamente" na linha do provider e na conta, "Usar" bloqueado, switcher sem falso "pronta"; falha de refresh avisa a UI na hora.
- **Disjuntor do 401-loop**: 1ª morte instantânea troca de conta, 2ª seguida trava com diagnóstico; toast com ação "Abrir Providers".
- **Handoff sem eco**: packs anteriores podados do excerpt de continuidade.

- **Botão Nova missão na sidebar**: cartão hero no topo do rail abre o fluxo simples no workspace atual.
- **Seletores ignoram sessão expirada**: Maestro, default do orquestrador, linha de cota e picker; erro do Maestro cita o re-login.
- **Resets do code-review**: cura do refresh emite, re-login zera o disjuntor, trip sempre emite evento.

## 0.74.1 — Operador no controle

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

- **Pane do operador na vista da missão**: "+ Pane" e "+ terminal" (grid e canvas) montam ao lado dos panes da missão em vez de nascer invisíveis; garantia anti-pivô-fantasma no `spawnAgent`.
- **Teardown pós-aprovação**: workers só encerram ~30s após "Marcar como feito"; enquanto "Aguardando você", os terminais ficam para inspeção e ajuste.
- **"Pedir um ajuste" não executa sozinho**: hold na first-wave, no flush de retries do fail-closed e ordem de espera no Maestro religado.
- **Revisão em paralelo**: doutrina ensina spawn `readOnly:true` para análise sem edição.
- **Catálogo**: glm-5.3-flash, claude-fable-5-1/mythos-5-1, gpt-6-astra (trusted-access fora do roteamento automático).
- **Auditoria**: deep-link sem `URIError`, renderer-protocol sem TOCTOU, preload isola listeners, voz expõe erro de encerramento Live.

## 0.74.0 — BridgeSpace 3.4.18 Parity & Autonomous Swarm Engine

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Incorporação dos 10 domínios do BridgeSpace 3.4.18 e orquestração de missões autônomas:
- **Design Tokens & Glass Depth Hierarchy**: Tokens de sombra em 3 níveis (`--shadow-card-rest`, `--shadow-card-focus`, `--shadow-card-drag`), escala semântica de blur (`--blur-sm..3xl`), bordas e cantos arredondados padronizados, além das classes utilitárias `.surface-card` e `.modal-radial-halo`.
- **Terminal Ghost Assist & Command Refinery**: Assistente de autocompletion inline com medição precisa de fonte via Xterm render service, aceitação com Tab/Seta Direita, aceitação de palavra com Option+Seta Direita, descarte com Escape e sanitização de comandos com detecção de `cd` redundante.
- **Shell Integration Hardened (macOS Login Shell & OSC 9;9)**: Geração de `.zprofile` e `.zshenv` sob `ZDOTDIR` customizado preservando a herança de `/etc/zprofile` e `path_helper` no macOS (`zsh -l`), e notificação instantânea de diretório de trabalho via escape sequence OSC 9;9.
- **Agent Hooks Drop-Box Watcher**: Ingestão atômica offline com escrita segura via arquivo temporário em `~/.nexus/agent-hooks/global/`, particionamento em lotes de 100 arquivos com debounce contra starvation e mapeamento canônico bidirecional de estados (`running` → `working`, etc.).
- **Swarm Mailbox & Scope-Freeze**: Protocolo de comunicação multi-agente transcript-first (log durável gravado antes do inbox de destino), guarda de escopo rígida limitando modificações a até 40 arquivos por worker, limite de ciclos de revisão antes de escalonamento para o operador e filtro anti-social chatter para diffs enxutos.
- **Knowledge Graph MCP (nexusmemory)**: Novas ferramentas MCP (`nexus_memory_backlinks`, `nexus_memory_orphans` e `nexus_memory_suggest_connections`) para exploração de decisões e memórias com pontuação de similaridade semântica e suporte a wikilinks com alias (`[[Title|Alias]]`).
- **Session Alive Sentinel & Recuperação de Queda**: Monitor de sobrevivência do processo gravando batimentos atômicos contínuos em `session.alive.v1.json`, permitindo detecção de encerramentos anômalos no próximo boot e garantindo limpeza de arquivos temporários órfãos.
- **Simulação E2E de Missões**: Suíte de validação executando missões simples (Fast-Lane/Direct) e complexas (Swarm + Story Plan + Review + Merge Queue) de início ao fim com 100% de sucesso.

## 0.73.0 — Paridade Overclock 1.33.18 e Super Swarm

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Incorporação das inovações e doutrinas do Overclock 1.33.18:
- **Warm Pool de Panes (P0)**: sessões PTY pré-aquecidas sob demanda com validação de liveness, expiração de stale (10min) e reposição assíncrona condicionada a folga mínima de CPU (>=25%).
- **Lease Registry (startKey)**: tokens criptográficos por spawn PTY impedem que requisições concorrentes de kill atinjam sessões recicladas ou recém-criadas.
- **Handoff Mecânico com Preservação de fullText e Modo Attach**: texto integral preservado até 60KB (com condense determinístico 20k head + 20k tail para payloads gigantes) e anexação de múltiplos artefatos por turno sem duplicação de handoffs.
- **Squads Builtin com Skills Guiadas**: qa-swarm (10 regras L0-L2), qa-vision (protocolo F-XXX), absurd-landing e cinema-site com recursos embutidos.
- **Superfície MCP Expandida**: aliases cron persistentes, validação/formatação de recipes de squads e telemetria unificada via perf_events.

## 0.72.1 — Grid grande, memória honesta

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Benchmark mediu (16/32/64 panes): o app aguenta grids enormes sem congelar.
Acima de 24 panes vivos, um pane que sai da tela descarta o terminal e
guarda só o snapshot + saída pendente; ao voltar, o conteúdo é restaurado
pela mesma trilha do restore de layout. PTY e sessões seguem intactos.

## 0.72.0 — Braço externo

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Nexus Arms: orquestradores que não moram num pane (Grok Bot, Cursor)
passam a ver o app em JSON e receber eventos com cursor, por MCP stdio.
Token dedicado em Configurações › Conectores (hash em disco, plaintext
uma vez); a superfície é observação por construção — sem conteúdo de
terminal, prompts ou segredos. Também: viewport de tablet no preview,
temas Cinza e Vermelho, e o adapter Muse Code.

## 0.71.0 — À frente do Overclock

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Corta os gaps reais do Overclock 1.3.18 (e corrige dois bugs que eles
tiveram): o modo de aprovação `untrusted` que o Codex atual rejeita sai do
adapter; pane sem conta escolhida nasce na conta com folga de quota; modelo
salvo desconhecido pela CLI não derruba o pane; cofre unificado visível ao
orquestrador (`nexus_vault_list`); caminhos no output do terminal viram
links clicáveis; Ctrl+Tab circula entre panes; verificação de assinatura
falhada para de acusar falta de licença.

## 0.70.22 — Entrega firme

_Para atualizar: baixe o DMG/ZIP abaixo e substitua o app (feche o Nexus antes)._

Entrega de handoff com retry de verdade: backoff de 15s entre tentativas
(em vez de 2 colagens no mesmo segundo), teto de 3 tentativas e o re-arm
do supervisor agora vive também em missão `done` aguardando a sua revisão.
Validado em missão real end-to-end no modo dev: kickoff, worker, entrega,
conclusão e aprovação do operador.

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
