# Regressões concretas da revisão da candidata 0.76.166

O head e860b15faea4a5856475dd703fc30fd9f642254d aprovou CI 36968857284:
19.038 testes, 1.714 arquivos aprovados, 166 testes/8 arquivos ignorados,
typecheck e renderer-sinks. CodeQL também aprovou todas as linguagens. Esses
resultados não são reutilizados como prova automática de alterações posteriores.

## Texto ACP entre turnos

O peer JSON-RPC real em subprocesso reproduziu `hello` seguido de `world`
como `helloworld` no ring volátil do pane. O driver agora acrescenta dois
newlines somente no primeiro chunk público não vazio de uma nova resposta.
Chunks da mesma resposta continuam concatenados; turnos vazios ou somente
thought não acrescentam texto. Cancelamento e tamanho limitado do ring
continuam no contrato existente. A reprodução falhou no driver e860 e passou
na correção; 47 testes locais passaram. A revisão independente confirmou os
hashes e não identificou blocker. Isso não comprova inferência de um provedor.

## Navegador estacionado e mão do operador

O código e860 recusava a janela original quando o gate do Main devolvia um
operador promovido a `user` após a missão, enquanto sua apresentação estava
estacionada. As duas reproduções usam a função real de devolução do gate e
cobrem a ficha física PTY ainda na missão e já devolvida a user: ambas falharam.

A origem captura se essa sessão era a mão promovida do operador. Sua leitura
acompanha a devolução exclusivamente quando o gate confiável é user sem missão
ou incarnation, a sessão física continua na janela original e os escopos de
coordenação/execução são exatos. Identidade, pane, adapter e conta continuam
iguais à captura. A transição não é aceita para ACP ou sessões físicas adotadas
por outra janela. O antigo caller da missão e workers headless dessa missão
não recuperam o coordenador devolvido. A suíte passou com 19/19 testes e
revisão independente; os PTYs/janelas nessa suíte são simulados.

## Preview Windows do head anterior

O run 36968864403 em e860 aprovou 135 testes focados e 22 probes no EXE extraído
do NUPKG, versão 0.76.166. Main emitiu renderer-mounted, functional-ready e
shutdown-complete do inventário físico PTY. Os dois artifacts são unsigned,
privados e temporários; Setup não foi instalado e os bytes não foram baixados
nem re-hashados localmente. API e upload concordam no digest. O harness Windows
não enumera todos os helpers Electron no OS; orphans=[] não é prova exaustiva.

## Preview Linux do head anterior

O run 36968857288 em e860 aprovou 19.043 testes, typecheck/sinks/audit, o gate
Clang 15/GCC 12, o browser funcional real e o build DEB/RPM/ZIP. O artifact
11212025107 foi baixado: SHA-256 local, API e upload iguais a
`c21b3c0286b7e49e77d867bb614ff5c81a8079c1b3a9b7232b690d936a5abe00`.
Formulário salvo, menu aberto, progressão/reinício do jogo e layout mobile foram
confirmados por ações/asserts reais e quatro PNGs de resultado inspecionadas.
A geometria mobile foi 390 px/uma coluna/sem overflow horizontal; não houve
falhas de carregamento. O jogo passou x=40→87 (2 movimentos/7 frames de
controle mantido), reiniciou e avançou x=65 (1 movimento/5 frames). As teclas
são eventos DOM sintéticos, sem inferência ou perfil pessoal de navegador. O aplicativo
empacotado abriu o renderer, mas a probe mission-prepare falhou porque o Codex
não estava instalado/executável. Functional-ready, instalação Ubuntu/Debian,
coleta de pacotes e recibos não foram alcançados. Não há candidata Linux
publicável desse run. As mudanças seguintes exigem uma execução completa nova.

As provas de imagens, instalação, restart, assinatura/notarização e publicação
são superfícies diferentes. Um check de fonte aprovado não substitui nenhuma
delas. Os resultados finais e seus SHAs ficam vinculados aos runs do PR.


## Pré-requisito Linux e persistência

A investigação identificou um pré-requisito ausente no workflow, não um CLI Darwin no pacote: Codex é externo e descoberto pelo PATH. Os workflows agora provisionam o mesmo Codex 0.145.0 usado no Windows, com SRI npm, SHA-256 nativo, arquitetura ELF e execução real de --version em home vazio. O Debian recebe somente o pacote nativo em mount read-only. O resolver real passou de null no PATH vazio para o binário verificado; nenhuma guarda de missão ou resolver de produção foi alterada.

O harness opcional de restart abre cada aplicativo duas vezes em um perfil privado pertencente ao teste. CDP loopback com porta efêmera confirma o PID real, versão por ops.releaseReadiness do Main e pixelMode: false→SET true→GET true no primeiro processo; o segundo processo deve ler true antes de qualquer SET. Há timeout/cancelamento, recusa de perfis/targets alheios e cleanup. O default single-launch continua sem CDP. A fixture Electron real provou dois processos com persistência, mas não era Nexus166; o pacote Nexus ainda exige o run completo. Root executou 124 testes combinados dos helpers, workflows e envelope Debian, todos aprovados. Os smokes de pacote/instalação permanecem gates reais, não substituídos por essa suíte local.


## Rodadas 74c321a e 1f74d25; operatorOpened

O agregado 74c321a encontrou TS2322: PaneAuthzInfo representa usuário por role opcional. 1f74d25 corrige essa representação sem mudar as guardas, e as 19 regressões passaram novamente. CI 36974887559 aprovou typecheck, renderer sinks e 19.091 testes; Windows 36974891235 aprovou 135 testes focados, 22 probes, renderer e encerramento do inventário físico de PTY. São previews específicos desse commit, sem Setup instalado ou assinatura de release.

Linux 36974887561 aprovou typecheck/compilador, mas a fonte falhou somente no teste existente decision-redaction: 502,929 ms versus <500 ms. 19.095 testes passaram. Redator e teste são idênticos à main62c304; a causa do atraso não foi demonstrada e o limite não foi alterado. Nenhum build/runtime/instalação/recibo foi executado nesse run.

A revisão reproduziu mais duas falhas em panes operatorOpened estacionados: terminateMissionRuntime e releaseOperatorOpenedTarget reais devolviam o gate ao usuário, enquanto a origem só aceitava promotedOperatorHand. A origem agora captura também a marca operatorOpened do inventário físico Main. O caminho exige o mesmo gate user limpo, proprietário original e escopos exatos, preservando provider/conta/sessão/pane. Chamadas da missão anterior ou com owner/account/scope/incarnation/mission diferentes continuam recusadas. As duas regressões falharam antes e passaram com 21/21 testes, repetidos pelo autor, root e revisão independente. A fronteira física do PTY é simulada nesses testes; os checks completos do novo head são necessários.

O preview macOS ARM64 adicional usa os gates ad hoc existentes, sem alterar o publicador/notary. A preparação local não demonstra execução Mac; CI hospedado e seus recibos devem registrar o resultado real.

## Rodada 8dac: execução real e origem destacada

CI 36978350328 aprovou typecheck, renderer-sinks e 19.113 testes (1.719 arquivos,
166 testes/8 arquivos ignorados). Windows 36978353719 aprovou 135 testes focados
e o aplicativo extraído do NUPKG: versão 0.76.166, renderer, 22 probes,
179 ferramentas/18 adapters e encerramento do inventário físico PTY.
Setup não foi instalado; o preview permanece unsigned.

macOS ARM64 36978350381 aprovou 45 testes focados e Forge. O app e a cópia
extraída do ZIP passaram nas mesmas 22 probes, com versão 0.76.166 e encerramento
graceful. O recibo nexus.macos-preview/v1 foi lido e validado por CRC32 por
ranges do artifact autorizado. Seu SHA-256 é
aec41cd4c704be34a09a3eb5d6a7d9a00b765bd5dd0ab000aea63f9b68642460.
O checkout real foi cff2f49a572268d4ee60c1ee5142d88418d38b6c, merge de
62c304/8dac, com árvore 08ce7614fc4446d3685f0e8571ea510c6dcc4428 idêntica ao
head. Assinatura ad-hoc; publishable=false, releaseEligible=false e
notarizationRequested=false. DMG não foi instalado. O hash completo do archive
460 MB veio do GitHub/upload; não foi recalculado localmente. O follow-up de
diagnostics inclui o recibo final no artifact pequeno; sua regressão passou 4/4.

Linux 36978350426 aprovou 19.118 testes/161 ignorados, browser real, CLI Codex
verificado e Forge DEB/RPM/ZIP. O primeiro smoke de pacote/restart falhou com
CDP command failed. O helper ocultava a captura do app antes de relançar o erro;
isso não demonstra a causa do erro CDP. Instalação Ubuntu/Debian e recibo Linux
ficaram skipped. O limite existente de 500 ms foi preservado e passou nesta
rodada. Nenhuma instalação ou compatibilidade Wayland é atribuída a esse run.

A revisão seguinte usou source:pending, como a criação real de operatorOpened.
A retenção real de workspace chamou detach e transferiu o pane ao Main; as
duas variantes falharam em 8dac. A correção aceita a devolução confirmada pelo
gate para uma origem operatorOpened fisicamente destacada, exigindo ainda um
runtime Main único, identidade/provider/conta e escopos exatos. A devolução
limpa role e workerIncarnationId no registro Main, além da missão. Adoção por
outra janela antes do primeiro sync, runtime duplicado/ausente e autoridade
alheia continuam negados. Autor, root e revisão independente passaram 23/23.
Inventário e lifetime físico do PTY são fronteiras simuladas nessa regressão;
retenção, termination e gate são produção real. Checks do próximo head continuam
necessários; os resultados de 8dac acima não os substituem.

O follow-up CDP expõe somente método, etapa local e código numérico seguro;
mensagens/dados/expressões do peer não entram no diagnóstico. O harness imprime
a captura e a árvore de processos antes de relançar o mesmo erro, sem emitir
matriz de sucesso ou restartProof nesse caminho. A regressão passou de sete
falhas para 98/98 testes, repetida por root e revisão independente. Não há retry,
alteração de prazo ou gate; a causa do app real ainda exige a próxima execução.

O preload real também foi rastreado no head 8dac: as probes dictation-delivery
e dictation-hold-to-talk criam um shell por IPC, exigem writeConfirmed e dois
ecos onData antes do cleanup. Isso torna os 22 resultados Mac/Windows evidência
de PTY real, além do encerramento. Não é inferência Codex/LLM, input físico de
teclado, inventário de PTY vivo nem prova de todos os helpers Windows no OS.


## Rodada 77c e descoberta de contexto CDP durante a navegação inicial

CI 36982170400 aprovou typecheck, renderer-sinks e 19.122 testes (166 ignorados,
1.719 arquivos aprovados/8 ignorados). CodeQL 36982164898 também aprovou.
Windows 36982180762 aprovou 135 testes e EXE extraído do NUPKG: versão
0.76.166, 22 probes/179 ferramentas/18 adapters, ecos de shell reais por IPC e
encerramento PTY. Setup não instalado; preview unsigned, sem inferência.

macOS ARM64 36982170427 aprovou 46 testes, Forge, app e ZIP extraído com as
mesmas 22 probes e shutdown graceful sem órfãos. Checkout 13a53dc858e78517d9dcda5b0a980aa56d0e4bf0,
árvore 9e0d32229186a276bbf1ef6177de2b362ad87209 idêntica ao head 77c.
Root baixou o artifact pequeno de diagnostics, verificou hash/CRC e leu o
recibo final: SHA-256 eb3e0b4955c3fdda8955637f508784999c5952da75f3a084feffdd9db202c150.
Ad-hoc/TeamIdentifier ausente, sem Developer ID, notarização ou stapling;
DMG não instalado e captura de voz desabilitada. Não é release elegível.

Linux 36982170396 aprovou 19.127 testes (161 ignorados), typecheck/sinks,
fixture de browser real, CLI Codex verificado e Forge DEB/RPM/ZIP. O primeiro
startup do pacote Nexus 0.76.166 passou nas 22 probes/179 ferramentas/18 adapters,
com shell/PTY real e shutdown graceful. O probe de restart falhou com
Runtime.evaluate, api-availability, -32000. Sua mensagem remota foi suprimida
por design; esse resultado sozinho não prova navegação inicial ou autoquit.
Instalação Ubuntu/Debian, persistência e recibo permaneceram skipped.

Uma fixture empacotada de Electron 43.7.4, versão 9.8.7, reproduziu um caso
específico: BrowserWindow criado sem load, consulta de disponibilidade pendente
e primeira loadFile retornam -32000 / Inspected target navigated or closed,
com o processo vivo. Após os eventos de contexto isolated/default, a mesma
consulta e o helper baseline passam. O baseline foi conferido byte a byte com
o arquivo GitHub 77c (SHA-256 05c53f1a78f76993c18c2e88b8f2dfa650c77913b7f30890e74b8ba473cd82f5).
Main/window atuais também adiam o primeiro load até bootstrap; isso descreve a
topologia compatível, sem atribuir a mensagem oculta do runner à fixture.

A correção é limitada à descoberta read-only: método Runtime.evaluate, etapa
api-availability, código inteiro -32000 e classificação exata observada acima.
Um WeakSet privado marca somente esse erro; raw message/data nunca são emitidos.
A rodada inteira fica inconclusiva, todos os sockets são descartados e a
listagem completa é refeita dentro do mesmo timer e pause de 50 ms existentes.
Um alvo válido e outro transitório não podem ocultar ambiguidade. PID real,
endpoint loopback, unicidade, cancelamento e cleanup continuam obrigatórios.
SystemInfo, VERSION, GET/SET, exceptionDetails, códigos ou mensagens diferentes
continuam fatais, sem repetição de escrita. Telemetria contém somente phase,
transientRounds, elapsedMs e classificação fixa, para confirmar o caso no runner.

Três regressões falharam no baseline (33/36 aprovadas); candidato passou 36/36,
repetido por root. A fixture real também passou com o candidato no mesmo
script congelado: erro bruto reproduzido/processo vivo, uma rodada descartada,
helper pré-load bem-sucedido e read após load aprovado. Root repetiu baseline
RED e candidato GREEN; fonte/teste permaneceram com SHA-256
02004ae604f95b666c1e3fc44269988bedcf4089f0177a5f1a43bac1f3d4f769 e
fe7dbdf8e81cbff016a40d2be4879470523cc29a47f634b23a93f2acccd20c36.
Fixture SHA-256 f47107b3881bed48146c1c28ca1c198cad6094f7c32749091a669c9baa5868dd;
relatório GREEN 1aaf864607ecac6d1914a06fdcbe91049c4c71f0ecb0a6948ebd690860d40103.
A fixture não é Nexus166 nem prova restart/persistência entre processos; teste
usa Xvfb/--no-sandbox exclusivamente no ambiente restrito. Os gates hospedados
de pacote, restart e instalação continuam exigidos para validar a correção.


## Rodada 6b61: limite de tempo de redação e resultado exibido na UI

CI 36987291469 aprovou typecheck, renderer-sinks e 19.130 testes (166 ignorados,
1.719 arquivos/8 ignorados); CodeQL 36987285970 aprovou. Windows 36987293974
aprovou 135 testes e EXE extraído do NUPKG com versão166/22 probes/179 tools/18 adapters,
renderer e PTY real encerrado; Setup não instalado, preview unsigned. Mac ARM64
36987291221 aprovou 46 testes e app/ZIP com as mesmas 22 probes, shutdown graceful
sem órfãos e assinatura ad-hoc. Root leu logs completos, metadata e o recibo
Mac, verificando SHA/CRC dos diagnostics; checkout1228a40 tem árvore0bc2 igual
à do head6b61. Esses resultados não constituem assinatura/notarização de release.

Linux 36987291239 falhou somente no teste existente decision-redaction, que
mediu 520,734334 ms contra o limite inalterado de 500 ms. 19.134 testes passaram,
161 foram ignorados; 1 arquivo falhou/1.718 passaram/8 ignorados. A fonte do
redator era idêntica à main. Nenhum browser/build/smoke/restart/instalação/recibo
foi executado nesse run; artifacts vazio. A mensagem CDP do caso77c não foi
reproduzida aqui porque a execução parou antes do pacote.

O ASSIGNMENT_PATTERN já limitava o prefixo do nome a64 caracteres, mas fazia
essa busca em cada posição de corridas longas sem qualquer palavra-chave.
Agora um preflight não-global de KEY/TOKEN/SECRET/PASSWORD precede somente esse
replace case-sensitive. Qualquer match original necessariamente contém uma
dessas palavras; quando ausentes, o replace seria identidade. Todos os regex,
limites, ordem, replacements, Cloudflare, segredos de provedores/PEM/JWT e o
caminho camelCase independente permanecem. Nenhum threshold, retry ou gate muda.

Os 17 testes passaram, incluindo o limite original e cobertura de credenciais
sem palavras uppercase, nomes embutidos/longos e chamadas repetidas; autor, root
e revisão independente repetiram a suíte. Em 1.455 casos diferenciais, as saídas
foram idênticas ao baseline exato. Cinco pares em processos novos após as duas
chamadas iniciais do teste mediram baseline77,62–86,67 ms e candidato26,15–28,22 ms;
root repetiu o corpus e nove pares (74,48–79,64 ms versus25,89–28,56 ms), além de
um par em processos novos (77,84/26,46 ms). Ganho relativo local não prevê a carga
do runner; a mesma exigência de500 ms precisa passar no próximo CI.
Fonte/teste SHA-256699c6f3e74f856260b4e020815f208a2d1ceb9af2d02097476c149c72caf22fa /
dd5b1298f840127a3a75cf53a371b4b7a16d0b55744017cbdf481d21774b6296.

A revisão também reproduziu o fechamento automático com status success a partir
de texto que dizia não ter aberto ou inspecionado o preview. Handoff guarda
claimTrust=untrusted/evidenceTrust=unverified quando faltam provas. MissionResult
estrito contém outcome/summary/evidenceIds/artifactRefs e não transporta esses
campos de trust nem uma prova visual; checagem técnica pode gerar refs sem validar
aparência ou gameplay. O contrato textual novo orienta o worker, sem garantir
obediência do modelo ou servir como verificador universal de qualidade.

MissionInspector passa a exibir rótulos Resultado registrado e a contagem de
referências fora dos detalhes, com a indicação explícita de que status de
conclusão não atesta validação visual. Não muda schema, trust, autoclose, gates
ou autonomia. Root conferiu baseline GitHub byte a byte, diff de JSX e syntax
transpile; revisão independente sem bloqueios. A suíte local do componente está
indisponível no checkout parcial (No test files found), sem alegar typecheck ou
validação de renderer por transpile. Os testes existentes/typecheck do próximo
CI permanecem exigidos. SHA-256 do componente7c0417b36e691931a5b095b1e49239436c6e95b3e09e66cd92d6f013e57f85c9.
