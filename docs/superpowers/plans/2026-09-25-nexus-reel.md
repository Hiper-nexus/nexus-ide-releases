# Reel vertical do Nexus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produzir o reel 9:16 de 20,6 s que apresenta o Nexus em PT-BR, renderizado em Remotion, com trilha original e versão muda.

**Architecture:** Projeto Remotion isolado em `/Users/cleofasrocha/dev/nexus-reel`. O roteiro é dado (`timing.ts` + `copy.ts` + `layout.ts`); cada capítulo é um componente que lê batidas da grade; efeitos, HUD e UI recriada são componentes reutilizáveis; a matemática (grade, esfera, digitação, split-flap, batidas, loudness) é pura e testada com vitest. Áudio vem da ElevenLabs, a grade de batidas é medida da trilha e a masterização/verificação são scripts Node.

**Tech Stack:** Remotion 4.0.529 (`remotion`, `@remotion/cli`, `@remotion/media`, `@remotion/fonts`, `@remotion/layout-utils`), React 19.3.0, TypeScript 5.9.3, Vitest 5.0.2, Node 22.22.3 (`--experimental-strip-types` nos scripts), ffmpeg/ffprobe (Homebrew), MCP ElevenLabs.

**Spec:** `docs/superpowers/specs/2026-09-25-nexus-reel-design.md` (nexus-ide). Leia a spec antes de qualquer tarefa.

## Global Constraints

- Caminho do projeto: `/Users/cleofasrocha/dev/nexus-reel`. Nesta sessão `$HOME` é efêmero; nunca use `~`.
- Composição `NexusReel`: 1080×1920, 60 fps, duração = `totalFrames()` (44 batidas; 1238 quadros a 128 BPM).
- Área segura de texto essencial: x ∈ [64, 900], y ∈ [250, 1480].
- Cores só de `src/theme.ts` (tokens do DESIGN.md, tema `nexus-pink-city`); nenhum hex em outro arquivo de `src/`.
- Rosa `#ff4f8b` só no que está vivo; verde `#3ce08d` = pronto; âmbar `#e5c07b` = limite; branco `#faf7f9` = tipografia.
- Glitch com separação de cores em no máximo 3 transições; VT323 em só 2 lugares ("SISTEMA ONLINE" e a linha final).
- Fontes: Inter (UI e headlines), JetBrains Mono (HUD, logs, dados, medidas), VT323 (2 usos).
- Copy PT-BR exatamente como em `src/copy.ts`; tagline "Da ideia à entrega, com uma frota de agentes."; sem "open source", sem "grátis", sem CTA/URL.
- Palavras gigantes terminam em "." e o ponto é renderizado como quadrado (rosa, ou verde em "Entregue.").
- Sem `Math.random()` nem `Date.now()` em componentes: use `random()` do Remotion com seed estável.
- Entregáveis em `out/`: `nexus-reel-ptbr.mp4` (com áudio), `nexus-reel-ptbr-mudo.mp4` (sem faixa de áudio), `nexus-reel-capa.png`.
- Master: H.264, `yuv420p`, CRF 16, AAC 48 kHz; final a -14 LUFS ±1 integrados, pico verdadeiro ≤ -1 dBTP, `+faststart`.
- Cortes de capítulo a ≤ ±2 quadros do ataque mais próximo da trilha medida.
- Commits no repo `nexus-reel`, formato `<tipo>: <descrição>` em PT-BR.

## Review Focus

1. `src/grid.json` corrompido ou com BPM absurdo (0, NaN, 400) → falha com mensagem clara citando `grid.json`, nunca quadros NaN. Teste em Task 1 (`parseGrid`).
2. Texto digitado com acento em NFD, cedilha ou emoji → nunca corta um caractere ao meio. Teste em Task 2 (`typedText`).
3. Split-flap com caractere fora do charset (ex.: "Ã") → termina mostrando o caractere pedido. Teste em Task 2 (`flapChar`).
4. Esfera com 0 ou 1 ponto → sem divisão por zero nem NaN. Teste em Task 3 (`fibonacciSphere`).
5. Trilha silenciosa ou curta demais na medição → erro claro, nunca BPM NaN gravado no `grid.json`. Teste em Task 16 (`estimateTempo`).

## Mapa de arquivos

```text
/Users/cleofasrocha/dev/nexus-reel/
├── package.json · tsconfig.json · vitest.config.ts · remotion.config.ts · .gitignore
├── public/fonts/      Inter.var.ttf, JetBrainsMono.var.ttf, VT323-Regular.ttf, OFL-1.1.txt, PROVENANCE.md
├── public/logos/      logos das CLIs (currentColor → #faf7f9) + NOTICE.md
├── public/audio/      music.mp3 + sfx/*.mp3 (gerados)
├── scripts/           measure-beats.ts · master.ts · verify.ts · contact-sheet.sh
└── src/
    ├── index.ts · Root.tsx · Reel.tsx · grid.json
    ├── timing.ts      grade, capítulos, conversão batida→quadro
    ├── theme.ts       tokens de cor/fonte + withAlpha
    ├── copy.ts        todos os textos
    ├── layout.ts      área segura + caixas de texto por capítulo
    ├── fonts.ts       loadAllFonts + useFontsReady
    ├── lib/           anim · timecode · typewriter · splitflap · sphere · nexusmark · pixel-art · beats · media-checks
    ├── fx/            Background · Grain · Glitch · Flare · SafeZones · ColorFilters
    ├── hud/           Hud · hud-state
    ├── ui/            BigWord · NexusMarkFlat · NexusMark3D · InicioCard · PaneTerminal · MissionCard · SplitFlap · ProviderLogo · PixelArt
    ├── audio/         cues.ts · Soundtrack.tsx
    └── chapters/      C00Boot … C09Fim + index.ts (mapa id → componente)
```

---

### Task 1: Scaffold do projeto e grade de batidas

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `remotion.config.ts`, `.gitignore`
- Create: `src/grid.json`, `src/timing.ts`, `src/index.ts`, `src/Root.tsx`, `src/Reel.tsx`
- Test: `src/timing.test.ts`

**Interfaces:**
- Produces: `FPS=60`, `WIDTH=1080`, `HEIGHT=1920`, `TOTAL_BEATS=44`; `type Grid = {bpm:number; fps:number}`; `type GridFile = {bpm:number; musicOffsetSeconds:number}`; `parseGrid(raw: unknown): GridFile`; `GRID: Grid`; `MUSIC_OFFSET_SECONDS: number`; `framesPerBeat(g?)`; `beatToFrame(beat, g?)`; `totalFrames(g?)`; `type ChapterId`; `type Chapter = {id; startBeat; endBeat; hudIndex; hudLabel}`; `CHAPTERS`; `type FrameRange = {from; durationInFrames}`; `chapterRange(c, g?)`; `chapterAt(frame, g?)`; `localFrame(absBeat, c, g?)`; `type ReelProps = {debugSafe: boolean}`; componente `Reel`.

- [ ] **Step 1: Criar o projeto e instalar dependências exatas**

```bash
mkdir -p /Users/cleofasrocha/dev/nexus-reel && cd /Users/cleofasrocha/dev/nexus-reel
git init -q
npm init -y >/dev/null
npm pkg set type=module
npm install --save-exact remotion@4.0.529 @remotion/cli@4.0.529 @remotion/media@4.0.529 @remotion/fonts@4.0.529 @remotion/layout-utils@4.0.529 react@19.3.0 react-dom@19.3.0
npm install --save-exact -D typescript@5.9.3 vitest@5.0.2 @types/react@19.3.0 @types/node@22
npm pkg set scripts.studio="remotion studio src/index.ts" \
  scripts.test="vitest run" \
  scripts.typecheck="tsc --noEmit" \
  scripts.still="remotion still src/index.ts NexusReel" \
  scripts.render="remotion render src/index.ts NexusReel out/master.mp4 --codec=h264 --crf=16 --pixel-format=yuv420p --jpeg-quality=95 --audio-codec=aac --audio-bitrate=320k" \
  scripts.measure-beats="node --experimental-strip-types scripts/measure-beats.ts" \
  scripts.master="node --experimental-strip-types scripts/master.ts" \
  scripts.verify="node --experimental-strip-types scripts/verify.ts"
```

Expected: `package.json` com as versões exatas acima (sem `^`) e `package-lock.json` criado.

- [ ] **Step 2: Configurações**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["DOM", "ES2022"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "scripts", "vitest.config.ts", "remotion.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
```

`remotion.config.ts`:

```ts
import { Config } from '@remotion/cli/config';

Config.setOverwriteOutput(true);
```

`.gitignore`:

```text
node_modules/
out/
.DS_Store
```

- [ ] **Step 3: Escrever o teste que falha**

`src/timing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CHAPTERS,
  TOTAL_BEATS,
  beatToFrame,
  chapterAt,
  chapterRange,
  framesPerBeat,
  localFrame,
  parseGrid,
  totalFrames,
} from './timing';

const G128 = { bpm: 128, fps: 60 } as const;

describe('grade de batidas', () => {
  it('128 BPM a 60 fps dá 28,125 quadros por batida', () => {
    expect(framesPerBeat(G128)).toBe(28.125);
  });

  it('44 batidas a 128 BPM somam 1238 quadros', () => {
    expect(beatToFrame(TOTAL_BEATS, G128)).toBe(1238);
    expect(totalFrames(G128)).toBe(1238);
  });

  it('o BPM medido muda a duração total', () => {
    expect(totalFrames({ bpm: 127.6, fps: 60 })).toBe(1241);
  });
});

describe('parseGrid', () => {
  it('aceita a grade gravada pelo medidor', () => {
    expect(parseGrid({ bpm: 128, musicOffsetSeconds: 0.05 })).toEqual({ bpm: 128, musicOffsetSeconds: 0.05 });
  });

  it.each([
    { bpm: 0, musicOffsetSeconds: 0 },
    { bpm: Number.NaN, musicOffsetSeconds: 0 },
    { bpm: 400, musicOffsetSeconds: 0 },
    { bpm: 128, musicOffsetSeconds: -1 },
    { bpm: 128 },
    null,
  ])('recusa grade inválida %j com mensagem que cita grid.json', (raw) => {
    expect(() => parseGrid(raw)).toThrow(/grid\.json/);
  });
});

describe('capítulos', () => {
  it('são contíguos, começam em 0 e terminam na batida 44', () => {
    expect(CHAPTERS[0].startBeat).toBe(0);
    expect(CHAPTERS[CHAPTERS.length - 1].endBeat).toBe(TOTAL_BEATS);
    for (let i = 1; i < CHAPTERS.length; i++) {
      expect(CHAPTERS[i].startBeat).toBe(CHAPTERS[i - 1].endBeat);
    }
  });

  it.each([100, 128, 160])('somam o total e nunca ficam vazios a %i BPM', (bpm) => {
    const g = { bpm, fps: 60 };
    const ranges = CHAPTERS.map((c) => chapterRange(c, g));
    expect(ranges.reduce((sum, r) => sum + r.durationInFrames, 0)).toBe(totalFrames(g));
    for (const r of ranges) expect(r.durationInFrames).toBeGreaterThan(0);
  });

  it('chapterAt acha o capítulo de qualquer quadro, inclusive fora do fim', () => {
    expect(chapterAt(0, G128).id).toBe('boot');
    expect(chapterAt(beatToFrame(22, G128), G128).id).toBe('camadas');
    expect(chapterAt(beatToFrame(22, G128) - 1, G128).id).toBe('missao');
    expect(chapterAt(totalFrames(G128) + 50, G128).id).toBe('fim');
  });

  it('localFrame converte batida absoluta em quadro dentro do capítulo', () => {
    const marca = CHAPTERS.find((c) => c.id === 'marca');
    if (!marca) throw new Error('capítulo marca ausente');
    expect(localFrame(12, marca, G128)).toBe(0);
    expect(localFrame(13.5, marca, G128)).toBe(42);
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `cd /Users/cleofasrocha/dev/nexus-reel && npx vitest run src/timing.test.ts`
Expected: FAIL — `Failed to resolve import "./timing"`.

- [ ] **Step 5: Implementar a grade**

`src/grid.json` (valor provisório; a Task 17 grava o medido):

```json
{ "bpm": 128, "musicOffsetSeconds": 0 }
```

`src/timing.ts`:

```ts
import rawGrid from './grid.json';

export const FPS = 60;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const TOTAL_BEATS = 44;

export type Grid = { readonly bpm: number; readonly fps: number };
export type GridFile = { readonly bpm: number; readonly musicOffsetSeconds: number };

export function parseGrid(raw: unknown): GridFile {
  const candidate = raw as Partial<GridFile> | null;
  const bpm = candidate?.bpm;
  const offset = candidate?.musicOffsetSeconds;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 60 || bpm > 200) {
    throw new Error(`src/grid.json: bpm inválido (${String(bpm)}); esperado entre 60 e 200. Rode npm run measure-beats de novo.`);
  }
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset >= 2) {
    throw new Error(`src/grid.json: musicOffsetSeconds inválido (${String(offset)}); esperado em [0, 2).`);
  }
  return { bpm, musicOffsetSeconds: offset };
}

const GRID_FILE = parseGrid(rawGrid);
export const GRID: Grid = { bpm: GRID_FILE.bpm, fps: FPS };
export const MUSIC_OFFSET_SECONDS = GRID_FILE.musicOffsetSeconds;

export function framesPerBeat(g: Grid = GRID): number {
  return (g.fps * 60) / g.bpm;
}

export function beatToFrame(beat: number, g: Grid = GRID): number {
  return Math.round(beat * framesPerBeat(g));
}

export function totalFrames(g: Grid = GRID): number {
  return beatToFrame(TOTAL_BEATS, g);
}

export type ChapterId =
  | 'boot'
  | 'ideia'
  | 'pedido'
  | 'marca'
  | 'missao'
  | 'camadas'
  | 'frota'
  | 'failover'
  | 'recursos'
  | 'fim';

export type Chapter = {
  readonly id: ChapterId;
  readonly startBeat: number;
  readonly endBeat: number;
  readonly hudIndex: number;
  readonly hudLabel: string;
};

export const CHAPTERS: readonly Chapter[] = [
  { id: 'boot', startBeat: 0, endBeat: 1, hudIndex: 1, hudLabel: 'IDEIA' },
  { id: 'ideia', startBeat: 1, endBeat: 7, hudIndex: 1, hudLabel: 'IDEIA' },
  { id: 'pedido', startBeat: 7, endBeat: 12, hudIndex: 2, hudLabel: 'PEDIDO' },
  { id: 'marca', startBeat: 12, endBeat: 16, hudIndex: 3, hudLabel: 'MARCA' },
  { id: 'missao', startBeat: 16, endBeat: 22, hudIndex: 4, hudLabel: 'MISSÃO' },
  { id: 'camadas', startBeat: 22, endBeat: 28, hudIndex: 5, hudLabel: 'CAMADAS' },
  { id: 'frota', startBeat: 28, endBeat: 32, hudIndex: 6, hudLabel: 'FROTA' },
  { id: 'failover', startBeat: 32, endBeat: 36, hudIndex: 7, hudLabel: 'FAILOVER' },
  { id: 'recursos', startBeat: 36, endBeat: 40, hudIndex: 8, hudLabel: 'RECURSOS' },
  { id: 'fim', startBeat: 40, endBeat: 44, hudIndex: 9, hudLabel: 'FIM' },
];

export type FrameRange = { readonly from: number; readonly durationInFrames: number };

export function chapterRange(c: Chapter, g: Grid = GRID): FrameRange {
  const from = beatToFrame(c.startBeat, g);
  return { from, durationInFrames: beatToFrame(c.endBeat, g) - from };
}

export function chapterAt(frame: number, g: Grid = GRID): Chapter {
  let current = CHAPTERS[0];
  for (const c of CHAPTERS) {
    if (beatToFrame(c.startBeat, g) <= frame) current = c;
  }
  return current;
}

/** Quadro local (dentro da Sequence do capítulo) em que acontece uma batida absoluta. */
export function localFrame(absBeat: number, c: Chapter, g: Grid = GRID): number {
  return beatToFrame(absBeat, g) - beatToFrame(c.startBeat, g);
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run src/timing.test.ts`
Expected: PASS (todos os testes de `timing.test.ts`).

- [ ] **Step 7: Composição mínima**

`src/index.ts`:

```ts
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
```

`src/Reel.tsx` (provisório; a Task 6 substitui):

```tsx
import React from 'react';
import { AbsoluteFill } from 'remotion';

export type ReelProps = { readonly debugSafe: boolean };

export const Reel: React.FC<ReelProps> = () => {
  return <AbsoluteFill style={{ backgroundColor: 'black' }} />;
};
```

`src/Root.tsx`:

```tsx
import React from 'react';
import { Composition } from 'remotion';
import { Reel } from './Reel';
import { FPS, HEIGHT, WIDTH, totalFrames } from './timing';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="NexusReel"
      component={Reel}
      durationInFrames={totalFrames()}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ debugSafe: false }}
    />
  );
};
```

- [ ] **Step 8: Verificar a composição e os tipos**

Run: `npx tsc --noEmit && npx remotion compositions src/index.ts`
Expected: `tsc` sem erros; a listagem mostra `NexusReel  60  1080x1920  1238 (20.63 sec)`. O primeiro comando do Remotion baixa o Chrome Headless Shell; se o download falhar, repita com `--browser-executable="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: scaffold Remotion e grade de batidas do reel"
```

---

### Task 2: Utilitários de texto e tempo

**Files:**
- Create: `src/lib/anim.ts`, `src/lib/timecode.ts`, `src/lib/typewriter.ts`, `src/lib/splitflap.ts`
- Test: `src/lib/anim.test.ts`, `src/lib/timecode.test.ts`, `src/lib/typewriter.test.ts`, `src/lib/splitflap.test.ts`

**Interfaces:**
- Produces: `EASE` (`outExpo`, `outQuart`, `inOutCubic`, `inExpo`, `linear`); `tween(frame, from, to, a, b, easing?)`; `progress(frame, from, to, easing?)`; `timecode(frame, fps): string` (`HH:MM:SS:FF`); `typedText(text, frame, startFrame, endFrame): string`; `FLAP_CHARSET`; `padSlots(word, slots): string[]`; `flapChar(from, to, progress): string`; `type FlapOptions = {from; to; slots; frame; startFrame; flipFrames; staggerFrames}`; `flapWord(opts): string[]`.

- [ ] **Step 1: Escrever os testes que falham**

`src/lib/anim.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EASE, progress, tween } from './anim';

describe('tween', () => {
  it('interpola e prende nas pontas', () => {
    expect(tween(-5, 0, 10, 0, 100, EASE.linear)).toBe(0);
    expect(tween(5, 0, 10, 0, 100, EASE.linear)).toBe(50);
    expect(tween(50, 0, 10, 0, 100, EASE.linear)).toBe(100);
  });

  it('não explode quando o intervalo tem zero quadros', () => {
    expect(tween(3, 10, 10, 0, 1)).toBe(0);
    expect(tween(10, 10, 10, 0, 1)).toBe(1);
    expect(tween(12, 10, 8, 0, 1)).toBe(1);
  });

  it('progress vai de 0 a 1', () => {
    expect(progress(0, 0, 4)).toBe(0);
    expect(progress(2, 0, 4)).toBe(0.5);
    expect(progress(9, 0, 4)).toBe(1);
  });
});
```

`src/lib/timecode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { timecode } from './timecode';

describe('timecode', () => {
  it('formata HH:MM:SS:FF a 60 fps', () => {
    expect(timecode(0, 60)).toBe('00:00:00:00');
    expect(timecode(312, 60)).toBe('00:00:05:12');
    expect(timecode(60 * 61 + 7, 60)).toBe('00:01:01:07');
  });

  it('prende quadros negativos e fracionários', () => {
    expect(timecode(-4, 60)).toBe('00:00:00:00');
    expect(timecode(59.9, 60)).toBe('00:00:00:59');
  });
});
```

`src/lib/typewriter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { typedText } from './typewriter';

const REQUEST = 'Um app de agenda pra minha barbearia, com lembrete no WhatsApp.';

describe('typedText', () => {
  it('fica vazio antes do início e completo no fim', () => {
    expect(typedText(REQUEST, 10, 10, 70)).toBe('');
    expect(typedText(REQUEST, 70, 10, 70)).toBe(REQUEST);
    expect(typedText(REQUEST, 500, 10, 70)).toBe(REQUEST);
  });

  it('cresce sem nunca encolher', () => {
    let previous = 0;
    for (let f = 10; f <= 70; f++) {
      const len = Array.from(typedText(REQUEST, f, 10, 70)).length;
      expect(len).toBeGreaterThanOrEqual(previous);
      previous = len;
    }
  });

  it('nunca corta acento em NFD, cedilha ou emoji ao meio', () => {
    const text = 'ação 🚀 entrega';
    for (let f = 0; f <= 20; f++) {
      const shown = typedText(text, f, 0, 20);
      expect(shown.normalize('NFC')).toBe(shown);
      expect(shown).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(typedText(text, 20, 0, 20)).toBe('ação 🚀 entrega');
  });

  it('intervalo vazio mostra tudo depois do início', () => {
    expect(typedText('abc', 11, 10, 10)).toBe('abc');
  });
});
```

`src/lib/splitflap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { flapChar, flapWord, padSlots } from './splitflap';

describe('padSlots', () => {
  it('completa com espaço e corta no número de casas', () => {
    expect(padSlots('kimi', 6)).toEqual(['K', 'I', 'M', 'I', ' ', ' ']);
    expect(padSlots('CLAUDECODE', 6)).toEqual(['C', 'L', 'A', 'U', 'D', 'E']);
  });
});

describe('flapChar', () => {
  it('começa no caractere de origem e termina no de destino', () => {
    expect(flapChar('A', 'D', 0)).toBe('A');
    expect(flapChar('A', 'D', 0.5)).toBe('B');
    expect(flapChar('A', 'D', 1)).toBe('D');
  });

  it('termina mostrando caractere fora do charset', () => {
    expect(flapChar('O', 'Ã', 0.99)).not.toBe('Ã');
    expect(flapChar('O', 'Ã', 1)).toBe('Ã');
  });
});

describe('flapWord', () => {
  const base = { from: 'GROK', to: 'CLAUDE', slots: 6, startFrame: 100, flipFrames: 10, staggerFrames: 2 };

  it('mostra a origem antes e o destino depois', () => {
    expect(flapWord({ ...base, frame: 99 }).join('')).toBe('GROK  ');
    expect(flapWord({ ...base, frame: 100 + 10 + 2 * 5 }).join('')).toBe('CLAUDE');
  });

  it('a primeira casa termina antes da última começar', () => {
    const mid = flapWord({ ...base, frame: 110 });
    expect(mid[0]).toBe('C');
    expect(mid[5]).toBe(' ');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib`
Expected: FAIL — imports `./anim`, `./timecode`, `./typewriter`, `./splitflap` não resolvem.

- [ ] **Step 3: Implementar**

`src/lib/anim.ts`:

```ts
import { Easing, interpolate } from 'remotion';

export const EASE = {
  outExpo: Easing.bezier(0.16, 1, 0.3, 1),
  outQuart: Easing.bezier(0.25, 1, 0.5, 1),
  inOutCubic: Easing.bezier(0.65, 0, 0.35, 1),
  inExpo: Easing.bezier(0.7, 0, 0.84, 0),
  linear: (t: number) => t,
} as const;

export function tween(
  frame: number,
  from: number,
  to: number,
  a: number,
  b: number,
  easing: (t: number) => number = EASE.outExpo,
): number {
  if (to <= from) return frame >= to ? b : a;
  return interpolate(frame, [from, to], [a, b], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

export function progress(frame: number, from: number, to: number, easing: (t: number) => number = EASE.linear): number {
  return tween(frame, from, to, 0, 1, easing);
}
```

`src/lib/timecode.ts`:

```ts
const pad = (n: number) => String(n).padStart(2, '0');

export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.floor(frame));
  const totalSeconds = Math.floor(f / fps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor(totalSeconds / 60) % 60;
  const ss = totalSeconds % 60;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(f % fps)}`;
}
```

`src/lib/typewriter.ts`:

```ts
export function typedText(text: string, frame: number, startFrame: number, endFrame: number): string {
  const chars = Array.from(text.normalize('NFC'));
  if (frame <= startFrame) return '';
  if (endFrame <= startFrame || frame >= endFrame) return chars.join('');
  const count = Math.floor((chars.length * (frame - startFrame)) / (endFrame - startFrame));
  return chars.slice(0, count).join('');
}
```

`src/lib/splitflap.ts`:

```ts
export const FLAP_CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-';

export function padSlots(word: string, slots: number): string[] {
  const chars = Array.from(word.toUpperCase());
  return Array.from({ length: slots }, (_, i) => chars[i] ?? ' ');
}

export function flapChar(from: string, to: string, progress: number): string {
  if (progress >= 1) return to;
  if (progress <= 0 || from === to) return from;
  const size = FLAP_CHARSET.length;
  const start = Math.max(0, FLAP_CHARSET.indexOf(from));
  const target = Math.max(0, FLAP_CHARSET.indexOf(to));
  const steps = (target - start + size) % size;
  const k = Math.floor(progress * steps);
  return FLAP_CHARSET[(start + k) % size];
}

export type FlapOptions = {
  readonly from: string;
  readonly to: string;
  readonly slots: number;
  readonly frame: number;
  readonly startFrame: number;
  readonly flipFrames: number;
  readonly staggerFrames: number;
};

export function flapWord(o: FlapOptions): string[] {
  const a = padSlots(o.from, o.slots);
  const b = padSlots(o.to, o.slots);
  return a.map((char, i) => {
    const slotStart = o.startFrame + i * o.staggerFrames;
    const p = o.flipFrames <= 0 ? (o.frame >= slotStart ? 1 : 0) : (o.frame - slotStart) / o.flipFrames;
    return flapChar(char, b[i], Math.min(1, Math.max(0, p)));
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib`
Expected: PASS em `anim`, `timecode`, `typewriter` e `splitflap`.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat: utilitários de tween, timecode, digitação e split-flap"
```

---

### Task 3: Matemática da esfera

**Files:**
- Create: `src/lib/sphere.ts`
- Test: `src/lib/sphere.test.ts`

**Interfaces:**
- Produces: `type Vec3 = {x; y; z}`; `fibonacciSphere(n): Vec3[]`; `rotateX(v, a)`; `rotateY(v, a)`; `type Projected = {x; y; scale; depth; index}`; `project(v, radius, cameraDistance, index): Projected`; `sortBackToFront(ps): Projected[]`; `ringPoint(i, n, radius): {x; y}`.

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/sphere.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fibonacciSphere, project, ringPoint, rotateX, rotateY, sortBackToFront } from './sphere';

const norm = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('fibonacciSphere', () => {
  it('gera n pontos na esfera unitária', () => {
    const pts = fibonacciSphere(64);
    expect(pts).toHaveLength(64);
    for (const p of pts) expect(norm(p)).toBeCloseTo(1, 6);
  });

  it('aguenta 0 e 1 ponto sem NaN', () => {
    expect(fibonacciSphere(0)).toEqual([]);
    const [only] = fibonacciSphere(1);
    expect(Number.isNaN(only.x + only.y + only.z)).toBe(false);
    expect(norm(only)).toBeCloseTo(1, 6);
  });
});

describe('rotação e projeção', () => {
  it('rotação preserva a norma', () => {
    const v = { x: 0.3, y: -0.5, z: 0.81 };
    expect(norm(rotateY(rotateX(v, 0.7), -1.3))).toBeCloseTo(norm(v), 9);
  });

  it('ponto mais perto da câmera fica maior', () => {
    const front = project({ x: 0, y: 0, z: 1 }, 300, 1200, 0);
    const back = project({ x: 0, y: 0, z: -1 }, 300, 1200, 1);
    expect(front.scale).toBeGreaterThan(back.scale);
  });

  it('ordena de trás para frente', () => {
    const ps = [0.5, -0.9, 0.1].map((z, i) => project({ x: 0, y: 0, z }, 300, 1200, i));
    expect(sortBackToFront(ps).map((p) => p.index)).toEqual([1, 2, 0]);
  });
});

describe('ringPoint', () => {
  it('distribui no círculo começando no topo', () => {
    const top = ringPoint(0, 4, 250);
    expect(top.x).toBeCloseTo(0, 9);
    expect(top.y).toBeCloseTo(-250, 9);
    const right = ringPoint(1, 4, 250);
    expect(right.x).toBeCloseTo(250, 9);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/sphere.test.ts`
Expected: FAIL — `./sphere` não resolve.

- [ ] **Step 3: Implementar**

`src/lib/sphere.ts`:

```ts
export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };
export type Projected = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly depth: number;
  readonly index: number;
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function fibonacciSphere(n: number): Vec3[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, z: 1 }];
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = GOLDEN_ANGLE * i;
    return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
  });
}

export function rotateX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

export function rotateY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

/** z positivo aponta para a câmera; cameraDistance é medida em pixels a partir do centro. */
export function project(v: Vec3, radius: number, cameraDistance: number, index: number): Projected {
  const scale = cameraDistance / (cameraDistance - v.z * radius);
  return { x: v.x * radius * scale, y: v.y * radius * scale, scale, depth: v.z, index };
}

export function sortBackToFront(ps: readonly Projected[]): Projected[] {
  return [...ps].sort((a, b) => a.depth - b.depth);
}

export function ringPoint(i: number, n: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/sphere.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sphere.ts src/lib/sphere.test.ts
git commit -m "feat: matemática da esfera e do anel"
```

---

### Task 4: Dados de design — tema, copy, layout e geometria da marca

**Files:**
- Create: `src/theme.ts`, `src/copy.ts`, `src/layout.ts`, `src/lib/nexusmark.ts`, `src/lib/pixel-art.ts`
- Test: `src/theme.test.ts`, `src/copy.test.ts`, `src/layout.test.ts`, `src/lib/nexusmark.test.ts`, `src/no-hex.test.ts`

**Interfaces:**
- Consumes: `ChapterId` (Task 1).
- Produces: `COLOR` (bg, bgElevated, bgBar, surfaceSidebar, surface2, surface3, text, textDim, textFaint, accent, live, warn, white); `FONT` (ui, mono, pixel); `withAlpha(hex, alpha)`; `BORDER`; `BORDER_STRONG`; `glow(color, strength?)`; `COPY` (ver código); `SAFE`; `SAFE_WIDTH`; `type Box = {x; y; w; h}`; `insideSafe(box)`; `TEXT` (caixas por capítulo); `MARK_GRID=13`; `type Cell = readonly [number, number]`; `RING`, `CORE`, `ORBITALS`; `MIC`; `pixelCells(art): Cell[]`.

- [ ] **Step 1: Escrever os testes que falham**

`src/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COLOR, withAlpha } from './theme';

describe('tema', () => {
  it('usa os tokens do DESIGN.md (nexus-pink-city)', () => {
    expect(COLOR.bg).toBe('#080709');
    expect(COLOR.accent).toBe('#ff4f8b');
    expect(COLOR.live).toBe('#3ce08d');
    expect(COLOR.warn).toBe('#e5c07b');
    expect(COLOR.text).toBe('#faf7f9');
  });

  it('withAlpha converte hex em rgba', () => {
    expect(withAlpha('#ff4f8b', 0.5)).toBe('rgba(255, 79, 139, 0.5)');
  });

  it('withAlpha recusa cor que não é hex de 6 dígitos', () => {
    expect(() => withAlpha('pink', 1)).toThrow(/Cor inválida/);
  });
});
```

`src/copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COPY } from './copy';

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};

describe('copy', () => {
  it('não tem texto vazio', () => {
    for (const s of strings(COPY)) expect(s.trim().length).toBeGreaterThan(0);
  });

  it('toda palavra gigante termina em ponto (vira o quadrado)', () => {
    const big = [
      ...COPY.ideia.words.map((w) => w.word),
      ...COPY.missao.words,
      COPY.failover.line1,
      COPY.failover.line2,
      COPY.recursos.fale,
      COPY.recursos.controle,
      COPY.recursos.total,
    ];
    for (const word of big) expect(word.endsWith('.')).toBe(true);
  });

  it('linhas dos terminais cabem no pane (até 42 caracteres)', () => {
    for (const pane of COPY.camadas.panes) {
      for (const line of pane.lines) expect(Array.from(line).length).toBeLessThanOrEqual(42);
    }
  });

  it('a tagline é a aprovada', () => {
    expect(COPY.marca.taglineLines.join(' ')).toBe('Da ideia à entrega, com uma frota de agentes.');
    expect(COPY.fim.taglineLines).toEqual(COPY.marca.taglineLines);
  });

  it('não promete o que o produto não afirma', () => {
    const all = strings(COPY).join(' ').toLowerCase();
    expect(all).not.toMatch(/open source|grátis|gratuito/);
  });
});
```

`src/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SAFE, TEXT, insideSafe } from './layout';

describe('layout', () => {
  it('a área segura é a da spec', () => {
    expect(SAFE).toEqual({ left: 64, top: 250, right: 900, bottom: 1480 });
  });

  it('toda caixa de texto essencial cabe na área segura', () => {
    for (const [chapter, boxes] of Object.entries(TEXT)) {
      for (const [name, box] of Object.entries(boxes)) {
        expect(insideSafe(box), `${chapter}.${name} ${JSON.stringify(box)}`).toBe(true);
      }
    }
  });
});
```

`src/lib/nexusmark.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CORE, MARK_GRID, ORBITALS, RING } from './nexusmark';
import { MIC, pixelCells } from './pixel-art';

const key = ([x, y]: readonly [number, number]) => `${x},${y}`;

describe('NexusMark', () => {
  it('anel: 16 pixels distintos a distância 4 do centro', () => {
    expect(new Set(RING.map(key)).size).toBe(16);
    for (const [x, y] of RING) expect(Math.abs(x - 6) + Math.abs(y - 6)).toBe(4);
  });

  it('núcleo em cruz e satélites nos eixos', () => {
    expect(CORE.map(key).sort()).toEqual(['5,6', '6,5', '6,6', '6,7', '7,6']);
    for (const [x, y] of ORBITALS) expect(Math.abs(x - 6) + Math.abs(y - 6)).toBe(6);
  });

  it('grupos não se sobrepõem e cabem na grade 13×13', () => {
    const all = [...RING, ...CORE, ...ORBITALS];
    expect(new Set(all.map(key)).size).toBe(all.length);
    for (const [x, y] of all) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(MARK_GRID);
    }
  });
});

describe('pixel art', () => {
  it('o microfone é 11×11 e tem pixels', () => {
    expect(MIC).toHaveLength(11);
    for (const row of MIC) expect(row).toHaveLength(11);
    expect(pixelCells(MIC).length).toBeGreaterThan(20);
  });

  it('pixelCells devolve coluna e linha de cada #', () => {
    expect(pixelCells(['.#', '#.'])).toEqual([[1, 0], [0, 1]]);
  });
});
```

`src/no-hex.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

describe('tokens', () => {
  it('nenhum hex fora de theme.ts', () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith('theme.ts'))
      .filter((f) => HEX.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/theme.test.ts src/copy.test.ts src/layout.test.ts src/lib/nexusmark.test.ts src/no-hex.test.ts`
Expected: FAIL nos quatro primeiros (imports não resolvem); `no-hex` passa (ainda não há hex fora de tema).

- [ ] **Step 3: Implementar**

`src/theme.ts`:

```ts
export const COLOR = {
  bg: '#080709',
  bgElevated: '#111013',
  bgBar: '#0d0b0f',
  surfaceSidebar: '#0b0a0d',
  surface2: '#16151a',
  surface3: '#201e25',
  text: '#faf7f9',
  textDim: '#aaa2a8',
  textFaint: '#928b90',
  accent: '#ff4f8b',
  live: '#3ce08d',
  warn: '#e5c07b',
  white: '#ffffff',
} as const;

export const FONT = { ui: 'Inter', mono: 'JetBrains Mono', pixel: 'VT323' } as const;

export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Cor inválida: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const BORDER = withAlpha(COLOR.white, 0.08);
export const BORDER_STRONG = withAlpha(COLOR.white, 0.16);

/** Brilho como pontuação: só no elemento vivo. */
export function glow(color: string, strength = 1): string {
  return `0 0 ${12 * strength}px ${withAlpha(color, 0.85)}, 0 0 ${40 * strength}px ${withAlpha(color, 0.4)}`;
}
```

`src/copy.ts`:

```ts
export const COPY = {
  hud: {
    brand: 'NEXUS // CENTRO DE COMANDO',
    reel: "SHOWREEL '26",
    spec: '1080×1920 · 60 FPS · 128 BPM',
    domain: 'NEXUS',
  },
  boot: { online: 'SISTEMA ONLINE' },
  ideia: {
    words: [
      { word: 'DESCREVA.', sub: 'UM APP · UM SITE · UMA CORREÇÃO' },
      { word: 'DELEGUE.', sub: 'UMA EQUIPE DE AGENTES DE IA' },
      { word: 'RECEBA.', sub: 'ENTREGA COM EVIDÊNCIA' },
    ],
  },
  pedido: {
    brand: 'Nexus',
    rail: ['Início', 'Abrir projeto', 'Projeto', 'Terminais', 'Quadro', 'Memória'],
    title: 'O que você quer criar?',
    lead: 'Conte sua ideia ou o que precisa melhorar. O Nexus organiza a equipe para trabalhar no seu projeto.',
    label: 'Seu pedido',
    request: 'Um app de agenda pra minha barbearia, com lembrete no WhatsApp.',
    chips: ['Corrigir algo', 'Criar uma tela', 'Publicar'],
    projectLabel: 'Projeto',
    projectName: 'Minha barbearia',
    teamTitle: 'Equipe da criação',
    teamSub: '3 agentes · Claude · Codex',
    cta: 'Iniciar criação',
  },
  marca: {
    name: 'Nexus',
    taglineLines: ['Da ideia à entrega,', 'com uma frota de agentes.'],
  },
  missao: {
    eyebrow: 'MISSÃO',
    title: 'Agenda da barbearia',
    running: 'Rodando',
    done: 'Pronto',
    tasksLabel: 'TAREFAS',
    testsLabel: 'TESTES',
    steps: ['Pedido', 'Plano', 'Código', 'Revisão', 'Entrega'],
    stepSubs: ['SEU TEXTO', '4 TAREFAS', '3 AGENTES', '23 TESTES', 'COM EVIDÊNCIA'],
    words: ['Planejado.', 'Construído.', 'Revisado.', 'Entregue.'],
    log: [
      'orquestrador · dividiu em 4 tarefas',
      'executor · criou a tela de agenda',
      'executor · lembrete via WhatsApp',
      'revisor · 23 testes passaram',
      'entrega pronta, com evidência',
    ],
  },
  camadas: {
    layers: [
      { name: 'INÍCIO', sub: 'o que você vê' },
      { name: 'QUADRO', sub: 'a missão' },
      { name: 'TERMINAIS', sub: 'os agentes trabalhando' },
    ],
    board: {
      columns: ['A fazer', 'Fazendo', 'Feito'],
      cards: ['Tela de agenda', 'Lembrete WhatsApp', 'Pesquisar API', 'Testes'],
    },
    captionLines: ['Por baixo,', 'terminais de verdade.'],
    sub: 'PTYs REAIS · UM AGENTE POR PANE',
    panes: [
      {
        cli: 'Claude',
        role: 'Orquestrador',
        logo: 'claude.svg',
        lines: [
          '● Missão: agenda da barbearia',
          '  Dividi em 4 tarefas para a equipe.',
          '● Codex → tela de agenda e horários',
          '● Kimi → revisar e testar',
          '● Grok → pesquisar a API do WhatsApp',
          '  Aguardando as entregas…',
          '● 3 de 4 tarefas prontas',
        ],
      },
      {
        cli: 'Codex',
        role: 'Executor',
        logo: 'codex.svg',
        lines: [
          '$ npm create vite@latest agenda',
          '● Criando src/pages/Agenda.tsx',
          '● Criando src/lib/horarios.ts',
          '  + 212 linhas',
          '● Lembrete: src/jobs/whatsapp.ts',
          '$ npm test',
          '  ✓ 23 testes passaram',
        ],
      },
      {
        cli: 'Kimi',
        role: 'Revisor',
        logo: 'kimi.svg',
        lines: [
          '● Revisando o diff (4 arquivos)',
          '● Rodando os testes',
          '  ✓ 23/23 passaram',
          '● Testando o fluxo no navegador',
          '  ✓ agenda salva e lembra',
          '● Aprovado, com evidência',
        ],
      },
      {
        cli: 'Grok',
        role: 'Scout',
        logo: 'grok.svg',
        lines: [
          '● Pesquisando a API do WhatsApp',
          '  templates · webhooks · limites',
          '● 3 fontes oficiais lidas',
          '● Exemplo de envio agendado',
          '● Resumo enviado ao orquestrador',
        ],
      },
    ],
  },
  frota: {
    count: 17,
    label: 'CLIs de IA num só lugar',
    sub: 'DETECTA AS QUE VOCÊ JÁ TEM INSTALADAS',
  },
  failover: {
    line1: 'Qualquer CLI.',
    line2: 'Qualquer conta.',
    line2Highlight: 'conta',
    sub: 'FAILOVER AUTOMÁTICO · RETOMA COM --resume',
    limit: 'LIMITE',
    takeover: 'ASSUMIU',
    resumed: 'RETOMADO · --resume',
    accounts: ['CONTA 1', 'CONTA 2', 'CONTA 3', 'CONTA 4'],
    accountCli: 'claude',
  },
  recursos: {
    fale: 'FALE.',
    faleSub: 'VOZ: DITE, PERGUNTE, COMANDE',
    flapsLabel: 'UMA FROTA, VÁRIAS CLIs',
    flaps: ['CLAUDE', 'CODEX', 'KIMI', 'GROK'],
    controle: 'CONTROLE.',
    total: 'TOTAL.',
    controleSub: 'ASSUMA QUALQUER PANE, A QUALQUER MOMENTO',
  },
  fim: {
    name: 'Nexus',
    taglineLines: ['Da ideia à entrega,', 'com uma frota de agentes.'],
    line: 'MULTIAGENTE · MULTI-CLI · MULTI-CONTA',
    measure: '13 × 13',
  },
} as const;
```

`src/layout.ts`:

```ts
import type { ChapterId } from './timing';

export const SAFE = { left: 64, top: 250, right: 900, bottom: 1480 } as const;
export const SAFE_WIDTH = SAFE.right - SAFE.left;

export type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

export function insideSafe(b: Box): boolean {
  return b.x >= SAFE.left && b.y >= SAFE.top && b.x + b.w <= SAFE.right && b.y + b.h <= SAFE.bottom;
}

/** Caixas do texto essencial de cada capítulo, em coordenadas do quadro 1080×1920. */
export const TEXT = {
  boot: { online: { x: 340, y: 1030, w: 400, h: 40 } },
  ideia: {
    counter: { x: 740, y: 640, w: 160, h: 30 },
    word: { x: 72, y: 700, w: 828, h: 230 },
    sub: { x: 72, y: 950, w: 828, h: 40 },
  },
  pedido: {
    card: { x: 72, y: 330, w: 828, h: 1000 },
    title: { x: 290, y: 420, w: 580, h: 50 },
    request: { x: 290, y: 600, w: 580, h: 150 },
    cta: { x: 660, y: 1220, w: 210, h: 56 },
  },
  marca: {
    wordmark: { x: 240, y: 1010, w: 600, h: 150 },
    tagline: { x: 180, y: 1180, w: 720, h: 110 },
  },
  missao: {
    card: { x: 72, y: 290, w: 828, h: 150 },
    log: { x: 72, y: 460, w: 828, h: 170 },
    word: { x: 72, y: 1260, w: 828, h: 190 },
  },
  camadas: {
    caption: { x: 72, y: 1250, w: 828, h: 170 },
    sub: { x: 72, y: 1430, w: 828, h: 40 },
  },
  frota: {
    counter: { x: 72, y: 1070, w: 828, h: 220 },
    label: { x: 72, y: 1300, w: 828, h: 64 },
    sub: { x: 72, y: 1390, w: 828, h: 40 },
  },
  failover: {
    line1: { x: 72, y: 290, w: 828, h: 120 },
    line2: { x: 72, y: 410, w: 828, h: 120 },
    sub: { x: 72, y: 550, w: 828, h: 40 },
  },
  recursos: {
    fale: { x: 72, y: 760, w: 828, h: 300 },
    faleSub: { x: 72, y: 1080, w: 828, h: 40 },
    flapsLabel: { x: 72, y: 740, w: 828, h: 40 },
    flaps: { x: 105, y: 820, w: 770, h: 180 },
    controle: { x: 72, y: 720, w: 828, h: 200 },
    total: { x: 72, y: 920, w: 828, h: 200 },
    controleSub: { x: 72, y: 1150, w: 828, h: 40 },
  },
  fim: {
    measure: { x: 440, y: 520, w: 200, h: 30 },
    wordmark: { x: 240, y: 1020, w: 600, h: 150 },
    tagline: { x: 180, y: 1180, w: 720, h: 110 },
    line: { x: 180, y: 1320, w: 720, h: 40 },
  },
} as const satisfies { readonly [K in ChapterId]: Readonly<Record<string, Box>> };
```

`src/lib/nexusmark.ts`:

```ts
/** Geometria do NexusMark portada de nexus-ide/src/renderer/components/NexusMark.tsx (grade 13×13). */
export const MARK_GRID = 13;
export type Cell = readonly [number, number];

export const RING: readonly Cell[] = [
  [6, 2], [7, 3], [8, 4], [9, 5], [10, 6], [9, 7], [8, 8], [7, 9],
  [6, 10], [5, 9], [4, 8], [3, 7], [2, 6], [3, 5], [4, 4], [5, 3],
];

export const CORE: readonly Cell[] = [[6, 6], [5, 6], [7, 6], [6, 5], [6, 7]];

export const ORBITALS: readonly Cell[] = [[6, 0], [12, 6], [6, 12], [0, 6]];
```

`src/lib/pixel-art.ts`:

```ts
import type { Cell } from './nexusmark';

export const MIC: readonly string[] = [
  '....###....',
  '...#####...',
  '...#####...',
  '...#####...',
  '...#####...',
  '.#.#####.#.',
  '.#..###..#.',
  '..#.....#..',
  '...#####...',
  '.....#.....',
  '...#####...',
];

export function pixelCells(art: readonly string[]): Cell[] {
  return art.flatMap((row, y) => Array.from(row).flatMap((ch, x) => (ch === '#' ? [[x, y] as const] : [])));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run && npx tsc --noEmit`
Expected: todos os testes PASS; `tsc` sem erros.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: tokens, copy, área segura e geometria da marca"
```

---

### Task 5: Assets (fontes, logos) e carregamento de fontes

**Files:**
- Create: `public/fonts/*` (cópias), `public/fonts/PROVENANCE.md`, `public/logos/*` (cópias), `src/logos.ts`, `src/fonts.ts`, `src/ui/ProviderLogo.tsx`
- Test: `src/assets.test.ts`

**Interfaces:**
- Consumes: `FONT` (Task 4), `COPY` (Task 4).
- Produces: `CLI_ADAPTERS: readonly string[]` (17 ids); `CLI_LOGOS: readonly {id; file}[]` (15 marcas); `loadAllFonts(): Promise<void[]>`; `useFontsReady(): boolean`; `<ProviderLogo file size style?>`.

- [ ] **Step 1: Copiar fontes e logos com procedência**

```bash
IDE=/Users/cleofasrocha/dev/nexus-ide
REEL=/Users/cleofasrocha/dev/nexus-reel
mkdir -p $REEL/public/fonts $REEL/public/logos
cp $IDE/src/renderer/styles/fonts/Inter.var.ttf $IDE/src/renderer/styles/fonts/JetBrainsMono.var.ttf $IDE/src/renderer/styles/fonts/VT323-Regular.ttf $REEL/public/fonts/
cp $IDE/third_party/licenses/OFL-1.1.txt $REEL/public/fonts/
for f in agy.svg aider.png claude.svg codex.svg deepseek-color.svg devin.svg glm.svg grok.svg kimi.svg longcat.svg mimo-code.png muse.svg openclaude.svg opencode.svg qwen-color.svg NOTICE.md; do
  cp $IDE/src/renderer/assets/provider-logos/$f $REEL/public/logos/
done
# logos monocromáticos usam currentColor, que vira preto num <img>: pinta de branco-Nexus
sed -i '' 's/currentColor/#faf7f9/g' $REEL/public/logos/*.svg
grep -l currentColor $REEL/public/logos/*.svg || echo "sem currentColor"
ls $IDE/src/adapters/builtin/*.json | wc -l
```

Expected: `sem currentColor` e `17` (conferência da afirmação "17 CLIs").

`public/fonts/PROVENANCE.md`:

```markdown
# Fontes

Copiadas de `nexus-ide/src/renderer/styles/fonts/` em 25/09/2026.

- Inter (variável) e JetBrains Mono (variável): SIL OFL 1.1 — procedência em
  `nexus-ide/third_party/provenance/fonts-inter-jetbrains.json`.
- VT323: SIL OFL 1.1.

Licença: `OFL-1.1.txt` nesta pasta.
```

- [ ] **Step 2: Escrever o teste que falha**

`src/assets.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY } from './copy';
import { CLI_ADAPTERS, CLI_LOGOS } from './logos';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

describe('assets', () => {
  it('as três fontes e a licença estão em public/fonts', () => {
    for (const f of ['Inter.var.ttf', 'JetBrainsMono.var.ttf', 'VT323-Regular.ttf', 'OFL-1.1.txt']) {
      expect(existsSync(join(PUBLIC, 'fonts', f)), f).toBe(true);
    }
  });

  it('todo logo usado existe e nenhum SVG depende de currentColor', () => {
    const used = new Set([...CLI_LOGOS.map((l) => l.file), ...COPY.camadas.panes.map((p) => p.logo)]);
    for (const file of used) {
      const path = join(PUBLIC, 'logos', file);
      expect(existsSync(path), file).toBe(true);
      if (file.endsWith('.svg')) expect(readFileSync(path, 'utf8')).not.toContain('currentColor');
    }
  });

  it('o contador do vídeo bate com a lista de adaptadores', () => {
    expect(CLI_ADAPTERS).toHaveLength(COPY.frota.count);
    expect(new Set(CLI_ADAPTERS).size).toBe(CLI_ADAPTERS.length);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/assets.test.ts`
Expected: FAIL — `./logos` não resolve.

- [ ] **Step 4: Implementar**

`src/logos.ts`:

```ts
/** Adaptadores embutidos do nexus-ide 0.76.96 (src/adapters/builtin/*.json), conferidos em 25/09. */
export const CLI_ADAPTERS: readonly string[] = [
  'agy', 'aider', 'claude', 'codex', 'deepseek', 'devin', 'glm-flash', 'glm', 'grok',
  'kimi', 'longcat', 'mimo-code', 'muse-claude', 'muse', 'openclaude', 'opencode', 'qwen',
];

export const CLI_LOGOS: readonly { readonly id: string; readonly file: string }[] = [
  { id: 'claude', file: 'claude.svg' },
  { id: 'codex', file: 'codex.svg' },
  { id: 'kimi', file: 'kimi.svg' },
  { id: 'grok', file: 'grok.svg' },
  { id: 'qwen', file: 'qwen-color.svg' },
  { id: 'deepseek', file: 'deepseek-color.svg' },
  { id: 'opencode', file: 'opencode.svg' },
  { id: 'aider', file: 'aider.png' },
  { id: 'devin', file: 'devin.svg' },
  { id: 'glm', file: 'glm.svg' },
  { id: 'longcat', file: 'longcat.svg' },
  { id: 'agy', file: 'agy.svg' },
  { id: 'mimo-code', file: 'mimo-code.png' },
  { id: 'muse', file: 'muse.svg' },
  { id: 'openclaude', file: 'openclaude.svg' },
];
```

`src/fonts.ts`:

```ts
import { loadFont } from '@remotion/fonts';
import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';
import { FONT } from './theme';

export function loadAllFonts(): Promise<void[]> {
  return Promise.all([
    loadFont({ family: FONT.ui, url: staticFile('fonts/Inter.var.ttf'), weight: '100 900' }),
    loadFont({ family: FONT.mono, url: staticFile('fonts/JetBrainsMono.var.ttf'), weight: '100 800' }),
    loadFont({ family: FONT.pixel, url: staticFile('fonts/VT323-Regular.ttf'), weight: '400' }),
  ]);
}

/** Segura o render até as fontes carregarem: fitText mede errado com a fonte de fallback. */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('Carregando as fontes do Nexus'));
  useEffect(() => {
    loadAllFonts()
      .then(() => {
        setReady(true);
        continueRender(handle);
      })
      .catch((err: unknown) => cancelRender(err));
  }, [handle]);
  return ready;
}
```

`src/ui/ProviderLogo.tsx`:

```tsx
import React from 'react';
import { Img, staticFile } from 'remotion';

export const ProviderLogo: React.FC<{ file: string; size: number; style?: React.CSSProperties }> = ({ file, size, style }) => (
  <Img
    src={staticFile(`logos/${file}`)}
    style={{
      width: size,
      height: size,
      objectFit: 'contain',
      imageRendering: file.endsWith('.png') ? 'pixelated' : 'auto',
      ...style,
    }}
  />
);
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS; `tsc` sem erros.

- [ ] **Step 6: Commit**

```bash
git add public src
git commit -m "feat: fontes e logos com procedência, carregamento de fontes"
```

---

### Task 6: Palco — fundo, grão, HUD, palavra gigante, efeitos e esqueleto do reel

**Files:**
- Modify: `src/timing.ts` (constante `PINK_FLASH`), `src/theme.ts` (token `danger`), `src/Reel.tsx` (substitui o provisório)
- Create: `src/hud/hud-state.ts`, `src/hud/Hud.tsx`, `src/fx/Background.tsx`, `src/fx/Grain.tsx`, `src/fx/ColorFilters.tsx`, `src/fx/Glitch.tsx`, `src/fx/Flare.tsx`, `src/fx/SafeZones.tsx`, `src/ui/BigWord.tsx`, `src/ui/MonoLabel.tsx`, `src/chapters/types.ts`, `src/chapters/Placeholder.tsx`, `src/chapters/index.ts`, `scripts/stills.sh`
- Test: `src/hud/hud-state.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `PINK_FLASH = {startBeat: 36, endBeat: 37}`; `COLOR.danger`; `hudState(frame, g?) → {index; total; label; ink: 'light'|'dark'}`; `<Hud/>`; `<Background/>`; `<Grain/>`; `<ColorFilters/>` (filtros `nx-only-red`, `nx-only-cyan`); `<Glitch amount seed>`; `<Flare x y size intensity color?>`; `<SafeZones/>`; `<BigWord text box enter exit? color? periodColor? highlight? highlightColor? variant? weight? maxFontSize? align?>`; `<MonoLabel text box enter typeFrames? size? color? align? weight?>`; `type ChapterProps = {chapter: Chapter}`; `CHAPTER_COMPONENTS: Record<ChapterId, React.FC<ChapterProps>>`; `scripts/stills.sh <nome> <quadro...>`.

- [ ] **Step 1: Escrever o teste que falha**

`src/hud/hud-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHAPTERS, PINK_FLASH, beatToFrame } from '../timing';
import { hudState } from './hud-state';

const G = { bpm: 128, fps: 60 } as const;

describe('hudState', () => {
  it('mostra o capítulo 01 no começo', () => {
    expect(hudState(0, G)).toEqual({ index: '01', total: '09', label: 'IDEIA', ink: 'light' });
  });

  it('escurece a tinta só durante a tela rosa do FALE', () => {
    const start = beatToFrame(PINK_FLASH.startBeat, G);
    const end = beatToFrame(PINK_FLASH.endBeat, G);
    expect(hudState(start - 1, G).ink).toBe('light');
    expect(hudState(start, G)).toMatchObject({ index: '08', label: 'RECURSOS', ink: 'dark' });
    expect(hudState(end, G).ink).toBe('light');
  });

  it('a tela rosa fica dentro do capítulo recursos', () => {
    const recursos = CHAPTERS.find((c) => c.id === 'recursos');
    expect(recursos?.startBeat).toBeLessThanOrEqual(PINK_FLASH.startBeat);
    expect(recursos?.endBeat).toBeGreaterThanOrEqual(PINK_FLASH.endBeat);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/hud`
Expected: FAIL — `PINK_FLASH` não exportado e `./hud-state` não resolve.

- [ ] **Step 3: Implementar o estado do HUD**

Acrescente ao fim de `src/timing.ts`:

```ts
/** Janela da tela rosa do FALE (capítulo recursos); o HUD troca de tinta nela. */
export const PINK_FLASH = { startBeat: 36, endBeat: 37 } as const;
```

Acrescente o token `danger` (DESIGN.md `--danger`) em `COLOR`, em `src/theme.ts`, logo depois de `warn`:

```ts
  danger: '#ff6b4a',
```

`src/hud/hud-state.ts`:

```ts
import { GRID, PINK_FLASH, beatToFrame, chapterAt, type Grid } from '../timing';

export type HudState = {
  readonly index: string;
  readonly total: string;
  readonly label: string;
  readonly ink: 'light' | 'dark';
};

export function hudState(frame: number, g: Grid = GRID): HudState {
  const chapter = chapterAt(frame, g);
  const inPink = frame >= beatToFrame(PINK_FLASH.startBeat, g) && frame < beatToFrame(PINK_FLASH.endBeat, g);
  return {
    index: String(chapter.hudIndex).padStart(2, '0'),
    total: '09',
    label: chapter.hudLabel,
    ink: inPink ? 'dark' : 'light',
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/hud`
Expected: PASS.

- [ ] **Step 5: Componentes do palco**

`src/hud/Hud.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COPY } from '../copy';
import { timecode } from '../lib/timecode';
import { COLOR, FONT, withAlpha } from '../theme';
import { hudState } from './hud-state';

const EDGE = 40;
const INSET = 84;
const ARM = 34;

export const Hud: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = hudState(frame);
  const ink = s.ink === 'dark' ? COLOR.bg : COLOR.text;
  const live = s.ink === 'dark' ? COLOR.bg : COLOR.accent;
  const text = (alpha: number, size: number, weight = 500): React.CSSProperties => ({
    fontFamily: FONT.mono,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: '0.14em',
    color: withAlpha(ink, alpha),
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  });
  const corner = (pos: React.CSSProperties, borders: React.CSSProperties) => (
    <div style={{ position: 'absolute', width: ARM, height: ARM, ...pos, ...borders }} />
  );
  const line = `2px solid ${withAlpha(ink, 0.4)}`;
  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {corner({ left: EDGE, top: EDGE }, { borderLeft: line, borderTop: line })}
      {corner({ right: EDGE, top: EDGE }, { borderRight: line, borderTop: line })}
      {corner({ left: EDGE, bottom: EDGE }, { borderLeft: line, borderBottom: line })}
      {corner({ right: EDGE, bottom: EDGE }, { borderRight: line, borderBottom: line })}

      <div style={{ position: 'absolute', left: INSET, top: 64 }}>
        <div style={text(0.72, 19, 600)}>{COPY.hud.brand}</div>
        <div style={{ ...text(0.45, 16), marginTop: 6 }}>{COPY.hud.reel}</div>
        <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ width: 7, height: 7, background: i === 0 ? live : withAlpha(ink, 0.25) }} />
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', right: INSET, top: 64, textAlign: 'right' }}>
        <div style={text(0.72, 19, 600)}>{timecode(frame, fps)}</div>
        <div style={{ ...text(0.45, 16), marginTop: 6 }}>{COPY.hud.spec}</div>
      </div>

      <div style={{ position: 'absolute', left: INSET, bottom: 64, display: 'flex', gap: 14, alignItems: 'baseline' }}>
        <span style={{ ...text(1, 17, 600), color: live }}>{s.index}</span>
        <span style={text(0.45, 17)}>/ {s.total}</span>
        <span style={text(0.72, 19, 600)}>{s.label}</span>
      </div>

      <div style={{ position: 'absolute', right: INSET, bottom: 64, width: 200, textAlign: 'right' }}>
        <div style={{ height: 2, background: withAlpha(ink, 0.15), marginBottom: 12 }}>
          <div style={{ height: 2, width: `${progress * 100}%`, background: live }} />
        </div>
        <div style={text(0.72, 19, 600)}>{COPY.hud.domain}</div>
      </div>
    </AbsoluteFill>
  );
};
```

`src/fx/Background.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, random, useCurrentFrame } from 'remotion';
import { HEIGHT, WIDTH } from '../timing';
import { COLOR, withAlpha } from '../theme';

const DUST = Array.from({ length: 40 }, (_, i) => ({
  x: random(`dust-x-${i}`) * WIDTH,
  y: random(`dust-y-${i}`) * HEIGHT,
  speed: 0.15 + random(`dust-s-${i}`) * 0.6,
  size: 2 + Math.round(random(`dust-z-${i}`) * 2),
  phase: random(`dust-p-${i}`) * Math.PI * 2,
  pink: random(`dust-c-${i}`) < 0.18,
}));

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = 'radial-gradient(ellipse 70% 60% at 50% 45%, black 20%, transparent 80%)';
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.bg }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(circle, ${withAlpha(COLOR.white, 0.1)} 1.3px, transparent 1.7px)`,
          backgroundSize: '30px 30px',
          backgroundPosition: `${-frame * 0.12}px ${-frame * 0.3}px`,
          maskImage: fade,
          WebkitMaskImage: fade,
          opacity: 0.55,
        }}
      />
      {DUST.map((d, i) => {
        const top = (((d.y - frame * d.speed) % HEIGHT) + HEIGHT) % HEIGHT;
        const twinkle = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(frame * 0.06 + d.phase));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: d.x,
              top,
              width: d.size,
              height: d.size,
              background: d.pink ? COLOR.accent : COLOR.text,
              opacity: twinkle,
            }}
          />
        );
      })}
      <AbsoluteFill
        style={{ background: `radial-gradient(ellipse 80% 70% at 50% 45%, transparent 40%, ${withAlpha(COLOR.bg, 0.92)} 100%)` }}
      />
    </AbsoluteFill>
  );
};
```

`src/fx/Grain.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen', opacity: 0.06 }}>
      <svg width="100%" height="100%">
        <filter id="nx-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={frame % 97} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#nx-grain)" />
      </svg>
    </AbsoluteFill>
  );
};
```

`src/fx/ColorFilters.tsx`:

```tsx
import React from 'react';

/** Filtros SVG de canal usados pelo Glitch (definidos uma vez no Reel). */
export const ColorFilters: React.FC = () => (
  <svg width={0} height={0} style={{ position: 'absolute' }}>
    <defs>
      <filter id="nx-only-red">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
      </filter>
      <filter id="nx-only-cyan">
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
      </filter>
    </defs>
  </svg>
);
```

`src/fx/Glitch.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, random, useCurrentFrame } from 'remotion';

/** Separação de canais + fatias deslocadas. Máximo de 3 usos no vídeo (spec). */
export const Glitch: React.FC<{ amount: number; seed: string; children: React.ReactNode }> = ({ amount, seed, children }) => {
  const frame = useCurrentFrame();
  if (amount <= 0.001) return <AbsoluteFill>{children}</AbsoluteFill>;
  const shift = 14 * amount;
  const bands = Array.from({ length: 6 }, (_, i) => {
    const top = random(`${seed}-t-${i}-${frame}`) * 92;
    const height = 2 + random(`${seed}-h-${i}-${frame}`) * 9;
    return {
      top,
      bottom: Math.max(0, 100 - top - height),
      dx: (random(`${seed}-x-${i}-${frame}`) - 0.5) * 160 * amount,
    };
  });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - 0.35 * amount }}>{children}</AbsoluteFill>
      <AbsoluteFill style={{ transform: `translateX(${shift}px)`, filter: 'url(#nx-only-red)', mixBlendMode: 'screen', opacity: 0.8 * amount }}>
        {children}
      </AbsoluteFill>
      <AbsoluteFill style={{ transform: `translateX(${-shift}px)`, filter: 'url(#nx-only-cyan)', mixBlendMode: 'screen', opacity: 0.8 * amount }}>
        {children}
      </AbsoluteFill>
      {bands.map((b, i) => (
        <AbsoluteFill key={i} style={{ clipPath: `inset(${b.top}% 0 ${b.bottom}% 0)`, transform: `translateX(${b.dx}px)` }}>
          {children}
        </AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
};
```

`src/fx/Flare.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { COLOR, withAlpha } from '../theme';

export const Flare: React.FC<{ x: number; y: number; size: number; intensity: number; color?: string }> = ({
  x,
  y,
  size,
  intensity,
  color = COLOR.accent,
}) => {
  if (intensity <= 0.001) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: x - size / 2,
          top: y - size / 2,
          width: size,
          height: size,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${withAlpha(COLOR.white, Math.min(1, intensity))} 0%, ${withAlpha(color, 0.6 * intensity)} 18%, ${withAlpha(color, 0)} 62%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: x - size * 2,
          top: y - 2,
          width: size * 4,
          height: 4,
          background: `linear-gradient(90deg, ${withAlpha(color, 0)}, ${withAlpha(COLOR.white, 0.8 * Math.min(1, intensity))}, ${withAlpha(color, 0)})`,
          filter: 'blur(1px)',
        }}
      />
    </AbsoluteFill>
  );
};
```

`src/fx/SafeZones.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { SAFE, SAFE_WIDTH } from '../layout';
import { HEIGHT, WIDTH } from '../timing';
import { COLOR, withAlpha } from '../theme';

/** Só para verificação: pinta o que as interfaces do Reels/TikTok cobrem. */
export const SafeZones: React.FC = () => {
  const zone = withAlpha(COLOR.danger, 0.28);
  const box = (left: number, top: number, width: number, height: number, background: string) => (
    <div style={{ position: 'absolute', left, top, width, height, background }} />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {box(0, 0, WIDTH, SAFE.top, zone)}
      {box(0, SAFE.bottom, WIDTH, HEIGHT - SAFE.bottom, zone)}
      {box(SAFE.right, SAFE.top, WIDTH - SAFE.right, SAFE.bottom - SAFE.top, zone)}
      {box(0, SAFE.top, SAFE.left, SAFE.bottom - SAFE.top, withAlpha(COLOR.danger, 0.18))}
      <div
        style={{
          position: 'absolute',
          left: SAFE.left,
          top: SAFE.top,
          width: SAFE_WIDTH,
          height: SAFE.bottom - SAFE.top,
          outline: `2px dashed ${withAlpha(COLOR.danger, 0.9)}`,
        }}
      />
    </AbsoluteFill>
  );
};
```

`src/ui/BigWord.tsx`:

```tsx
import { fitText } from '@remotion/layout-utils';
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Box } from '../layout';
import { EASE, tween } from '../lib/anim';
import { COLOR, FONT, glow, withAlpha } from '../theme';

type BigWordProps = {
  readonly text: string;
  readonly box: Box;
  readonly enter: number;
  readonly exit?: number;
  readonly color?: string;
  readonly periodColor?: string;
  readonly highlight?: string;
  readonly highlightColor?: string;
  readonly variant?: 'solid' | 'outline';
  readonly weight?: number;
  readonly maxFontSize?: number;
  readonly align?: 'left' | 'center';
};

const TRACKING = '-0.04em';

/** Palavra gigante: o "." final vira o quadrado de acento (assinatura do reel). */
export const BigWord: React.FC<BigWordProps> = ({
  text,
  box,
  enter,
  exit,
  color = COLOR.text,
  periodColor = COLOR.accent,
  highlight,
  highlightColor = COLOR.accent,
  variant = 'solid',
  weight = 900,
  maxFontSize = 190,
  align = 'left',
}) => {
  const frame = useCurrentFrame();
  const t = frame - enter;
  if (t < 0) return null;
  const body = text.endsWith('.') ? text.slice(0, -1) : text;
  const fontSize = Math.min(
    maxFontSize,
    fitText({ text: `${body}.`, withinWidth: box.w, fontFamily: FONT.ui, fontWeight: weight, letterSpacing: TRACKING, validateFontIsLoaded: true }).fontSize,
  );

  let opacity = tween(t, 0, 8, 0, 1, EASE.outQuart);
  let y = tween(t, 0, 14, 64, 0);
  let blur = tween(t, 0, 10, 18, 0);
  const scale = tween(t, 0, 16, 1.06, 1) * (1 + 0.0006 * t);
  if (exit !== undefined) {
    const e = frame - exit;
    opacity *= tween(e, 0, 7, 1, 0, EASE.inExpo);
    y += tween(e, 0, 7, 0, -48, EASE.inExpo);
    blur += tween(e, 0, 7, 0, 16, EASE.inExpo);
  }

  const outline = variant === 'outline';
  const stroke = Math.max(2, fontSize / 60);
  const cut = highlight ? body.lastIndexOf(highlight) : -1;
  const before = cut >= 0 ? body.slice(0, cut) : body;
  const marked = cut >= 0 ? body.slice(cut, cut + (highlight?.length ?? 0)) : '';
  const after = cut >= 0 ? body.slice(cut + marked.length) : '';
  const ink = (c: string): React.CSSProperties =>
    outline ? { color: 'transparent', WebkitTextStroke: `${stroke}px ${c}` } : { color: c, textShadow: `0 0 30px ${withAlpha(COLOR.white, 0.22)}` };

  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
      }}
    >
      <div
        style={{
          fontFamily: FONT.ui,
          fontWeight: weight,
          fontSize,
          letterSpacing: TRACKING,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          opacity,
          filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
          transform: `translateY(${y}px) scale(${scale})`,
          transformOrigin: align === 'center' ? 'center bottom' : 'left bottom',
        }}
      >
        <span style={ink(color)}>{before}</span>
        {marked ? <span style={ink(highlightColor)}>{marked}</span> : null}
        {after ? <span style={ink(color)}>{after}</span> : null}
        <span
          style={{
            display: 'inline-block',
            width: '0.19em',
            height: '0.19em',
            marginLeft: '0.06em',
            background: outline ? 'transparent' : periodColor,
            border: outline ? `${stroke}px solid ${periodColor}` : undefined,
            boxShadow: outline ? undefined : glow(periodColor, 0.8),
          }}
        />
      </div>
    </div>
  );
};
```

`src/ui/MonoLabel.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Box } from '../layout';
import { tween } from '../lib/anim';
import { typedText } from '../lib/typewriter';
import { COLOR, FONT } from '../theme';

type MonoLabelProps = {
  readonly text: string;
  readonly box: Box;
  readonly enter: number;
  readonly typeFrames?: number;
  readonly size?: number;
  readonly color?: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly weight?: number;
  readonly family?: string;
  readonly tracking?: string;
};

/** Rótulo mono em maiúsculas que se digita rápido; usado em subtítulos e medidas. */
export const MonoLabel: React.FC<MonoLabelProps> = ({
  text,
  box,
  enter,
  typeFrames = 12,
  size = 22,
  color = COLOR.textDim,
  align = 'left',
  weight = 500,
  family = FONT.mono,
  tracking = '0.18em',
}) => {
  const frame = useCurrentFrame();
  if (frame < enter) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        fontFamily: family,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        color,
        whiteSpace: 'nowrap',
        opacity: tween(frame, enter, enter + 4, 0, 1),
      }}
    >
      {typedText(text, frame, enter, enter + typeFrames)}
    </div>
  );
};
```

`src/chapters/types.ts`:

```ts
import type { Chapter } from '../timing';

export type ChapterProps = { readonly chapter: Chapter };
```

`src/chapters/Placeholder.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { COLOR, FONT } from '../theme';
import type { ChapterProps } from './types';

export const Placeholder: React.FC<ChapterProps> = ({ chapter }) => (
  <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
    <div style={{ fontFamily: FONT.mono, fontSize: 40, letterSpacing: '0.2em', color: COLOR.textDim }}>
      {chapter.id.toUpperCase()}
    </div>
  </AbsoluteFill>
);
```

`src/chapters/index.ts` (cada Task de capítulo troca a sua entrada):

```ts
import type React from 'react';
import type { ChapterId } from '../timing';
import { Placeholder } from './Placeholder';
import type { ChapterProps } from './types';

export const CHAPTER_COMPONENTS: Record<ChapterId, React.FC<ChapterProps>> = {
  boot: Placeholder,
  ideia: Placeholder,
  pedido: Placeholder,
  marca: Placeholder,
  missao: Placeholder,
  camadas: Placeholder,
  frota: Placeholder,
  failover: Placeholder,
  recursos: Placeholder,
  fim: Placeholder,
};
```

`src/Reel.tsx` (substitui o provisório):

```tsx
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { CHAPTER_COMPONENTS } from './chapters';
import { useFontsReady } from './fonts';
import { Background } from './fx/Background';
import { ColorFilters } from './fx/ColorFilters';
import { Grain } from './fx/Grain';
import { SafeZones } from './fx/SafeZones';
import { Hud } from './hud/Hud';
import { CHAPTERS, chapterRange } from './timing';
import { COLOR, FONT } from './theme';

export type ReelProps = { readonly debugSafe: boolean };

export const Reel: React.FC<ReelProps> = ({ debugSafe }) => {
  const fontsReady = useFontsReady();
  if (!fontsReady) return <AbsoluteFill style={{ backgroundColor: COLOR.bg }} />;
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.bg, fontFamily: FONT.ui, color: COLOR.text }}>
      <ColorFilters />
      <Background />
      {CHAPTERS.map((c) => {
        const range = chapterRange(c);
        const Chapter = CHAPTER_COMPONENTS[c.id];
        return (
          <Sequence key={c.id} name={c.id} from={range.from} durationInFrames={range.durationInFrames}>
            <Chapter chapter={c} />
          </Sequence>
        );
      })}
      <Hud />
      <Grain />
      {debugSafe ? <SafeZones /> : null}
    </AbsoluteFill>
  );
};
```

`scripts/stills.sh` (`chmod +x`):

```bash
#!/usr/bin/env bash
# Uso: scripts/stills.sh <nome> <quadro> [<quadro>...]
# DEBUG_SAFE=1 sobrepõe as áreas das plataformas. Gera out/stills/<nome>-NNNN.png e out/stills/<nome>-sheet.png.
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1; shift
mkdir -p out/stills
props='{"debugSafe":false}'
if [ "${DEBUG_SAFE:-0}" = 1 ]; then props='{"debugSafe":true}'; fi
npx remotion bundle src/index.ts --out-dir=out/bundle --log=error >/dev/null
files=()
for f in "$@"; do
  out="out/stills/${name}-$(printf '%04d' "$f").png"
  npx remotion still out/bundle NexusReel "$out" --frame="$f" --props="$props" --log=error
  files+=("$out")
done
n=${#files[@]}
if [ "$n" -eq 1 ]; then cp "${files[0]}" "out/stills/${name}-sheet.png"; echo "out/stills/${name}-sheet.png"; exit 0; fi
cols=$(( n < 4 ? n : 4 ))
inputs=(); filter=""; stack=""; layout=""
for i in $(seq 0 $((n - 1))); do
  inputs+=(-i "${files[$i]}")
  filter+="[$i:v]scale=360:640[s$i];"
  stack+="[s$i]"
  layout+="$(( (i % cols) * 360 ))_$(( (i / cols) * 640 ))|"
done
ffmpeg -hide_banner -loglevel error -y "${inputs[@]}" \
  -filter_complex "${filter}${stack}xstack=inputs=$n:layout=${layout%|}:fill=black" \
  "out/stills/${name}-sheet.png"
echo "out/stills/${name}-sheet.png"
```

- [ ] **Step 6: Verificar tipos, testes e o palco em imagem**

Run: `chmod +x scripts/stills.sh && npx tsc --noEmit && npx vitest run && scripts/stills.sh t6 0 400 1100 && DEBUG_SAFE=1 scripts/stills.sh t6safe 400`
Expected: `tsc` e testes limpos (se `remotion bundle` não existir nesta versão, troque `out/bundle` por `src/index.ts` no script). Abra `out/stills/t6-sheet.png` e `out/stills/t6safe-sheet.png` (Read) e confirme:
- fundo preto neutro com grade de pontos visível no centro, sem banding; poeira discreta;
- HUD com os 4 cantos, `NEXUS // CENTRO DE COMANDO`, timecode (`00:00:06:40` no quadro 400), `03 / 09 MARCA` no quadro 400, barra de progresso;
- texto do placeholder em JetBrains Mono (não em fonte serifada de fallback);
- o still com `DEBUG_SAFE` mostra as faixas vermelhas nas bordas e o retângulo tracejado da área segura.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: palco do reel — fundo, HUD, grão, palavra gigante e efeitos"
```

---

### Task 7: Capítulos 00 (boot) e 01 (ideia)

**Files:**
- Create: `src/ui/FrameMarks.tsx`, `src/ui/Rule.tsx`, `src/chapters/C00Boot.tsx`, `src/chapters/C01Ideia.tsx`
- Modify: `src/chapters/index.ts` (entradas `boot` e `ideia`)

**Interfaces:**
- Consumes: `localFrame`, `COPY.boot`, `COPY.ideia`, `TEXT.boot`, `TEXT.ideia`, `BigWord`, `MonoLabel`, `Glitch`, `tween`, `EASE`, `glow`.
- Produces: `<FrameMarks box enter exit?>`; `<Rule box enter exit?>`; `C00Boot`; `C01Ideia`. Constante `BOOT_CENTER = {x: 540, y: 840}` exportada de `C00Boot.tsx` (o pixel que o capítulo 01 herda).

- [ ] **Step 1: Peças de moldura**

`src/ui/FrameMarks.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Box } from '../layout';
import { EASE, tween } from '../lib/anim';
import { COLOR, withAlpha } from '../theme';

const PAD = 24;
const ARM = 22;

/** Cantoneiras que enquadram a palavra gigante e estalam a cada troca. */
export const FrameMarks: React.FC<{ box: Box; enter: number; exit?: number }> = ({ box, enter, exit }) => {
  const frame = useCurrentFrame();
  const t = frame - enter;
  if (t < 0) return null;
  const out = exit === undefined ? 1 : tween(frame, exit, exit + 6, 1, 0, EASE.inExpo);
  const opacity = tween(t, 0, 6, 0, 0.5) * out;
  const scale = tween(t, 0, 10, 1.08, 1);
  const line = `2px solid ${withAlpha(COLOR.text, 0.35)}`;
  const mark = (style: React.CSSProperties) => <div style={{ position: 'absolute', width: ARM, height: ARM, ...style }} />;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x - PAD,
        top: box.y - PAD,
        width: box.w + PAD * 2,
        height: box.h + PAD * 2,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      {mark({ left: 0, top: 0, borderLeft: line, borderTop: line })}
      {mark({ right: 0, top: 0, borderRight: line, borderTop: line })}
      {mark({ left: 0, bottom: 0, borderLeft: line, borderBottom: line })}
      {mark({ right: 0, bottom: 0, borderRight: line, borderBottom: line })}
    </div>
  );
};
```

`src/ui/Rule.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Box } from '../layout';
import { EASE, tween } from '../lib/anim';
import { BORDER_STRONG, COLOR } from '../theme';

/** Fio fino sob a palavra, com o tique rosa na ponta esquerda. */
export const Rule: React.FC<{ box: Box; enter: number; exit?: number }> = ({ box, enter, exit }) => {
  const frame = useCurrentFrame();
  if (frame < enter) return null;
  const grow = tween(frame, enter, enter + 12, 0, 1);
  const out = exit === undefined ? 1 : tween(frame, exit, exit + 6, 1, 0, EASE.inExpo);
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y - 10, width: box.w * grow, height: 1, background: BORDER_STRONG, opacity: out }}>
      <div style={{ position: 'absolute', left: 0, top: -1, width: 10, height: 3, background: COLOR.accent }} />
    </div>
  );
};
```

- [ ] **Step 2: Capítulo 00**

`src/chapters/C00Boot.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COPY } from '../copy';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { COLOR, FONT, glow, withAlpha } from '../theme';
import { MonoLabel } from '../ui/MonoLabel';
import type { ChapterProps } from './types';

export const BOOT_CENTER = { x: 540, y: 840 } as const;
const R = 150;

export const C00Boot: React.FC<ChapterProps> = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { x: cx, y: cy } = BOOT_CENTER;
  const circumference = 2 * Math.PI * R;
  const pixel = tween(frame, 0, 6, 0, 1);
  const ring = tween(frame, 2, 20, 0, 1, EASE.outQuart);
  const out = tween(frame, durationInFrames - 6, durationInFrames, 1, 0, EASE.inExpo);
  const scanDeg = frame * 7;
  return (
    <AbsoluteFill>
      <svg width={1080} height={1920} style={{ position: 'absolute', opacity: out }}>
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="none"
          stroke={withAlpha(COLOR.white, 0.18)}
          strokeWidth={2}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ring)}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={R + 18}
          fill="none"
          stroke={withAlpha(COLOR.accent, 0.65)}
          strokeWidth={2}
          strokeDasharray={`${circumference * 0.08} ${circumference}`}
          transform={`rotate(${scanDeg} ${cx} ${cy})`}
          opacity={ring}
        />
        {[0, 90, 180, 270].map((a) => (
          <line
            key={a}
            x1={cx}
            y1={cy - R - 12}
            x2={cx}
            y2={cy - R + 12}
            stroke={withAlpha(COLOR.white, 0.35)}
            strokeWidth={2}
            transform={`rotate(${a} ${cx} ${cy})`}
            opacity={ring}
          />
        ))}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: cx - 7,
          top: cy - 7,
          width: 14,
          height: 14,
          background: COLOR.accent,
          boxShadow: glow(COLOR.accent, 1.2),
          transform: `scale(${pixel})`,
        }}
      />
      <div style={{ opacity: out }}>
        <MonoLabel text={COPY.boot.online} box={TEXT.boot.online} enter={6} typeFrames={12} family={FONT.pixel} size={34} tracking="0.24em" align="center" />
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Capítulo 01**

`src/chapters/C01Ideia.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COPY } from '../copy';
import { Glitch } from '../fx/Glitch';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { localFrame } from '../timing';
import { COLOR, glow, withAlpha } from '../theme';
import { BigWord } from '../ui/BigWord';
import { FrameMarks } from '../ui/FrameMarks';
import { MonoLabel } from '../ui/MonoLabel';
import { Rule } from '../ui/Rule';
import { BOOT_CENTER } from './C00Boot';
import type { ChapterProps } from './types';

export const C01Ideia: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const at = (beat: number) => localFrame(beat, chapter);
  const starts = [at(1), at(3), at(5)];
  const glitch = tween(frame, at(6.5), durationInFrames, 0, 1, EASE.inOutCubic);
  const handoff = tween(frame, 0, 6, 1, 0, EASE.inExpo);

  return (
    <AbsoluteFill>
      <Glitch amount={glitch} seed="ideia">
        {COPY.ideia.words.map((w, i) => {
          const enter = starts[i];
          const exit = i < starts.length - 1 ? starts[i + 1] - 5 : undefined;
          if (frame < enter || (exit !== undefined && frame >= exit + 8)) return null;
          const fade = exit === undefined ? 1 : tween(frame, exit, exit + 6, 1, 0, EASE.inExpo);
          return (
            <AbsoluteFill key={w.word}>
              <FrameMarks box={TEXT.ideia.word} enter={enter} exit={exit} />
              <BigWord text={w.word} box={TEXT.ideia.word} enter={enter} exit={exit} />
              <Rule box={TEXT.ideia.sub} enter={enter + 4} exit={exit} />
              <div style={{ opacity: fade }}>
                <MonoLabel text={w.sub} box={TEXT.ideia.sub} enter={enter + 5} typeFrames={14} />
                <MonoLabel
                  text={`0${i + 1} / 03`}
                  box={TEXT.ideia.counter}
                  enter={enter}
                  typeFrames={1}
                  align="right"
                  size={20}
                  color={withAlpha(COLOR.text, 0.45)}
                />
              </div>
            </AbsoluteFill>
          );
        })}
      </Glitch>
      <div
        style={{
          position: 'absolute',
          left: BOOT_CENTER.x - 7,
          top: BOOT_CENTER.y - 7,
          width: 14,
          height: 14,
          background: COLOR.accent,
          boxShadow: glow(COLOR.accent, 1.2),
          opacity: handoff,
          transform: `scale(${handoff})`,
        }}
      />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Registrar os capítulos**

Em `src/chapters/index.ts`, importe e troque as entradas:

```ts
import { C00Boot } from './C00Boot';
import { C01Ideia } from './C01Ideia';
// ...
  boot: C00Boot,
  ideia: C01Ideia,
```

- [ ] **Step 5: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t7 10 22 45 100 160 188 && DEBUG_SAFE=1 scripts/stills.sh t7safe 45 100 160`
Expected: tipos e testes limpos. Em `out/stills/t7-sheet.png` confira:
- quadro 10: pixel rosa no centro com brilho, anel se desenhando, "SISTEMA ONLINE" em VT323 aparecendo;
- quadro 45: **DESCREVA** em Inter 900 com o quadrado rosa no lugar do ponto, cantoneiras em volta, fio com tique rosa e "UM APP · UM SITE · UMA CORREÇÃO" em mono, contador `01 / 03`;
- quadros 100 e 160: DELEGUE. e RECEBA. no mesmo lugar, sem restos da palavra anterior;
- quadro 188: RECEBA. com separação de canais e fatias deslocadas.
Em `t7safe-sheet.png`, nenhuma palavra ou subtítulo encosta nas faixas vermelhas. Se algo destoar (tamanho, espaço entre palavra e subtítulo), ajuste as caixas em `src/layout.ts` e rode de novo os testes de layout.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat: capítulos boot e ideia"
```

---

### Task 8: Capítulo 02 (pedido) — tela Início, digitação, clique e colapso

**Files:**
- Modify: `src/copy.ts` (`pedido.ctaBusy`)
- Create: `src/ui/NexusMarkFlat.tsx`, `src/ui/InicioCard.tsx`, `src/ui/Cursor.tsx`, `src/chapters/C02Pedido.tsx`
- Modify: `src/chapters/index.ts` (entrada `pedido`)

**Interfaces:**
- Consumes: `RING`, `CORE`, `ORBITALS`, `COPY.pedido`, `TEXT.pedido`, `typedText`, `tween`, `EASE`, `Flare`, `localFrame`.
- Produces: `<NexusMarkFlat size color>`; `<InicioCard typed caretOn ctaLabel ctaPressed>` (828×1000, coordenadas internas); `<Cursor x y scale>`; `C02Pedido`; constante `LOGO_CENTER = {x: 540, y: 800}` exportada de `src/ui/NexusMarkFlat.tsx` (ponto onde o colapso termina e o logo nasce).

- [ ] **Step 1: Copy do botão ocupado**

Em `src/copy.ts`, dentro de `pedido`, logo depois de `cta`:

```ts
    ctaBusy: 'Iniciando…',
```

- [ ] **Step 2: Marca plana e cursor**

`src/ui/NexusMarkFlat.tsx`:

```tsx
import React from 'react';
import { CORE, MARK_GRID, ORBITALS, RING } from '../lib/nexusmark';

/** Centro do logo no quadro: o colapso do capítulo 02 termina aqui e o capítulo 03 nasce daqui. */
export const LOGO_CENTER = { x: 540, y: 800 } as const;

export const NexusMarkFlat: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`} shapeRendering="crispEdges" fill={color}>
    {RING.map(([x, y]) => <rect key={`r${x}-${y}`} x={x} y={y} width={1} height={1} opacity={0.92} />)}
    {ORBITALS.map(([x, y]) => <rect key={`o${x}-${y}`} x={x} y={y} width={1} height={1} opacity={0.55} />)}
    {CORE.map(([x, y]) => <rect key={`c${x}-${y}`} x={x} y={y} width={1} height={1} />)}
  </svg>
);
```

`src/ui/Cursor.tsx`:

```tsx
import React from 'react';
import { COLOR } from '../theme';

/** Seta de mouse do macOS, desenhada em vetor. (x, y) é a ponta. */
export const Cursor: React.FC<{ x: number; y: number; scale: number }> = ({ x, y, scale }) => (
  <svg
    width={34}
    height={48}
    viewBox="0 0 17 24"
    style={{ position: 'absolute', left: x, top: y, transform: `scale(${scale})`, transformOrigin: '0 0', overflow: 'visible' }}
  >
    <path d="M1 1 L1 19 L5.5 14.8 L8.6 22 L11.4 20.8 L8.4 13.8 L14.5 13.8 Z" fill={COLOR.text} stroke={COLOR.bg} strokeWidth={1.2} strokeLinejoin="round" />
  </svg>
);
```

- [ ] **Step 3: A tela Início recriada**

`src/ui/InicioCard.tsx`:

```tsx
import React from 'react';
import { COPY } from '../copy';
import { BORDER, BORDER_STRONG, COLOR, FONT, withAlpha } from '../theme';
import { NexusMarkFlat } from './NexusMarkFlat';

export const CARD_W = 828;
export const CARD_H = 1000;
const RAIL_W = 200;
const MAIN_X = RAIL_W + 18;
/** Centro do botão Iniciar criação em coordenadas do cartão (o cursor mira aqui). */
export const CTA_CENTER = { x: 693, y: 918 } as const;

type InicioCardProps = {
  readonly typed: string;
  readonly caretOn: boolean;
  readonly ctaLabel: string;
  readonly ctaPressed: number;
};

const text = (size: number, weight: number, color: string): React.CSSProperties => ({
  fontFamily: FONT.ui,
  fontSize: size,
  fontWeight: weight,
  color,
  whiteSpace: 'nowrap',
});

export const InicioCard: React.FC<InicioCardProps> = ({ typed, caretOn, ctaLabel, ctaPressed }) => {
  const p = COPY.pedido;
  return (
    <div
      style={{
        position: 'relative',
        width: CARD_W,
        height: CARD_H,
        background: COLOR.bg,
        borderRadius: 18,
        border: `1px solid ${BORDER_STRONG}`,
        boxShadow: `0 40px 120px ${withAlpha(COLOR.bg, 0.8)}, 0 0 0 1px ${BORDER}`,
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, width: RAIL_W, height: CARD_H, background: COLOR.surfaceSidebar, borderRight: `1px solid ${BORDER}` }}>
        <div style={{ display: 'flex', gap: 8, padding: '18px 18px 0' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 11, height: 11, borderRadius: 6, background: withAlpha(COLOR.text, 0.18) }} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '26px 18px 0' }}>
          <NexusMarkFlat size={20} color={COLOR.accent} />
          <span style={text(20, 600, COLOR.text)}>{p.brand}</span>
        </div>
        <div style={{ margin: '24px 14px 0', padding: '10px 12px', border: `1px solid ${BORDER_STRONG}`, borderRadius: 10, ...text(15, 600, COLOR.text) }}>
          + Novo pedido
        </div>
        <div style={{ marginTop: 18 }}>
          {p.rail.map((item, i) => (
            <div
              key={item}
              style={{
                margin: '4px 10px',
                padding: '10px 12px',
                borderRadius: 8,
                background: i === 0 ? withAlpha(COLOR.accent, 0.12) : 'transparent',
                border: `1px solid ${i === 0 ? withAlpha(COLOR.accent, 0.55) : 'transparent'}`,
                ...text(16, 500, i === 0 ? COLOR.text : COLOR.textDim),
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', left: MAIN_X, top: 90, width: CARD_W - MAIN_X - 30 }}>
        <div style={text(34, 650, COLOR.text)}>{p.title}</div>
        <div style={{ ...text(16, 400, COLOR.textDim), whiteSpace: 'normal', lineHeight: 1.45, marginTop: 12, maxWidth: 540 }}>{p.lead}</div>
        <div style={{ ...text(17, 600, COLOR.text), marginTop: 36 }}>{p.label}</div>
        <div
          style={{
            marginTop: 12,
            height: 170,
            padding: 18,
            borderRadius: 12,
            background: COLOR.bgElevated,
            border: `1px solid ${BORDER_STRONG}`,
            ...text(22, 400, COLOR.text),
            whiteSpace: 'normal',
            lineHeight: 1.4,
          }}
        >
          {typed}
          <span style={{ display: 'inline-block', width: 2, height: 26, marginLeft: 2, verticalAlign: 'text-bottom', background: COLOR.text, opacity: caretOn ? 1 : 0 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {p.chips.map((chip) => (
            <div key={chip} style={{ padding: '8px 14px', borderRadius: 999, border: `1px solid ${BORDER_STRONG}`, ...text(14, 500, COLOR.textDim) }}>
              {chip}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 34, paddingBottom: 18, borderBottom: `1px solid ${BORDER}` }}>
          <span style={text(15, 400, COLOR.textDim)}>{p.projectLabel} ·</span>
          <span style={text(15, 600, COLOR.text)}>{p.projectName}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 18, paddingBottom: 18, borderBottom: `1px solid ${BORDER}` }}>
          <div>
            <div style={text(16, 600, COLOR.text)}>{p.teamTitle}</div>
            <div style={{ ...text(14, 400, COLOR.textDim), marginTop: 4 }}>{p.teamSub}</div>
          </div>
          <span style={text(14, 500, COLOR.textDim)}>Personalizar equipe ⌄</span>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: CTA_CENTER.x - 105,
          top: CTA_CENTER.y - 28,
          width: 210,
          height: 56,
          borderRadius: 10,
          background: COLOR.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${1 - 0.05 * ctaPressed})`,
          boxShadow: ctaPressed > 0 ? `0 0 0 ${6 * ctaPressed}px ${withAlpha(COLOR.accent, 0.35)}` : undefined,
          ...text(18, 650, COLOR.bg),
        }}
      >
        {ctaLabel}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: O capítulo**

`src/chapters/C02Pedido.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { Flare } from '../fx/Flare';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { typedText } from '../lib/typewriter';
import { localFrame } from '../timing';
import { COLOR, withAlpha } from '../theme';
import { Cursor } from '../ui/Cursor';
import { CARD_H, CARD_W, CTA_CENTER, InicioCard } from '../ui/InicioCard';
import { LOGO_CENTER } from '../ui/NexusMarkFlat';
import type { ChapterProps } from './types';

export const C02Pedido: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);
  const box = TEXT.pedido.card;

  // entrada em perspectiva e deriva lenta
  const enter = tween(frame, 0, at(8), 0, 1);
  const settle = tween(frame, at(10.8), at(11), 1, 0, EASE.inOutCubic);
  const rotX = (28 - 18 * enter) * settle;
  const rotY = (18 - 10 * enter - tween(frame, at(8), at(10.5), 0, 4, EASE.linear)) * settle;
  const rotZ = (-4 + 3 * enter) * settle;
  const lift = 260 * (1 - enter);
  const push = tween(frame, at(8), at(10.5), 1, 1.05, EASE.inOutCubic);

  // colapso em ponto de luz, terminando no centro do logo
  const flatten = tween(frame, at(11), at(11.35), 1, 0.006, EASE.inExpo);
  const pinch = tween(frame, at(11.35), at(11.7), 1, 0.004, EASE.inExpo);
  const travel = tween(frame, at(11), at(11.7), 0, 1, EASE.inOutCubic);
  const cardCenter = { x: box.x + CARD_W / 2, y: box.y + CARD_H / 2 };
  const dx = (LOGO_CENTER.x - cardCenter.x) * travel;
  const dy = (LOGO_CENTER.y - cardCenter.y) * travel;
  const brightness = 1 + 1.5 * tween(frame, at(11), at(11.5), 0, 1, EASE.inExpo);
  const cardVisible = frame < at(11.75);

  // digitação, cursor e clique
  const typed = typedText(COPY.pedido.request, frame, at(7.6), at(10));
  const caretOn = frame < at(10) || Math.floor(frame / 16) % 2 === 0;
  const click = at(10.5);
  const move = tween(frame, at(9.6), at(10.4), 0, 1, EASE.inOutCubic);
  const cursor = { x: 900 + (CTA_CENTER.x - 900) * move, y: 1100 + (CTA_CENTER.y - 1100) * move };
  const pressed = frame < click + 3 ? tween(frame, click, click + 3, 0, 1) : tween(frame, click + 3, click + 9, 1, 0);
  const ripple = tween(frame, click, click + 16, 0, 1, EASE.outQuart);
  const ctaLabel = frame >= click + 4 ? COPY.pedido.ctaBusy : COPY.pedido.cta;

  const flare = tween(frame, at(11.3), at(11.7), 0, 1.4, EASE.inExpo) * tween(frame, at(11.7), at(12), 1, 0.55);

  return (
    <AbsoluteFill>
      {cardVisible ? (
        <div
          style={{
            position: 'absolute',
            left: box.x,
            top: box.y,
            width: CARD_W,
            height: CARD_H,
            opacity: tween(frame, 0, 6, 0, 1),
            filter: `brightness(${brightness})`,
            transform: [
              `translate(${dx}px, ${dy + lift}px)`,
              'perspective(1800px)',
              `rotateX(${rotX}deg)`,
              `rotateY(${rotY}deg)`,
              `rotateZ(${rotZ}deg)`,
              `scale(${push * pinch}, ${push * flatten})`,
            ].join(' '),
          }}
        >
          <InicioCard typed={typed} caretOn={caretOn} ctaLabel={ctaLabel} ctaPressed={pressed} />
          {ripple > 0 && ripple < 1 ? (
            <div
              style={{
                position: 'absolute',
                left: CTA_CENTER.x - 130 * ripple,
                top: CTA_CENTER.y - 130 * ripple,
                width: 260 * ripple,
                height: 260 * ripple,
                borderRadius: '50%',
                border: `2px solid ${withAlpha(COLOR.accent, 0.8 * (1 - ripple))}`,
              }}
            />
          ) : null}
          {frame >= at(9.6) && frame < at(11) ? <Cursor x={cursor.x} y={cursor.y} scale={1 - 0.12 * pressed} /> : null}
        </div>
      ) : null}
      <Flare x={LOGO_CENTER.x} y={LOGO_CENTER.y} size={220} intensity={flare} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Registrar**

Em `src/chapters/index.ts`: `import { C02Pedido } from './C02Pedido';` e `pedido: C02Pedido,`.

- [ ] **Step 6: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t8 205 250 290 305 318 326 334 && DEBUG_SAFE=1 scripts/stills.sh t8safe 290`
Expected (quadros globais; o capítulo vai de 197 a 338):
- 205: cartão entrando inclinado, de baixo para cima;
- 250 e 290: tela Início legível — barra lateral com "Início" selecionado em rosa, "O que você quer criar?", pedido sendo digitado com cursor de texto, chips, equipe e o botão branco "Iniciar criação";
- 305: seta do mouse sobre o botão, com o anel rosa do clique e o rótulo "Iniciando…";
- 318–334: o cartão achata numa linha clara, vira um ponto e acende um brilho rosa no centro do logo (540, 800).
Em `t8safe-sheet.png`, o título, o pedido e o botão ficam dentro do retângulo tracejado. Se a perspectiva empurrar o botão para fora, reduza `rotY` de repouso.

- [ ] **Step 7: Commit**

```bash
git add src
git commit -m "feat: capítulo pedido com a tela Início, clique e colapso"
```

---

### Task 9: Capítulo 03 (marca) — NexusMark em voxel, nome e tagline

**Files:**
- Create: `src/ui/NexusMark3D.tsx`, `src/ui/Wordmark.tsx`, `src/chapters/C03Marca.tsx`
- Modify: `src/chapters/index.ts` (entrada `marca`)

**Interfaces:**
- Consumes: `RING`, `CORE`, `ORBITALS`, `MARK_GRID`, `LOGO_CENTER`, `COPY.marca`, `TEXT.marca`, `Flare`, `tween`, `EASE`, `glow`, `withAlpha`.
- Produces: `<NexusMark3D center pixel ring orbit core extrude sweep>` (todos os estados 0..1; `sweep` < 0 desliga o brilho); `<Wordmark text box enter>`; `<Tagline lines emphasis box enter>`; `C03Marca`.

- [ ] **Step 1: O logo em voxel**

`src/ui/NexusMark3D.tsx`:

```tsx
import React from 'react';
import { random } from 'remotion';
import { EASE } from '../lib/anim';
import { CORE, MARK_GRID, ORBITALS, RING, type Cell } from '../lib/nexusmark';
import { COLOR, glow, withAlpha } from '../theme';

type NexusMark3DProps = {
  readonly center: { readonly x: number; readonly y: number };
  readonly pixel: number;
  readonly ring: number;
  readonly orbit: number;
  readonly core: number;
  readonly extrude: number;
  readonly sweep: number;
};

const LAYERS = 8;
const STAGGER = 0.6;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const NexusMark3D: React.FC<NexusMark3DProps> = ({ center, pixel, ring, orbit, core, extrude, sweep }) => {
  const size = MARK_GRID * pixel;
  const origin = { x: center.x - size / 2, y: center.y - size / 2 };
  const depth = 2.4 * extrude;
  const sweepX = -120 + sweep * (size + 240);

  const cell = (key: string, [gx, gy]: Cell, color: string, style: React.CSSProperties = {}) => (
    <div key={key} style={{ position: 'absolute', left: gx * pixel + 1, top: gy * pixel + 1, width: pixel - 2, height: pixel - 2, background: color, ...style }} />
  );

  const ringPlaced = RING.map((c, i) => {
    const p = EASE.outExpo(clamp01(ring * (1 + STAGGER) - (i / RING.length) * STAGGER));
    const angle = random(`mark-a-${i}`) * Math.PI * 2;
    const dist = 520 + random(`mark-d-${i}`) * 420;
    return { c, p, dx: Math.cos(angle) * dist * (1 - p), dy: Math.sin(angle) * dist * (1 - p), rot: (random(`mark-r-${i}`) - 0.5) * 360 * (1 - p) };
  });
  const orbitOffset = (gx: number, gy: number) => {
    const p = EASE.outExpo(clamp01(orbit));
    return { dx: Math.sign(gx - 6) * 620 * (1 - p), dy: Math.sign(gy - 6) * 620 * (1 - p), p };
  };
  const shine = (gx: number) => (sweep < 0 ? 0 : Math.exp(-(((gx + 0.5) * pixel - sweepX) / 46) ** 2));

  return (
    <div style={{ position: 'absolute', left: origin.x, top: origin.y, width: size, height: size }}>
      {extrude > 0.01
        ? Array.from({ length: LAYERS }, (_, k) => LAYERS - k).map((k) => (
            <div key={`layer-${k}`} style={{ position: 'absolute', left: k * depth, top: k * depth, width: size, height: size }}>
              {[...RING, ...ORBITALS, ...CORE].map((c, i) =>
                cell(`l${k}-${i}`, c, withAlpha(COLOR.accent, 0.1 + 0.035 * (LAYERS - k))),
              )}
            </div>
          ))
        : null}
      {ringPlaced.map(({ c, p, dx, dy, rot }, i) =>
        p > 0
          ? cell(`ring-${i}`, c, COLOR.accent, {
              opacity: 0.92 * p,
              transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`,
              filter: `brightness(${1 + 0.9 * shine(c[0])})`,
            })
          : null,
      )}
      {ORBITALS.map((c, i) => {
        const o = orbitOffset(c[0], c[1]);
        return o.p > 0
          ? cell(`orbit-${i}`, c, COLOR.accent, {
              opacity: 0.55 * o.p,
              transform: `translate(${o.dx}px, ${o.dy}px)`,
              filter: `brightness(${1 + 0.9 * shine(c[0])})`,
            })
          : null;
      })}
      {CORE.map((c, i) =>
        core > 0
          ? cell(`core-${i}`, c, COLOR.text, {
              opacity: core,
              boxShadow: glow(COLOR.accent, 0.9 * core),
              filter: `brightness(${1 + 0.6 * shine(c[0])})`,
            })
          : null,
      )}
    </div>
  );
};
```

- [ ] **Step 2: Nome e tagline**

`src/ui/Wordmark.tsx`:

```tsx
import { fitText } from '@remotion/layout-utils';
import React from 'react';
import { useCurrentFrame } from 'remotion';
import type { Box } from '../layout';
import { EASE, tween } from '../lib/anim';
import { COLOR, FONT, withAlpha } from '../theme';

export const Wordmark: React.FC<{ text: string; box: Box; enter: number }> = ({ text, box, enter }) => {
  const frame = useCurrentFrame();
  if (frame < enter) return null;
  const fontSize = Math.min(150, fitText({ text, withinWidth: box.w, fontFamily: FONT.ui, fontWeight: 700, letterSpacing: '-0.035em', validateFontIsLoaded: true }).fontSize);
  const t = frame - enter;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          fontFamily: FONT.ui,
          fontWeight: 700,
          fontSize,
          letterSpacing: '-0.035em',
          lineHeight: 1,
          color: COLOR.text,
          textShadow: `0 0 36px ${withAlpha(COLOR.white, 0.3)}`,
          opacity: tween(t, 0, 8, 0, 1),
          filter: `blur(${tween(t, 0, 10, 14, 0)}px)`,
          transform: `translateY(${tween(t, 0, 14, 40, 0)}px)`,
        }}
      >
        {text}
      </div>
    </div>
  );
};

export const Tagline: React.FC<{ lines: readonly string[]; emphasis: string; box: Box; enter: number }> = ({ lines, emphasis, box, enter }) => {
  const frame = useCurrentFrame();
  if (frame < enter) return null;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      {lines.map((line, i) => {
        const t = frame - enter - i * 4;
        const cut = line.indexOf(emphasis);
        return (
          <div
            key={line}
            style={{
              fontFamily: FONT.ui,
              fontSize: 38,
              fontWeight: 400,
              color: COLOR.textDim,
              whiteSpace: 'nowrap',
              opacity: tween(t, 0, 8, 0, 1),
              transform: `translateY(${tween(t, 0, 12, 18, 0, EASE.outExpo)}px)`,
            }}
          >
            {cut >= 0 ? (
              <>
                {line.slice(0, cut)}
                <span style={{ color: COLOR.text, fontWeight: 600 }}>{emphasis}</span>
                {line.slice(cut + emphasis.length)}
              </>
            ) : (
              line
            )}
          </div>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 3: O capítulo**

`src/chapters/C03Marca.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COPY } from '../copy';
import { Flare } from '../fx/Flare';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { localFrame } from '../timing';
import { COLOR, withAlpha } from '../theme';
import { NexusMark3D } from '../ui/NexusMark3D';
import { LOGO_CENTER } from '../ui/NexusMarkFlat';
import { Tagline, Wordmark } from '../ui/Wordmark';
import type { ChapterProps } from './types';

export const C03Marca: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const at = (beat: number) => localFrame(beat, chapter);
  const coreOn = at(13.5);
  const inherited = tween(frame, 0, at(12.5), 0.55, 0);
  const coreFlash = tween(frame, coreOn, coreOn + 2, 0, 1.3) * tween(frame, coreOn + 2, coreOn + 14, 1, 0);
  const out = tween(frame, durationInFrames - 6, durationInFrames, 1, 0, EASE.inExpo);
  const spin = frame * 0.25;

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <svg width={1080} height={1920} style={{ position: 'absolute' }}>
        {[230, 262].map((r, i) => (
          <circle
            key={r}
            cx={LOGO_CENTER.x}
            cy={LOGO_CENTER.y}
            r={r}
            fill="none"
            stroke={withAlpha(COLOR.white, 0.08)}
            strokeWidth={1.5}
            strokeDasharray={i === 0 ? '2 10' : '40 14'}
            transform={`rotate(${i === 0 ? spin : -spin} ${LOGO_CENTER.x} ${LOGO_CENTER.y})`}
            opacity={tween(frame, at(12.5), at(13.5), 0, 1)}
          />
        ))}
      </svg>
      <NexusMark3D
        center={LOGO_CENTER}
        pixel={26}
        ring={tween(frame, 0, at(13), 0, 1, EASE.linear)}
        orbit={tween(frame, at(13), at(13.5), 0, 1, EASE.linear)}
        core={tween(frame, coreOn, coreOn + 4, 0, 1)}
        extrude={tween(frame, coreOn, at(14), 0, 1)}
        sweep={frame < at(14) ? -1 : tween(frame, at(14), at(15), 0, 1, EASE.inOutCubic)}
      />
      <Flare x={LOGO_CENTER.x} y={LOGO_CENTER.y} size={220} intensity={Math.max(inherited, coreFlash)} />
      <Wordmark text={COPY.marca.name} box={TEXT.marca.wordmark} enter={at(14)} />
      <Tagline lines={COPY.marca.taglineLines} emphasis="frota de agentes" box={TEXT.marca.tagline} enter={at(14.5)} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Registrar**

Em `src/chapters/index.ts`: `import { C03Marca } from './C03Marca';` e `marca: C03Marca,`.

- [ ] **Step 5: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t9 345 360 372 382 400 425 445 && DEBUG_SAFE=1 scripts/stills.sh t9safe 425`
Expected (capítulo de 338 a 450):
- 345–360: pixels rosa voando de fora e encaixando no anel em diamante; o brilho herdado do colapso some;
- 372: satélites chegando pelos eixos;
- 382: núcleo branco acende com clarão rosa e o logo ganha volume (camadas mais escuras deslocadas para baixo e à direita);
- 400: "Nexus" subindo abaixo do logo e faixa de brilho atravessando os pixels;
- 425–445: tagline em duas linhas centralizadas, com "frota de agentes" em branco.
Em `t9safe-sheet.png`, nome e tagline dentro da área segura.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat: capítulo marca com NexusMark em voxel"
```

---

### Task 10: Capítulo 04 (missão) — pipeline, cartão da missão e log

**Files:**
- Create: `src/ui/MissionCard.tsx`, `src/ui/Pipeline.tsx`, `src/chapters/C04Missao.tsx`
- Modify: `src/chapters/index.ts` (entrada `missao`)

**Interfaces:**
- Consumes: `COPY.missao`, `TEXT.missao`, `BigWord`, `typedText`, `tween`, `EASE`, `glow`, `withAlpha`, `BORDER`, `BORDER_STRONG`, `localFrame`.
- Produces: `type StepState = 'pending' | 'running' | 'done'`; `<MissionCard box status tasks tests enter>`; `<Pipeline states progress enter>` com `PIPELINE_NODES` (5 posições globais); `C04Missao`.

- [ ] **Step 1: Cartão da missão**

`src/ui/MissionCard.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import type { Box } from '../layout';
import { tween } from '../lib/anim';
import { BORDER, COLOR, FONT, glow, withAlpha } from '../theme';

type MissionCardProps = {
  readonly box: Box;
  readonly status: 'running' | 'done';
  readonly tasks: number;
  readonly tests: number;
  readonly enter: number;
};

export const MissionCard: React.FC<MissionCardProps> = ({ box, status, tasks, tests, enter }) => {
  const frame = useCurrentFrame();
  const m = COPY.missao;
  const running = status === 'running';
  const tone = running ? COLOR.accent : COLOR.live;
  const breathe = running ? 0.55 + 0.45 * Math.sin(frame * 0.25) : 1;
  const mono = (size: number, color: string): React.CSSProperties => ({
    fontFamily: FONT.mono,
    fontSize: size,
    letterSpacing: '0.16em',
    color,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        boxSizing: 'border-box',
        padding: '22px 26px',
        borderRadius: 16,
        background: COLOR.bgElevated,
        border: `1px solid ${BORDER}`,
        display: 'flex',
        justifyContent: 'space-between',
        opacity: tween(frame, enter, enter + 8, 0, 1),
        transform: `translateY(${tween(frame, enter, enter + 12, -40, 0)}px)`,
      }}
    >
      <div>
        <div style={mono(15, COLOR.textDim)}>{m.eyebrow}</div>
        <div style={{ fontFamily: FONT.ui, fontSize: 34, fontWeight: 600, color: COLOR.text, marginTop: 10 }}>{m.title}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 999,
            border: `1px solid ${withAlpha(tone, 0.5)}`,
            background: withAlpha(tone, 0.1),
            ...mono(16, tone),
          }}
        >
          <div style={{ width: 9, height: 9, borderRadius: 5, background: tone, opacity: breathe, boxShadow: glow(tone, 0.5) }} />
          {running ? m.running.toUpperCase() : m.done.toUpperCase()}
        </div>
        <div style={{ display: 'flex', gap: 22 }}>
          <span style={mono(17, COLOR.textDim)}>
            {m.tasksLabel} <span style={{ color: COLOR.text }}>{tasks}/4</span>
          </span>
          <span style={mono(17, COLOR.textDim)}>
            {m.testsLabel} <span style={{ color: COLOR.text }}>{tests}/23</span>
          </span>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Pipeline vertical em onda**

`src/ui/Pipeline.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { tween } from '../lib/anim';
import { BORDER_STRONG, COLOR, FONT, glow, withAlpha } from '../theme';

export type StepState = 'pending' | 'running' | 'done';

/** Centros dos 5 nós em coordenadas globais: um S suave que desce pela tela. */
export const PIPELINE_NODES: readonly { readonly x: number; readonly y: number }[] = [
  { x: 180, y: 690 },
  { x: 330, y: 810 },
  { x: 200, y: 930 },
  { x: 350, y: 1050 },
  { x: 220, y: 1170 },
];

const NODE = 64;

const pathThrough = (pts: readonly { x: number; y: number }[]) =>
  pts.reduce((d, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    const a = pts[i - 1];
    return `${d} C ${a.x} ${a.y + 70}, ${p.x} ${p.y - 70}, ${p.x} ${p.y}`;
  }, '');

type PipelineProps = {
  readonly states: readonly StepState[];
  readonly progress: number;
  readonly enter: number;
};

export const Pipeline: React.FC<PipelineProps> = ({ states, progress, enter }) => {
  const frame = useCurrentFrame();
  const d = pathThrough(PIPELINE_NODES);
  const m = COPY.missao;
  return (
    <>
      <svg width={1080} height={1920} style={{ position: 'absolute' }}>
        <path d={d} fill="none" stroke={withAlpha(COLOR.white, 0.14)} strokeWidth={2} strokeDasharray="4 8" />
        <path
          d={d}
          fill="none"
          stroke={COLOR.accent}
          strokeWidth={3}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - progress}
          style={{ filter: `drop-shadow(0 0 8px ${withAlpha(COLOR.accent, 0.7)})` }}
        />
      </svg>
      {PIPELINE_NODES.map((n, i) => {
        const state = states[i];
        const pop = tween(frame, enter + i * 3, enter + i * 3 + 10, 0.6, 1);
        const shown = tween(frame, enter + i * 3, enter + i * 3 + 6, 0, 1);
        const tone = state === 'done' ? COLOR.live : COLOR.accent;
        const breathe = 0.6 + 0.4 * Math.sin(frame * 0.3);
        return (
          <React.Fragment key={m.steps[i]}>
            <div
              style={{
                position: 'absolute',
                left: n.x - NODE / 2,
                top: n.y - NODE / 2,
                width: NODE,
                height: NODE,
                borderRadius: 18,
                background: COLOR.bgElevated,
                border: state === 'pending' ? `1px solid ${BORDER_STRONG}` : `2px solid ${tone}`,
                boxShadow: state === 'running' ? glow(COLOR.accent, 0.7 * breathe) : undefined,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: FONT.mono,
                fontSize: 18,
                fontWeight: 600,
                color: state === 'pending' ? COLOR.textFaint : COLOR.text,
                opacity: shown,
                transform: `scale(${pop})`,
              }}
            >
              {String(i + 1).padStart(2, '0')}
              {state === 'done' ? (
                <div
                  style={{
                    position: 'absolute',
                    right: -9,
                    top: -9,
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    background: COLOR.live,
                    color: COLOR.bg,
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ✓
                </div>
              ) : null}
            </div>
            <div style={{ position: 'absolute', left: n.x + NODE / 2 + 24, top: n.y - 26, opacity: shown }}>
              <div style={{ fontFamily: FONT.ui, fontSize: 30, fontWeight: 600, color: state === 'pending' ? COLOR.textDim : COLOR.text }}>{m.steps[i]}</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 15, letterSpacing: '0.16em', color: COLOR.textFaint, marginTop: 4 }}>{m.stepSubs[i]}</div>
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
};
```

- [ ] **Step 3: O capítulo**

`src/chapters/C04Missao.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { TEXT } from '../layout';
import { tween } from '../lib/anim';
import { typedText } from '../lib/typewriter';
import { localFrame } from '../timing';
import { BORDER, COLOR, FONT } from '../theme';
import { BigWord } from '../ui/BigWord';
import { MissionCard } from '../ui/MissionCard';
import { Pipeline, type StepState } from '../ui/Pipeline';
import type { ChapterProps } from './types';

const ACTIVATE = [16, 17, 18.5, 20, 21] as const;
const WORD_BEATS = [17, 18.5, 20, 21] as const;
const LOG_BEATS = [17, 18.5, 19.2, 20, 21] as const;

export const C04Missao: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);
  const acts = ACTIVATE.map(at);
  const doneAt = at(21.5);

  const states: StepState[] = acts.map((start, i) => {
    const end = i < acts.length - 1 ? acts[i + 1] : doneAt;
    if (frame < start) return 'pending';
    return frame < end ? 'running' : 'done';
  });
  const progress = interpolate(frame, acts, [0, 0.25, 0.5, 0.75, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tasks = frame < at(17) ? 0 : Math.round(tween(frame, at(17), at(20), 1, 4));
  const tests = Math.round(tween(frame, at(20), at(20.8), 0, 23));
  const status = frame < at(21) ? 'running' : 'done';

  const logs = COPY.missao.log
    .map((line, i) => ({ line, start: at(LOG_BEATS[i]), last: i === COPY.missao.log.length - 1 }))
    .filter((l) => frame >= l.start)
    .slice(-4);

  const words = WORD_BEATS.map(at);

  return (
    <AbsoluteFill>
      <MissionCard box={TEXT.missao.card} status={status} tasks={tasks} tests={tests} enter={0} />
      <div
        style={{
          position: 'absolute',
          left: TEXT.missao.log.x,
          top: TEXT.missao.log.y,
          width: TEXT.missao.log.w,
          height: TEXT.missao.log.h,
          boxSizing: 'border-box',
          padding: '16px 22px',
          borderRadius: 14,
          background: COLOR.bgBar,
          border: `1px solid ${BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          gap: 8,
          opacity: tween(frame, at(16.5), at(16.5) + 8, 0, 1),
        }}
      >
        {logs.map((l) => (
          <div key={l.line} style={{ fontFamily: FONT.mono, fontSize: 18, color: l.last ? COLOR.live : COLOR.textDim, whiteSpace: 'nowrap' }}>
            <span style={{ color: l.last ? COLOR.live : COLOR.accent }}>{l.last ? '✓ ' : '› '}</span>
            {typedText(l.line, frame, l.start, l.start + 10)}
          </div>
        ))}
      </div>
      <Pipeline states={states} progress={progress} enter={4} />
      {COPY.missao.words.map((word, i) => {
        const last = i === COPY.missao.words.length - 1;
        return (
          <BigWord
            key={word}
            text={word}
            box={TEXT.missao.word}
            enter={words[i]}
            exit={last ? undefined : words[i + 1] - 4}
            maxFontSize={150}
            periodColor={last ? COLOR.live : COLOR.accent}
            color={last ? COLOR.live : COLOR.text}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Registrar**

Em `src/chapters/index.ts`: `import { C04Missao } from './C04Missao';` e `missao: C04Missao,`.

- [ ] **Step 5: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t10 458 490 535 575 600 615 && DEBUG_SAFE=1 scripts/stills.sh t10safe 600`
Expected (capítulo de 450 a 619):
- 458: cartão "Agenda da barbearia" com selo RODANDO rosa; nós 01–05 aparecendo em S, linha tracejada entre eles;
- 490: nó 02 rosa pulsando, 01 verde com ✓, linha rosa desenhada até o 02, "Planejado." com quadrado rosa embaixo, primeira linha do log;
- 535 e 575: "Construído." e depois "Revisado.", contadores de tarefas e testes subindo;
- 600: selo PRONTO verde, "Entregue." em verde com quadrado verde, log termina em "✓ entrega pronta, com evidência" (o nó 05 ainda pulsa rosa);
- 615: os cinco nós verdes com ✓.
Em `t10safe-sheet.png`, "Construído." (a palavra mais longa) não passa da área segura.

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat: capítulo missão com pipeline e log"
```

---

### Task 11: Capítulo 05 (camadas) — a virada em 3D e o grid de terminais

**Files:**
- Create: `src/lib/project3d.ts`, `src/ui/PaneTerminal.tsx`, `src/ui/TerminalGrid.tsx`, `src/ui/BoardMini.tsx`, `src/chapters/C05Camadas.tsx`
- Modify: `src/ui/BigWord.tsx` (prop `period`), `src/chapters/index.ts` (entrada `camadas`)
- Test: `src/lib/project3d.test.ts`

**Interfaces:**
- Consumes: `InicioCard`, `CARD_W`, `CARD_H`, `ProviderLogo`, `COPY.camadas`, `TEXT.camadas`, `BigWord`, `MonoLabel`, `typedText`, `tween`, `EASE`.
- Produces: `type CssCamera = {rotX; rotZ; scale; perspective}` (graus); `projectCss(p: {x; y; z}, cam): {x; y}` (relativo ao centro do palco); `<PaneTerminal index cli role logo lines startFrame lineEvery busy width height>`; `<TerminalGrid width height startFrame>`; `<BoardMini width height>`; `BigWord` ganha `period?: boolean` (padrão `true`); `C05Camadas`; constante `STACK_CENTER = {x: 486, y: 760}` e `PANE_LOGO_POINTS` (centros dos logos dos 4 panes no quadro final, usados pelo capítulo 06), ambos exportados de `C05Camadas.tsx`.

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/project3d.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { projectCss } from './project3d';

const flat = { rotX: 0, rotZ: 0, scale: 1, perspective: 2000 };

describe('projectCss', () => {
  it('sem rotação e em z=0 devolve o próprio ponto', () => {
    expect(projectCss({ x: 100, y: -50, z: 0 }, flat)).toEqual({ x: 100, y: -50 });
  });

  it('z positivo (em direção à câmera) aumenta a distância ao centro', () => {
    const near = projectCss({ x: 100, y: 0, z: 400 }, flat);
    expect(near.x).toBeGreaterThan(100);
  });

  it('rotateZ de 90° gira no sentido horário da tela (y para baixo)', () => {
    const p = projectCss({ x: 100, y: 0, z: 0 }, { ...flat, rotZ: 90 });
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(100, 9);
  });

  it('rotateX positivo afasta o topo e o aproxima do centro', () => {
    const top = projectCss({ x: 0, y: -200, z: 0 }, { ...flat, rotX: 60 });
    expect(Math.abs(top.y)).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/project3d.test.ts`
Expected: FAIL — `./project3d` não resolve.

- [ ] **Step 3: Implementar a projeção**

`src/lib/project3d.ts`:

```ts
/** Mesma ordem do CSS `perspective: P` no pai + `transform: rotateX(a) rotateZ(b) scale(s)` no filho. */
export type CssCamera = { readonly rotX: number; readonly rotZ: number; readonly scale: number; readonly perspective: number };

const RAD = Math.PI / 180;

export function projectCss(p: { x: number; y: number; z: number }, cam: CssCamera): { x: number; y: number } {
  const x0 = p.x * cam.scale;
  const y0 = p.y * cam.scale;
  const z0 = p.z * cam.scale;
  const b = cam.rotZ * RAD;
  const x1 = x0 * Math.cos(b) - y0 * Math.sin(b);
  const y1 = x0 * Math.sin(b) + y0 * Math.cos(b);
  const a = cam.rotX * RAD;
  const y2 = y1 * Math.cos(a) - z0 * Math.sin(a);
  const z2 = y1 * Math.sin(a) + z0 * Math.cos(a);
  const f = cam.perspective / (cam.perspective - z2);
  return { x: x1 * f + 0, y: y2 * f + 0 };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/project3d.test.ts`
Expected: PASS.

- [ ] **Step 5: `period` opcional na palavra gigante**

Em `src/ui/BigWord.tsx`: acrescente `readonly period?: boolean;` em `BigWordProps`, `period = true,` na desestruturação e envolva o `<span>` do quadrado em `{period ? (...) : null}`. Com `period = false`, a medida do `fitText` usa `body` sem o ponto:

```tsx
    fitText({ text: period ? `${body}.` : body, withinWidth: box.w, fontFamily: FONT.ui, fontWeight: weight, letterSpacing: TRACKING, validateFontIsLoaded: true }).fontSize,
```

- [ ] **Step 6: Terminal, grid e quadro**

`src/ui/PaneTerminal.tsx`:

```tsx
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { typedText } from '../lib/typewriter';
import { BORDER, COLOR, FONT, glow, withAlpha } from '../theme';
import { ProviderLogo } from './ProviderLogo';

export type PaneTerminalProps = {
  readonly index: number;
  readonly cli: string;
  readonly role: string;
  readonly logo: string;
  readonly lines: readonly string[];
  readonly startFrame: number;
  readonly lineEvery: number;
  readonly busy: boolean;
  readonly width: number;
  readonly height: number;
};

export const PANE_HEADER = 44;

const lineColor = (line: string) => (line.trimStart().startsWith('✓') ? COLOR.live : COLOR.textDim);

export const PaneTerminal: React.FC<PaneTerminalProps> = ({ index, cli, role, logo, lines, startFrame, lineEvery, busy, width, height }) => {
  const frame = useCurrentFrame();
  const shown = lines
    .map((line, k) => ({ line, start: startFrame + k * lineEvery }))
    .filter((l) => frame >= l.start);
  const toks = 80 + Math.round(40 * Math.abs(Math.sin(frame * 0.05 + index)));
  const breathe = 0.55 + 0.45 * Math.sin(frame * 0.25 + index);
  return (
    <div
      style={{
        width,
        height,
        boxSizing: 'border-box',
        borderRadius: 12,
        overflow: 'hidden',
        background: COLOR.bg,
        border: busy ? `1.5px solid ${withAlpha(COLOR.accent, 0.8)}` : `1px solid ${BORDER}`,
      }}
    >
      <div style={{ height: PANE_HEADER, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: COLOR.bgBar, borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ width: 9, height: 9, borderRadius: 5, background: busy ? COLOR.accent : COLOR.textFaint, opacity: busy ? breathe : 1, boxShadow: busy ? glow(COLOR.accent, 0.4) : undefined }} />
        <div style={{ fontFamily: FONT.mono, fontSize: 13, color: COLOR.textDim, padding: '2px 7px', border: `1px solid ${BORDER}`, borderRadius: 6 }}>pane {index + 1}</div>
        <ProviderLogo file={logo} size={18} />
        <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 600, color: COLOR.text, whiteSpace: 'nowrap' }}>
          {cli} · {role}
        </div>
        <div style={{ marginLeft: 'auto', fontFamily: FONT.mono, fontSize: 12, color: COLOR.textFaint, whiteSpace: 'nowrap' }}>{toks} tok/s</div>
      </div>
      <div style={{ padding: '14px 14px', fontFamily: FONT.mono, fontSize: 14, lineHeight: 1.6 }}>
        {shown.map(({ line, start }, k) => {
          const text = k === shown.length - 1 ? typedText(line, frame, start, start + 8) : line;
          const lead = text.charAt(0);
          const accentLead = lead === '●' || lead === '$';
          return (
            <div key={`${k}-${line}`} style={{ color: lineColor(line), whiteSpace: 'pre' }}>
              {accentLead ? <span style={{ color: COLOR.accent }}>{lead}</span> : null}
              {accentLead ? text.slice(1) : text}
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

`src/ui/TerminalGrid.tsx`:

```tsx
import React from 'react';
import { COPY } from '../copy';
import { PaneTerminal } from './PaneTerminal';

export const GRID_GAP = 20;

export const TerminalGrid: React.FC<{ width: number; height: number; startFrame: number }> = ({ width, height, startFrame }) => {
  const paneW = (width - GRID_GAP) / 2;
  const paneH = (height - GRID_GAP) / 2;
  return (
    <div style={{ position: 'relative', width, height, display: 'grid', gridTemplateColumns: `${paneW}px ${paneW}px`, gap: GRID_GAP }}>
      {COPY.camadas.panes.map((p, i) => (
        <PaneTerminal
          key={p.cli}
          index={i}
          cli={p.cli}
          role={p.role}
          logo={p.logo}
          lines={p.lines}
          startFrame={startFrame + i * 6}
          lineEvery={22}
          busy={i !== 3}
          width={paneW}
          height={paneH}
        />
      ))}
    </div>
  );
};
```

`src/ui/BoardMini.tsx`:

```tsx
import React from 'react';
import { COPY } from '../copy';
import { BORDER, BORDER_STRONG, COLOR, FONT, withAlpha } from '../theme';

/** Quadro da missão em miniatura: a camada do meio. */
export const BoardMini: React.FC<{ width: number; height: number }> = ({ width, height }) => {
  const b = COPY.camadas.board;
  const placement = [2, 1, 2, 0];
  return (
    <div style={{ width, height, boxSizing: 'border-box', padding: 28, borderRadius: 18, background: COLOR.bg, border: `1px solid ${BORDER_STRONG}` }}>
      <div style={{ fontFamily: FONT.ui, fontSize: 26, fontWeight: 600, color: COLOR.text }}>Quadro · {COPY.missao.title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 28 }}>
        {b.columns.map((col, ci) => (
          <div key={col} style={{ minHeight: 700, padding: 14, borderRadius: 12, background: COLOR.bgElevated, border: `1px solid ${BORDER}` }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 14, letterSpacing: '0.14em', color: COLOR.textDim }}>{col.toUpperCase()}</div>
            {b.cards.map((card, i) =>
              placement[i] === ci ? (
                <div
                  key={card}
                  style={{
                    marginTop: 14,
                    padding: '14px 12px',
                    borderRadius: 10,
                    background: COLOR.surface2,
                    border: `1px solid ${ci === 1 ? withAlpha(COLOR.accent, 0.6) : BORDER}`,
                    fontFamily: FONT.ui,
                    fontSize: 16,
                    color: COLOR.text,
                  }}
                >
                  {card}
                </div>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 7: O capítulo**

`src/chapters/C05Camadas.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { projectCss, type CssCamera } from '../lib/project3d';
import { localFrame } from '../timing';
import { COLOR, FONT, withAlpha } from '../theme';
import { BigWord } from '../ui/BigWord';
import { BoardMini } from '../ui/BoardMini';
import { CARD_H, CARD_W, InicioCard } from '../ui/InicioCard';
import { MonoLabel } from '../ui/MonoLabel';
import { PANE_HEADER } from '../ui/PaneTerminal';
import { GRID_GAP, TerminalGrid } from '../ui/TerminalGrid';
import type { ChapterProps } from './types';

export const STACK_CENTER = { x: 486, y: 760 } as const;
const PERSPECTIVE = 2000;
const FINAL_SCALE = 0.94;

/** Centro do logo de cada pane no quadro final (grid chapado, escala 0,94): o capítulo 06 parte daqui. */
export const PANE_LOGO_POINTS: readonly { x: number; y: number }[] = [0, 1, 2, 3].map((i) => {
  const paneW = (CARD_W - GRID_GAP) / 2;
  const paneH = (CARD_H - GRID_GAP) / 2;
  const col = i % 2;
  const row = Math.floor(i / 2);
  const localX = col * (paneW + GRID_GAP) + 12 + 9 + 10 + 62 + 10 + 9;
  const localY = row * (paneH + GRID_GAP) + PANE_HEADER / 2;
  return {
    x: STACK_CENTER.x + (localX - CARD_W / 2) * FINAL_SCALE,
    y: STACK_CENTER.y + (localY - CARD_H / 2) * FINAL_SCALE,
  };
});

export const C05Camadas: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);

  const tilt = tween(frame, 0, at(23.5), 0, 1, EASE.inOutCubic);
  const dive = tween(frame, at(24), at(25), 0, 1, EASE.inOutCubic);
  const drift = tween(frame, at(23.5), at(24), 0, 4, EASE.linear);
  const cam: CssCamera = {
    rotX: 58 * tilt * (1 - dive),
    rotZ: (-32 * tilt - drift) * (1 - dive),
    scale: FINAL_SCALE - (FINAL_SCALE - 0.62) * tilt * (1 - dive),
    perspective: PERSPECTIVE,
  };
  const spread = tilt;
  const layers = [
    { key: 'inicio', z: 300 * spread + 1300 * dive, opacity: 1 - tween(frame, at(24), at(24.6), 0, 1) },
    { key: 'quadro', z: 1200 * tween(frame, at(24.2), at(25), 0, 1, EASE.inExpo), opacity: 1 - tween(frame, at(24.3), at(24.9), 0, 1) },
    { key: 'terminais', z: -300 * spread * (1 - dive), opacity: 1 },
  ];
  const labelsOn = tween(frame, at(23), at(23.3), 0, 1) * (1 - tween(frame, at(24), at(24.2), 0, 1));
  const layerZ = [300, 0, -300];

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ perspective: PERSPECTIVE, perspectiveOrigin: `${STACK_CENTER.x}px ${STACK_CENTER.y}px` }}>
        <div
          style={{
            position: 'absolute',
            left: STACK_CENTER.x - CARD_W / 2,
            top: STACK_CENTER.y - CARD_H / 2,
            width: CARD_W,
            height: CARD_H,
            transformStyle: 'preserve-3d',
            transform: `rotateX(${cam.rotX}deg) rotateZ(${cam.rotZ}deg) scale(${cam.scale})`,
          }}
        >
          {[...layers].reverse().map((layer) => (
            <div
              key={layer.key}
              style={{
                position: 'absolute',
                inset: 0,
                transform: `translateZ(${layer.z}px)`,
                opacity: layer.opacity,
                boxShadow: layer.key === 'terminais' ? undefined : `0 0 0 1px ${withAlpha(COLOR.accent, 0.25 * spread)}`,
                borderRadius: 18,
              }}
            >
              {layer.key === 'inicio' ? <InicioCard typed={COPY.pedido.request} caretOn={false} ctaLabel={COPY.pedido.cta} ctaPressed={0} /> : null}
              {layer.key === 'quadro' ? <BoardMini width={CARD_W} height={CARD_H} /> : null}
              {layer.key === 'terminais' ? <TerminalGrid width={CARD_W} height={CARD_H} startFrame={-10} /> : null}
            </div>
          ))}
        </div>
      </AbsoluteFill>

      {labelsOn > 0
        ? COPY.camadas.layers.map((l, i) => {
            const p = projectCss({ x: -CARD_W / 2, y: -CARD_H / 2, z: layerZ[i] }, cam);
            return (
              <div
                key={l.name}
                style={{
                  position: 'absolute',
                  left: Math.max(84, STACK_CENTER.x + p.x - 20),
                  top: STACK_CENTER.y + p.y - 64,
                  opacity: labelsOn,
                  fontFamily: FONT.mono,
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: '0.16em', color: i === 2 ? COLOR.accent : COLOR.text }}>{l.name}</span>
                <span style={{ fontSize: 20, color: COLOR.textDim, marginLeft: 14 }}>· {l.sub}</span>
              </div>
            );
          })
        : null}

      <BigWord
        text={COPY.camadas.captionLines[0]}
        box={{ ...TEXT.camadas.caption, h: 78 }}
        enter={at(25.5)}
        period={false}
        weight={800}
        maxFontSize={72}
        color={COLOR.textDim}
      />
      <BigWord
        text={COPY.camadas.captionLines[1]}
        box={{ ...TEXT.camadas.caption, y: TEXT.camadas.caption.y + 84, h: 86 }}
        enter={at(25.5) + 4}
        weight={800}
        maxFontSize={72}
      />
      <MonoLabel text={COPY.camadas.sub} box={TEXT.camadas.sub} enter={at(26)} typeFrames={14} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 8: Registrar**

Em `src/chapters/index.ts`: `import { C05Camadas } from './C05Camadas';` e `camadas: C05Camadas,`.

- [ ] **Step 9: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t11 622 650 665 680 695 715 760 780 && DEBUG_SAFE=1 scripts/stills.sh t11safe 780`
Expected (capítulo de 619 a 788):
- 622: tela Início chapada, de frente;
- 650–680: a pilha tomba em perspectiva e se separa em 3 camadas; rótulos INÍCIO / QUADRO / TERMINAIS (este em rosa) junto ao canto de cada camada;
- 695–715: Início e Quadro voam em direção à câmera e somem; o grid de terminais se endireita;
- 760–780: grid 2×2 chapado com Claude · Orquestrador, Codex · Executor, Kimi · Revisor e Grok · Scout, linhas aparecendo, bordas rosa nos três ocupados; legenda "Por baixo," (cinza) / "terminais de verdade." (branca, quadrado rosa) e o subtítulo mono.
Se um rótulo sair da tela ou se sobrepuser à camada vizinha, ajuste o deslocamento (`- 20`, `- 64`) do rótulo. Em `t11safe-sheet.png`, a legenda e o subtítulo ficam dentro da área segura; o grid pode encostar nas bordas (é visual, não texto essencial), mas os cabeçalhos dos panes não devem ficar sob a faixa direita.

- [ ] **Step 10: Commit**

```bash
git add src
git commit -m "feat: capítulo camadas com a pilha em 3D e o grid de terminais"
```

---

### Task 12: Capítulo 06 (frota) — esfera de CLIs e contador 17

**Files:**
- Create: `src/ui/FleetSphere.tsx`, `src/chapters/C06Frota.tsx`
- Modify: `src/chapters/index.ts` (entrada `frota`)

**Interfaces:**
- Consumes: `fibonacciSphere`, `rotateX`, `rotateY`, `project`, `sortBackToFront`, `CLI_LOGOS`, `CLI_ADAPTERS`, `PANE_LOGO_POINTS`, `chapterRange`, `CHAPTERS`, `COPY.frota`, `TEXT.frota`, `MonoLabel`.
- Produces: `SPHERE = {center: {x: 540, y: 700}, radius: 290, camera: 1400, count: 60}`; `type FleetTile = {kind: 'logo'; file; id} | {kind: 'name'; id}`; `FLEET_TILES: readonly FleetTile[]`; `ACTIVE_IDS`; `sphereLayout(absFrame): {tile; x; y; scale; depth; index}[]` (coordenadas globais, de trás para frente); `<FleetTileView tile size active style>`; `C06Frota`.

- [ ] **Step 1: A cena da esfera (compartilhada com o capítulo 07)**

`src/ui/FleetSphere.tsx`:

```tsx
import React from 'react';
import { fibonacciSphere, project, rotateX, rotateY, sortBackToFront } from '../lib/sphere';
import { CLI_ADAPTERS, CLI_LOGOS } from '../logos';
import { BORDER, COLOR, FONT, glow, withAlpha } from '../theme';
import { ProviderLogo } from './ProviderLogo';

export const SPHERE = { center: { x: 540, y: 700 }, radius: 290, camera: 1400, count: 60 } as const;
export const ACTIVE_IDS: readonly string[] = ['claude', 'codex', 'kimi', 'grok'];

export type FleetTile =
  | { readonly kind: 'logo'; readonly file: string; readonly id: string }
  | { readonly kind: 'name'; readonly id: string };

export const FLEET_TILES: readonly FleetTile[] = Array.from({ length: SPHERE.count }, (_, i) => {
  if (i % 2 === 0) {
    const logo = CLI_LOGOS[(i / 2) % CLI_LOGOS.length];
    return { kind: 'logo', file: logo.file, id: logo.id };
  }
  return { kind: 'name', id: CLI_ADAPTERS[((i - 1) / 2) % CLI_ADAPTERS.length] };
});

const POINTS = fibonacciSphere(SPHERE.count);

/** Rotação contínua pelo quadro absoluto: os capítulos 06 e 07 veem a mesma esfera no corte. */
export const sphereRotY = (absFrame: number) => 0.2 + absFrame * 0.015;

export function sphereLayout(absFrame: number) {
  const projected = POINTS.map((p, i) =>
    project(rotateX(rotateY(p, sphereRotY(absFrame)), 0.35), SPHERE.radius, SPHERE.camera, i),
  );
  return sortBackToFront(projected).map((p) => ({
    tile: FLEET_TILES[p.index],
    index: p.index,
    x: SPHERE.center.x + p.x,
    y: SPHERE.center.y + p.y,
    scale: p.scale,
    depth: p.depth,
  }));
}

export const FleetTileView: React.FC<{ tile: FleetTile; size: number; active: boolean; style?: React.CSSProperties }> = ({ tile, size, active, style }) => (
  <div
    style={{
      position: 'absolute',
      width: size,
      height: size,
      marginLeft: -size / 2,
      marginTop: -size / 2,
      borderRadius: size * 0.24,
      background: COLOR.bgElevated,
      border: active ? `2px solid ${COLOR.accent}` : `1px solid ${BORDER}`,
      boxShadow: active ? glow(COLOR.accent, 0.5) : `0 6px 18px ${withAlpha(COLOR.bg, 0.6)}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...style,
    }}
  >
    {tile.kind === 'logo' ? (
      <ProviderLogo file={tile.file} size={size * 0.52} />
    ) : (
      <span style={{ fontFamily: FONT.mono, fontSize: size * 0.17, color: COLOR.textDim, letterSpacing: '0.04em' }}>{tile.id}</span>
    )}
  </div>
);
```

- [ ] **Step 2: O capítulo**

`src/chapters/C06Frota.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { chapterRange, localFrame } from '../timing';
import { COLOR, FONT, withAlpha } from '../theme';
import { ACTIVE_IDS, FleetTileView, sphereLayout } from '../ui/FleetSphere';
import { MonoLabel } from '../ui/MonoLabel';
import { PANE_LOGO_POINTS } from './C05Camadas';
import type { ChapterProps } from './types';

const TILE = 74;

export const C06Frota: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);
  const absFrame = chapterRange(chapter).from + frame;
  const layout = sphereLayout(absFrame);
  const count = Math.round(tween(frame, at(29), at(31), 1, COPY.frota.count, EASE.outQuart));
  const counting = frame >= at(29) && frame < at(31);

  return (
    <AbsoluteFill>
      {layout.map(({ tile, index, x, y, scale, depth }) => {
        const start = PANE_LOGO_POINTS[index % PANE_LOGO_POINTS.length];
        const p = EASE.outExpo(Math.min(1, Math.max(0, (frame - index * 0.35) / 18)));
        const px = start.x + (x - start.x) * p;
        const py = start.y + (y - start.y) * p;
        const shade = 0.35 + 0.65 * ((depth + 1) / 2);
        return (
          <FleetTileView
            key={index}
            tile={tile}
            size={TILE * scale}
            active={ACTIVE_IDS.includes(tile.id)}
            style={{
              left: px,
              top: py,
              opacity: shade * tween(frame, 0, 6, 0, 1),
              filter: depth < -0.2 ? 'blur(1.5px)' : undefined,
            }}
          />
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: TEXT.frota.counter.x,
          top: TEXT.frota.counter.y,
          width: TEXT.frota.counter.w,
          height: TEXT.frota.counter.h,
          display: 'flex',
          alignItems: 'flex-end',
          fontFamily: FONT.ui,
          fontWeight: 800,
          fontSize: 210,
          lineHeight: 1,
          letterSpacing: '-0.04em',
          color: COLOR.text,
          fontVariantNumeric: 'tabular-nums',
          textShadow: `0 0 36px ${withAlpha(COLOR.white, 0.25)}`,
          filter: counting ? 'blur(1.5px)' : undefined,
          opacity: tween(frame, at(28.8), at(29), 0, 1),
        }}
      >
        {count}
      </div>
      <div
        style={{
          position: 'absolute',
          left: TEXT.frota.label.x,
          top: TEXT.frota.label.y,
          width: TEXT.frota.label.w,
          height: TEXT.frota.label.h,
          display: 'flex',
          alignItems: 'center',
          fontFamily: FONT.ui,
          fontWeight: 600,
          fontSize: 46,
          color: COLOR.text,
          opacity: tween(frame, at(29.5), at(29.5) + 8, 0, 1),
          transform: `translateY(${tween(frame, at(29.5), at(29.5) + 12, 16, 0)}px)`,
        }}
      >
        {COPY.frota.label}
      </div>
      <MonoLabel text={COPY.frota.sub} box={TEXT.frota.sub} enter={at(30)} typeFrames={14} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Registrar**

Em `src/chapters/index.ts`: `import { C06Frota } from './C06Frota';` e `frota: C06Frota,`.

- [ ] **Step 4: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t12 792 805 830 860 895 && DEBUG_SAFE=1 scripts/stills.sh t12safe 880`
Expected (capítulo de 788 a 900):
- 792–805: blocos saindo dos 4 pontos onde ficavam os logos dos panes e se espalhando;
- 830–895: esfera girando com logos coloridos (Claude laranja, Kimi azul, Qwen gradiente) e nomes em mono; Codex, Grok e OpenCode em branco (sem `currentColor` preto); blocos do fundo menores, mais escuros e desfocados; blocos de claude/codex/kimi/grok com borda rosa;
- contador subindo até **17** com o rótulo "CLIs de IA num só lugar" e o subtítulo.
Em `t12safe-sheet.png`, contador e rótulos dentro da área segura; a esfera não invade a faixa direita.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: capítulo frota com a esfera de CLIs"
```

---

### Task 13: Capítulo 07 (failover) — anel de contas e troca automática

**Files:**
- Create: `src/ui/AccountNode.tsx`, `src/chapters/C07Failover.tsx`
- Modify: `src/chapters/index.ts` (entrada `failover`)

**Interfaces:**
- Consumes: `sphereLayout`, `FleetTileView`, `ACTIVE_IDS`, `ringPoint`, `NexusMarkFlat`, `ProviderLogo`, `Glitch`, `BigWord`, `MonoLabel`, `COPY.failover`, `TEXT.failover`, `chapterRange`, `localFrame`.
- Produces: `type AccountState = 'idle' | 'active' | 'limit'`; `<AccountNode x y label cli quota state appear chip? chipTone?>`; `RING_CENTER = {x: 540, y: 1010}`, `RING_RADIUS = 250`; `C07Failover`.

- [ ] **Step 1: O nó de conta**

`src/ui/AccountNode.tsx`:

```tsx
import React from 'react';
import { BORDER, COLOR, FONT, glow, withAlpha } from '../theme';
import { ProviderLogo } from './ProviderLogo';

export type AccountState = 'idle' | 'active' | 'limit';

const W = 200;
const H = 84;
const TONE: Record<AccountState, string> = { idle: COLOR.textFaint, active: COLOR.accent, limit: COLOR.warn };

type AccountNodeProps = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly cli: string;
  readonly quota: number;
  readonly state: AccountState;
  readonly appear: number;
  readonly chip?: string;
  readonly chipTone?: string;
};

export const AccountNode: React.FC<AccountNodeProps> = ({ x, y, label, cli, quota, state, appear, chip, chipTone }) => {
  const tone = TONE[state];
  return (
    <div style={{ position: 'absolute', left: x - W / 2, top: y - H / 2, width: W, height: H, opacity: appear, transform: `scale(${0.7 + 0.3 * appear})` }}>
      <div
        style={{
          width: W,
          height: H,
          boxSizing: 'border-box',
          padding: '12px 14px',
          borderRadius: 14,
          background: COLOR.bgElevated,
          border: state === 'idle' ? `1px solid ${BORDER}` : `2px solid ${tone}`,
          boxShadow: state === 'active' ? glow(COLOR.accent, 0.5) : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ProviderLogo file={`${cli}.svg`} size={18} />
          <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 600, letterSpacing: '0.12em', color: COLOR.text }}>{label}</span>
        </div>
        <div style={{ marginTop: 14, height: 6, borderRadius: 3, background: withAlpha(COLOR.white, 0.08) }}>
          <div style={{ width: `${Math.min(1, quota) * 100}%`, height: 6, borderRadius: 3, background: state === 'idle' ? COLOR.textFaint : tone }} />
        </div>
      </div>
      {chip ? (
        <div
          style={{
            position: 'absolute',
            left: W / 2,
            top: H + 10,
            transform: 'translateX(-50%)',
            padding: '5px 12px',
            borderRadius: 999,
            border: `1px solid ${chipTone ?? tone}`,
            background: withAlpha(chipTone ?? tone, 0.14),
            fontFamily: FONT.mono,
            fontSize: 14,
            letterSpacing: '0.14em',
            color: chipTone ?? tone,
            whiteSpace: 'nowrap',
          }}
        >
          {chip}
        </div>
      ) : null}
    </div>
  );
};
```

- [ ] **Step 2: O capítulo**

`src/chapters/C07Failover.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { COPY } from '../copy';
import { Glitch } from '../fx/Glitch';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { ringPoint } from '../lib/sphere';
import { chapterRange, localFrame } from '../timing';
import { COLOR, FONT, glow, withAlpha } from '../theme';
import { AccountNode, type AccountState } from '../ui/AccountNode';
import { BigWord } from '../ui/BigWord';
import { ACTIVE_IDS, FleetTileView, sphereLayout } from '../ui/FleetSphere';
import { MonoLabel } from '../ui/MonoLabel';
import { NexusMarkFlat } from '../ui/NexusMarkFlat';
import type { ChapterProps } from './types';

export const RING_CENTER = { x: 540, y: 1010 } as const;
export const RING_RADIUS = 250;
const TILE = 74;

export const C07Failover: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const at = (beat: number) => localFrame(beat, chapter);
  const f = COPY.failover;

  const collapse = tween(frame, 0, at(32.6), 0, 1, EASE.inExpo);
  const appear = tween(frame, at(32.4), at(33), 0, 1);
  const limitAt = at(34);
  const hopStart = at(34.5);
  const hopEnd = hopStart + 12;
  const resumedAt = at(35);

  const quota0 = tween(frame, at(32.6), limitAt, 0.62, 1, EASE.inOutCubic);
  const states: AccountState[] = [
    frame < limitAt ? 'active' : 'limit',
    frame < hopEnd ? 'idle' : 'active',
    'idle',
    'idle',
  ];
  const quotas = [quota0, frame < hopEnd ? 0.08 : tween(frame, hopEnd, hopEnd + 30, 0.08, 0.2), 0.22, 0.35];
  const chips: (string | undefined)[] = [frame >= limitAt ? f.limit : undefined, frame >= hopEnd ? f.takeover : undefined, undefined, undefined];

  const nodes = f.accounts.map((label, i) => {
    const p = ringPoint(i, f.accounts.length, RING_RADIUS);
    return { label, x: RING_CENTER.x + p.x, y: RING_CENTER.y + p.y };
  });
  const activeIndex = frame < hopEnd ? 0 : 1;
  const linkTone = frame >= limitAt && frame < hopEnd ? COLOR.warn : COLOR.accent;
  const linkAlpha = frame >= limitAt && frame < hopEnd ? tween(frame, limitAt, hopStart, 1, 0.15) : 1;

  const hop = tween(frame, hopStart, hopEnd, 0, 1, EASE.inOutCubic);
  const hopAngle = -Math.PI / 2 + hop * (Math.PI / 2);
  const comet = { x: RING_CENTER.x + Math.cos(hopAngle) * RING_RADIUS, y: RING_CENTER.y + Math.sin(hopAngle) * RING_RADIUS };

  const glitch = tween(frame, durationInFrames - 8, durationInFrames, 0, 1, EASE.inOutCubic);
  const absFrame = chapterRange(chapter).from + frame;

  return (
    <AbsoluteFill>
      <Glitch amount={glitch} seed="failover">
        {collapse < 1
          ? sphereLayout(absFrame).map(({ tile, index, x, y, scale, depth }) => (
              <FleetTileView
                key={index}
                tile={tile}
                size={TILE * scale * (1 - 0.8 * collapse)}
                active={ACTIVE_IDS.includes(tile.id)}
                style={{
                  left: x + (RING_CENTER.x - x) * collapse,
                  top: y + (RING_CENTER.y - y) * collapse,
                  opacity: (0.35 + 0.65 * ((depth + 1) / 2)) * (1 - collapse),
                }}
              />
            ))
          : null}

        <svg width={1080} height={1920} style={{ position: 'absolute', opacity: appear }}>
          <circle cx={RING_CENTER.x} cy={RING_CENTER.y} r={RING_RADIUS} fill="none" stroke={withAlpha(COLOR.white, 0.1)} strokeWidth={1.5} strokeDasharray="3 9" />
          {nodes.map((n, i) => (
            <line
              key={n.label}
              x1={RING_CENTER.x}
              y1={RING_CENTER.y}
              x2={n.x}
              y2={n.y}
              stroke={i === activeIndex ? withAlpha(linkTone, linkAlpha) : withAlpha(COLOR.white, 0.08)}
              strokeWidth={i === activeIndex ? 3 : 1.5}
              strokeDasharray={i === activeIndex ? '10 8' : '2 8'}
              strokeDashoffset={-frame * 2}
            />
          ))}
        </svg>

        <div style={{ position: 'absolute', left: RING_CENTER.x - 45, top: RING_CENTER.y - 45, opacity: appear, filter: `drop-shadow(0 0 18px ${withAlpha(COLOR.accent, 0.6)})` }}>
          <NexusMarkFlat size={90} color={COLOR.accent} />
        </div>

        {nodes.map((n, i) => (
          <AccountNode
            key={n.label}
            x={n.x}
            y={n.y}
            label={n.label}
            cli={f.accountCli}
            quota={quotas[i]}
            state={states[i]}
            appear={appear}
            chip={chips[i]}
          />
        ))}

        {hop > 0 && hop < 1 ? (
          <div style={{ position: 'absolute', left: comet.x - 9, top: comet.y - 9, width: 18, height: 18, borderRadius: 9, background: COLOR.text, boxShadow: glow(COLOR.accent, 1.4) }} />
        ) : null}

        {frame >= resumedAt ? (
          <div
            style={{
              position: 'absolute',
              left: RING_CENTER.x,
              top: RING_CENTER.y + 72,
              transform: `translateX(-50%) scale(${tween(frame, resumedAt, resumedAt + 8, 0.8, 1)})`,
              opacity: tween(frame, resumedAt, resumedAt + 6, 0, 1),
              padding: '7px 16px',
              borderRadius: 999,
              border: `1px solid ${COLOR.live}`,
              background: withAlpha(COLOR.live, 0.14),
              fontFamily: FONT.mono,
              fontSize: 16,
              letterSpacing: '0.12em',
              color: COLOR.live,
              whiteSpace: 'nowrap',
            }}
          >
            ✓ {f.resumed}
          </div>
        ) : null}

        <BigWord text={f.line1} box={TEXT.failover.line1} enter={at(32.5)} maxFontSize={110} weight={800} />
        <BigWord text={f.line2} box={TEXT.failover.line2} enter={at(33.5)} maxFontSize={110} weight={800} highlight={f.line2Highlight} />
        <MonoLabel text={f.sub} box={TEXT.failover.sub} enter={at(34)} typeFrames={16} />
      </Glitch>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Registrar**

Em `src/chapters/index.ts`: `import { C07Failover } from './C07Failover';` e `failover: C07Failover,`.

- [ ] **Step 4: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t13 904 925 960 976 990 1010 && DEBUG_SAFE=1 scripts/stills.sh t13safe 1000`
Expected (capítulo de 900 a 1013):
- 904: a esfera do quadro 899 continua girando no mesmo lugar (sem salto) e começa a se fechar no centro do anel;
- 925: anel tracejado com o NexusMark rosa no centro e 4 contas (CONTA 1 no topo com borda rosa e barra de cota quase cheia); "Qualquer CLI." no alto;
- 960: CONTA 1 âmbar com chip LIMITE; "Qualquer conta." com "conta" em rosa; subtítulo mono;
- 976: bolinha branca com brilho rosa percorrendo o arco do topo até a direita;
- 990: CONTA 2 rosa com chip ASSUMIU, ligação rosa até ela, chip verde "✓ RETOMADO · --resume" sob o logo;
- 1010: separação de canais do glitch de saída.
Em `t13safe-sheet.png`, as linhas de texto e a conta da direita (x até 890) ficam dentro da área segura.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat: capítulo failover com o anel de contas"
```

---

### Task 14: Capítulo 08 (recursos) — FALE., letreiro split-flap e CONTROLE. TOTAL.

**Files:**
- Modify: `src/lib/splitflap.ts` (`flapSequenceAt`), `src/ui/BigWord.tsx` (prop `shadow`), `src/chapters/index.ts` (entrada `recursos`)
- Create: `src/ui/PixelArt.tsx`, `src/ui/SplitFlap.tsx`, `src/chapters/C08Recursos.tsx`
- Test: `src/lib/splitflap.test.ts` (novos casos)

**Interfaces:**
- Consumes: `flapWord`, `MIC`, `pixelCells`, `PINK_FLASH`, `BigWord`, `MonoLabel`, `Glitch`, `COPY.recursos`, `TEXT.recursos`, `localFrame`.
- Produces: `type FlapSequence = {words; starts; slots; flipFrames; staggerFrames}`; `flapSequenceAt(seq, frame): string[]`; `BigWord` ganha `shadow?: boolean` (padrão `true`); `<PixelArt art pixel color style?>`; `<SplitFlap chars previous tileW tileH gap>`; `C08Recursos`.

- [ ] **Step 1: Escrever o teste que falha**

Em `src/lib/splitflap.test.ts`, acrescente `flapSequenceAt` ao import de `./splitflap` já existente e, no fim do arquivo:

```ts
describe('flapSequenceAt', () => {
  const seq = { words: ['CLAUDE', 'CODEX', 'KIMI', 'GROK'], starts: [10, 30, 50], slots: 6, flipFrames: 6, staggerFrames: 1 };

  it('mostra a primeira palavra antes da primeira troca', () => {
    expect(flapSequenceAt(seq, 0).join('')).toBe('CLAUDE');
  });

  it('assenta em cada palavra depois da sua troca', () => {
    expect(flapSequenceAt(seq, 29).join('')).toBe('CODEX ');
    expect(flapSequenceAt(seq, 49).join('')).toBe('KIMI  ');
    expect(flapSequenceAt(seq, 200).join('')).toBe('GROK  ');
  });

  it('recusa sequência com número errado de inícios', () => {
    expect(() => flapSequenceAt({ ...seq, starts: [10] }, 0)).toThrow(/starts/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/splitflap.test.ts`
Expected: FAIL — `flapSequenceAt` não exportado.

- [ ] **Step 3: Implementar**

Acrescente a `src/lib/splitflap.ts`:

```ts
export type FlapSequence = {
  readonly words: readonly string[];
  readonly starts: readonly number[];
  readonly slots: number;
  readonly flipFrames: number;
  readonly staggerFrames: number;
};

/** Letreiro que passa por várias palavras; starts[i] é o quadro em que começa a troca words[i] → words[i + 1]. */
export function flapSequenceAt(seq: FlapSequence, frame: number): string[] {
  if (seq.starts.length !== seq.words.length - 1) {
    throw new Error(`flapSequenceAt: esperava ${seq.words.length - 1} starts, recebeu ${seq.starts.length}`);
  }
  let i = -1;
  for (let k = 0; k < seq.starts.length; k++) if (frame >= seq.starts[k]) i = k;
  if (i < 0) return padSlots(seq.words[0], seq.slots);
  return flapWord({
    from: seq.words[i],
    to: seq.words[i + 1],
    slots: seq.slots,
    frame,
    startFrame: seq.starts[i],
    flipFrames: seq.flipFrames,
    staggerFrames: seq.staggerFrames,
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/splitflap.test.ts`
Expected: PASS.

- [ ] **Step 5: `shadow` opcional na palavra gigante**

Em `src/ui/BigWord.tsx`: acrescente `readonly shadow?: boolean;` em `BigWordProps`, `shadow = true,` na desestruturação e troque o ramo sólido de `ink`:

```tsx
    outline
      ? { color: 'transparent', WebkitTextStroke: `${stroke}px ${c}` }
      : { color: c, textShadow: shadow ? `0 0 30px ${withAlpha(COLOR.white, 0.22)}` : undefined };
```

E no quadrado: `boxShadow: outline || !shadow ? undefined : glow(periodColor, 0.8),`.

- [ ] **Step 6: Pixel art e letreiro**

`src/ui/PixelArt.tsx`:

```tsx
import React from 'react';
import { pixelCells } from '../lib/pixel-art';

export const PixelArt: React.FC<{ art: readonly string[]; pixel: number; color: string; style?: React.CSSProperties }> = ({ art, pixel, color, style }) => {
  const width = (art[0]?.length ?? 0) * pixel;
  return (
    <svg width={width} height={art.length * pixel} viewBox={`0 0 ${art[0]?.length ?? 0} ${art.length}`} shapeRendering="crispEdges" style={style}>
      {pixelCells(art).map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
      ))}
    </svg>
  );
};
```

`src/ui/SplitFlap.tsx`:

```tsx
import React from 'react';
import { BORDER, COLOR, FONT, withAlpha } from '../theme';

type SplitFlapProps = {
  readonly chars: readonly string[];
  readonly previous: readonly string[];
  readonly tileW: number;
  readonly tileH: number;
  readonly gap: number;
};

export const SplitFlap: React.FC<SplitFlapProps> = ({ chars, previous, tileW, tileH, gap }) => (
  <div style={{ display: 'flex', gap }}>
    {chars.map((ch, i) => {
      const flipping = previous[i] !== ch;
      return (
        <div
          key={i}
          style={{
            position: 'relative',
            width: tileW,
            height: tileH,
            borderRadius: 10,
            background: COLOR.surface2,
            border: `1px solid ${BORDER}`,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT.ui,
            fontWeight: 800,
            fontSize: tileH * 0.64,
            color: COLOR.text,
          }}
        >
          <span style={{ transform: `scaleY(${flipping ? 0.86 : 1})`, filter: flipping ? 'blur(1px)' : undefined }}>{ch}</span>
          <div style={{ position: 'absolute', left: 0, right: 0, top: tileH / 2 - 1, height: 2, background: COLOR.bg }} />
          {flipping ? <div style={{ position: 'absolute', inset: 0, bottom: tileH / 2, background: withAlpha(COLOR.bg, 0.35) }} /> : null}
        </div>
      );
    })}
  </div>
);
```

- [ ] **Step 7: O capítulo**

`src/chapters/C08Recursos.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { Glitch } from '../fx/Glitch';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { MIC } from '../lib/pixel-art';
import { flapSequenceAt } from '../lib/splitflap';
import { PINK_FLASH, localFrame } from '../timing';
import { COLOR, withAlpha } from '../theme';
import { BigWord } from '../ui/BigWord';
import { MonoLabel } from '../ui/MonoLabel';
import { PixelArt } from '../ui/PixelArt';
import { SplitFlap } from '../ui/SplitFlap';
import type { ChapterProps } from './types';

export const C08Recursos: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);
  const r = COPY.recursos;
  const pinkEnd = at(PINK_FLASH.endBeat);
  const controleAt = at(38.5);

  const seq = {
    words: r.flaps,
    starts: [at(37.35), at(37.75), at(38.15)],
    slots: 6,
    flipFrames: 6,
    staggerFrames: 1,
  };

  if (frame < pinkEnd) {
    const zoom = tween(frame, 0, 10, 1.06, 1);
    const glitch = tween(frame, pinkEnd - 5, pinkEnd, 0, 1, EASE.inOutCubic);
    return (
      <Glitch amount={glitch} seed="fale">
        <AbsoluteFill style={{ backgroundColor: COLOR.accent, transform: `scale(${zoom})` }}>
          <PixelArt art={MIC} pixel={16} color={COLOR.bg} style={{ position: 'absolute', left: TEXT.recursos.fale.x, top: TEXT.recursos.fale.y - 200 }} />
          <BigWord text={r.fale} box={TEXT.recursos.fale} enter={0} maxFontSize={300} color={COLOR.bg} periodColor={COLOR.bg} shadow={false} />
          <MonoLabel text={r.faleSub} box={TEXT.recursos.faleSub} enter={4} typeFrames={12} color={withAlpha(COLOR.bg, 0.8)} weight={600} />
          <div style={{ position: 'absolute', left: TEXT.recursos.faleSub.x, top: TEXT.recursos.faleSub.y + 70, display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
            {Array.from({ length: 24 }, (_, i) => (
              <div key={i} style={{ width: 10, height: 12 + 60 * Math.abs(Math.sin(frame * 0.45 + i * 0.7)), background: COLOR.bg }} />
            ))}
          </div>
        </AbsoluteFill>
      </Glitch>
    );
  }

  if (frame < controleAt) {
    const out = tween(frame, controleAt - 4, controleAt, 1, 0, EASE.inExpo);
    return (
      <AbsoluteFill style={{ opacity: out, transform: `scale(${1 - 0.04 * (1 - out)})` }}>
        <MonoLabel text={r.flapsLabel} box={TEXT.recursos.flapsLabel} enter={pinkEnd} typeFrames={10} />
        <div style={{ position: 'absolute', left: TEXT.recursos.flaps.x, top: TEXT.recursos.flaps.y }}>
          <SplitFlap chars={flapSequenceAt(seq, frame)} previous={flapSequenceAt(seq, frame - 2)} tileW={120} tileH={170} gap={10} />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <BigWord text={r.controle} box={TEXT.recursos.controle} enter={controleAt} maxFontSize={220} />
      <BigWord text={r.total} box={TEXT.recursos.total} enter={controleAt + 4} maxFontSize={220} variant="outline" />
      <MonoLabel text={r.controleSub} box={TEXT.recursos.controleSub} enter={controleAt + 8} typeFrames={16} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 8: Registrar**

Em `src/chapters/index.ts`: `import { C08Recursos } from './C08Recursos';` e `recursos: C08Recursos,`.

- [ ] **Step 9: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t14 1016 1030 1039 1050 1062 1074 1090 1115 && DEBUG_SAFE=1 scripts/stills.sh t14safe 1030 1115`
Expected (capítulo de 1013 a 1125):
- 1016–1030: tela inteira rosa, microfone em pixel, **FALE** enorme em tinta escura com quadrado escuro, subtítulo e barras de onda; o HUD também em tinta escura;
- 1039: glitch saindo do rosa;
- 1050–1074: fundo preto, "UMA FROTA, VÁRIAS CLIs" e letreiro de 6 casas trocando CLAUDE → CODEX → KIMI → GROK, com as casas que estão virando achatadas;
- 1090–1115: **CONTROLE.** sólido com quadrado rosa e **TOTAL.** só em contorno, subtítulo mono.
Em `t14safe-sheet.png`, FALE., CONTROLE. e TOTAL. dentro da área segura.

- [ ] **Step 10: Commit**

```bash
git add src
git commit -m "feat: capítulo recursos com FALE, letreiro e CONTROLE TOTAL"
```

---

### Task 15: Capítulo 09 (fim) — flash, grade de construção e marca

**Files:**
- Create: `src/chapters/C09Fim.tsx`
- Modify: `src/chapters/index.ts` (entrada `fim`; depois disso `Placeholder` sai do mapa e o arquivo é removido)

**Interfaces:**
- Consumes: `NexusMark3D`, `LOGO_CENTER`, `MARK_GRID`, `Wordmark`, `Tagline`, `MonoLabel`, `Flare`, `COPY.fim`, `TEXT.fim`, `localFrame`.
- Produces: `C09Fim`. Com isso `CHAPTER_COMPONENTS` não usa mais `Placeholder`.

- [ ] **Step 1: O capítulo**

`src/chapters/C09Fim.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COPY } from '../copy';
import { Flare } from '../fx/Flare';
import { TEXT } from '../layout';
import { EASE, tween } from '../lib/anim';
import { MARK_GRID } from '../lib/nexusmark';
import { HEIGHT, WIDTH, localFrame } from '../timing';
import { COLOR, FONT, withAlpha } from '../theme';
import { MonoLabel } from '../ui/MonoLabel';
import { NexusMark3D } from '../ui/NexusMark3D';
import { LOGO_CENTER } from '../ui/NexusMarkFlat';
import { Tagline, Wordmark } from '../ui/Wordmark';
import type { ChapterProps } from './types';

const PIXEL = 26;

export const C09Fim: React.FC<ChapterProps> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const at = (beat: number) => localFrame(beat, chapter);
  const size = MARK_GRID * PIXEL;
  const left = LOGO_CENTER.x - size / 2;
  const top = LOGO_CENTER.y - size / 2;

  const flash = frame < 3 ? 1 : tween(frame, 3, 14, 1, 0, EASE.outQuart);
  const draw = tween(frame, 2, at(41), 0, 1, EASE.outExpo);
  const gridAlpha = 0.22 * tween(frame, at(42), at(42.8), 1, 0.4);
  const settle = tween(frame, 0, 12, 1.08, 1);
  const line = withAlpha(COLOR.white, gridAlpha);

  return (
    <AbsoluteFill>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute' }}>
        {Array.from({ length: MARK_GRID + 1 }, (_, i) => (
          <React.Fragment key={i}>
            <line x1={left + i * PIXEL} y1={LOGO_CENTER.y - (size / 2) * draw} x2={left + i * PIXEL} y2={LOGO_CENTER.y + (size / 2) * draw} stroke={line} strokeWidth={1} />
            <line x1={LOGO_CENTER.x - (size / 2) * draw} y1={top + i * PIXEL} x2={LOGO_CENTER.x + (size / 2) * draw} y2={top + i * PIXEL} stroke={line} strokeWidth={1} />
          </React.Fragment>
        ))}
        {[top, top + size].map((y) => (
          <line key={`h${y}`} x1={LOGO_CENTER.x - (WIDTH / 2) * draw} y1={y} x2={LOGO_CENTER.x + (WIDTH / 2) * draw} y2={y} stroke={withAlpha(COLOR.white, gridAlpha * 0.6)} strokeWidth={1} />
        ))}
        {[left, left + size].map((x) => (
          <line key={`v${x}`} x1={x} y1={LOGO_CENTER.y - 520 * draw} x2={x} y2={LOGO_CENTER.y + 520 * draw} stroke={withAlpha(COLOR.white, gridAlpha * 0.6)} strokeWidth={1} />
        ))}
      </svg>

      <div style={{ position: 'absolute', inset: 0, transform: `scale(${settle})`, transformOrigin: `${LOGO_CENTER.x}px ${LOGO_CENTER.y}px` }}>
        <NexusMark3D
          center={LOGO_CENTER}
          pixel={PIXEL}
          ring={1}
          orbit={1}
          core={1}
          extrude={1}
          sweep={frame < at(41.5) ? -1 : tween(frame, at(41.5), at(42.5), 0, 1, EASE.inOutCubic)}
        />
      </div>

      <MonoLabel text={COPY.fim.measure} box={TEXT.fim.measure} enter={at(40.3)} typeFrames={6} align="center" size={20} color={withAlpha(COLOR.text, 0.45)} />
      <Wordmark text={COPY.fim.name} box={TEXT.fim.wordmark} enter={at(41)} />
      <Tagline lines={COPY.fim.taglineLines} emphasis="frota de agentes" box={TEXT.fim.tagline} enter={at(41.5)} />
      <MonoLabel text={COPY.fim.line} box={TEXT.fim.line} enter={at(42.5)} typeFrames={16} align="center" family={FONT.pixel} size={32} tracking="0.2em" />

      <Flare x={LOGO_CENTER.x} y={LOGO_CENTER.y} size={320} intensity={1.2 * flash} color={COLOR.accent} />
      <AbsoluteFill style={{ backgroundColor: COLOR.white, opacity: flash, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Registrar e remover o placeholder**

Em `src/chapters/index.ts`: `import { C09Fim } from './C09Fim';`, `fim: C09Fim,` e apague o import de `Placeholder`. Depois:

```bash
git rm -q src/chapters/Placeholder.tsx
```

- [ ] **Step 3: Verificar em imagem**

Run: `npx tsc --noEmit && npx vitest run && scripts/stills.sh t15 1126 1132 1150 1170 1190 1210 1237 && DEBUG_SAFE=1 scripts/stills.sh t15safe 1237`
Expected (capítulo de 1125 a 1238):
- 1126: quadro quase todo branco (flash);
- 1132–1150: flash se apagando, grade 13×13 se desenhando do centro para fora com guias até as bordas, "13 × 13" em mono acima do logo;
- 1170–1190: NexusMark em voxel, "Nexus" e a tagline em duas linhas, faixa de brilho atravessando o logo;
- 1210–1237: "MULTIAGENTE · MULTI-CLI · MULTI-CONTA" em VT323; grade mais fraca; nada de chamada ou URL.
Em `t15safe-sheet.png`, nome, tagline e linha final dentro da área segura.

- [ ] **Step 4: Painel do vídeo inteiro (ainda mudo)**

Run: `scripts/stills.sh t15all 15 60 130 185 260 330 380 430 520 600 650 700 760 850 950 1025 1060 1100 1180 1230`
Expected: abra `out/stills/t15all-sheet.png` e confira a sequência completa contra o roteiro da spec (seção "Roteiro"), capítulo a capítulo: continuidade nos cortes (pixel do boot → DESCREVA; colapso → logo; logos dos panes → esfera; esfera → anel), nenhum quadro vazio, HUD sempre presente e com o capítulo certo.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: capítulo fim com a grade de construção"
```

---

### Task 16: Medição da batida (biblioteca + script)

**Files:**
- Create: `src/lib/beats.ts` (sem imports: o script roda em Node puro), `scripts/measure-beats.ts`
- Test: `src/lib/beats.test.ts`

**Interfaces:**
- Produces: `type Envelope = {values: Float64Array; rate: number; t0: number}`; `onsetEnvelope(samples, sampleRate, hop?, win?)`; `estimateTempo(env, minBpm?, maxBpm?) → {bpm; periodFrames}` (lança erro claro para trilha curta ou silenciosa); `fitGrid(env, approxPeriodFrames) → {bpm; offsetSeconds; periodFrames; phaseFrames}`; `pickOnsets(env, k?) → number[]` (segundos); `nearestDistanceFrames(onsets, targets, fps) → number[]`; `type CutStatus = 'on' | 'off' | 'none'`; `classifyCuts(distances) → {statuses; pass}`; CLI `npm run measure-beats -- <arquivo> [--write]`.

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/beats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyCuts, estimateTempo, fitGrid, nearestDistanceFrames, onsetEnvelope, pickOnsets } from './beats';

const SR = 22050;

function clickTrack(bpm: number, offset: number, seconds: number): Float32Array {
  const s = new Float32Array(Math.round(seconds * SR));
  let seed = 1;
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    s[i] = (seed / 2 ** 32 - 0.5) * 0.02;
  }
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const start = Math.round(t * SR);
    for (let k = 0; k < 400 && start + k < s.length; k++) s[start + k] += 0.8 * Math.exp(-k / 80) * Math.sin(k * 0.6);
  }
  return s;
}

describe('medição de batida', () => {
  it.each([
    [128, 0.1],
    [120, 0.25],
    [127.6, 0.05],
  ])('acha %f BPM com a primeira batida em %f s', (bpm, offset) => {
    const env = onsetEnvelope(clickTrack(bpm, offset, 14), SR);
    const coarse = estimateTempo(env);
    expect(Math.abs(coarse.bpm - bpm)).toBeLessThan(1.5);
    const grid = fitGrid(env, coarse.periodFrames);
    expect(Math.abs(grid.bpm - bpm)).toBeLessThan(0.05);
    expect(Math.abs(grid.offsetSeconds - offset)).toBeLessThan(0.008);
  });

  it('trilha silenciosa dá erro claro', () => {
    const env = onsetEnvelope(new Float32Array(SR * 10), SR);
    expect(() => estimateTempo(env)).toThrow(/silenciosa/);
  });

  it('trilha curta demais dá erro claro', () => {
    const env = onsetEnvelope(clickTrack(128, 0, 2), SR);
    expect(() => estimateTempo(env)).toThrow(/curta/);
  });

  it('acha os ataques dos cliques', () => {
    const env = onsetEnvelope(clickTrack(120, 0.25, 6), SR);
    const onsets = pickOnsets(env, 2);
    expect(onsets.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...nearestDistanceFrames(onsets, [0.25], 60))).toBeLessThan(1);
  });
});

describe('cortes', () => {
  it('mede a distância em quadros até o ataque mais próximo', () => {
    expect(nearestDistanceFrames([1, 2], [1.01], 60)[0]).toBeCloseTo(0.6, 6);
  });

  it('reprova corte com ataque perto mas fora da tolerância', () => {
    expect(classifyCuts([0.5, 1, 1.2, 0, 0.3, 1.9, 0.1, 0.4]).pass).toBe(true);
    expect(classifyCuts([0.5, 1, 1.2, 0, 0.3, 1.9, 0.1, 4]).pass).toBe(false);
    expect(classifyCuts([0.5, 1, 1.2, 0, 0.3, 1.9, 0.1, 30]).statuses[7]).toBe('none');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/beats.test.ts`
Expected: FAIL — `./beats` não resolve.

- [ ] **Step 3: Implementar**

`src/lib/beats.ts`:

```ts
/** Envelope de ataques. values[i] vale para o instante t0 + i / rate (fim da janela i). */
export type Envelope = { readonly values: Float64Array; readonly rate: number; readonly t0: number };

export function onsetEnvelope(samples: Float32Array, sampleRate: number, hop = 128, win = 256): Envelope {
  const count = Math.max(0, Math.floor((samples.length - win) / hop) + 1);
  const logEnergy = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let e = 0;
    const start = i * hop;
    for (let k = 0; k < win; k++) e += samples[start + k] * samples[start + k];
    logEnergy[i] = Math.log(1e-10 + e / win);
  }
  const values = new Float64Array(count);
  for (let i = 1; i < count; i++) values[i] = Math.max(0, logEnergy[i] - logEnergy[i - 1]);
  return { values, rate: sampleRate / hop, t0: win / sampleRate };
}

const MIN_SECONDS = 4;

export function estimateTempo(env: Envelope, minBpm = 100, maxBpm = 160): { bpm: number; periodFrames: number } {
  const v = env.values;
  const seconds = v.length / env.rate;
  if (seconds < MIN_SECONDS) {
    throw new Error(`Trilha curta demais para medir o tempo: ${seconds.toFixed(2)} s (mínimo ${MIN_SECONDS} s).`);
  }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (!(mean > 1e-6)) throw new Error('Trilha sem ataques detectáveis (silenciosa?): não dá para medir o tempo.');
  const centered = Float64Array.from(v, (x) => x - mean);
  const minLag = Math.floor((60 / maxBpm) * env.rate);
  const maxLag = Math.ceil((60 / minBpm) * env.rate);
  const score = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < centered.length; i++) s += centered[i] * centered[i + lag];
    return s / (centered.length - lag);
  };
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = score(lag);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  const y0 = score(bestLag - 1);
  const y2 = score(bestLag + 1);
  const denom = y0 - 2 * best + y2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const periodFrames = bestLag + shift;
  return { bpm: (60 * env.rate) / periodFrames, periodFrames };
}

export function fitGrid(env: Envelope, approxPeriodFrames: number) {
  const v = env.values;
  const sample = (x: number) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= v.length) return 0;
    const f = x - i;
    return v[i] * (1 - f) + v[i + 1] * f;
  };
  let best = { score: -Infinity, period: approxPeriodFrames, phase: 0 };
  for (let step = -40; step <= 40; step++) {
    const period = approxPeriodFrames * (1 + step * 0.0005);
    for (let phase = 0; phase < period; phase += 0.25) {
      let sum = 0;
      let n = 0;
      for (let x = phase; x < v.length; x += period) {
        sum += sample(x);
        n++;
      }
      const score = n > 0 ? sum / n : 0;
      if (score > best.score) best = { score, period, phase };
    }
  }
  // t0 desloca a fase; o offset é o instante da primeira batida dentro de um período.
  const periodSeconds = best.period / env.rate;
  const raw = env.t0 + best.phase / env.rate;
  return {
    bpm: (60 * env.rate) / best.period,
    offsetSeconds: ((raw % periodSeconds) + periodSeconds) % periodSeconds,
    periodFrames: best.period,
    phaseFrames: best.phase,
  };
}

export function pickOnsets(env: Envelope, k = 2.5): number[] {
  const v = env.values;
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length));
  const threshold = mean + k * sd;
  const times: number[] = [];
  for (let i = 1; i + 1 < v.length; i++) {
    if (v[i] > threshold && v[i] >= v[i - 1] && v[i] > v[i + 1]) times.push(env.t0 + i / env.rate);
  }
  return times;
}

export function nearestDistanceFrames(onsets: readonly number[], targets: readonly number[], fps: number): number[] {
  return targets.map((t) => (onsets.length === 0 ? Infinity : Math.min(...onsets.map((o) => Math.abs(o - t))) * fps));
}

export type CutStatus = 'on' | 'off' | 'none';

/** 'on' ≤ 2 quadros; 'off' = há ataque perto (≤ 8) mas fora da tolerância; 'none' = nada perto. */
export function classifyCuts(distances: readonly number[]): { statuses: CutStatus[]; pass: boolean } {
  const statuses = distances.map((d): CutStatus => (d <= 2 ? 'on' : d <= 8 ? 'off' : 'none'));
  const on = statuses.filter((s) => s === 'on').length;
  return { statuses, pass: !statuses.includes('off') && on >= Math.ceil(distances.length * 0.7) };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/beats.test.ts`
Expected: PASS nos 8 testes. Se o de 127,6 BPM falhar só por precisão de `fitGrid`, reduza o passo de período (`0.0005` → `0.00025`, com `step` de -80 a 80) e rode de novo; não afrouxe as tolerâncias do teste.

- [ ] **Step 5: O script**

`scripts/measure-beats.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { classifyCuts, estimateTempo, fitGrid, nearestDistanceFrames, onsetEnvelope, pickOnsets } from '../src/lib/beats.ts';

const SR = 22050;
const CUT_BEATS = [1, 7, 12, 16, 22, 28, 32, 36, 37, 38.5, 40];

const args = process.argv.slice(2);
const audio = args.find((a) => !a.startsWith('--')) ?? 'public/audio/music.mp3';
const write = args.includes('--write');

const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', audio, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
if (ff.status !== 0) {
  console.error(`ffmpeg falhou ao ler ${audio}:\n${ff.stderr.toString()}`);
  process.exit(1);
}
const samples = new Float32Array(ff.stdout.byteLength / 4);
for (let i = 0; i < samples.length; i++) samples[i] = ff.stdout.readFloatLE(i * 4);

const env = onsetEnvelope(samples, SR);
const coarse = estimateTempo(env);
const grid = fitGrid(env, coarse.periodFrames);
const cutTimes = CUT_BEATS.map((b) => grid.offsetSeconds + (b * 60) / grid.bpm);
const distances = nearestDistanceFrames(pickOnsets(env), cutTimes, 60);
const cuts = classifyCuts(distances);

console.log(
  JSON.stringify(
    {
      audio,
      bpm: Number(grid.bpm.toFixed(3)),
      musicOffsetSeconds: Number(grid.offsetSeconds.toFixed(4)),
      cuts: CUT_BEATS.map((beat, i) => ({ beat, distanceFrames: Number(distances[i].toFixed(2)), status: cuts.statuses[i] })),
      pass: cuts.pass,
    },
    null,
    2,
  ),
);

if (!cuts.pass) {
  console.error('Cortes fora da batida: gere outra trilha (outra seed) antes de gravar o grid.json.');
  process.exit(2);
}
if (write) {
  writeFileSync('src/grid.json', `${JSON.stringify({ bpm: Number(grid.bpm.toFixed(3)), musicOffsetSeconds: Number(grid.offsetSeconds.toFixed(4)) }, null, 2)}\n`);
  console.log('src/grid.json gravado.');
}
```

- [ ] **Step 6: Conferir o script com uma trilha sintética**

```bash
cd /Users/cleofasrocha/dev/nexus-reel
ffmpeg -v error -y -f lavfi -i "sine=frequency=1000:duration=0.02" -af "apad=pad_dur=0.44875" -ar 22050 out/click.wav
ffmpeg -v error -y -stream_loop 43 -i out/click.wav -ar 22050 out/click-128.wav
npm run measure-beats -- out/click-128.wav
```

Expected: JSON com `"bpm"` entre 127,95 e 128,05, `"musicOffsetSeconds"` < 0,01 e `"pass": true`. O `grid.json` não muda (sem `--write`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/beats.ts src/lib/beats.test.ts scripts/measure-beats.ts
git commit -m "feat: medição de BPM e fase da trilha"
```

---

### Task 17: Trilha original (ElevenLabs) e grade medida

**Files:**
- Create: `public/audio/music.mp3` (gerado), `public/audio/PROVENANCE.md`
- Modify: `src/grid.json` (medido), `src/copy.ts` (`hud.spec`, só se o BPM arredondado não for 128)

**Interfaces:**
- Consumes: MCP `mcp__elevenlabs__check_subscription`, `mcp__elevenlabs__create_composition_plan`, `mcp__elevenlabs__compose_music` (carregar os schemas via ToolSearch antes); `npm run measure-beats` (Task 16).
- Produces: `public/audio/music.mp3` (~22 s, instrumental); `src/grid.json` com `bpm` e `musicOffsetSeconds` medidos.

- [ ] **Step 1: Saldo antes**

Chame `mcp__elevenlabs__check_subscription` e anote `character_count` e `character_limit` (plano Starter; em 25/09 havia ~87,8 mil créditos livres). Se o saldo livre for menor que 10 000, pare e avise o operador antes de gerar.

- [ ] **Step 2: Esqueleto do plano de composição (grátis)**

Chame `mcp__elevenlabs__create_composition_plan` com:

```json
{
  "prompt": "22-second dark instrumental electronic track at exactly 128 BPM in 4/4 for a product reel: intro with pulsing analog sub bass and riser, impact hit into a driving groove, short breakdown with filter sweep, full-energy drop with synth stabs, final cinematic impact with reverb tail.",
  "music_length_ms": 22000,
  "model_id": "music_v2"
}
```

Anote o valor de `context_adherence` que vier em cada chunk (e qualquer campo obrigatório que o schema devolver).

- [ ] **Step 3: Gerar a trilha**

Chame `mcp__elevenlabs__compose_music` com `model_id: "music_v2"`, `force_instrumental: true`, `seed: 128`, `output_directory: "/Users/cleofasrocha/dev/nexus-reel/public/audio"` e este `composition_plan` (mantenha o `context_adherence` que o Step 2 devolveu, em todos os chunks):

```json
{
  "chunks": [
    {
      "text": "Intro. Dark, precise electronic at exactly 128 BPM in 4/4. Pulsing analog sub bass on every quarter note, tight closed hi-hats in sixteenths, soft glassy digital blips, a system booting up. The last bar builds with a rising noise riser and a snare roll into a hit.",
      "duration_ms": 5625,
      "positive_styles": ["dark electronic", "cinematic tech", "128 bpm", "analog synth", "tight drums", "instrumental"],
      "negative_styles": ["vocals", "lyrics", "acoustic guitar", "lo-fi", "jazz", "orchestral strings"]
    },
    {
      "text": "Impact hit on the first downbeat, then a driving groove at 128 BPM: four-on-the-floor kick, crisp clap on beats 2 and 4, rolling analog bassline, arpeggiated synth. Confident, operational, precise.",
      "duration_ms": 4688,
      "positive_styles": ["dark electronic", "driving groove", "128 bpm", "analog bassline", "arpeggio"],
      "negative_styles": ["vocals", "lyrics", "acoustic guitar", "lo-fi", "jazz", "orchestral strings"]
    },
    {
      "text": "Breakdown at 128 BPM: the kick drops out, a low-pass filter sweeps open, a deep sub drop and a reversed cymbal swell into the next drop. Tension, like diving through layers.",
      "duration_ms": 2812,
      "positive_styles": ["breakdown", "filter sweep", "sub drop", "tension", "128 bpm"],
      "negative_styles": ["vocals", "lyrics", "acoustic guitar", "lo-fi", "jazz", "orchestral strings"]
    },
    {
      "text": "Full-energy drop at 128 BPM: heavy four-on-the-floor kick, sidechained bass, bright arpeggiated lead, short synth stabs on every beat in the final bar. Maximum energy, clean and controlled.",
      "duration_ms": 5625,
      "positive_styles": ["full energy drop", "sidechain", "synth stabs", "128 bpm", "clean mix"],
      "negative_styles": ["vocals", "lyrics", "acoustic guitar", "lo-fi", "jazz", "orchestral strings"]
    },
    {
      "text": "Final cinematic impact on the downbeat with a long reverb tail and a sub boom; everything else stops and the tail decays to silence.",
      "duration_ms": 3250,
      "positive_styles": ["cinematic impact", "reverb tail", "sub boom", "ending"],
      "negative_styles": ["vocals", "lyrics", "drums continuing", "new melody"]
    }
  ]
}
```

Renomeie o arquivo devolvido pela ferramenta:

```bash
cd /Users/cleofasrocha/dev/nexus-reel/public/audio
mv "<caminho devolvido pela ferramenta>" music.mp3
ffprobe -v error -show_entries format=duration -of csv=p=0 music.mp3
```

Expected: duração entre 21,5 e 22,5 s.

- [ ] **Step 4: Medir e gravar a grade**

Run: `cd /Users/cleofasrocha/dev/nexus-reel && npm run measure-beats -- public/audio/music.mp3`
Expected: `"bpm"` entre 124 e 132 e `"pass": true`. Então grave:

Run: `npm run measure-beats -- public/audio/music.mp3 --write && npx vitest run src/timing.test.ts && npx remotion compositions src/index.ts`
Expected: `src/grid.json gravado.`; testes PASS; a composição lista a nova duração (1238 quadros a 128,000 BPM; ±3 quadros para BPM medido perto de 128).

Se `pass` vier `false` ou o BPM sair da faixa: gere de novo o Step 3 com `seed: 129` e depois `seed: 130`. Depois de 3 tentativas reprovadas, pare e mostre ao operador o JSON do `measure-beats` (não gaste mais créditos).

- [ ] **Step 5: HUD com o BPM real**

Se `Math.round(bpm)` do `grid.json` não for 128, troque em `src/copy.ts` o `hud.spec` para `1080×1920 · 60 FPS · <BPM arredondado> BPM`.

- [ ] **Step 6: Procedência e saldo depois**

`public/audio/PROVENANCE.md`:

```markdown
# Áudio

- `music.mp3`: gerada em 25/09/2026 com ElevenLabs Music (`music_v2`, instrumental, seed registrada no commit),
  plano Starter (licença comercial dos planos pagos). Plano de composição: `docs/superpowers/plans/2026-09-25-nexus-reel.md` (Task 17).
- `sfx/*.mp3`: efeitos gerados com ElevenLabs Sound Effects (Task 18).
```

Chame `mcp__elevenlabs__check_subscription` de novo e anote quantos créditos a trilha custou (diferença de `character_count`).

- [ ] **Step 7: Commit**

```bash
git add public/audio src/grid.json src/copy.ts
git commit -m "feat: trilha original a 128 BPM e grade medida"
```

---

### Task 18: Efeitos sonoros, marcações e trilha no vídeo

**Files:**
- Create: `public/audio/sfx/*.mp3` (13 gerados), `src/audio/cues.ts`, `src/audio/Soundtrack.tsx`
- Modify: `src/Reel.tsx` (monta `<Soundtrack />`)
- Test: `src/audio/cues.test.ts`

**Interfaces:**
- Consumes: MCP `mcp__elevenlabs__text_to_sound_effects`; `beatToFrame`, `MUSIC_OFFSET_SECONDS`, `TOTAL_BEATS`.
- Produces: `SFX` (13 nomes); `type SfxName`; `type Cue = {sfx; beat; volume; untilBeat?}`; `CUES`; `<Soundtrack />`.

- [ ] **Step 1: Gerar os efeitos**

Chame `mcp__elevenlabs__check_subscription` e anote o saldo (repita ao fim deste step para registrar o custo). Para cada linha abaixo, chame `mcp__elevenlabs__text_to_sound_effects` com `text`, `duration_seconds`, `output_format: "mp3_44100_128"` e `output_directory: "/Users/cleofasrocha/dev/nexus-reel/public/audio/sfx"`, e renomeie o arquivo devolvido para `<nome>.mp3`:

| nome | duração (s) | text |
|---|---|---|
| boot | 0.8 | short futuristic system power-on blip with a soft low sub thump, clean UI sound |
| slam | 0.6 | punchy short whoosh into a tight impact hit for kinetic typography, clean, no reverb tail |
| glitch | 0.5 | short digital glitch stutter, data corruption burst, crisp |
| typing | 2.0 | fast mechanical keyboard typing, close mic, clean, no room |
| click | 0.5 | single crisp mouse click, UI button press |
| collapse | 1.0 | reverse whoosh sucking into a single point, ending in a tiny bright spark |
| blips | 1.2 | rapid sequence of tiny 8-bit digital blips assembling, rising in pitch |
| tick | 0.5 | short clean sci-fi interface tick, soft |
| confirm | 0.6 | positive confirmation chime, two soft ascending notes, modern UI |
| dive | 1.5 | deep cinematic whoosh descending through layers, airy, with low rumble |
| alert | 0.6 | soft cockpit warning beep, two short tones, not harsh |
| flaps | 1.5 | split-flap display flipping letters, mechanical clatter, airport board |
| impact | 3.0 | deep cinematic impact hit with long reverb tail and sub boom |

Run: `ls /Users/cleofasrocha/dev/nexus-reel/public/audio/sfx`
Expected: os 13 arquivos `boot.mp3` … `impact.mp3`.

- [ ] **Step 2: Escrever o teste que falha**

`src/audio/cues.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOTAL_BEATS } from '../timing';
import { CUES, SFX } from './cues';

const SFX_DIR = fileURLToPath(new URL('../../public/audio/sfx/', import.meta.url));

describe('marcações de áudio', () => {
  it('todo efeito existe em public/audio/sfx', () => {
    for (const name of SFX) expect(existsSync(`${SFX_DIR}${name}.mp3`), name).toBe(true);
  });

  it('marcações ordenadas, dentro do vídeo e com volume válido', () => {
    for (let i = 0; i < CUES.length; i++) {
      const c = CUES[i];
      expect(c.beat).toBeGreaterThanOrEqual(0);
      expect(c.beat).toBeLessThan(TOTAL_BEATS);
      expect(c.volume).toBeGreaterThan(0);
      expect(c.volume).toBeLessThanOrEqual(1);
      if (c.untilBeat !== undefined) expect(c.untilBeat).toBeGreaterThan(c.beat);
      if (i > 0) expect(c.beat).toBeGreaterThanOrEqual(CUES[i - 1].beat);
    }
  });

  it('no máximo 3 glitches, um para cada glitch visual', () => {
    expect(CUES.filter((c) => c.sfx === 'glitch')).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run src/audio`
Expected: FAIL — `./cues` não resolve.

- [ ] **Step 4: Implementar**

`src/audio/cues.ts`:

```ts
export const SFX = ['boot', 'slam', 'glitch', 'typing', 'click', 'collapse', 'blips', 'tick', 'confirm', 'dive', 'alert', 'flaps', 'impact'] as const;
export type SfxName = (typeof SFX)[number];
export type Cue = { readonly sfx: SfxName; readonly beat: number; readonly volume: number; readonly untilBeat?: number };

/** Cada efeito cai na batida do evento visual correspondente (ver roteiro na spec). */
export const CUES: readonly Cue[] = [
  { sfx: 'boot', beat: 0, volume: 0.6 },
  { sfx: 'slam', beat: 1, volume: 0.7 },
  { sfx: 'slam', beat: 3, volume: 0.7 },
  { sfx: 'slam', beat: 5, volume: 0.7 },
  { sfx: 'glitch', beat: 6.5, volume: 0.5 },
  { sfx: 'typing', beat: 7.6, volume: 0.45, untilBeat: 10 },
  { sfx: 'click', beat: 10.5, volume: 0.8 },
  { sfx: 'collapse', beat: 11, volume: 0.6 },
  { sfx: 'blips', beat: 12, volume: 0.5 },
  { sfx: 'tick', beat: 17, volume: 0.5 },
  { sfx: 'tick', beat: 18.5, volume: 0.5 },
  { sfx: 'tick', beat: 20, volume: 0.5 },
  { sfx: 'confirm', beat: 21, volume: 0.6 },
  { sfx: 'dive', beat: 24, volume: 0.7 },
  { sfx: 'tick', beat: 29, volume: 0.35 },
  { sfx: 'alert', beat: 34, volume: 0.55 },
  { sfx: 'confirm', beat: 35, volume: 0.55 },
  { sfx: 'glitch', beat: 35.8, volume: 0.5 },
  { sfx: 'glitch', beat: 36.8, volume: 0.45 },
  { sfx: 'flaps', beat: 37.3, volume: 0.55 },
  { sfx: 'impact', beat: 40, volume: 0.85 },
];
```

`src/audio/Soundtrack.tsx`:

```tsx
import { Audio } from '@remotion/media';
import React from 'react';
import { Sequence, interpolate, staticFile, useVideoConfig } from 'remotion';
import { MUSIC_OFFSET_SECONDS, beatToFrame } from '../timing';
import { CUES } from './cues';

export const Soundtrack: React.FC = () => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <>
      <Audio
        src={staticFile('audio/music.mp3')}
        trimBefore={Math.round(MUSIC_OFFSET_SECONDS * fps)}
        volume={(f) => interpolate(f, [durationInFrames - 24, durationInFrames - 1], [0.9, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
      />
      {CUES.map((cue, i) => {
        const from = beatToFrame(cue.beat);
        const duration = cue.untilBeat === undefined ? undefined : beatToFrame(cue.untilBeat) - from;
        return (
          <Sequence key={`${cue.sfx}-${i}`} name={`sfx:${cue.sfx}`} from={from} durationInFrames={duration} layout="none">
            <Audio src={staticFile(`audio/sfx/${cue.sfx}.mp3`)} volume={cue.volume} />
          </Sequence>
        );
      })}
    </>
  );
};
```

Em `src/Reel.tsx`, importe `Soundtrack` de `./audio/Soundtrack` e monte `<Soundtrack />` logo depois de `<Grain />`.

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS; `tsc` limpo.

- [ ] **Step 6: Conferir o áudio renderizado**

Run:

```bash
npx remotion render src/index.ts NexusReel out/audio-check.wav --codec=wav --log=error
ffprobe -v error -show_entries format=duration -of csv=p=0 out/audio-check.wav
ffmpeg -hide_banner -i out/audio-check.wav -af ebur128 -f null - 2>&1 | grep -E "^\s+I:"
```

Expected: duração igual a `totalFrames / 60` (±0,05 s); loudness integrada entre -24 e -8 LUFS (antes da masterização). Se o `@remotion/media` recusar o callback de volume, troque a trilha para `Html5Audio` de `remotion` (mesmas props) e rode de novo.

- [ ] **Step 7: Commit**

```bash
git add public/audio/sfx src/audio src/Reel.tsx
git commit -m "feat: efeitos sonoros na batida e trilha no reel"
```

---

### Task 19: Masterização e verificação automáticas

**Files:**
- Create: `src/lib/media-checks.ts` (sem imports), `scripts/master.ts`, `scripts/verify.ts`
- Modify: `package.json` (script `build:all`)
- Test: `src/lib/media-checks.test.ts`

**Interfaces:**
- Consumes: `totalFrames` (só no teste), `npm run measure-beats`.
- Produces: `LOUDNESS_TARGET = {I: -14, TP: -1, LRA: 11}`; `type LoudnormMeasure`; `parseLoudnormJson(stderr)`; `loudnormSecondPass(m, target?)`; `type Ebur128 = {integrated; truePeak}`; `parseEbur128Summary(stderr)`; `expectedFrames(bpm)`; `type ProbeExpect`; `checkProbe(probeJson, expect): string[]`; scripts `npm run master`, `npm run verify`, `npm run build:all`.

- [ ] **Step 1: Escrever o teste que falha**

`src/lib/media-checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { totalFrames } from '../timing';
import { checkProbe, expectedFrames, loudnormSecondPass, parseEbur128Summary, parseLoudnormJson } from './media-checks';

const LOUDNORM_STDERR = `[Parsed_loudnorm_0 @ 0x1]
{
	"input_i" : "-19.23",
	"input_tp" : "-3.10",
	"input_lra" : "5.40",
	"input_thresh" : "-29.61",
	"output_i" : "-14.02",
	"output_tp" : "-1.00",
	"output_lra" : "4.90",
	"output_thresh" : "-24.40",
	"normalization_type" : "linear",
	"target_offset" : "0.02"
}`;

const EBUR_STDERR = `[Parsed_ebur128_0 @ 0x2] Summary:

  Integrated loudness:
    I:         -14.1 LUFS
    Threshold: -24.4 LUFS

  True peak:
    Peak:       -1.2 dBFS`;

const probe = (over: Record<string, unknown> = {}, audio = true) => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, r_frame_rate: '60/1', pix_fmt: 'yuv420p', ...over },
    ...(audio ? [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }] : []),
  ],
  format: { duration: '20.640000' },
});

describe('loudnorm', () => {
  it('lê a medição da primeira passada', () => {
    expect(parseLoudnormJson(LOUDNORM_STDERR)).toEqual({ input_i: -19.23, input_tp: -3.1, input_lra: 5.4, input_thresh: -29.61, target_offset: 0.02 });
  });

  it('recusa medição de áudio silencioso (-inf)', () => {
    expect(() => parseLoudnormJson(LOUDNORM_STDERR.replace('"-19.23"', '"-inf"'))).toThrow(/input_i/);
  });

  it('monta a segunda passada linear com os valores medidos', () => {
    const f = loudnormSecondPass(parseLoudnormJson(LOUDNORM_STDERR));
    expect(f).toContain('I=-14:TP=-1:LRA=11');
    expect(f).toContain('measured_I=-19.23');
    expect(f).toContain('linear=true');
  });
});

describe('ebur128', () => {
  it('lê loudness integrada e pico verdadeiro', () => {
    expect(parseEbur128Summary(EBUR_STDERR)).toEqual({ integrated: -14.1, truePeak: -1.2 });
  });

  it('erra claro sem resumo', () => {
    expect(() => parseEbur128Summary('nada')).toThrow(/resumo/);
  });
});

describe('probe', () => {
  const expectMain = { width: 1080, height: 1920, fps: 60, durationSeconds: 20.625, audio: true };

  it('aprova o master correto', () => {
    expect(checkProbe(probe(), expectMain)).toEqual([]);
  });

  it('aponta fps, pixel format e áudio errados', () => {
    const problems = checkProbe(probe({ r_frame_rate: '30/1', pix_fmt: 'yuv444p' }, false), expectMain);
    expect(problems.join(' | ')).toMatch(/fps/);
    expect(problems.join(' | ')).toMatch(/pix_fmt/);
    expect(problems.join(' | ')).toMatch(/sem faixa de áudio/);
  });

  it('a versão muda não pode ter áudio', () => {
    expect(checkProbe(probe(), { ...expectMain, audio: false })).toContain('a versão muda tem faixa de áudio');
  });
});

describe('expectedFrames', () => {
  it.each([100, 127.6, 128, 160])('bate com totalFrames a %f BPM', (bpm) => {
    expect(expectedFrames(bpm)).toBe(totalFrames({ bpm, fps: 60 }));
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/media-checks.test.ts`
Expected: FAIL — `./media-checks` não resolve.

- [ ] **Step 3: Implementar**

`src/lib/media-checks.ts`:

```ts
export const LOUDNESS_TARGET = { I: -14, TP: -1, LRA: 11 } as const;

export type LoudnormMeasure = {
  readonly input_i: number;
  readonly input_tp: number;
  readonly input_lra: number;
  readonly input_thresh: number;
  readonly target_offset: number;
};

export function parseLoudnormJson(stderr: string): LoudnormMeasure {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('loudnorm: JSON de medição não encontrado na saída do ffmpeg.');
  const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  const num = (key: keyof LoudnormMeasure) => {
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) throw new Error(`loudnorm: campo ${key} inválido (${raw[key]}).`);
    return value;
  };
  return {
    input_i: num('input_i'),
    input_tp: num('input_tp'),
    input_lra: num('input_lra'),
    input_thresh: num('input_thresh'),
    target_offset: num('target_offset'),
  };
}

export function loudnormSecondPass(m: LoudnormMeasure, t: { I: number; TP: number; LRA: number } = LOUDNESS_TARGET): string {
  return [
    `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}`,
    `measured_I=${m.input_i}`,
    `measured_TP=${m.input_tp}`,
    `measured_LRA=${m.input_lra}`,
    `measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}`,
    'linear=true',
    'print_format=summary',
  ].join(':');
}

export type Ebur128 = { readonly integrated: number; readonly truePeak: number };

export function parseEbur128Summary(stderr: string): Ebur128 {
  const at = stderr.lastIndexOf('Summary:');
  const summary = at < 0 ? '' : stderr.slice(at);
  const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
  if (!integrated || !peak) throw new Error('ebur128: resumo sem I ou Peak (rode com -af ebur128=peak=true).');
  return { integrated: Number(integrated[1]), truePeak: Number(peak[1]) };
}

/** Mesma conta de timing.ts (44 batidas a 60 fps), sem importar o grid.json: o teste prende as duas. */
export function expectedFrames(bpm: number): number {
  return Math.round(44 * ((60 * 60) / bpm));
}

export type ProbeExpect = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSeconds: number;
  readonly audio: boolean;
};

type Stream = {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly pix_fmt?: string;
  readonly sample_rate?: string;
};

export function checkProbe(probe: { streams?: readonly Stream[]; format?: { duration?: string } }, e: ProbeExpect): string[] {
  const video = probe.streams?.find((s) => s.codec_type === 'video');
  const audio = probe.streams?.find((s) => s.codec_type === 'audio');
  if (!video) return ['sem faixa de vídeo'];
  const problems: string[] = [];
  if (video.codec_name !== 'h264') problems.push(`codec ${video.codec_name}, esperado h264`);
  if (video.width !== e.width || video.height !== e.height) problems.push(`resolução ${video.width}x${video.height}, esperado ${e.width}x${e.height}`);
  if (video.pix_fmt !== 'yuv420p') problems.push(`pix_fmt ${video.pix_fmt}, esperado yuv420p`);
  const [num, den] = (video.r_frame_rate ?? '0/1').split('/').map(Number);
  if (!(Math.abs(num / den - e.fps) <= 0.01)) problems.push(`fps ${video.r_frame_rate}, esperado ${e.fps}`);
  const duration = Number(probe.format?.duration);
  if (!(Math.abs(duration - e.durationSeconds) <= 0.05)) problems.push(`duração ${duration} s, esperado ${e.durationSeconds.toFixed(3)} s`);
  if (e.audio && !audio) problems.push('sem faixa de áudio');
  if (e.audio && audio && audio.codec_name !== 'aac') problems.push(`áudio ${audio.codec_name}, esperado aac`);
  if (e.audio && audio && audio.sample_rate !== '48000') problems.push(`áudio a ${audio.sample_rate} Hz, esperado 48000`);
  if (!e.audio && audio) problems.push('a versão muda tem faixa de áudio');
  return problems;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/media-checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Scripts**

`scripts/master.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { LOUDNESS_TARGET, loudnormSecondPass, parseLoudnormJson } from '../src/lib/media-checks.ts';

const MASTER = 'out/master.mp4';
const MAIN = 'out/nexus-reel-ptbr.mp4';
const MUTE = 'out/nexus-reel-ptbr-mudo.mp4';
const COVER = 'out/nexus-reel-capa.png';

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}… falhou (código ${r.status})`);
  }
  return r;
}

if (!existsSync(MASTER)) {
  console.error('out/master.mp4 não existe: rode npm run render antes.');
  process.exit(1);
}

const t = LOUDNESS_TARGET;
const pass1 = run('ffmpeg', ['-hide_banner', '-i', MASTER, '-af', `loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:print_format=json`, '-f', 'null', '-']);
const measured = parseLoudnormJson(pass1.stderr);
run('ffmpeg', ['-hide_banner', '-y', '-i', MASTER, '-c:v', 'copy', '-af', loudnormSecondPass(measured), '-ar', '48000', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', MAIN]);
run('ffmpeg', ['-hide_banner', '-y', '-i', MAIN, '-c:v', 'copy', '-an', '-movflags', '+faststart', MUTE]);

const frames = Number(
  JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'json', MASTER]).stdout).streams[0].nb_frames,
);
run('npx', ['remotion', 'still', 'src/index.ts', 'NexusReel', COVER, `--frame=${frames - 1}`, '--log=error']);

console.log(JSON.stringify({ measured, outputs: [MAIN, MUTE, COVER] }, null, 2));
```

`scripts/verify.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkProbe, expectedFrames, parseEbur128Summary } from '../src/lib/media-checks.ts';

const MAIN = 'out/nexus-reel-ptbr.mp4';
const MUTE = 'out/nexus-reel-ptbr-mudo.mp4';
const failures: string[] = [];

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
const probeOf = (file: string) => JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).stdout);

const grid = JSON.parse(readFileSync('src/grid.json', 'utf8')) as { bpm: number };
const durationSeconds = expectedFrames(grid.bpm) / 60;
const base = { width: 1080, height: 1920, fps: 60, durationSeconds };

for (const [file, audio] of [[MAIN, true], [MUTE, false]] as const) {
  for (const p of checkProbe(probeOf(file), { ...base, audio })) failures.push(`${file}: ${p}`);
}

const loud = parseEbur128Summary(run('ffmpeg', ['-hide_banner', '-i', MAIN, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr);
if (Math.abs(loud.integrated - -14) > 1) failures.push(`loudness ${loud.integrated} LUFS, esperado -14 ±1`);
if (loud.truePeak > -1) failures.push(`pico verdadeiro ${loud.truePeak} dBFS, esperado ≤ -1`);

const beats = run('npm', ['run', '--silent', 'measure-beats', '--', 'public/audio/music.mp3']);
const beatReport = JSON.parse(beats.stdout.slice(beats.stdout.indexOf('{'), beats.stdout.lastIndexOf('}') + 1));
if (!beatReport.pass) failures.push('cortes fora da batida (ver measure-beats)');

run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', MAIN, '-vf', 'fps=2,scale=270:480,tile=8x3:padding=4:color=white', 'out/nexus-reel-sheet-%02d.png']);

console.log(JSON.stringify({ durationSeconds, loudness: loud, bpm: beatReport.bpm, cuts: beatReport.cuts, sheets: 'out/nexus-reel-sheet-*.png', failures }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
```

Run: `npm pkg set scripts.build:all="npm run render && npm run master && npm run verify" && npx tsc --noEmit`
Expected: `tsc` limpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/media-checks.ts src/lib/media-checks.test.ts scripts/master.ts scripts/verify.ts package.json
git commit -m "feat: masterização a -14 LUFS e verificação dos entregáveis"
```

---

### Task 20: Render final, revisão visual e entrega

**Files:**
- Create: `README.md` (nexus-reel)
- Modify: o que a revisão visual apontar (layout, tempos de entrada, tamanhos)

**Interfaces:**
- Consumes: tudo acima.
- Produces: `out/nexus-reel-ptbr.mp4`, `out/nexus-reel-ptbr-mudo.mp4`, `out/nexus-reel-capa.png`, `out/nexus-reel-sheet-*.png`.

- [ ] **Step 1: Render completo e verificação automática**

Run: `cd /Users/cleofasrocha/dev/nexus-reel && npx vitest run && npx tsc --noEmit && npm run build:all`
Expected: testes e tipos limpos; `verify` imprime `"failures": []` e sai com código 0. Se falhar, corrija a causa (não afrouxe o critério) e rode de novo.

- [ ] **Step 2: Revisão visual contra o roteiro**

Abra (Read) cada `out/nexus-reel-sheet-*.png` e confira, capítulo a capítulo, contra a tabela "Roteiro" da spec e contra os painéis da referência (`/private/tmp/claude-501/-Users-cleofasrocha-dev-nexus-ide/735b701f-3329-413f-b6ad-fce751bca276/scratchpad/ref/sheet_*.jpg`, se ainda existirem):
- cada capítulo aparece no tempo certo e com o texto da copy;
- rosa só no que está vivo; verde em Entregue., PRONTO e RETOMADO; âmbar só no LIMITE;
- no máximo 3 glitches (saída de RECEBA., saída do failover, saída do FALE.);
- VT323 só em "SISTEMA ONLINE" e na linha final;
- nenhuma fonte de fallback (serifada ou Arial) em lugar nenhum;
- o HUD sempre legível, com o capítulo e o timecode certos.
Anote cada defeito com quadro e capítulo, corrija, rode `npm run build:all` de novo e repita até não sobrar defeito.

- [ ] **Step 3: Áreas das plataformas**

Run: `DEBUG_SAFE=1 scripts/stills.sh final-safe 45 290 425 600 780 880 990 1030 1115 1237`
Expected: em `out/stills/final-safe-sheet.png`, nenhum texto essencial dentro das faixas vermelhas.

- [ ] **Step 4: README do projeto**

`README.md`:

```markdown
# Reel do Nexus (9:16, PT-BR)

Vídeo de 20,6 s para Reels / Shorts / TikTok, feito em Remotion. Spec e plano no nexus-ide:
`docs/superpowers/specs/2026-09-25-nexus-reel-design.md` e `docs/superpowers/plans/2026-09-25-nexus-reel.md`.

## Entregáveis (`out/`)

- `nexus-reel-ptbr.mp4` — com trilha e efeitos, -14 LUFS
- `nexus-reel-ptbr-mudo.mp4` — sem faixa de áudio (para usar um som do próprio app)
- `nexus-reel-capa.png` — capa (tela final)

## Trocar um texto e renderizar de novo

1. Edite `src/copy.ts` (todos os textos estão lá).
2. `npm test` (confere área segura, pontos finais e afirmações proibidas).
3. `npm run build:all` (render, masterização e verificação).

## Comandos

- `npm run studio` — pré-visualização no Remotion Studio
- `scripts/stills.sh <nome> <quadro...>` — quadros soltos + painel (`DEBUG_SAFE=1` mostra as áreas das plataformas)
- `npm run measure-beats -- <audio> [--write]` — mede BPM e fase de uma trilha nova e grava `src/grid.json`

Licença do Remotion: grátis para pessoa física e empresa de até 3 funcionários (remotion.dev/license).
```

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "docs: README do reel e ajustes da revisão final"
git log --oneline | head -25
```

- [ ] **Step 6: Entregar ao operador**

Mostre ao operador: os caminhos dos três entregáveis, o painel `out/nexus-reel-sheet-01.png` (e seguintes), o JSON final do `verify` (duração, loudness, BPM, cortes) e os créditos da ElevenLabs gastos (Tasks 17 e 18).
