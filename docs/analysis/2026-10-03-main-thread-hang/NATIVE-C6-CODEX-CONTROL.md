# Codex real — controle privado de admissão pesada

## Padrão livre confirmado após orientação do operador

O operador autorizou explicitamente liberdade de rede e execução em04/10.
O padrão do produto já é `operator-choice`/Autopilot: sem sandbox externo e
com os argumentos full-auto declarados pelo adapter. A fixture agora usa
`buildControlArgs` do Codex real para duas fases adicionais, baseline e fila,
sem inventar flags de teste. Nessas fases a escrita no segundo caminho próprio,
o TCP ao listener próprio e o Unix próprio são **permitidos**, como esperado;
Make e Node passam pela mesma admissão/coorte física. Os efeitos permanecem
nos diretórios e serviços locais da fixture.

Gate `PLAN/freedom-native-defaults.log`: **31 PASS/3 suítes**,32,93s,
incluindo quatro controles da CLI real (duas fases do padrão livre e duas
fases adicionais de workspace-write offline), `control-args` e
`mission-cli-execution-policy`. A política confinada adicional não limita
o padrão livre do Nexus. Não é prova do aplicativo assinado nem do caller
Main que ainda está em integração.

Fonte de transporte: `172b4af771b216cbd71e96ba2ed1ccd2649560f6`, integrada
como `6272f908138057fdff9c4f0b84893d6466286eb4`; API privada final em
`a600004d9a2f96aab447cf8f1680a38026166e53`. A fixture co-locada é
`src/main/orch/native-heavy-codex.test.ts`. O snapshot de transporte ainda
aguarda os controles adicionais e a revisão independente; o caller de
produção e o candidato assinado têm aceite separado.

CLI instalada medida: Codex **0.160.0**, launcher `/opt/homebrew/bin/codex`.
Validador, supervisor e byte-helper de teste usam Node22. Somente a inferência
é simulada por gateway Responses local e finito, com credenciais fictícias;
o comando é executado pela ferramenta real `functions.exec` → `exec_command`.
O gateway usa os tools declarados em `additional_tools`, conforme o protocolo
Responses Lite dessa versão, e espera a conclusão física do mesmo handle.

Baseline e fase com fila usam HOME/provider/conversas/TMP privados e a mesma
política `workspace-write`/aprovação `never`. Não há flag de bypass, proxy
novo, permissão de rede/arquivos extra ou perfil/conta do operador. A fase
com fila usa `prepareCodexOperatorMissionHome`, registro de artifact ativo e
`configureCodexNativeHeavyChannel`; a configuração guarda só nomes das quatro
variáveis do canal, sem seus novos valores. O transporte por arquivos usa o
TMP já permitido e o mesmo helper fixo; Node fork é apenas port de teste.

Controles finais do Root, log privado `PLAN/codex-file-actual-final.log`:

- **2 PASS/1 suíte**,13,15s, Node22/mutex, baseline e fase com fila.
- O Make e o descendente Node produzem seus marcadores dentro do workspace.
  Nenhum marcador existe antes da aquisição da reserva Main.
- Na fase com fila há claim `darwin-job` real, empréstimo autenticado da mesma
  lease e exatamente `grant, release` pelo observador de coorte física.
- Ambas as fases negam escrita fora do workspace, TCP direto ao Main e Unix
  alheio. Os listeners próprios usados como negativos recebem zero conexões
  da ferramenta. A leitura/escrita no TMP próprio é confirmada nas duas fases.
- Artefatos/configuração privados são removidos somente após close do CLI,
  drain do serviço nativo e dispose do helper; as chaves novas não aparecem
  no TOML. Não há execução externa de IA ou credencial real.

A tentativa inicial de exigir um empréstimo de kind `typescript` foi uma
expectativa excessiva da fixture: o zsh fez o empréstimo de kind `build` da
lease ancestral para o script completo, incluindo o Node. O controle exige
o empréstimo real e o único grant/liberação; não atribui esse empréstimo ao
preload Node. A prova específica do preload F-895 permanece na sua suíte.

Os protótipos anteriores com TCP/Unix falharam na rede offline. Um protótipo
Unix passou depois de configurar um proxy restrito, mas essa mudança de rede
foi removida antes da API final e não é aceite do produto. Também foi
corrigida uma falha da fixture que omitia `NEXUS_HEAVY_AGENT_ENTRY` e reservava
RAM para toda a CLI; esse erro não foi atribuído ao Nexus.

Pendente: revisão final do transporte por arquivos, wiring do spawn Main com
as cercas de reserva/geração/abort e teste no aplicativo assinado. F-894 fica
aberto até esses critérios; este documento não certifica a release.
