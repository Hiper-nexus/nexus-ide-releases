# Gamificação NexusIDE — Sistema "Power-Scaling" (design)

Data: 2026-07-06 · Status: design aprovado, aguardando plano de implementação.

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
Um mascote pixel-art **original**, o **Operador**. Ele é ao mesmo tempo:
- o **companheiro de gamificação** (evolui no HUD conforme você joga), e
- o **logo/marca** do produto (padrão Octocat/Tux/Freddie: a mascote É o ícone).

Um sistema só. Funciona como ícone do app, favicon (16px) e menu bar — pixel art
brilha em tamanho minúsculo. Wordmark **"NEXUS"** em tipografia pixel/terminal.

### Power Level (o número épico)
Número grande e cumulativo (ex.: `35.500.000`) = total de XP-por-entrega
acumulado. É o herói do HUD e do perfil. Sobe visivelmente ao entregar.

### Tiers (bandas de poder nomeadas)
O power level cai em bandas; cada banda evolui o visual/aura do mascote:

`RECRUTA → OPERADOR → VETERANO → ELITE → MAESTRO → LENDA`

(MAESTRO é também o nome do orquestrador no app — amarra a metáfora.) Os limiares
numéricos de cada banda são calibráveis (constantes), definidos no plano.

### Evolução por estilo de jogo
Rastreamos a proporção do jogo do usuário e o mascote **ramifica** o visual
(mesma escada de poder, identidades diferentes → apego + rejogabilidade):
- **Guardião** — quem entrega muito código revisado/testado (peso reviewer).
- **Forja** — quem prototipa/constrói rápido (peso builder/executor).
- **Scout** — quem pesquisa/mapeia muito (peso scout/architect).

A ramificação usa as categorias de agente que já existem nos squads
(scout/builder/reviewer/architect) ponderadas pelas entregas do usuário.

---

## 3. Modelo de XP

Eventos de domínio → pontos (valores base calibráveis no plano):

| Evento | Fonte (já existe) | Peso |
|---|---|---|
| Missão concluída **verde** (status done, gates passando) | mission-store status | alto |
| Handoff entregue com status `success` | `onHandoffSubmitted` / handoff-store | médio |
| Feature/ship, bug fechado | task-store (tasks done) | médio/alto |
| Mídia gerada (primeira de cada tipo → conquista) | media_usage | baixo + conquista |
| **Multiplicador de eficiência** | comparação custo real (usage-store) vs média móvel da tarefa | +% sobre o XP base da missão |

Regras:
- **Handoff `failed`/`blocked` não dá XP** (não premiar tentativa fracassada).
- **Multiplicador de eficiência**: se o custo real da missão (telemetria de token +
  mídia) ficou abaixo da **média móvel do custo por tier de tarefa** — usando a
  classificação de tier que o `nexus_route_task` já produz
  (`trivial|easy|medium|hard|critical`) como agrupamento — aplica bônus (ex.: até
  `+50%`). Torna o roteamento por custo uma skill visível. Missões sem tier
  registrado não recebem multiplicador (base neutra).
- **Token gasto nunca vira XP.** Aparece só como estatística no perfil.
- **Idempotência**: cada evento de XP é registrado com uma chave única (ex.:
  `(tipo, id-da-entidade)`) para nunca dar XP duplo no mesmo handoff/missão.

---

## 4. Componentes & UI

1. **HUD do Operador** — canto, sempre visível. Mascote pixel + power level + tier
   + barra pro próximo nível. Reage em tempo real (pulso/aura ao entregar verde; o
   power level "conta" subindo). Discreto por padrão (respeita "densidade calma" da
   marca), expande no hover. Respeita `prefers-reduced-motion`.
2. **Tela "Perfil de Operador"** — abrível. Mascote grande na evolução atual;
   power level; tier atual + próximos; **breakdown de XP por tipo de entrega**;
   multiplicador de eficiência (custo vs média); streak; grid de conquistas; skins.
3. **Conquistas** (~12–15) — sobre marcos que **já rastreamos**: primeiro squad,
   primeira missão agêntica, primeira mídia gerada, 100 handoffs, primeira missão
   verde sem retrabalho, N missões abaixo do custo, streak de X dias, primeira
   missão em cada ramo de evolução, etc.
4. **Streaks / dailies** — shipping streak (dias consecutivos com ≥1 entrega verde)
   + metas diárias leves (ex.: "feche 1 missão verde hoje"). Anti-churn.
5. **Skins do mascote** — desbloqueáveis por conquista (v1).
6. **Leaderboard de time (opt-in)** — pontuado por entrega, nunca por gasto.

---

## 5. Arquitetura & dados

- **XP engine puro** (`src/main/gamification/xp-engine.ts` ou equivalente): função
  pura `evento de domínio → pontos`, sem electron, 100% testável. Contém a tabela
  de pesos, o cálculo do multiplicador de eficiência e a regra de idempotência.
- **`gamification-store` (SQLite compartilhado)**: tabelas para eventos de XP
  (event-sourced, auditável, `UNIQUE` na chave de idempotência), estado agregado
  (power level, tier, ramo de evolução), streak, conquistas desbloqueadas, skins
  possuídas. O power level é derivável dos eventos (o agregado é cache).
- **Integração via eventos existentes** (read-model, não novo tracking): assinar
  `onHandoffSubmitted`, mudanças de status de missão, `media_usage`, e ler
  `usage-store` para o multiplicador de eficiência. Sem instrumentar nada novo no
  fluxo de trabalho.
- **IPC + UI**: canais para `gamification:snapshot` (pull) + `gamification:changed`
  (broadcast coalescido, como já fazemos em cost/usage). Renderer: HUD + tela de
  perfil (React), consumindo o snapshot.
- **Local-first**: tudo acima funciona 100% offline.

### As duas peças com dependência externa (gated)
- **Leaderboard de TIME** — requer backend/nuvem para sincronizar entre usuários.
  **v1**: mostra recordes/estatísticas **pessoais** + estado "conecte seu time
  quando o SaaS estiver no ar". A sincronização fica atrás de um flag
  (`NEXUS_BACKEND_URL`).
- **Loja PAGA de skins** — requer billing ao vivo (hoje scaffold). **v1**: skins
  são **desbloqueadas por conquista**, sem compra. A loja paga fica atrás do flag
  de billing.

Ambas são **desenhadas agora** e destravadas quando o backend/billing subirem
(parte de virar-SaaS). Nada é jogado fora; só sequenciado pela realidade.

---

## 6. Escopo

### v1 (local-first — sai completo)
HUD do Operador · Perfil de Operador · power level + tiers · XP engine (XP por
entrega + multiplicador de eficiência) · evolução do mascote por estilo ·
~12–15 conquistas · streaks/dailies · skins por conquista · leaderboard em modo
**recordes pessoais**.

### Gated (desenhado, atrás de flag)
Sincronização de leaderboard de time (backend) · loja paga de skins (billing).

### Fora de escopo (spec própria depois)
- **Landing page pública** power-scaling — usará esta mesma identidade (mascote,
  tiers, power level) como prova real (screenshots/GIFs do sistema vivo).
- Produção dos assets pixel finais (mascote em cada ramo/tier, skins, wordmark) —
  é passo de implementação; pode dogfoodar a geração de mídia do próprio app.

---

## 7. Qualidade, segurança & privacidade

- **Anti-trapaça**: XP local é honor-system (aceitável para solo/single-machine).
  Quando o leaderboard de time for ao ar, o XP que conta para o ranking é
  **revalidado no backend** a partir de evidência (não confiar no cliente).
- **Privacidade**: leaderboard e qualquer telemetria compartilhada são **opt-in
  explícito** (default off). Recordes pessoais e todo o resto vivem 100% local em
  `~/.nexus`. Nunca compartilhar custo/valores sem consentimento.
- **Acessibilidade**: HUD respeita `prefers-reduced-motion`; contraste AA; nada de
  animação essencial-só-visual sem alternativa textual.
- **Testes**: XP engine e cálculo de tier/eficiência/streak são puros e cobertos
  por unit tests; store testado com SQLite in-memory (padrão do repo).

---

## 8. Racional (por que assim)

- **Reusa o que já existe** (telemetria real, stores de missão/handoff/task,
  decisões do router, vitórias de onboarding) → esforço em dias, não semanas.
- **XP por entrega** é o diferencial honesto: não gamifica a conta, premia shipar
  e economizar. Diferencia de qualquer gamificação ingênua baseada em consumo.
- **Mascote = marca** unifica gamificação e identidade num único ativo memorável,
  e alimenta a landing depois com material real.
