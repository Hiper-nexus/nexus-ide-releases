# Handoff — Nexus IDE

Branch `security/p0h1-mission-projection-hardening` · último commit `51872948`
258 arquivos modificados + 34 novos, **nada commitado**.

---

## 1. Onde parou

A missão **ainda não roda de ponta a ponta**: o coordenador é reprovado no passo
Equipe. Quatro hipóteses foram medidas e descartadas — **a causa continua em
aberto** e não há conserto pronto para aplicar. Detalhe na seção 3.

---

## 2. Feito nesta rodada (com prova)

### 2.1 Motor de missão — a missão agora fecha sozinha
**Problema:** trabalho 100% concluído e a missão ficava `running` para sempre.
O driver decidia `wait` com o motivo `terminal completion is verifier-owned`,
esperando um selo que nunca vinha.

**Conserto:** `DriveAction` ganhou `complete`; os três portões (`workProven`,
`workDoneUnproven`, `allStepsDone`) agora **fecham** em vez de bloquear;
`completeMission` implementado sobre `MissionEngine.completeVerified`.

| Arquivo | Mudança |
|---|---|
| `src/main/orch/mission-drive.ts` | `DriveAction.complete` + 3 portões abertos |
| `src/main/orch/mission-driver-apply.ts` | `case 'complete'` → `completeMission` |
| `src/main/orch/mission-driver-io.ts` | porta `completeMission` sobre `completeVerified` |
| `src/main/orch/mission-completion-invariant.test.ts` | 4 invariantes reescritos |

**Prova:** 107/107 testes do motor verdes · typecheck limpo.
Driver confirmado em `active` por padrão (`missionDriverActiveMode: default(true)`).

### 2.2 Paralelismo — largada de 4 terminais, teto de 7
**Problema:** missão abria com 2 terminais e subia para 3. O gargalo era o
roster recomendado de 3 papéis, não a máquina.

| Arquivo | Mudança |
|---|---|
| `src/main/orch/mission-scheduler.ts` | `DEFAULT_ADAPTIVE_CAP.currentCap` 2 → 4 |
| `src/renderer/components/mission/TeamStep.tsx` | presets **3 Enxuta / 5 Padrão / 8 Força total** |
| `src/renderer/styles/mission-setup.css` | cards de preset |

Nesta máquina (10 núcleos): `paneBudget 14`, `cores-2 = 8`, roster 8 →
**7 terminais em paralelo**, largando com 4.
Os limites reais continuam intactos — nada fura hardware nem orçamento de panes.

**Prova:** 149/149 testes de missão · 18/18 da escada · verificado na tela.

### 2.3 Paridade visual com o Bridge (7 superfícies)
Missão, Equipe, Revisar, Board, Quadro, Memória, Configurações.
- Board com barra de direção; Quadro virou **kanban por status**
  (`A FAZER / EM ANDAMENTO / CONCLUÍDA`) com acento por coluna.
- Memória: criado `memory-note-readable.ts` — remove scaffolding YAML/HTML e
  UUIDs de 36 chars que vazavam para a tela.
- **Badge de ícone no cabeçalho** das 3 superfícies que compartilham
  `product-workspace__header` (Memória `file`, Quadro `board`, Terminal `terminal`).

**Prova:** 264 arquivos / 1876 testes de renderer verdes · comparação lado a
lado em `/tmp/nexus-vs-bridge-full.png`.

### 2.4 Botão "Abrir contexto" — parou de roubar o clique do X
**Problema (reportado com print):** a pílula flutuava em `right:8px; top:48px`,
exatamente sobre a barra de ações do pane (`Ampliar · À direita · Abaixo · ✕ Fechar`).

**Conserto:** virou **aba estreita na borda direita**, centro vertical — a única
faixa livre (o topo é do pane, o rodapé é do HUD de voz). 18px de largura,
ícone `chevron` girado 180° apontando para de onde o painel surge.

| Arquivo | Mudança |
|---|---|
| `src/renderer/components/ContextualPanel.tsx` | texto → ícone |
| `src/renderer/styles/product-wave.css` | `right:0; top:50%; translateY(-50%)`; raio `8px 0 0 8px` |

**Prova:** 5/5 testes · typecheck limpo · **verificado na tela** (`/tmp/fix-01.png`):
barra de ações totalmente livre.

### 2.5 Readiness — CLI de assinatura própria deixou de ser reprovada
`isAdapterModelAuthenticated` exigia o modelo dentro de `authReadyModels`.
Lista **vazia** não é "nada autorizado" — é ausência de informação, que é
exatamente o que uma CLI de assinatura própria produz.

`src/renderer/orch/mission-runtime-readiness.ts`:
- lista **não vazia** → continua autoritativa (granularidade por modelo preservada);
- lista **vazia** → aceita `authStrategy` `subscription` / `credentialless`.

**Prova:** 10/10, incluindo o caso negativo — `login-needed` sem conta **continua recusado**.

### 2.6 Auditoria honesta das 15 flags
14 portam comportamento real (`requireFlag` derruba o handler IPC).
**1 está morta:** `feature.autonomy.profiles` — zero consumidores no renderer,
só o próprio teste de default. Ligar não muda nada visível.

---

## 3. Bloqueio atual — causa **ainda em aberto**

**Sintoma:** no passo Equipe o coordenador aparece com
*"Precisa de ajuste — A ferramenta escolhida não está pronta para este papel"*.
A missão não começa.

**Não é o CLI.** Medido nesta máquina:

```
claude --version               2.1.226
claude --model claude-sonnet-5 responde OK
```

**A cadeia real, medida com sonda (`/tmp/auth-probe.mts`):**

```
keychain (sync)              = true    credencial EXISTE
detect file-only             = false   não há arquivo
detect com keychain          = true    detecção completa APROVA
hasSubscriptionAuthForStatus = false   o caminho que a UI usa REPROVA
```

O Claude Code guarda a credencial **no Keychain do macOS**
(`security find-generic-password -s "Claude Code-credentials"`), sem arquivo.
`hasSubscriptionAuthForStatus` olha **só arquivo**, de propósito — a consulta ao
keychain custa **346 ms medidos** por chamada e travaria o event loop do Electron
a cada snapshot. Há teste protegendo isso
(*"warms a Keychain-only Claude status asynchronously without poisoning the cold cache"*).
**Tentei encurtar o prazo para 400ms e revertei** — o custo é real e o teste está certo.

**Onde a investigação parou — e uma correção honesta:**
`provider-config-store.ts:1331` dispara o aquecimento assíncrono no
`providers.list` e **re-transmite** quando o cache esquenta. Existe um store
vivo que escuta (`provider-store.ts:62`, montado em `App.tsx:249`).

> **Errei numa versão anterior deste documento.** Escrevi que a wizard não
> ouvia esse aviso e que faltava um conserto de ~3 linhas. **Não falta.**
> `MissionSetup.tsx:222` já lê `useProviderStore` e `MissionSetup.tsx:348-368`
> já recomputa `missionRuntimeReadiness` sempre que `liveProviders` muda.
> A ligação está feita. **Não escreva esse código de novo.**

Ou seja: a causa do veredito *"não está pronta"* **continua em aberto**. O que
já está descartado, com medição:

| Hipótese | Veredito |
|---|---|
| CLI quebrada ou deslogada | **descartada** — `claude --model claude-sonnet-5` responde OK |
| Modelo fora de `authReadyModels` | **descartada** — corrigido na seção 2.5, 10/10 |
| Wizard não escuta mudança de provider | **descartada** — ligação já existe |
| Sonda de keychain no caminho de status | **descartada como conserto** — 346 ms medidos, há teste protegendo |

### Próximo passo de diagnóstico (não de código)

Falta observar o que o app **realmente** projeta em runtime. Duas suspeitas
ainda não medidas:

1. `security` pode ser negado dentro do Electron (TCC), embora funcione no
   terminal — aí `refreshClaudeSubscriptionAuthCache` nunca vira `true`.
2. `claude` pode estar caindo fora de `verifiedMaestros` por
   `missionControlCapable !== true`, e não por autenticação
   (`mission-runtime-readiness.ts`, filtro sob política `operator-choice`).

Sonda pronta e reutilizável: **`/tmp/auth-probe.mts`**
(`node --import tsx /tmp/auth-probe.mts`). Ela já imprime os quatro valores
citados acima. Falta o equivalente **dentro do Electron** — um log pontual em
`provider-config-store` na hora de montar o snapshot resolve, ou reativar o
DevTools remoto (o `DevToolsActivePort` diz `9222`, mas o endpoint HTTP estava
mudo nesta sessão).

---

## 4. Pendente

| # | Item | Estado |
|---|---|---|
| 1 | **Achar por que o coordenador é reprovado** | causa **não identificada**; hipóteses já descartadas na seção 3. Bloqueia todo o resto |
| 2 | **Rodar missão de PRD ponta a ponta** | repo de teste criado em `/tmp/nexus-prd-lab`; bloqueado pelo item 1 |
| 3 | `feature.autonomy.profiles` morta | decidir: ligar na UI ou remover do Labs. Começado, interrompido |
| 4 | Gate completo pós-edições | último: **11270/11271** — a única falha (`cron-routes`) passa isolada 18/18, é pressão de CPU do PostgreSQL-WASM sob 4 workers |
| 5 | Commit / push / release | 258+34 arquivos soltos; versão já subida `0.28.1 → 0.30.0` em `package.json`, lock e `server/`; **nada empurrado**, sem upstream |

### Sobre o item 4 — atenção ao rodar testes
Se aparecerem ~430 falhas de uma vez, **não é regressão**: é ABI.
O app rodando recompila `better-sqlite3` para Electron (`NODE_MODULE_VERSION 148`)
e o vitest precisa de Node (`127`).

```bash
# pare o app antes
npm run rebuild:node
```

---

## 5. Como retomar

```bash
cd /Users/cleofasrocha/dev/nexus-ide

# 1. diagnosticar o item 1 — NÃO há conserto pronto para aplicar

# 2. validar o alvo
npx vitest run src/renderer/components/mission
npx tsc --noEmit -p tsconfig.json

# 3. subir o app e provar na tela
#    (perfil de dev: .dev-user-data-v2-live-fix)
NEXUS_USER_DATA_DIR=.dev-user-data-v2-live-fix npm run start

# 4. gate completo, com o app PARADO
npm run rebuild:node && npm test
```

### Decisões de release ainda em aberto
1. **Destino** — merge/PR para `main`, ou empurrar a branch `security/p0h1-...`?
2. **Versão** — `0.30.0` já está escrita nos arquivos. Confirmar ou reverter.
3. **Escopo do commit** — um único commit grande, ou separado em blocos lógicos
   (UI Bridge · motor+GLM · robustez e testes)? Recomendo separado: fica revisável.
