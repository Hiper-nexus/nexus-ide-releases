# Product

## Register

product

## Users

Dois níveis convivem no mesmo produto:

1. Pessoas sem experiência em programação, que chegam com uma ideia e precisam
   ser guiadas da definição do produto à entrega validada, sem aprender terminal,
   CLIs, squads ou jargão de orquestração.
2. Desenvolvedores e operadores que trabalham com CLIs de IA (Claude, Codex,
   Gemini, Kimi, Grok…) e precisam inspecionar ou controlar agentes, worktrees,
   handoffs, custo e evidências em sessões longas.

O job comum é transformar uma intenção humana em software pronto com controle e
evidência. O caminho padrão deve pedir apenas a próxima decisão necessária; a
complexidade operacional continua disponível por divulgação progressiva.

## Product Purpose

NexusIDE é um sistema de criação de software multi-agente: conduz objetivo, PRD,
planejamento, implementação, revisão, testes e entrega enquanto mantém grid de
terminais reais, canvas, orquestração MCP, voz e multi-conta disponíveis para
inspeção avançada. Sucesso = uma pessoa descreve o que quer, entende decisões
importantes e recebe uma entrega verificável; um operador pode abrir a camada
técnica e assumir controle sem trocar de produto.

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
3. **Cor com parcimônia.** Pink City sinaliza foco, seleção e trabalho ativo.
   A ação principal é branca; superfícies usam os neutros de `DESIGN.md`.
4. **Densidade calma.** Muita informação, pouca ansiedade: hierarquia por
   tipografia e espaçamento, não por caixas e bordas.
5. **Teclado primeiro.** Power users não caçam botões; atalhos visíveis e
   aprendíveis em contexto.
6. **Endorfina em toda superfície.** Cada tela do path feliz (boot → launch →
   home → missão) entrega presença, confirmação ou progresso — pet, kicker,
   status narrativo, CTA com peso. Contrato em `src/shared/endorphin.ts`.
   Não é RGB gamer: é o operador sentir que o sistema respondeu com vida.
7. **Criação direta como padrão.** Início contém o formulário real:
   descrever → iniciar → acompanhar → receber a entrega → pedir ajustes.
   A equipe recomendada é suficiente para começar. Configuração de papéis,
   modelos, critérios e referências é opcional; o usuário leigo não precisa
   aprovar um plano ou montar a equipe para cada pedido. Terminal é destino
   explícito, não a tela automática ao abrir um projeto salvo.
8. **Autonomia sem cerimônia.** Iniciar autoriza o trabalho definido no pedido.
   Planejamento, implementação, revisão e reparo são responsabilidade do motor.
   O caminho manual continua disponível por escolha explícita. Pendências
   reais de conexão ou acesso precisam ser acionáveis; a interface não deve
   transformar verificação indisponível em uma entrega anunciada como validada.
9. **Entrega guiada determinística.** Squads gerados pelo fluxo iniciante
   executam uma onda de implementação seguida por QA independente. O QA só
   altera e integra quando encontra um defeito; se a entrega já estiver verde,
   sensores e revisão do processo principal emitem um receipt físico sem
   fabricar commit. Squads salvos, manuais ou especializados preservam o
   planejamento avançado definido pelo orquestrador.

## Accessibility & Inclusion

Padrão razoável: contraste AA (≥4.5:1 texto corpo), `prefers-reduced-motion`
respeitado em toda animação, navegação por teclado nos fluxos principais.
Sem certificação formal.
