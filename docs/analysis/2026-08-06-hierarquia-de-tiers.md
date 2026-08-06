# Finding A — largura vem da ÁRVORE, não do teto

**Evidência (OBSERVADA):** `system-prompt-pane-105.txt`
> *"the topology is 3 FIXED chefes, scout/builder/reviewer, and each chefe runs
> ONLY the workers of its OWN tier"* · *"≤5 leaf workers, the width cap"*

**Corroboração (ATESTADA):** o orquestrador confirma que o `width_cap` que o
bloqueou hoje é contado **por chefe** — mesma contabilidade, vista do outro lado.

## A aritmética que explica tudo

| | Overclock | Nexus hoje |
|---|---|---|
| Andares | 3 (orq → 3 chefes → folhas) | 2 (orq → workers) |
| Teto | ≤5 folhas **por chefe** | 8 **por missão** |
| Pico | 3 × 5 = **15 possíveis** (9 observado) | **8**, e só se o plano tiver 8 raízes |

Nosso teto por missão é **mais generoso** que o deles por chefe. A largura deles
não vem de teto — vem de **multiplicar tetos por andar**.

> Corolário que muda a estratégia: **subir `maxWorkers` nunca resolveria.** O
> lever é **acrescentar um andar**.

---

## Desenho para o Nexus: tier intermediário por ÁREA

Não copiar os 3 chefes fixos (scout/builder/reviewer é a topologia de produto
deles). O eixo natural do Nexus é **área do repositório** — que é exatamente o
que prong (b) já vai descobrir.

```
missão
 └─ orquestrador
     ├─ sub-orquestrador ÁREA A (src/auth/**)      → N folhas dentro de A
     ├─ sub-orquestrador ÁREA B (src/billing/**)   → N folhas dentro de B
     └─ sub-orquestrador ÁREA C (tests/**)         → N folhas dentro de C
```

**O que cada andar possui**
- **Orquestrador**: o plano, as áreas, os gates entre fases. Não escreve código.
- **Sub-orquestrador de área**: a ownership da ÁREA inteira (fatia disjunta), o
  sub-plano dentro dela, e o handoff agregado da área.
- **Folha**: uma unidade dentro da área, ownership ⊂ ownership da área.

**Invariante de segurança (barato, e já temos a peça):** ownership de folha ⊂
ownership do sub-orquestrador, e áreas pairwise-disjuntas ⇒ **duas folhas de
áreas diferentes nunca colidem por construção**. `ownershipsIntersect` já
decide isso; muda só quem é comparado com quem.

**Agregação de handoff**: folha → sub-orquestrador (que consolida) →
orquestrador. Um handoff por área em vez de N — reduz o ruído no topo, que é
justamente o custo que o Overclock paga com a regra de blocos sequenciados.

---

## Custo honesto

1. **Overhead de coordenação**: cada sub-orquestrador é um pane que **não
   escreve código** — puro custo até a área ter ≥2 unidades reais.
2. **Latência de partida**: mais um salto de spawn+handoff antes da primeira
   linha escrita.
3. **Tokens**: o sub-orquestrador relê contexto da área.
4. **Modos de falha novos**: sub-orquestrador que morre leva a área junto (o
   handoff-enforcement precisa cobrir o andar do meio também).

## Quando a árvore é PIOR que a onda plana

- **Plano pequeno (≤5 unidades)**: puro overhead — a onda plana já cabe no teto
  de 8. **É o caso comum dele.**
- **Área com 1 unidade**: o sub-orquestrador é um intermediário inútil.
- **Trabalho fortemente acoplado**: mais andares só multiplicam handoffs.

**Regra proposta:** criar tier intermediário **somente** quando
`áreas ≥ 2` **e** `unidades totais > teto plano (8)`. Abaixo disso, onda plana —
que é mais rápida e o que já funciona hoje.

---

## Prioridade honesta

Isto fica **abaixo** de prong (b) na fila. Prong (b) descobre as áreas; sem
áreas descobertas não há por onde ramificar. E prong (b) sozinho já leva o plano
dele de 1 raiz para N raízes — que é o salto que ele enxerga. A árvore só passa
a valer quando N > 8, o que ainda não é o caso dos planos dele.
