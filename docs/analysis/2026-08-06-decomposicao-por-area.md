# Prong (b) — ownership derivada do REPOSITÓRIO VIVO

**O caso que importa para ele:** trabalho livre em repo existente
("continua codando nosso sistema"). É exatamente o que template nenhum alarga.

---

## O socket já existe (de novo)

`guided-mission-planner.ts:482-489`:
```ts
const baseOwnership =
  intentOwnership.length > 0
    ? intentOwnership                                   // goal cita arquivos
    : resolveGuidedMutationOwnership(
        mission.intentContract,
        deps.listRepositoryOwnership(suite.tasks.scope), // ← INVENTÁRIO VIVO
      );
```

O planner **já lê o repositório**. O que falta não é conhecimento — é
**particionamento**: hoje o inventário vira UM `baseOwnership` plano para UMA
tarefa de entrega. Ninguém o divide em fatias disjuntas.

> Prong (b) = **particionar o inventário vivo em áreas disjuntas e emitir uma
> raiz por área**, quando o objetivo toca mais de uma.

---

## Desenho conservador

### 1. Descobrir ÁREAS, não arquivos
Do inventário vivo, derivar fronteiras naturais na ordem em que o repo as
oferece:
1. **workspaces/packages** declarados (`package.json workspaces`, `pnpm-workspace`,
   `Cargo.toml members`) — fronteira mais forte que existe: o próprio projeto já
   declarou que são unidades independentes;
2. **diretórios de primeiro nível sob a raiz de código** (`src/*`, `apps/*`,
   `services/*`, `packages/*`);
3. **fronteira de teste** (`tests/**`, `**/__tests__/**`) como área própria.

### 2. Casar o OBJETIVO com as áreas
- alvos citados no goal (arquivo/módulo/nome de superfície) → área correspondente;
- nenhum alvo citado ⇒ **não inventar**: cai no caminho de hoje (1 raiz).

### 3. Emitir raízes só onde a disjunção é PROVÁVEL
- ≥2 áreas casadas e **pairwise-disjuntas** ⇒ uma story por área,
  `ownershipFiles` = a fatia da área, `dependsOn: []`;
- área que não dá para separar (glue compartilhado, arquivo raiz, migração)
  ⇒ story **sem** `ownershipFiles` ⇒ pelo amolecimento por story, serializa
  atrás com `sequential-only`, sem derrubar o leque;
- 1 área ⇒ 1 raiz, e o veredito diz **fase sequencial**, que é a verdade.

### 4. Nunca inferir dependência
Áreas disjuntas nascem **sem** aresta. Dependência só quando declarada pelo
objetivo ou imposta por gate (QA/revisão depois da entrega).

---

## Segurança

- Reusa `ownershipsIntersect` / `selectDisjointWave`: nada de critério novo.
- Glue reservado (`RESERVED_GLUE_PATTERNS`: lockfiles, `index.ts`, `migrations/`)
  **nunca** entra numa fatia de área — continua exclusivo.
- Prova de disjunção é pré-condição da emissão, não asserção posterior.

## Limite honesto
Um objetivo que toca **uma** área não alarga, e não deve. O ganho é para
objetivo que toca várias — "mexe no billing e no settings" abre 2; "corrige o
login" abre 1, com o motivo escrito na tela.

## Tamanho
G (maior de todos os itens abertos): toca o planner, exige descoberta de áreas e
casamento objetivo↔área. Depende do amolecimento por story (F2) já estar dentro.

---

## MEDIÇÃO REAL — quantas raízes o HiperGO dele abriria

Medido no repo dele (`/Users/cleofasrocha/HiperGO`), não estimado:

- `package.json workspaces` = `["apps/web"]` — **1 workspace declarado**
- segundo nível: `apps/web`, `services/api`, `packages/contracts` — **3 pacotes de código**
- auxiliares: `scripts/`, `deploy/`, `.github/`, `_bmad-output/`, `docs/`

**Áreas particionáveis hoje: 3 de código + 1–2 auxiliares.**

| Objetivo típico dele | Áreas tocadas | Raízes |
|---|---|---|
| "continua codando o sistema" (web + api) | 2 | **2** |
| Story 1.2 — tenant isolation + RLS + suíte CI | api, contracts, scripts/CI | **3** |
| idem + closeout documental | + `_bmad-output` | **4** |
| "corrige o login" | 1 | **1** (e o veredito diz por quê) |

> **Resposta honesta: 2 a 4, tipicamente 3. Não 8.**

E o motivo importa: **o teto dele é a forma do REPOSITÓRIO, não o nosso motor.**
Abrir 8 exigiria 8 áreas independentes; ele tem 3 pacotes de código. Nosso teto
efetivo (8) vai continuar ocioso — e isso está CERTO, não é defeito.

Comparação útil: o plano de 6 unidades que ele rodou hoje tinha largura máxima 2.
Com prong (b), o MESMO objetivo abriria **3**. É ganho real (1 → 3 na primeira
onda), e é menor que o número que a palavra "leque" sugere.
