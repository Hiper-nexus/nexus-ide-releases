# Análise sênior do relatório de auditoria v0.19.30 + Plano de implementação por etapas

Documento de trabalho sobre `nexuside-relatorio-achados-divida-tecnica-v0.19.30.pdf` (commit `31628c4f`, corte 25/07/2026).
Data desta análise: 2026-07-26. Achados verificados por amostragem direta no código — ver seção 1.4.

---

## PARTE 1 — Análise sênior do relatório

### 1.1 Veredito geral

É uma auditoria **acima da média** e honesta. Três sinais raros de qualidade:

1. **Limitações declaradas com precisão** — a auditoria não executou typecheck/testes (node_modules ausente), não auditou CVEs (sem autorização para consultar o registry) e não fez teste dinâmico. Ela não esconde isso em rodapé; está na página 2 e volta na seção 7. Isso significa que tudo no documento é *análise estática de snapshot* e precisa da baseline da Fase 0 para virar verdade operacional.
2. **"Interpretações evitadas" (§8.2)** — o relatório recusa ativamente exageros: não chamou Electron 43 de beta, não chamou `allowedTools null` de acesso irrestrito, não chamou CSP de XSS. Esse ceticismo disciplinado é o que separa auditoria sênior de scanner glorificado.
3. **Deletion test como critério de refatoração** — recusar "dividir arquivo grande em arquivos menores" como melhoria é a posição correta. O envelope de 3.000–5.700 LOC é conservador e apresentado como hipótese, não meta.

### 1.2 Verificação independente (amostragem no código atual)

Confirmei por leitura direta, neste worktree, no mesmo commit auditado:

| Achado | Verificação | Resultado |
|---|---|---|
| QUAL-01 (sem CI) | `ls .github/workflows` | **Confirmado** — diretório inexistente |
| QUAL-05 (lint = typecheck) | `package.json:35-36` | **Confirmado** — ambos são `tsc --noEmit` |
| SEG-01 (default full-auto) | `control-args.ts:28-37, 94-105` | **Confirmado** — modo vazio cai no `yolo` se o adapter o declarar; `defaultPermissionMode` retorna `'yolo'` como preferência de produto |
| FUNC-01 (cost store no-op) | `cost-store.ts:7-28` | **Confirmado** — TODO explícito, cast via `unknown`, no-op quando bridge ausente |
| SEG-03 (blacklist regex) | `guardrails.ts:14-47` | **Confirmado** — `DESTRUCTIVE_PATTERNS` é lista fixa de regex; já existe uma segunda lista (`REMOTE_OR_DEPLOY_PATTERNS`), o que reforça a tese do relatório: a blacklist cresce por acréscimo e nunca será completa |
| SEG-02 (segredos MCP plaintext) | `mcp-hub-core.ts:24-48` | **Confirmado** — schema persiste `headers`/`env` como strings; máscara é só para UI |
| ARCH-02 (doc histórico) | `docs/ARCHITECTURE.md:4` | **Confirmado** — "DESIGN ONLY — nenhum código de produto nesta fase", mas segue sendo o doc mais abrangente |

7 de 7 amostrados confirmados. Confiança alta de que o restante do registro está bem fundamentado.

### 1.3 A leitura que o relatório faz — e a leitura que ele não nomeia

O relatório está correto ao dizer que SEG-01..04 "formam uma cadeia coerente de autoridade, segredo e execução". Mas há três padrões transversais que ele demonstra sem nomear, e nomeá-los muda a estratégia de correção:

**Padrão A — Defaults otimistas em vez de fail-closed.**
É a raiz comum dos quatro achados altos e de vários médios:

- `permissionMode` vazio → **yolo** (SEG-01)
- contrato PREVC ausente → **autoridade permissiva** (SEG-04)
- `allowedTools: null` → **todos os tools standard** (ARCH-03)
- comando shell não reconhecido pela regex → **executa sem consentimento** (SEG-03)
- bridge de custo ausente → **no-op silencioso** (FUNC-01)
- health do MCP Hub → **"configured" incondicional** (FUNC-02)

Em todos os casos, a ausência de informação/configuração degrada para o comportamento *mais* permissivo ou *mais* otimista. Um sistema de autoridade maduro degrada fechado. Correção sistêmica: um princípio de engenharia escrito ("ausência de política = negação ou escolha explícita, nunca default implícito") aplicado como checklist de review, mais uniões discriminadas (`mode: 'all-standard' | 'allowlist'`) no lugar de sentinelas nullable. Sem o princípio, corrigir os seis pontos individualmente só move o problema para o sétimo.

**Padrão B — Meia-integração como forma dominante de dívida.**
Cost store ligado a bridge inexistente (FUNC-01), health stub (FUNC-02), harness E2E entranhado em produção (ARCH-01), documento "DESIGN ONLY" tratado como contrato (ARCH-02), módulos com testes mas sem caminho de produção (TD-01). O produto acumulou *capacidades prometidas* que nunca foram conectadas nem removidas. Isso é pior que código feio: treina a equipe a não confiar nos sinais do próprio sistema (health diz "configured", doc diz "nunca plaintext", lint diz "lint"). A correção não é refatorar — é **completar ou deletar**, sem terceira opção.

**Padrão C — Controle correto no lugar errado.**
A denylist de segredos existe, mas só na camada de agent tools, não no PTY nativo (SEG-02). A validação de sender existe, mas é privada a `window.ts` (SEG-05). O consentimento existe, mas depende de um classificador de string (SEG-03). Em cada caso há um controle real, maduro e testado — posicionado numa camada que o atacante/regressão pode contornar. A lição arquitetural: controles de segurança precisam ser **composicionais e não-puláveis** (helper central de IPC trusted, cofre resolvido no spawn, policy no dispatcher), não utilitários que cada call site lembra de usar.

### 1.4 Riscos e fraquezas do próprio plano do relatório

Sendo cândido sobre a seção 6 (sequência recomendada):

1. **Dependência oculta: decisões de produto, não código, bloqueiam a Fase 1.** SEG-01 exige decidir autonomia-first vs containment-first; SEG-04 exige decidir prevc-required vs intent-only por missão; TD-16 exige decidir o destino de mobile. Nenhuma dessas é tarefa de engenharia — são decisões que, se não forem tomadas por um humano com autoridade de produto *antes*, transformam a Fase 1 em código descartado. O relatório lista-as como itens de fase, mas elas são **pré-condições** com dono e data.
2. **SEG-01 e SEG-03 interagem de forma que o relatório trata separadamente.** A cadeia real de exploração é: prompt injection no workspace → CLI nativo full-auto (SEG-01) → lê segredos MCP em plaintext (SEG-02) ou executa comando destrutivo sem modal (SEG-03). Corrigir SEG-03 sem SEG-01 deixa o shell nativo do PTY fora do consent policy inteiramente. A Fase 1 precisa ser tratada como *um* projeto de fronteira de autoridade, não quatro tickets paralelos.
3. **TD-05 e TD-13 têm overlap não explicitado** — o próprio TD-13 admite "combinar com TD-05 para não duplicar coordenação". Executá-los em fases diferentes (4 e... também 4, ok) com implementadores diferentes cria dois coordenadores de lifecycle. Devem ser uma única fatia de design.
4. **Estimativas de janela são otimistas para uma equipe que também toca o produto.** 1–2 semanas para Fase 0 (CI + toolchain + Electron patch + audit) é factível; mas "2–4 semanas" para a Fase 1 inclui uma migração de cofre de segredos com rollback — isso sozinho, feito com o cuidado que o próprio relatório exige (testes de migração/rollback + prova adversarial), consome a janela.
5. **Nada no plano mede sucesso.** O relatório define gates por item (excelente), mas não define métricas de programa: cobertura por domínio de política, LOC líquido removido por mês, tempo de onboarding (TD-20). Sem isso, a Fase 6 "contínua" vira cemitério de P3.
6. **O achado mais barato de alto valor não está destacado:** QUAL-05 (renomear/implementar lint) e SEG-12 (hook global `web-contents-created`) são horas de trabalho e removem classes inteiras de regressão futura. Num plano real, eles entram na primeira semana, não "junto da área".

### 1.5 O que a auditoria não cobre (e o plano precisa prever)

- **CVEs de dependências**: não auditadas por restrição de autorização. Electron 43.0.0 com patch pendente (43.2.0) + node-pty beta + onnxruntime é uma superfície real; a Fase 0 precisa incluir o `npm audit`/OSV autorizado como item bloqueante, não opcional.
- **Validação dinâmica**: todos os gates adversariais propostos (prompt injection, frames atacantes, MITM) ainda não foram executados por ninguém. O relatório propõe; o plano precisa alocar quem executa.
- **Carga cognitiva de 24 achados + 20 TDs simultâneos**: sem um owner único do programa e uma regra de WIP (work-in-progress), o plano morre por diluição.

---

## PARTE 2 — Plano de implementação por etapas

> **⚠️ SUBSTITUÍDO em 2026-07-26** por `2026-07-26-plano-final-correcoes-v0.19.30.md`, que incorpora o audit de dependências executado (0 CVEs) e a decisão de produto autonomia-first. Mantido abaixo apenas como registro histórico do raciocínio.

Princípios do plano (herdados do relatório e dos padrões acima):

- **CI antes de refatorar** — nenhuma refatoração profunda começa sem gate automático verde.
- **Decisões antes de código** — as três decisões de produto têm dono, data e ADR antes da Etapa 2.
- **Um Seam por vez** — Adapter antigo coexistindo até paridade provada; apagar só no verde.
- **Fail-closed como regra de review** a partir da Etapa 1.
- **Completar ou deletar** — proibido deixar meia-integração nova; cada etapa fecha o que abre.

Legenda de esforço: assume 1–2 engenheiros sêniores com conhecimento do domínio, em paralelo com trabalho de produto (~50% de capacidade).

---

### Etapa 0 — Baseline reproduzível (semana 1–2)

**Objetivo:** todo commit passa a produzir evidência automática. Sem isso, nada abaixo é verificável.

| # | Item | IDs | Entrega |
|---|---|---|---|
| 0.1 | Fixar toolchain: `.nvmrc`/Volta em Node 22.23.1, `packageManager` npm 12, checagem pré-script | QUAL-03 | `scripts/check-build-node.mjs` ligado no preinstall/CI |
| 0.2 | Workflow `.github/workflows/quality.yml` em PR/push: `npm ci`, typecheck + test root e server | QUAL-01 | Check obrigatório + branch protection |
| 0.3 | Decisão mobile (suportado/separado/arquivado) — determina se mobile entra no CI | QUAL-03, TD-16 | ADR curto com dono |
| 0.4 | Renomear `lint` para refletir o que é, ou introduzir ESLint/Biome com baseline mínimo (~10 regras de baixo ruído, sem reformat) | QUAL-05 | Check separado no CI |
| 0.5 | Audit de dependências autorizado (`npm audit`/OSV) em root + server; triagem registrada | QUAL-04 | Snapshot no CI + relatório de triagem |
| 0.6 | Bump Electron 43.0.0 → 43.2.0 isolado, lendo release notes; matrix de rebuild/smoke dos nativos (node-pty, better-sqlite3, onnxruntime) | QUAL-04 | Smoke empacotado por SO |
| 0.7 | Alinhar `@types/react` 19 ↔ React 18 (uma das duas direções, explícita) | QUAL-03 | Typecheck limpo |
| 0.8 | Hook global `web-contents-created` negando popup/permissão/navegação por default | SEG-12 | Teste criando webContents sem config |

**Gate de saída:** checkout limpo em Node/npm oficiais → `npm ci` → typecheck/test root+server verdes no CI; PR de teste falhando typecheck é bloqueado pelo branch protection.

---

### Etapa 1 — Decisões de autoridade (semana 2–3, em paralelo com 0.6–0.8)

**Objetivo:** converter as três decisões de produto em ADRs com matriz de comportamento. **Sem código de refatoração nesta etapa** — só decisão documentada e testes de caracterização do comportamento atual.

| # | Decisão | IDs | Formato |
|---|---|---|---|
| 1.1 | **Autonomia nativa** — ✅ DECIDIDA em 2026-07-26 pelo dono do produto: **autonomia-first**. Yolo/full-auto é default por design; vibe coding exige zero atrito de consentimento. Falta apenas registrar o ADR e a matriz pane/role/modo/flag por adapter. Consequência: o risco de SEG-01 não desaparece, desloca-se para contenção de blast radius — Etapas 2.1 e 3 (segredos fora do alcance) viram os itens de segurança mais importantes do programa | SEG-01 | ADR + matriz pane/role/modo/flag por adapter |
| 1.2 | **PREVC**: `prevc-required` vs `intent-only` por missão; política default e migração de missões legadas | SEG-04 | ADR + política explícita persistida por missão (schema) |
| 1.3 | **allowedTools**: união discriminada `toolPolicy.mode` substituindo sentinela `null` | ARCH-03 | ADR + tabela de decisão role/pane/policy |
| 1.4 | Princípio fail-closed escrito no guia de engenharia + checklist de PR | Padrão A | 1 página, referenciado nos ADRs |
| 1.5 | Testes de caracterização do comportamento atual de autoridade (antes de mudar qualquer coisa) | SEG-01/03/04 | Suíte "authority matrix" documentando o que existe |

**Gate de saída:** três ADRs aprovados por quem tem autoridade de produto; suíte de caracterização verde documentando o status quo (ela vira a régu de paridade das Etapas 2–3).

---

### Etapa 2 — Contenção de blast radius da autonomia (semana 3–6)

**Objetivo:** com autonomia-first decidida, conter o que um agente full-auto comprometido consegue alcançar. O risco não sai pela porta do consentimento — sai pela porta do isolamento.

| # | Item | IDs | Notas |
|---|---|---|---|
| 2.1 | **DECIDIDO (produto, 2026-07-26): autonomia-first.** Yolo/full-auto é a tese do produto para vibe coding. O trabalho vira contenção de blast radius, não consentimento: (a) consentimento informado uma única vez no primeiro uso, com linguagem clara do risco; (b) segredos fora do alcance do processo nativo (Etapa 3 vira bloqueante); (c) máscara da subárvore `.nexus` no isolamento do processo nativo; (d) fechar a lacuna do Windows onde o PTY interativo não herda o ProcessSandbox; (e) worktree descartável como opção de execução para missões não confiáveis | SEG-01 | ADR a registrar na Etapa 1.1; não reabrir em auditorias futuras sem evidência nova |
| 2.2 | Blacklist deixa de ser fronteira declarada (corrigir descrição da tool), mas **sem** consentimento por ação em shell arbitrário — incompatível com 2.1. Mitigação proporcional: manter modal apenas para o conjunto catastrófico irreversível (`rm -rf` em raiz/home, `mkfs`, `dd`, wipe de disco), expandir cobertura de variantes (`git clean -fdx`, PowerShell) e tratar sandbox real como a fronteira de verdade | SEG-03 | `DESTRUCTIVE_PATTERNS` é UX de proteção contra acidente, não controle de segurança — documentar assim |
| 2.3 | Teste de contrato provando quais políticas alcançam MCP tools, ProcessSandbox e PTY nativo — as três superfícies explicitamente não-equivalentes | SEG-01 | Documenta a fronteira real no código |
| 2.4 | Cenário adversarial E2E: arquivo de instrução malicioso no workspace tentando ler fora da raiz, ler `.nexus` e mutar sem intent — macOS/Linux/Windows | SEG-01/02/03 | Gate adversarial executado de verdade |
| 2.5 | `allowedTools` → união discriminada com migração versionada de persistência | ARCH-03 | Snapshot da capacidade efetiva, não do campo |

**Gate de saída:** cenário adversarial confirma que um agente full-auto comprometido **não lê segredos reais nem a subárvore `.nexus`** nas três plataformas; conjunto catastrófico de comandos conserva modal; matriz role/pane/policy em teste.

---

### Etapa 3 — Cofre de segredos (semana 4–7, paralelizável com 2 após 2.1)

**Prioridade elevada pela decisão de produto (autonomia-first, 2026-07-26):** com yolo como default intencional, segredo em plaintext no workspace deixa de ser "risco composto" e vira o caminho de exfiltração nº 1. Esta etapa é bloqueante para qualquer ampliação de autonomia.

| # | Item | IDs | Notas |
|---|---|---|---|
| 3.1 | Workspace passa a persistir apenas *referências* de segredo; valores em safeStorage/Keychain | SEG-02 | Resolver referência somente no spawn do servidor MCP |
| 3.2 | Migração atômica: detectar formato antigo → importar → validar → substituir por referência; rollback protegido | SEG-02 | Testes de migração/rollback antes do merge |
| 3.3 | Valores reais fora de qualquer objeto enviado ao renderer (auditar payloads IPC do Hub) | SEG-02 | UI continua mascarada |
| 3.4 | Credenciais gerenciadas: ACL mínima, nomes não previsíveis, fora do workspace, cleanup em crash/startup | SEG-06 | Teste com kill -9 |
| 3.5 | Prova adversarial: worker full-auto não consegue obter valor real de segredo | SEG-02/06 | Depende de 2.1 |

**Gate de saída:** `grep` do workspace não encontra valor real; prova adversarial verde; migração testada ida e volta.

---

### Etapa 4 — Quick wins: deletar e completar (semana 6–8)

**Objetivo:** capturar o envelope barato de desinflamento e fechar meia-integrações. Cada item é um PR pequeno e independente.

| # | Item | IDs | Redução |
|---|---|---|---|
| 4.1 | Reachability dos 11 módulos suspeitos (metafile + dynamic imports); classificar integrar/deletar/documentar; **decisão oposta para worktree-removal-safety** (integrar a proteção ou provar duplicação) | TD-01 | 300–1.100 LOC + testes |
| 4.2 | Retirar harness real-mission-e2e do grafo de release: entrypoint dedicado + capability injection mínima | TD-02, ARCH-01 | 2.538 LOC fora do release; metafile como prova |
| 4.3 | Manifests gerados → artefatos de build com digest | TD-03 | ~1,9 MB fora da árvore |
| 4.4 | Cost bridge: completar (canais em shared + bridge no preload) **ou** deletar store+handlers — decisão binária | FUNC-01 | fim do no-op silencioso |
| 4.5 | MCP Hub health: adapter por transporte com probe/timeout/backoff; estados configured/connecting/healthy/degraded/offline | FUNC-02 | UI deixa de mentir |
| 4.6 | Remover `buildMissionKickoffPrompt` legado após prova de reachability | TD-17 | dezenas de LOC |
| 4.7 | Centralizar schema puro de model ID | TD-18 | pequena |
| 4.8 | Corrigir testes cross-fronteira main/renderer (mover lógica pura para shared) | TD-19 | neutra |

**Gate de saída:** deletion test documentado por PR (LOC líquido removido); metafile do release sem módulos E2E; `e2e:real-mission` verde na variante de teste.

---

### Etapa 5 — Seams privilegiados: IPC, OAuth, CSP (semana 8–12)

| # | Item | IDs | Notas |
|---|---|---|---|
| 5.1 | Module main-only `trusted-ipc` com `handleTrusted/onTrusted` (validação exata de main-frame/protocol/host, deny-by-default, log sem payload); migrar mutadores primeiro: settings, account, provider-config, updater, team | SEG-05 | 301 handlers inventariados; ordem por privilégio |
| 5.2 | OAuth window: allowlist de origens por provider + callback loopback exato; redirect fora da lista interrompe o fluxo | SEG-08 | Testes: cross-origin, punycode, subdomínio enganoso, IPv6 |
| 5.3 | CSP: isolar WASM/worker em contexto dedicado se viável; corrigir a divergência doc↔código; teste negativo de sink injetado | SEG-13 | Auditoria de sinks vira check de CI |
| 5.4 | orch-ipc → Adapter fino: extrair NativeAttestation e SquadFileExchange como módulos profundos; bootstrap/close separados do registro | TD-06 | 250–450 LOC prod + 500–800 testes |
| 5.5 | Preload por domínio: `create*Bridge` para orch/voice/pet + helper tipado de subscribe; teste de contrato com IpcRenderer fake | TD-07 | Elimina a classe de bug do FUNC-01 |

**Gate de saída:** testes com frames atacantes (navegação, janela destruída, sender desconhecido); contrato do preload enumera chaves/canais/cleanup.

---

### Etapa 6 — Servidor e supply chain (semana 10–13, paralelizável com 5)

| # | Item | IDs |
|---|---|---|
| 6.1 | Rate limit: modo de deploy codificado (single vs Redis/Postgres compartilhado); trust proxy como config validada; smoke multi-instância | SEG-11 |
| 6.2 | Security headers no app (HSTS, nosniff, frame-ancestors, referrer) + smoke externo no domínio real | ARCH-04 |
| 6.3 | Catálogo: manifesto assinado pelo Nexus (item → publisher/commit/digest), verificado antes do download; UI separa curado de comunitário | SEG-07 |
| 6.4 | Sandbox Windows: SBOM + scan + assinatura da imagem; Doctor verifica antes de declarar ready | SEG-09 |
| 6.5 | Modo LAN: manter local como default; documentar/exigir CA ou VPN em ambiente hostil; fingerprint fora de banda se companion nativo | SEG-10 |

**Gate de saída:** teste concorrente contra duas instâncias; Doctor rejeita imagem sem assinatura; headers verificados no endpoint público.

---

### Etapa 7 — Lifecycle profundo: Pane/PTY/Browser/OMP (semana 12–20)

**Esta é a fase de maior risco. Pré-condição: Etapas 0–5 no verde.** Uma fatia por vez, na ordem abaixo, e TD-05+TD-13 como **um único design** (ver análise 1.4.3).

| # | Item | IDs | Redução |
|---|---|---|---|
| 7.1 | `PaneLifecycleCoordinator` no main (registry + PTY como adapters), começando por recovery sem mudar IPC; renderer só aplica layout e relata físico. Inclui `TerminalSurfaceLifecycle` no renderer | TD-05 + TD-13 | 700–1.400 LOC combinadas |
| 7.2 | `BrowserSession` encapsulando owner/scope; `BrowserAutomationCommand` único; design-session por adapter | TD-08 | 250–500 LOC |
| 7.3 | `SessionHost` profundo no OMP RPC; IPC vira tradução de ownership/payload | TD-10 | 200–450 LOC |

**Gates por fatia (do relatório, §Gates mínimos):** owner/cross-window/scope, reload, morte do PTY Host, saída física, grid/canvas; SSRF/DNS pinning no browser; reconnect/cancelamento/login no OMP; smoke empacotado multiprocesso em cada uma.

---

### Etapa 8 — Voz e autoridade de missão (semana 18–26, paralelizável com 7)

| # | Item | IDs | Redução |
|---|---|---|---|
| 8.1 | `VoiceSessionCoordinator` com estado privado e interface comportamental pequena; hook React vira adapter; migrar wake → captura → finalização primeiro; substituir os 15 testes de wiring textual por testes de comportamento | TD-04, QUAL-02 | 700–1.200 LOC |
| 8.2 | Autoridade de missão no main: transições e construção de candidato saem do renderer; schema puro de mission draft; uma transição por vez | TD-11 | 400–700 LOC |
| 8.3 | Módulo de aplicação de workflow separado das tools MCP de contexto; tools ficam como validação/tradução | TD-12 | 250–500 LOC |

**Gates:** wake/PTT/barge-in/cancel/fallback Classic↔Gemini/uma única saída TTS; kickoff/aprovação/revogação/recovery/bearer com paridade do wizard; contratos PREVC, CAS/revision, merge/recovery.

---

### Etapa 9 — Consolidação contínua e mapa vivo (a partir da semana 8, fundo contínuo)

| # | Item | IDs |
|---|---|---|
| 9.1 | Marcar ARCHITECTURE.md como histórico; criar índice arquitetural vivo curto + glossário de domínio (mission, pane, session, bearer, intent, squad, workflow); ADRs já nascem nas Etapas 1–3 | ARCH-02, TD-20 |
| 9.2 | Tipos compartilhados por domínio; `NexusApi` tipado derivado dos bridges da Etapa 5.5; remover runtime Node de shared | TD-14 |
| 9.3 | Repositório profundo de persistência (load/save/atomicidade/masking/broadcast) para os 4 stores; vocabulário de domínio fora dele | TD-15 |
| 9.4 | Normalizadores de hooks por `AgentHookAdapter` (17 providers); rejeitar se só redistribuir linhas | TD-09 |
| 9.5 | Destino de mobile/companion executado conforme ADR da Etapa 0.3; companion com fontes legíveis gerando o worker no build | TD-16 |
| 9.6 | Cobertura por domínio de política + mutation testing nos gates críticos (consent, destructive detector, sender validation, path policy); relatório publicado no CI | QUAL-02 |

**Gate permanente:** deletion test por PR; métricas de programa (LOC líquido, cobertura por domínio de política, mutantes mortos) revistas mensalmente.

---

### Cronograma consolidado

```
Sem        2    4    6    8    10   12   14   16   18   20   22   24   26
Etapa 0  [==]
Etapa 1     [==]
Etapa 2        [=====]
Etapa 3           [=====]
Etapa 4              [====]
Etapa 5                 [======]
Etapa 6                    [=====]
Etapa 7                       [==========]
Etapa 8                          [==========]
Etapa 9              [======== contínuo ========]
```

Esforço total estimado: **~6 meses com 1–2 sêniores a ~50%**, próximo do envelope do relatório (12–26 semanas) adicionando o custo real das migrações de segredos e da decisão de produto.

### Riscos do plano e mitigações

- **Decisões de produto travarem a Etapa 1** → dono nomeado e data limite; na ausência de decisão, o default é containment-first/prevc-required (fail-closed), que é reversível.
- **Migração de segredos quebrar usuários existentes** → rollback protegido é requisito de aceite da 3.2, não opcional; formato antigo lido por uma release inteira antes de apagar.
- **Refatorações P1 (Etapas 7–8) regredirem comportamento sutil** → suíte de caracterização da Etapa 1.5 é a régu; nenhuma fatia entra sem ela verde.
- **Scope creep no lint/CI** → baseline mínimo deliberado; regras novas só com justificativa de bug real evitado.
- **Plano virar papel** → um owner de programa, WIP máximo de 2 etapas ativas, revisão mensal das métricas da 9.6.
