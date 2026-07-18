# Product

## Register

product

## Users

Desenvolvedores que trabalham com CLIs de IA (claude, codex, gemini, kimi, grok…)
no macOS — power users de terminal, confortáveis com múltiplos agentes rodando em
paralelo. Contexto: sessões longas de trabalho, ambiente escuro, telas grandes.
O job: orquestrar vários agentes de IA ao mesmo tempo (squads, missões, handoffs)
sem perder o controle do que cada um está fazendo.

## Product Purpose

NexusIDE é um terminal IDE multi-agente: grid de panes de terminal reais, canvas
infinito, orquestração nativa de squads/missões via MCP embutido, voz (Jarvis) e
multi-conta com failover. Sucesso = o usuário comanda uma frota de agentes como
um operador em um centro de operações — rápido, legível, sem fricção.

## Brand Personality

Sci-fi operacional. Centro de comando, cockpit de operações: denso em sinal,
calmo em ruído. Três palavras: **operacional, preciso, vivo**. A interface deve
evocar controle e prontidão (aviônica, mission control), nunca fantasia gamer.

## Anti-references

- **IDE corporativo pesado** (Eclipse/IntelliJ): toolbars com dezenas de ícones,
  painéis aninhados, poluição visual. Cada control na tela precisa merecer o lugar.
- **Brinquedo gamer RGB**: neon excessivo, glow em tudo, animações chamativas.
  O glow é pontuação, não fundo; a seriedade vem primeiro.
- SaaS genérico de dashboard (cards brancos, gradiente roxo de landing page).

## Design Principles

1. **Sinal > cromo.** Estado dos agentes, custo, atividade — dados operacionais
   sempre visíveis; decoração nunca compete com informação.
2. **Prontidão.** Toda tela responde "o que está rodando e o que posso fazer
   agora?" — inclusive (principalmente) o estado vazio.
3. **Neon com parcimônia.** Um acento ciano/verde operacional para o que está
   VIVO (agentes ativos, ações primárias); o resto fica em neutros profundos.
4. **Densidade calma.** Muita informação, pouca ansiedade: hierarquia por
   tipografia e espaçamento, não por caixas e bordas.
5. **Teclado primeiro.** Power users não caçam botões; atalhos visíveis e
   aprendíveis em contexto.
6. **Endorfina em toda superfície.** Cada tela do path feliz (boot → launch →
   home → missão) entrega presença, confirmação ou progresso — pet, kicker,
   status narrativo, CTA com peso. Contrato em `src/shared/endorphin.ts`.
   Não é RGB gamer: é o operador sentir que o sistema respondeu com vida.

## Accessibility & Inclusion

Padrão razoável: contraste AA (≥4.5:1 texto corpo), `prefers-reduced-motion`
respeitado em toda animação, navegação por teclado nos fluxos principais.
Sem certificação formal.
