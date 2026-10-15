# Redline — revisão visual e fontes de cota em 15/10/2026

Escopo: painel nativo macOS e caminho quota-service → scorer → snapshot → companheiro. Estado observado no NexusIDE/Redline 0.76.275 instalado: 18 provedores, 20 linhas, nove com alguma leitura. O aplicativo instalado não foi substituído ou reiniciado; estas correções estão no checkout e no build de prévia.

| Provedor | Evidência nesta sessão | Resultado / pendência |
|---|---|---|
| Claude | Duas contas, duas janelas medidas em cada | Leituras presentes no snapshot |
| Codex | Duas contas com semana medida; GET nativo retornou 200, 77% semanal e `secondary_window: null` | Ausência de 5h é o que a API informou; não é zero nem falha de autenticação |
| Kimi | 5h e semanal medidas | Leitura presente |
| GLM / z.ai | 5h e semanal medidas | Leitura presente |
| Cursor Agent | Mensal medida, com placeholders 5h/semanal vazios | Corrigido F-032; fonte mensal preservada |
| Grok | Semanal medida | Outras janelas não informadas não viram porcentagens |
| Devin | Diário e semanal medidos | Leitura presente |
| Antigravity / AGY | Conta salva sem leitura, mas comando nativo devolveu quatro buckets válidos, zero turnos | Corrigido F-035; fonte nativa independente, sem afirmar que pertence à conta salva |
| MiMo Code | Conta salva sem leitura | A fonte implementada exige sessão própria do console MiMo, vinculada à identidade e ao consentimento. Não foi validada conexão autenticada do console neste ciclo; usar “Conectar cota” em Uso e cotas |
| MiniMax Code | Estado autenticado e token de acesso vencido no arquivo nativo | CLI conserva o login; precisa renovar seu próprio token ou fornecer Subscription Key. Não rotacionamos seu grant |
| Muse | Sem leitura no snapshot; resolver tem suporte a env/arquivo e não extrai senha do Keychain macOS | Fonte precisa ser configurada/validada; não se anunciou leitura ao vivo |
| OpenClaude | Sem leitura no snapshot | Há sonda OAuth e fallback CLI implementados; causa específica desta conexão não confirmada ao vivo |
| DeepSeek | Sem leitura no snapshot | Rota direta não tem leitor de percentual implementado neste dispatcher; não inventar porcentagem a partir de saldo monetário |
| Qwen | Sem leitura no snapshot | Leitor existente usa Token Plan Alibaba via console/CLI `bl`; não foi validada sessão de console para esta conexão |
| Sakana | Sem leitura no snapshot | Sem leitor dedicado de cota percentual no dispatcher atual |
| OMP | Excluído por ausência de credencial no snapshot | Conferir credencial da conexão antes de esperar telemetria |
| Prime Agent | Excluído por ausência de credencial no snapshot | Conferir credencial da conexão |
| Qoder | Excluído por ausência de credencial no snapshot | Conferir credencial da conexão |

O `readHint` agora atravessa o canal para que falha de leitura, fonte de cota necessária, ausência de CLI e reautenticação não virem o mesmo estado visual (F-033). O companheiro também conserva o marcador `estimated`, identifica a estimativa e não a apresenta como uso medido na barra (F-034).

Após o operador recusar o primeiro acabamento como semelhante demais ao original, o painel foi recomposto: medidores circulares lado a lado, superfície própria por conta, logos maiores, faixa gráfica de cobertura e filtros Todas / Com leitura / Resolver. O compacto passou a 460 × 720; o ampliado conserva colunas calculadas pela altura real. Resets aparecem com ícone e tempo curto; janelas genéricas vazias deixam de poluir as linhas medidas. Ausência de cota oferece “Resolver no Nexus” com ação real. A paleta permanece a do DESIGN.md.

O teste AppKit exercita cliques nos filtros (incluindo 0% confirmado e estimativa), recuperação de todas as contas, rolagem, contraste nos temas claro/escuro, nomes longos, ausência de dados, estado offline e cronômetros. A segunda composição foi compilada e capturada em `/tmp/nexus-redline-v2/` (`compacto.png`, `ampliado.png`, `Nexus Redline.app`). Não foi publicada.

Validação: `npm run typecheck`; `npx vitest run src/main/quota/ src/main/redline/ native/menubar-redline/main.test.ts scripts/build-macos-menubar.test.mjs --exclude '**/.muse/**'` (55 arquivos, 859 testes); build real Swift/macOS 14 e `codesign --verify --deep --strict`. A exclusão só evita recolher cópias de testes nas worktrees locais `.muse`; não altera a configuração do projeto.

Prévia compilada em `/tmp/nexus-redline-preview/Nexus Redline.app`; capturas compacta e ampliada em `/tmp/nexus-redline-preview/`. Capturas usam o snapshot real ainda produzido pelo Nexus instalado, portanto não simulam o resultado futuro do conserto do AGY nem os novos hints ausentes no processo antigo. A implantação das mudanças do serviço exige uma nova build do Nexus e reinício oportuno do aplicativo, preservando as sessões do operador.

## Preparação da release 0.76.277

Pedido de publicação autorizado pelo operador. As alterações do Redline foram reaplicadas isoladamente sobre main 0.76.276, sem os commits de orquestração da checkout de origem. Uma revisão independente encontrou e confirmou a correção de rodapé sobreposto após filtro ampliado, crédito futuro de reset apresentado como folga atual e avisos/cronômetros perdidos em estimativas ou ausência de leitura. As regressões AppKit passaram na candidata; o revisor aprovou este escopo. A folga do cabeçalho agora é exclusivamente medida.

Instalação limpa com Node 22.23.2 e npm 12.0.0 verificado por integridade passou, com zero vulnerabilidades no npm ci. Typecheck e renderer-sinks passaram. O comando adicional npm run lint encontrou sete erros preexistentes em arquivos idênticos à main: suppression-reason em exact-resume-health, ansi-text, adapter-registry-init e pty-analysis-screen-delta, e teste registrado em laço em bundled-font-coverage. Esses arquivos não foram alterados para esta release. Build, gate e publicação usam o fluxo canônico release:mac e seus recibos, que registrarão a evidência final.
