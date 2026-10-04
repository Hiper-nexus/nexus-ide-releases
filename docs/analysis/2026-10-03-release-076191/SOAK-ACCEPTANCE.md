# Task 5 — cinco minutos de atividade no app assinado

Este harness implementa o gate; testes de fixture não certificam execução nativa, assinatura ou estabilidade do candidato. A prova de release é `acceptance.json` produzido pela execução abaixo no app final. Não há inspector/CDP, alteração de fuses, login, configuração global ou API nova em `window.nexus`.

```sh
/opt/homebrew/opt/node@22/bin/node scripts/smoke-packaged-soak.mjs \
  --verify-soak \
  --app /caminho/copia-do-mesmo-ZIP/NexusIDE.app \
  --zip /ROOT/out/make/zip/darwin/arm64/candidato.zip \
  --build-receipt /ROOT/release-artifacts/candidate-build.json \
  --source-sha SHA_FINAL_DE_40_CARACTERES \
  --expected-version 0.76.192 \
  --evidence-dir /ROOT/.superpowers/sdd/PLAN/evidence/soak-novo
```

O diretório de evidências precisa ser novo, absoluto e fora do profile descartável. O root deduzido de `release-artifacts/candidate-build.json` deve estar limpo, com HEAD e tag anotado da versão apontando exatamente ao SHA informado. A lista de signers do repositório determina a verificação do tag; lista vazia admite tag anotado unsigned conforme a autoridade existente. A assinatura Developer ID do app continua obrigatória. O validator canônico compara recibo de build, package lock, versões/integridade das ferramentas e os dois artefatos. Nenhum campo de tag é aceito somente por autorrelato do recibo.

Antes/depois do uso, um processo Python stdlib compara todos os arquivos, permissões executáveis e links do bundle com o MESMO ZIP sem extração. Recusa duplicatas, escape, conteúdo adicional, troca de identidade durante leitura e divergência de bytes; inclui app.asar, Info.plist, framework, recursos nativos e assinatura. O gate também verifica Developer ID/supervisor, CodeDirectory hash e fuses existentes. Essa prova específica não substitui o restante do checklist de release/notarização.

O launcher existente cria HOME/userData privados. Somente esse modo explícito recebe o marker Main na URL inicial; o observer de UI não se instala na URL normal e edição posterior do marker não o habilita. Depois da primeira verificação funcional, o renderer permanece montado. Cada ciclo lê o arquivo privado do workspace, consulta a busca local, abre um shell no layout real, confirma escrita, verifica saída executada cujo marker não existe no comando digitado, confere o marker no buffer xterm visível, produz scrollback, resize e frames, coleta memória e aguarda `orchTerminateSession === true`. Só então fecha a UI e inicia outro ciclo. A confirmação Main é ligada a nonce/webContents/frame/PID/cwd/owner. Uma baseline de shell criada pelo layout pode permanecer até o quit; RSS e contagens incluem todas as sessões ativas.

Critérios imutáveis da política v1, definidos antes do run: pelo menos300 s monotônicos, pelo menos40 amostras, no máximo80, cadência alvo5 s com gap máximo15 s, no máximo3 PTYs e2 hosts renderer. O orçamento da fase é420 s, com prazo externo480 s e observer450 s, disponíveis somente ao modo soak privado sem inspector. A média mediana de60–120 s é comparada à dos últimos60 s de atividade; também há pico absoluto e tendência OLS após60 s. Não se muda limite retrospectivamente para passar.

| Métrica | Pico MiB | Crescimento MiB | Tendência MiB/min |
|---|---:|---:|---:|
| Main heap | 512 | 64 | 16 |
| Main RSS | 1536 | 192 | 64 |
| Renderer heap | 512 | 64 | 16 |
| Renderer RSS | 1536 | 192 | 64 |
| Electron RSS agregado | 3072 | 256 | 96 |
| RSS agregado de panes | 512 | 128 | 32 |

Main usa `process.memoryUsage`; RSS Electron usa os working sets do snapshot existente; RSS dos panes vem do host PTY. Heap renderer usa o isolate V8 da versão qualificada Electron43.7.4 no preload sandboxed, convertido de KiB para bytes. A [documentação pinned](https://github.com/electron/electron/blob/v43.7.4/docs/api/process.md) descreve a API; a [implementação pinned](https://github.com/electron/electron/blob/v43.7.4/shell/common/api/electron_bindings.cc#L118) confirma disponibilidade no sandbox e conversão por deslocamento de10 bits. Métrica ausente/zero, PID trocado, atividade incompleta, fechamento sem prova ou crescimento excedido não viram PASS.

Ao terminar os ciclos, o cleanup da UI e a verificação funcional completa são repetidos antes do recibo. Quit natural e inventário físico sem órfãos são obrigatórios. Falha/timeout/crash marca stopped e entra imediatamente no shutdown Main existente, que sela admission e arma seu quit ceiling; não aguarda UI/IO preso para começar esse shutdown e nunca transforma ceiling/UNKNOWN em prova de sucesso. Resultados tardios ficam cercados após os awaits.

Evidências: `candidate-before.json`, `candidate-after.json`, `soak-smoke.json`, `soak-samples.ndjson`, `acceptance.json`. Falha produz `failure.json`; profile com árvore desconhecida permanece privado para diagnóstico. Raw samples/política são preservados fora do profile antes de descartar uma sessão cuja árvore foi provada limpa.

Validação de fonte: união de12 suítes/186 testes passou; mais2 testes do caller real escritos pelo revisor passaram e foram co-localizados. Inclui shell real limitado em HOME temporário, Git/tag reais em repositório de fixture, comparação ZIP/bundle real de fixture e controles de métricas/cadência/cleanup/dormância. Clock e Electron/PTY de unitários são seams explícitas; esses resultados não contam como cinco minutos no app assinado. O candidato final ainda precisa executar este comando depois de integrado/revisado e congelado.
