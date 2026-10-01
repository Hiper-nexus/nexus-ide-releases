# Nexus Data Café

O jogo da comunidade. Substitui o jogo de corrida da Pink City (30/09/2026).

## Como se joga

O jogador é o dev de plantão num data center ao entardecer.

1. Pega uma caixa de GPU na doca (uma por vez, visível nas mãos).
2. Leva até um rack desligado e segura E para instalar. O rack liga: LEDs, ventoinhas e o neon na cor da LLM.
3. Com o data center crescendo, racks ligados caem ao acaso. O ticket aparece no NOC e o dev segura E para reiniciar.
4. Café é energia. Cai com o tempo, mais rápido andando e carregando. Sem café o dev anda devagar e boceja; a cafeteira reabastece.
5. Tickets dão XP, níveis (Estagiário a Principal) e selos. Ligar as 18 LLMs dá o selo "Data center completo".
6. O mural do sorteio e a TV da live abrem o convite do grupo e o canal de lives.

7. Entregas emendadas viram combo: instalar ou reiniciar um rack em até 18 s do anterior multiplica o XP (×1,25 por entrega, até ×2).
8. Três missões do turno ficam ativas (ligar racks, resolver incidentes, chegar a um combo, tomar café a tempo). Fechar uma paga XP e traz a próxima.
9. O turno dura 3 minutos e os pontos são o XP ganho nele. O recorde fica salvo.
10. Cada nível deixa o dev 3% mais rápido.

XP, recorde e progresso ficam só no navegador (`nexus-data-cafe:v1`, esquema 2; o salvo do esquema 1 migra sem perder nada) e não contam para o sorteio.

## Arquitetura (`src/datacafe/`)

| Módulo | Papel | Testes |
| --- | --- | --- |
| `layout.js` | Mapa em grade (dados puros), racks por LLM, pontos de interação | `layout.test.js` |
| `grid.js` | Colisão: `slideMove` empurra o disco para fora dos sólidos e contorna quinas | `grid.test.js` (fuzz) |
| `interact.js` | Objeto interativo mais próximo e progresso de segurar | `interact.test.js` |
| `walk.js`, `rig.js` | Caminhada relativa à câmera e câmera de diorama | `walk.test.js` |
| `energy.js`, `racks.js`, `tickets.js`, `progress.js` | Regras puras e imutáveis | um teste por módulo |
| `combo.js`, `missions.js`, `shift.js` | Combo de entregas, missões do turno e turno cronometrado | um teste por módulo |
| `progression.js` | Junta combo, missões e turno: `scoreTicket` quando um ticket fecha, `progressionStep` no relógio | `progression.test.js` |
| `audio.js` | Som sintetizado em WebAudio, liga após gesto, mudo e volume persistentes, limitador na saída, trilha em arpejo | `audio.test.js` |
| `kit.js`, `character.js`, `datacenter.js` | Arte 3D: cache por mundo, InstancedMesh, partículas, descarte | `art.test.js` |
| `scene.js` | Liga entrada, simulação, arte e eventos do HUD | navegador |
| `mount.js`, `datacafe.css` | HUD montado por código, igual nas duas páginas | navegador |

## API para embutir

```js
import { mountDataCafe } from './datacafe/mount.js';
const game = mountDataCafe(stageElement, {
  host: focusableElementForCanvas,
  variant: 'full' | 'embed',
  startButtons: [button],
  autostart: false,
});
game.start(); game.resetProgress(); game.dispose();
```

A comunidade monta em tela cheia; a página principal monta sob demanda no clique de "Jogar aqui", então o módulo 3D (cerca de 156 kB gzip) não pesa no carregamento.

## Som

Tudo sintetizado, sem arquivos. O mestre é o volume do jogador (padrão 0,8) e passa por um limitador. Medido no navegador com um analisador na saída: a sala com a trilha fica em torno de -25 dBFS RMS e os efeitos chegam a cerca de -8 dBFS de pico. Antes disso o mestre era 0,18 com efeitos de pico 0,05 a 0,12, o que dava uns -44 dBFS: o jogo parecia mudo. O teste `os efeitos chegam audíveis` falha se algum efeito cair abaixo de 0,1 de pico.

Efeitos: passos, pegar GPU, rack no ar, alarme de incidente, café, ação bloqueada, combo (o bip sobe a cada entrega), missão cumprida, subir de nível, fim de turno e `typing()` para o teclado do PC. O botão de som fica sempre visível no HUD; o volume fica no painel (M). Pausa e aba oculta suspendem o contexto; mudo e pausa também param a trilha.

## Orçamento medido

Cerca de 130 chamadas de desenho em 1440×900 a 60 fps no Chromium; sem rolagem horizontal de 320 a 800 px.

## Próximas ideias

Trocar ventoinha, cabear rack, deploy pelo terminal, gato do escritório, devs que pedem café, incidentes encadeados e ciclo de dia e noite.
