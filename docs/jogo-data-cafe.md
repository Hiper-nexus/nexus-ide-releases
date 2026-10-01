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
7. Na estação de trabalho (a mesa do meio da fileira de mesas, com monitor grande e cadeira) o dev senta segurando E. Sentado, segurar E roda `nexus deploy --prod` no terminal (soltar pausa); com pelo menos um rack no ar o deploy rende XP e o próximo build fica pronto em 25 s. Com um incidente aberto o deploy cai no canary. Toque rápido em E, Esc, WASD ou o joystick levantam.

Câmera: segue o dev olhando um pouco à frente da caminhada, aproxima enquanto ele segura uma ação e enquadra o monitor quando ele senta. Roda do mouse ou pinça aproximam (no limite do zoom a roda volta a rolar a página); arrastar gira e inclina um pouco. Quando um rack ou parede ficaria entre a câmera e o dev, ela sobe até vê-lo.

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
| `walk.js` | Caminhada relativa à câmera | `walk.test.js` |
| `rig.js` | Câmera: suavização independente de fps, antecipação, zoom, órbita, oclusão por altura das células, enquadramento sentado | `rig.test.js` (todas as posições do salão × giro × zoom × tela) |
| `desk.js` | Mesa do terminal: de pé → sentando → sentado → agindo → concluído → levantando, plano do deploy, pose | `desk.test.js` |
| `energy.js`, `racks.js`, `tickets.js`, `progress.js` | Regras puras e imutáveis | um teste por módulo |
| `combo.js`, `missions.js`, `shift.js` | Combo de entregas, missões do turno e turno cronometrado | um teste por módulo |
| `progression.js` | Junta combo, missões e turno: `scoreTicket` quando um ticket fecha, `progressionStep` no relógio | `progression.test.js` |
| `audio.js` | Som sintetizado em WebAudio, liga após gesto, mudo e volume persistentes, limitador na saída, trilha em arpejo | `audio.test.js` |
| `kit.js`, `character.js`, `datacenter.js` | Arte 3D: cache por mundo, InstancedMesh, partículas, descarte, terminal que só repinta quando muda | `art.test.js` (inclui: nenhuma face do dev no mesmo plano de outra cor, caneca fora do alcance dos braços, racks vizinhos sem fresta) |
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

Efeitos: passos, pegar GPU, rack no ar, alarme de incidente, café, ação bloqueada, combo (o bip sobe a cada entrega), missão cumprida, subir de nível, fim de turno `typing()` para o teclado do PC e `sit()`/`stand()` para a cadeira. O deploy no terminal entra no combo como qualquer entrega e tem missão própria ("Faça 2 deploys no terminal"). O botão de som fica sempre visível no HUD; o volume fica no painel (M). Pausa e aba oculta suspendem o contexto; mudo e pausa também param a trilha.

## Orçamento medido

Entre 112 e 153 chamadas de desenho em 1440×900 a 60 fps no Chromium (01/10/2026, Apple M5): 134 no início do plantão, 130 nas mesas, 153 com o zoom todo afastado. Em 390×844 e 768×1024 com toque, 127 e 144 a 60 fps. Sem rolagem horizontal de 320 a 800 px.

## Por que o boneco piscava (01/10/2026)

Medido no navegador, uma causa por vez: a franja do cabelo e a testa no mesmo plano (z-fighting), a caneca do cinto dentro do volume do braço (sumia a cada passada), frestas de 14 cm entre racks (o dev aparecia e sumia atrás da fileira) e o serrilhado da sombra própria. Culling, near plane, bocejo e troca de visibilidade foram descartados com medida. Os testes de `art.test.js` impedem a volta das três primeiras.

## Próximas ideias

Trocar ventoinha, cabear rack, resolver ticket pelo terminal (SSH no rack caído), gato do escritório, devs que pedem café, incidentes encadeados e ciclo de dia e noite.
