# Gamificação NexusIDE — Sistema "Power-Scaling" (design)

Data: 2026-07-06 · Status: design aprovado (rev. 2, pós-review adversarial),
aguardando plano de implementação.

Sistema de gamificação in-app do NexusIDE. Primeira de duas entregas que
compartilham uma identidade (a segunda — a landing page pública — terá spec
própria). Esta spec cobre a **identidade compartilhada** (mascote/logo, tiers,
regras de XP) + o **sistema in-app**.

---

## 1. Princípio norteador (não-negociável)

**XP = valor entregue, NUNCA consumo.** O jogador sobe de poder por *shipar*
(missão verde, handoff verde, feature/bug), não por queimar tokens. Token gasto
é estatística secundária, jamais fonte de XP. A eficiência (entregar barato) é
recompensada com bônus. Isso alinha o incentivo do usuário (entregar mais, gastar
menos) com o nosso, e evita gamificar a conta — o que quebraria a confiança num
SaaS pago.

Uma frase: *a ferramenta que te sobe de nível te ajudando a shipar — e ainda
mostra o quanto você economizou.*

---

## 2. Identidade

### Mascote = marca (logo)
Um mascote pixel-art **original** — nome de trabalho **"o Operador"** (um nome
próprio de marca pode ser dado na fase de branding; no código/dados ele é
`operator`, o nome exibido é uma string de copy trocável sem impacto). Ele é ao
mesmo tempo:
- o **companheiro de gamificação** (evolui no HUD conforme você joga), e
- o **logo/marca** do produto (padrão Octocat/Tux/Freddie: a mascote É o ícone).

Um sistema só. Funciona como ícone do app, favicon (16px) e menu bar — pixel art
brilha em tamanho minúsculo. Wordmark **"NEXUS"** em tipografia pixel/terminal.

**Guardrails de IP (obrigatórios):** design 100% original — silhueta própria,
família de paleta distinta de qualquer mascote concorrente do segmento, nenhum
elemento derivado de IP de terceiros (Nintendo, Toei etc.). Processo de criação
documentado (iterações salvas) como proveniência para registro de marca.

**Spec de asset (trava o caminho crítico):** grade base **32×32** (HUD usa 24px,
perfil usa 64/96px em escala inteira), paleta de **16 cores** definida no design
system, entregue como **sprite sheet** com estados: idle, celebrando (entrega
verde), evoluindo (transição de tier), dormindo (sem atividade). Animações por
frames (sem interpolação suave — é pixel art), 2–4 frames por estado.

### Power Level (o número épico)
Número grande e cumulativo (ex.: `35.500.000`) = total de XP-por-entrega
acumulado. É o herói do HUD e do perfil. Sobe visivelmente ao entregar. A curva
de tier é **exponencial** (cada banda ~3–4× a anterior): primeiras evoluções
rápidas (hook), últimas são status real.

### Tiers (bandas de poder nomeadas)
O power level cai em bandas; cada banda evolui o visual/aura do mascote:

`RECRUTA → INICIADO → VETERANO → ELITE → MAESTRO → LENDA`

(MAESTRO é também o nome do orquestrador no app — amarra a metáfora. O tier 2
chama-se INICIADO para não colidir com o nome de trabalho do mascote.) Limiares
numéricos são constantes calibráveis definidas no plano, seguindo a curva
exponencial.

**Endgame — Prestígio:** ao alcançar LENDA, o jogador pode **transcender**:
o power level reseta para a nova jornada, e o mascote ganha uma marca visual
PERMANENTE e cumulativa (estrela/aura de transcendência — 1★, 2★…). Progressão
nunca morre; o veterano exibe as estrelas. (v1 já define a regra; a arte da
marca de prestígio pode chegar depois do primeiro usuário atingir LENDA.)

### Evolução por estilo de jogo
Rastreamos a proporção do jogo do usuário e o mascote **ramifica** o visual
(mesma escada de poder, identidades diferentes → apego + rejogabilidade):
- **Guardião** — quem entrega muito código revisado/testado (peso reviewer).
- **Forja** — quem prototipa/constrói rápido (peso builder/executor).
- **Scout** — quem pesquisa/mapeia muito (peso scout/architect).

A ramificação usa as categorias de agente que já existem nos squads,
ponderadas pelas entregas do usuário. Perfil equilibrado permanece no visual
base ("híbrido") até um estilo dominar (limiar definido no plano). Sem respec
manual na v1 — o visual segue o jogo real.

**Escopo de arte na v1:** a LÓGICA de ramificação entra completa, mas a arte
da v1 cobre o **ramo base + 1 ramo completo** (o de maior apelo visual); os
outros 2 ramos ganham arte em release subsequente. Isso tira a produção de
assets do caminho crítico sem retrabalho de código.

---

## 3. Modelo de XP

Eventos de domínio → pontos (valores base calibráveis no plano):

| Evento | Fonte (já existe) | Peso |
|---|---|---|
| Missão concluída **verde** (com evidência — ver abaixo) | mission-store status + evidência | alto, **escalado pelo tier da tarefa** |
| Handoff entregue com status `success` | `onHandoffSubmitted` / handoff-store | médio, escalado pelo tier |
| Feature/ship, bug fechado | task-store (tasks done) | médio/alto |
| Mídia gerada (primeira de cada tipo → conquista) | media_usage | baixo + conquista |
| **Multiplicador de eficiência** | custo real (usage-store + media_usage) vs banda de referência | +% sobre o XP base da missão |

### Anti-farm (obrigatório)
- **XP escalado pelo tier da tarefa** que o `nexus_route_task` já classifica
  (`trivial|easy|medium|hard|critical`): missão trivial rende pouco; critical
  rende muito. Fatiar trabalho em migalhas deixa de pagar.
- **Retorno decrescente diário**: a partir da N-ésima entrega do MESMO tier no
  mesmo dia, o XP daquele tier decai (curva definida no plano). Zera à meia-noite.
- **Idempotência**: cada evento de XP tem chave única (`(tipo, id-da-entidade)`,
  `UNIQUE` no SQLite) — nunca XP duplo pelo mesmo handoff/missão.
- Handoff `failed`/`blocked` não dá XP (não premiar tentativa fracassada).

### O que conta como "verde" (evidência, não auto-relato)
Handoff `success` é auto-reportado pelo agente — sozinho ele NÃO basta para o
peso "verde". Uma entrega é **verde** quando há evidência de verificação:
- saída de test/lint capturada do pane com exit 0 (os comandos reais do projeto,
  que os squads já cobram nos gates), OU
- gate de missão marcado como passado pelo orquestrador com o log anexado.

O evento de XP **grava a evidência** (referência ao trecho de output + comando).
Entrega `success` sem evidência ganha o peso menor "entrega simples". Quando o
leaderboard de time subir, o backend revalida a partir da evidência gravada —
integridade competitiva desenhada desde já.

### Multiplicador de eficiência (bandas fixas, não média própria)
Comparar com a média móvel do PRÓPRIO usuário pune quem melhora (a média cai
junto) e sofre cold start. Em vez disso: **bandas de referência fixas de custo
por tier de tarefa** (tabela calibrada por nós, versionada, revisável):
- custo real da missão abaixo da banda "eficiente" do seu tier → bônus (até +50%);
- dentro da banda normal → sem bônus; sem tier registrado → neutro.
Estável, sem cold start, sem erosão — e o roteamento barato (`nexus_route_task`)
vira skill permanentemente visível.

### Versionamento de regras
Pesos/curvas/bandas carregam uma **versão de regra**. Eventos são event-sourced;
o agregado pode ser recomputado com regras novas quando quisermos rebalancear
(política padrão: re-score total em minor releases de regra; nunca reduzir tier
já alcançado — piso de tier é mantido).

---

## 4. Componentes & UI

1. **HUD do Operador** — canto, sempre visível (exceto modo sóbrio). Mascote
   pixel + power level + tier + barra pro próximo nível. Reage em tempo real
   (pulso/aura ao entregar verde; o power level "conta" subindo). Discreto por
   padrão (respeita "densidade calma"), expande no hover. Respeita
   `prefers-reduced-motion`.
2. **Tela "Perfil de Operador"** — abrível. Mascote grande na evolução atual;
   power level; tier atual + próximos; estrelas de prestígio; **breakdown de XP
   por tipo de entrega**; eficiência (custo vs banda de referência); streak;
   grid de conquistas; skins; export/import de perfil.
3. **Conquistas** (~12–15) — sobre marcos que **já rastreamos**: primeiro squad,
   primeira missão agêntica, primeira mídia gerada, 100 handoffs, primeira missão
   verde sem retrabalho, N missões na banda eficiente, streak de X dias úteis,
   primeira evolução de ramo, primeiro prestígio, etc. (lista final no plano).
4. **Streak com misericórdia** — shipping streak conta **dias úteis** (fim de
   semana não quebra) e o jogador ganha **2 escudos/mês** (um dia útil sem
   entrega consome escudo em vez de zerar). Férias não viram punição.
   **Dailies ficam FORA da v1** — o streak sozinho sustenta o hábito; metas
   diárias mal calibradas viram tarefa chata.
5. **Skins do mascote** — desbloqueáveis por conquista (v1).
6. **Leaderboard de time (opt-in)** — pontuado por entrega, nunca por gasto.
7. **Celebrações com voz (diferencial)** — level-up/evolução/conquista são
   narrados pelo **jarvis-narrator** que já existe ("Subiu para ELITE. 47
   missões verdes."), respeitando as regras de anti-tagarelice atuais (só em
   modo jarvis, debounce, nunca sobrepor turno de voz). Nenhum concorrente tem
   gamificação falada. Level-up também vira highlight no **thin client mobile**.
8. **Modo sóbrio (obrigatório para SaaS)** — toggle em Settings que oculta HUD,
   celebrações e narração de gamificação. O XP continua acumulando em silêncio
   (religar não perde nada). Default: ligado para contas pessoais; comprador
   enterprise pode exigir desligado por padrão via config de time (futuro).

### Estreia — XP retroativo (o momento uau)
No primeiro boot com o sistema, um **replay do histórico existente** (missões,
handoffs, tasks, mídia já no SQLite) computa o XP retroativo: o usuário abre o
app e descobre que **já é VETERANO com 12M de power level** — o sistema nasce
sendo dele, não um brinquedo zerado. (Evidência de "verde" não existe no
histórico antigo: entregas antigas contam com o peso "entrega simples".)

---

## 5. Arquitetura & dados

- **XP engine puro** (`src/main/gamification/xp-engine.ts`): função pura
  `evento de domínio → pontos`, sem electron, 100% testável. Contém tabela de
  pesos, escala por tier, retorno decrescente, multiplicador por banda,
  idempotência e versão de regra.
- **`gamification-store` (SQLite compartilhado)**: eventos de XP (event-sourced,
  auditável, `UNIQUE` na chave de idempotência, evidência anexada), agregado
  (power level, tier, piso de tier, prestígio, ramo), streak + escudos,
  conquistas, skins. O agregado é cache derivável dos eventos.
- **Integração via eventos existentes** (read-model, não novo tracking):
  `onHandoffSubmitted`, status de missão, task-store, `media_usage`, decisões do
  router (tier), `usage-store` (custo real p/ eficiência).
- **IPC + UI**: `gamification:snapshot` (pull) + `gamification:changed`
  (broadcast coalescido, padrão cost/usage). Renderer: HUD + tela de perfil.
- **Export/import de perfil (v1)**: JSON assinado com os eventos (não só o
  agregado) — resolve multi-máquina hoje e é a semente do sync do SaaS.
- **Local-first**: tudo acima funciona 100% offline.
- **i18n**: todo copy de gamificação (tiers, conquistas, narração) em tokens de
  string desde o dia 1 — PT-BR primeiro, EN barato depois (SaaS global).

### As duas peças com dependência externa (gated)
- **Leaderboard de TIME** — requer backend. **v1**: recordes/estatísticas
  **pessoais** + estado "conecte seu time quando o SaaS estiver no ar". Sync
  atrás de flag (`NEXUS_BACKEND_URL`). No backend, o XP que conta para ranking é
  **revalidado a partir da evidência** gravada nos eventos (não confia no cliente).
- **Loja PAGA de skins** — requer billing vivo. **v1**: skins por conquista.
  Loja paga atrás do flag de billing. Cosmético nunca tranca funcionalidade.

---

## 6. Escopo

### v1 (local-first — sai completo)
HUD do Operador · Perfil de Operador · power level + tiers + prestígio (regra) ·
XP engine (tier-scaled, anti-farm, evidência de verde, bandas de eficiência,
versionamento) · XP retroativo na estreia · lógica de ramificação completa +
arte do ramo base + 1 ramo · ~12–15 conquistas · streak com escudos ·
skins por conquista · celebração por voz (jarvis-narrator) · modo sóbrio ·
export/import de perfil · leaderboard em modo recordes pessoais.

### Releases subsequentes
Arte dos 2 ramos restantes · arte da marca de prestígio · dailies (se métricas
pedirem) · highlight de level-up no thin client mobile.

### Gated (desenhado, atrás de flag)
Sincronização de leaderboard de time (backend, com revalidação por evidência) ·
loja paga de skins (billing).

### Fora de escopo (spec própria depois)
- **Landing page pública** power-scaling — usará esta identidade como prova real.
- Produção dos assets finais além do escopo v1 (segue a spec de asset da §2).

---

## 7. Qualidade, segurança & privacidade

- **Anti-trapaça**: local é honor-system mitigado por evidência (§3); ranking de
  time só com revalidação no backend.
- **Privacidade**: leaderboard e qualquer dado compartilhado são **opt-in
  explícito** (default off). Todo o resto vive 100% local em `~/.nexus`. Nunca
  compartilhar custos sem consentimento.
- **Acessibilidade**: HUD respeita `prefers-reduced-motion`; contraste AA;
  narração de voz nunca é o único canal de um evento (sempre há UI).
- **Testes**: XP engine, tier/curva, retorno decrescente, bandas de eficiência,
  streak/escudos e prestígio são puros e cobertos por unit tests; store com
  SQLite in-memory (padrão do repo); replay retroativo testado com fixture de
  histórico real.

### Critérios de sucesso (medidos localmente, exibidos opt-in)
- Retenção: usuários com gamificação ativa voltam mais (D7/D30 vs modo sóbrio).
- Engajamento: % de usuários que abrem o Perfil de Operador na primeira semana.
- Incentivo correto: custo médio por missão **cai** após a estreia (a eficiência
  está sendo jogada) — se subir, as regras estão erradas e o rebalanceamento
  (versão de regra) corrige.

---

## 8. Racional (por que assim)

- **Reusa o que já existe** (telemetria real, stores de missão/handoff/task,
  tiers do router, vitórias de onboarding, jarvis-narrator) → esforço em dias.
- **XP por entrega com evidência e anti-farm** é o diferencial honesto e
  defensável: não gamifica a conta, premia shipar e economizar, e aguenta
  escrutínio quando virar competitivo.
- **Mascote = marca** unifica gamificação e identidade num único ativo memorável
  e alimenta a landing com material real.
