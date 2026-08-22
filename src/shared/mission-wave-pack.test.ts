import { describe, expect, it } from "vitest";
import {
  assertWavePackStoriesReady,
  assertWavePackStoryFilesDisjoint,
  decomposeGoalByRepositoryAreas,
  decomposeGuidedGoalIntoStories,
  extractStoriesFromPromotedPlanSummary,
  extractStoryOwnershipFiles,
  freezeWavePackStoriesForContract,
  hasWavePackDisjointFilesDomain,
  hasWavePackDomain,
  MAX_WAVE_PACK_STORIES,
  planWavePackTasks,
  resolveMissionOrchestrationMode,
  resolveWavePackStories,
  topologyForOrchestrationMode,
  WAVE_PACK_DISJOINT_FILES_DOMAIN,
  WAVE_PACK_DOMAIN,
  wavePackStoryDomain,
  type ExtractedWavePackStory,
} from "./mission-wave-pack";
import { storiesForWavePackTemplate } from "./wave-pack-templates";

const SAMPLE_PLAN = `
# Plano

## Epic 1: Auth

### Story 1.1: Login form

As a user,
I want to log in,
So that I reach the app.

### Story 1.2: Session refresh

As a user,
I want silent refresh,
So that I stay signed in.

## Epic 2: Billing

### Story 2.1: Checkout PIX

As a buyer,
I want PIX checkout,
So that I can pay.
`;

describe("extractStoriesFromPromotedPlanSummary", () => {
  it("parses BMAD Story N.M headings in order", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    expect(stories).toHaveLength(3);
    expect(stories[0]).toMatchObject({
      id: "story-1-1",
      epicStoryId: "1.1",
      title: "Login form",
    });
    expect(stories[0]!.body).toContain("As a user");
    expect(stories[2]).toMatchObject({
      epicStoryId: "2.1",
      title: "Checkout PIX",
    });
  });

  it("returns empty when the plan has no story headings", () => {
    expect(
      extractStoriesFromPromotedPlanSummary("# só um PRD sem stories"),
    ).toEqual([]);
  });
});

describe("resolveWavePackStories", () => {
  it("prefers structured contract stories over markdown", () => {
    const structured = storiesForWavePackTemplate("fix");
    const stories = resolveWavePackStories({
      wavePackStories: structured,
      promotedPlanSummary: SAMPLE_PLAN,
    });
    expect(stories).toHaveLength(2);
    expect(stories[0]!.title).toBe("Reproduzir e corrigir");
  });

  it("falls back to markdown when structured stories are absent", () => {
    expect(
      resolveWavePackStories({ promotedPlanSummary: SAMPLE_PLAN }),
    ).toHaveLength(3);
  });
});

describe("freezeWavePackStoriesForContract", () => {
  it("keeps markdown when no template is chosen", () => {
    const frozen = freezeWavePackStoriesForContract({
      summary: SAMPLE_PLAN,
    });
    expect(frozen).toHaveLength(3);
    expect(frozen[0]!.title).toBe("Login form");
  });

  it("prefers explicit template over markdown stories", () => {
    const frozen = freezeWavePackStoriesForContract({
      summary: SAMPLE_PLAN,
      templateId: "landing",
    });
    expect(frozen).toHaveLength(3);
    expect(frozen[0]!.title).toBe("Hero e estrutura da página");
  });

  it("fills from template when markdown is thin", () => {
    const frozen = freezeWavePackStoriesForContract({
      summary: "# plano sem stories BMAD",
      templateId: "saas",
    });
    expect(frozen).toHaveLength(5);
    expect(frozen[0]!.title).toBe("Auth mínima");
  });
});

describe("resolveMissionOrchestrationMode", () => {
  it("selects pack for promoted multi-story normal risk", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
      }),
    ).toBe("pack");
  });

  it("keeps guided for destructive even with many stories", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "destructive",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
      }),
    ).toBe("guided");
  });

  it("falls back to guided for a single story", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 1,
      }),
    ).toBe("guided");
  });

  it("honors forced mode", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: true,
        extractedStoryCount: 7,
        forcedMode: "guided",
      }),
    ).toBe("guided");
  });

  it("maps forced guided with ≥2 stories to delivery topology", () => {
    const mode = resolveMissionOrchestrationMode({
      risk: "normal",
      hasPromotedPlan: true,
      extractedStoryCount: 3,
      forcedMode: "guided",
    });
    expect(mode).toBe("guided");
    expect(topologyForOrchestrationMode(mode)).toBe("delivery");
  });

  it("maps forced pack with ≥2 stories to wave-pack topology", () => {
    const mode = resolveMissionOrchestrationMode({
      risk: "normal",
      hasPromotedPlan: true,
      extractedStoryCount: 3,
      forcedMode: "pack",
    });
    expect(mode).toBe("pack");
    expect(topologyForOrchestrationMode(mode)).toBe("wave-pack");
  });

  it("keeps guided for destructive even when Pack is forced", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "destructive",
        hasPromotedPlan: true,
        extractedStoryCount: 3,
        forcedMode: "pack",
      }),
    ).toBe("guided");
  });

  it("does not auto-pack structured stories without a promoted plan", () => {
    expect(
      resolveMissionOrchestrationMode({
        risk: "normal",
        hasPromotedPlan: false,
        extractedStoryCount: 5,
      }),
    ).toBe("guided");
  });
});

describe("planWavePackTasks", () => {
  it("fans out all stories with ownership files and optional QA", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    const planned = planWavePackTasks({
      missionTitle: "Auth + Billing",
      goal: "Entregar auth e checkout",
      acceptanceCriteria: ["Login funciona", "PIX funciona"],
      stories,
      executors: [
        { id: "dev-a", agentName: "Dev A", category: "executor" },
        { id: "dev-b", agentName: "Dev B", category: "executor" },
      ],
      qualityGate: { id: "qa-1", agentName: "QA", category: "reviewer" },
      maxWorkers: 2,
      ownershipFiles: ["src/", "docs/"],
      ownershipCoverageDomains: ["repository-coverage"],
    });

    // maxWorkers is wave concurrency, not a story drop.
    expect(planned).toHaveLength(4);
    expect(planned[0]!.agentRef).toBe("dev-a");
    expect(planned[1]!.agentRef).toBe("dev-b");
    expect(planned[2]!.agentRef).toBe("dev-a");
    expect(planned[0]!.ownership.files).toEqual(["src/", "docs/"]);
    expect(planned[0]!.ownership.domains).toContain("repository-coverage");
    expect(planned.slice(0, 3).every((task) => task.dependsOn.length === 0)).toBe(
      true,
    );
    expect(planned[3]).toMatchObject({
      plannerId: "wave-pack-quality-gate",
      category: "reviewer",
      executionMode: "read_only",
    });
    expect(planned[3]!.dependsOn).toEqual([
      planned[0]!.plannerId,
      planned[1]!.plannerId,
      planned[2]!.plannerId,
    ]);
    for (const storyTask of planned.slice(0, 3)) {
      expect(hasWavePackDomain(storyTask.ownership.domains)).toBe(true);
      expect(storyTask.ownership.domains).toContain(WAVE_PACK_DOMAIN);
      expect(storyTask.executionMode).toBe("isolated_worktree");
      expect(storyTask.plannerId.startsWith("wave-pack-")).toBe(true);
    }
  });

  it("rejects empty ownership", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    expect(() =>
      planWavePackTasks({
        missionTitle: "Cap",
        goal: "cap",
        acceptanceCriteria: ["ok"],
        stories,
        executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
        maxWorkers: 12,
        ownershipFiles: [],
      }),
    ).toThrow(/wave_pack_ownership_missing/);
  });

  it("P0-9: seals 85 disjoint stories past the old 64 ceiling (drain-to-exhaustion)", () => {
    const stories: ExtractedWavePackStory[] = Array.from(
      { length: 85 },
      (_unused, index) => ({
        id: `story-1-${index + 1}`,
        epicStoryId: `1.${index + 1}`,
        title: `Story ${index + 1}`,
        body: `Toque somente src/gen/mod-${index + 1}.ts`,
        ownershipFiles: [`src/gen/mod-${index + 1}.ts`],
      }),
    );
    const planned = planWavePackTasks({
      missionTitle: "85 utils",
      goal: "Implemente 85 utilitários independentes",
      acceptanceCriteria: ["Todos os 85 entregues"],
      stories,
      executors: [
        { id: "dev-a", agentName: "Dev A", category: "executor" },
        { id: "dev-b", agentName: "Dev B", category: "executor" },
      ],
      qualityGate: { id: "qa-1", agentName: "QA", category: "reviewer" },
      // maxWorkers is a wave-concurrency hint, NOT a story cap: all 85 seal and
      // wait for slots. The old 64 ceiling would have thrown before this point.
      maxWorkers: 8,
      ownershipFiles: ["src/gen/"],
    });
    // 85 story writers + 1 QA gate — nothing dropped, nothing truncated.
    const storyTasks = planned.filter((entry) =>
      hasWavePackDisjointFilesDomain(entry.ownership.domains),
    );
    expect(storyTasks).toHaveLength(85);
    expect(planned).toHaveLength(86);
    expect(planned[85]!.plannerId).toBe("wave-pack-quality-gate");
    expect(planned[85]!.dependsOn).toHaveLength(85);
  });

  it("P0-9: fails CLOSED and visibly past MAX_WAVE_PACK_STORIES", () => {
    const stories: ExtractedWavePackStory[] = Array.from(
      { length: MAX_WAVE_PACK_STORIES + 1 },
      (_unused, index) => ({
        id: `story-1-${index + 1}`,
        epicStoryId: `1.${index + 1}`,
        title: `Story ${index + 1}`,
        body: `src/gen/mod-${index + 1}.ts`,
        ownershipFiles: [`src/gen/mod-${index + 1}.ts`],
      }),
    );
    expect(() =>
      planWavePackTasks({
        missionTitle: "too many",
        goal: "over the backstop",
        acceptanceCriteria: ["ok"],
        stories,
        executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
        maxWorkers: 8,
        ownershipFiles: ["src/gen/"],
      }),
    ).toThrow(
      new RegExp(
        `wave_pack_too_many_stories.*${MAX_WAVE_PACK_STORIES}.*${MAX_WAVE_PACK_STORIES + 1}`,
      ),
    );
  });

  it("maps mode to topology", () => {
    expect(topologyForOrchestrationMode("pack")).toBe("wave-pack");
    expect(topologyForOrchestrationMode("guided")).toBe("delivery");
    expect(
      topologyForOrchestrationMode("livre", "team-read-only-fanout"),
    ).toBe("team-read-only-fanout");
    expect(wavePackStoryDomain("story-1-2")).toBe("wave-pack-story:story-1-2");
  });
});

describe("wave-pack disjoint-file ownership (P0-3 fan-out)", () => {
  const disjointStories = [
    {
      id: "story-1-1",
      epicStoryId: "1.1",
      title: "Login form",
      body: "As a user",
      ownershipFiles: ["src/auth/login.ts", "src/auth/login.css"],
    },
    {
      id: "story-1-2",
      epicStoryId: "1.2",
      title: "Session refresh",
      body: "As a user",
      ownershipFiles: ["src/auth/session.ts"],
    },
    {
      id: "story-2-1",
      epicStoryId: "2.1",
      title: "Checkout PIX",
      body: "As a buyer",
      ownershipFiles: ["src/billing/checkout.ts"],
    },
  ];

  it("gives each declaring story its own disjoint files + disjoint marker", () => {
    const planned = planWavePackTasks({
      missionTitle: "Auth + Billing",
      goal: "Entregar auth e checkout",
      acceptanceCriteria: ["Login funciona", "PIX funciona"],
      stories: disjointStories,
      executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
      maxWorkers: 3,
      // Shared inventory is the merge permit; per-story files carve the writer.
      ownershipFiles: ["src/", "docs/"],
    });

    expect(planned).toHaveLength(3);
    expect(planned[0]!.ownership.files).toEqual([
      "src/auth/login.ts",
      "src/auth/login.css",
    ]);
    expect(planned[1]!.ownership.files).toEqual(["src/auth/session.ts"]);
    expect(planned[2]!.ownership.files).toEqual(["src/billing/checkout.ts"]);
    for (const task of planned) {
      expect(hasWavePackDomain(task.ownership.domains)).toBe(true);
      expect(hasWavePackDisjointFilesDomain(task.ownership.domains)).toBe(true);
      expect(task.ownership.domains).toContain(
        WAVE_PACK_DISJOINT_FILES_DOMAIN,
      );
    }
  });

  it("throws when two declaring stories claim the same file", () => {
    expect(() =>
      planWavePackTasks({
        missionTitle: "Collide",
        goal: "collide",
        acceptanceCriteria: ["ok"],
        stories: [
          {
            id: "story-a",
            epicStoryId: "1.1",
            title: "A",
            body: "a",
            ownershipFiles: ["src/shared/util.ts"],
          },
          {
            id: "story-b",
            epicStoryId: "1.2",
            title: "B",
            body: "b",
            // Same file, different path spelling — normalization must catch it.
            ownershipFiles: ["./src/shared/util.ts"],
          },
        ],
        executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
        maxWorkers: 2,
        ownershipFiles: ["src/"],
      }),
    ).toThrow(/wave_pack_story_files_overlap/);
  });

  it("keeps the shared-inventory merge-permit path (no marker) when stories omit files", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    const planned = planWavePackTasks({
      missionTitle: "Shared",
      goal: "shared",
      acceptanceCriteria: ["ok"],
      stories,
      executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
      maxWorkers: 3,
      ownershipFiles: ["src/", "docs/"],
    });
    for (const task of planned) {
      expect(task.ownership.files).toEqual(["src/", "docs/"]);
      expect(hasWavePackDisjointFilesDomain(task.ownership.domains)).toBe(
        false,
      );
    }
  });

  it("assertWavePackStoryFilesDisjoint is the fail-closed invariant", () => {
    const disjoint = [
      { plannerId: "wp-a", ownership: { files: ["src/a.ts"] } },
      { plannerId: "wp-b", ownership: { files: ["src/b.ts"] } },
    ];
    expect(() => assertWavePackStoryFilesDisjoint(disjoint)).not.toThrow();

    const overlapping = [
      { plannerId: "wp-a", ownership: { files: ["src/a.ts", "src/x.ts"] } },
      { plannerId: "wp-b", ownership: { files: ["src\\x.ts"] } },
    ];
    expect(() => assertWavePackStoryFilesDisjoint(overlapping)).toThrow(
      /wave_pack_story_files_overlap/,
    );
  });
});

describe("disjoint file producer (P0-3 seam A)", () => {
  const FILE_NAMING_PLAN = `
# Plano

## Epic 1: Utils

### Story 1.1: slugify

Implemente \`src/util/slugify.ts\` com teste em \`src/util/slugify.test.ts\`.

### Story 1.2: debounce

Crie src/util/debounce.ts e src/util/debounce.test.ts.

### Story 1.3: clamp

Adicione src/util/clamp.ts.
`;

  it("extracts a story's own file footprint from its body text", () => {
    expect(
      extractStoryOwnershipFiles(
        "Edite `src/util/slugify.ts` e src/util/slugify.test.ts.",
      ),
    ).toEqual(["src/util/slugify.ts", "src/util/slugify.test.ts"]);
    // Version-like tokens and bare words (no directory separator) are not files.
    expect(
      extractStoryOwnershipFiles("Story 1.1 usa node.js versão 3.2 sem arquivo."),
    ).toEqual([]);
    // Path-spelling is normalized (backslash → /, leading ./ stripped) + deduped.
    expect(
      extractStoryOwnershipFiles("toca .\\src\\a.ts, ./src/a.ts e src/a.ts"),
    ).toEqual(["src/a.ts"]);
  });

  it("emits per-story ownershipFiles parsed from each story body", () => {
    const stories = extractStoriesFromPromotedPlanSummary(FILE_NAMING_PLAN);
    expect(stories).toHaveLength(3);
    expect(stories[0]!.ownershipFiles).toEqual([
      "src/util/slugify.ts",
      "src/util/slugify.test.ts",
    ]);
    expect(stories[1]!.ownershipFiles).toEqual([
      "src/util/debounce.ts",
      "src/util/debounce.test.ts",
    ]);
    expect(stories[2]!.ownershipFiles).toEqual(["src/util/clamp.ts"]);
  });

  it("keeps the partition disjoint (first-owner-wins) when a file is named twice", () => {
    const plan = `
# P

### Story 1.1: A

Toca src/shared/util.ts e src/a.ts.

### Story 1.2: B

Também cita src/shared/util.ts, mas edita src/b.ts.
`;
    const stories = extractStoriesFromPromotedPlanSummary(plan);
    expect(stories[0]!.ownershipFiles).toEqual([
      "src/shared/util.ts",
      "src/a.ts",
    ]);
    // src/shared/util.ts already owned by story 1.1 → excluded from 1.2.
    expect(stories[1]!.ownershipFiles).toEqual(["src/b.ts"]);
  });

  it("omits ownershipFiles when a story names no files (shared-inventory fallback)", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SAMPLE_PLAN);
    for (const story of stories) {
      expect(story.ownershipFiles).toBeUndefined();
    }
  });

  it("feeds the consumer: a file-naming plan fans out N disjoint writers with the marker", () => {
    const stories = extractStoriesFromPromotedPlanSummary(FILE_NAMING_PLAN);
    const planned = planWavePackTasks({
      missionTitle: "Utils",
      goal: "utils independentes",
      acceptanceCriteria: ["cada util com teste"],
      stories,
      executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
      maxWorkers: 3,
      ownershipFiles: ["src/", "docs/"],
    });
    expect(planned).toHaveLength(3);
    expect(planned[0]!.ownership.files).toEqual([
      "src/util/slugify.ts",
      "src/util/slugify.test.ts",
    ]);
    expect(planned[2]!.ownership.files).toEqual(["src/util/clamp.ts"]);
    for (const task of planned) {
      expect(hasWavePackDisjointFilesDomain(task.ownership.domains)).toBe(true);
    }
  });
});

describe("decomposeGuidedGoalIntoStories (P0-8 NL fan-out)", () => {
  it("splits a file-naming NL goal into one disjoint story per file", () => {
    const stories = decomposeGuidedGoalIntoStories({
      goal:
        "Implemente uma biblioteca de utilitários: src/util/slugify.ts, " +
        "src/util/debounce.ts, src/util/clamp.ts. Cada história é isolada.",
    });
    expect(stories).toHaveLength(3);
    expect(stories.map((story) => story.ownershipFiles)).toEqual([
      ["src/util/slugify.ts"],
      ["src/util/debounce.ts"],
      ["src/util/clamp.ts"],
    ]);
    // Disjoint by construction — the core fan-out invariant must hold.
    expect(() =>
      assertWavePackStoryFilesDisjoint(
        stories.map((story) => ({
          plannerId: story.id,
          ownership: { files: story.ownershipFiles ?? [] },
        })),
      ),
    ).not.toThrow();
  });

  it("feeds planWavePackTasks a real disjoint wave (>1 concurrent writer)", () => {
    const stories = decomposeGuidedGoalIntoStories({
      goal:
        "Crie src/a.ts, src/b.ts e src/c.ts, cada um independente do outro.",
    });
    const planned = planWavePackTasks({
      missionTitle: "NL fan-out",
      goal: "três arquivos independentes",
      acceptanceCriteria: ["cada arquivo entregue"],
      stories,
      executors: [{ id: "dev", agentName: "Dev", category: "executor" }],
      maxWorkers: 4,
      ownershipFiles: ["src/"],
    });
    const storyTasks = planned.filter((task) =>
      hasWavePackDisjointFilesDomain(task.ownership.domains),
    );
    expect(storyTasks).toHaveLength(3);
    expect(storyTasks.every((task) => task.ownership.files.length === 1)).toBe(
      true,
    );
    expect(
      new Set(storyTasks.map((task) => task.ownership.files[0])).size,
    ).toBe(3);
  });

  it("keeps a goal that names fewer than 2 files single-writer (delivery)", () => {
    expect(
      decomposeGuidedGoalIntoStories({ goal: "corrija o bug no src/app.ts" }),
    ).toEqual([]);
    expect(
      decomposeGuidedGoalIntoStories({ goal: "melhore a performance geral" }),
    ).toEqual([]);
  });

  it("decomposes an 85+ file goal in full (well past the old 64 throttle)", () => {
    const files = Array.from(
      { length: 85 },
      (_v, index) => `src/gen/mod-${index}.ts`,
    ).join(", ");
    const stories = decomposeGuidedGoalIntoStories({ goal: `Crie ${files}` });
    expect(stories).toHaveLength(85);
    expect(stories.length).toBeGreaterThan(64);
    expect(stories.length).toBeLessThanOrEqual(MAX_WAVE_PACK_STORIES);
  });
});

describe("decomposeGoalByRepositoryAreas (prong b)", () => {
  const HIPERGO = [
    { id: "apps/web", files: ["apps/web/src/app.tsx"] },
    { id: "services/api", files: ["services/api/src/tenant.ts"] },
    { id: "packages/contracts", files: ["packages/contracts/src/t.ts"] },
  ];

  it("emite uma story por área, com ownership da própria área", () => {
    const stories = decomposeGoalByRepositoryAreas({
      goal: "mexe no apps/web, no services/api e no packages/contracts",
      areas: HIPERGO,
    });

    expect(stories).toHaveLength(3);
    expect(stories.map((s) => s.ownershipFiles?.[0])).toEqual([
      "apps/web/src/app.tsx",
      "services/api/src/tenant.ts",
      "packages/contracts/src/t.ts",
    ]);
  });

  it("stories são pairwise-disjuntas por construção", () => {
    const stories = decomposeGoalByRepositoryAreas({
      goal: "apps/web services/api packages/contracts",
      areas: HIPERGO,
    });
    const todos = stories.flatMap((s) => [...(s.ownershipFiles ?? [])]);

    expect(new Set(todos).size).toBe(todos.length);
  });

  it("UMA área não decompõe — devolve vazio e o caminho segue single-writer", () => {
    // Honestidade: objetivo que toca uma frente não vira leque fingido.
    expect(
      decomposeGoalByRepositoryAreas({ goal: "corrige o login", areas: [HIPERGO[0]!] }),
    ).toHaveLength(0);
  });

  it("sem áreas devolve vazio, sem inventar", () => {
    expect(decomposeGoalByRepositoryAreas({ goal: "x", areas: [] })).toHaveLength(0);
  });

  it("respeita o teto de stories seladas", () => {
    const muitas = Array.from({ length: MAX_WAVE_PACK_STORIES + 10 }, (_, i) => ({
      id: `packages/p${i}`,
      files: [`packages/p${i}/src/a.ts`],
    }));
    expect(
      decomposeGoalByRepositoryAreas({ goal: muitas.map((a) => a.id).join(" "), areas: muitas }).length,
    ).toBeLessThanOrEqual(MAX_WAVE_PACK_STORIES);
  });
});

describe("leque PARCIAL — uma incógnita não afunda o plano (06/08)", () => {
  const base = {
    missionTitle: "m",
    goal: "g",
    acceptanceCriteria: ["a"],
    executors: [{ id: "exec", agentName: "Exec", category: "executor" as const }],
    maxWorkers: 8,
    ownershipFiles: ["src/**"],
  };

  it("declaradas abrem em leque; a não-declarada serializa ATRÁS", () => {
    const tasks = planWavePackTasks({
      ...base,
      stories: [
        { id: "a", epicStoryId: "1.1", title: "A", body: "", ownershipFiles: ["src/a.ts"] },
        { id: "b", epicStoryId: "1.2", title: "B", body: "", ownershipFiles: ["src/b.ts"] },
        // sem ownership: incógnita
        { id: "c", epicStoryId: "1.3", title: "C", body: "" },
      ],
    });

    const disjuntas = tasks.filter((t) =>
      t.ownership.domains.includes(WAVE_PACK_DISJOINT_FILES_DOMAIN),
    );
    expect(disjuntas).toHaveLength(2);

    const incognita = tasks.find((t) => t.plannerId.includes("-c"));
    expect(incognita!.ownership.domains).toContain("sequential-only");
    // Ela recebe o inventário compartilhado: pode tocar qualquer coisa, então
    // toma slot exclusivo em vez de dividir onda com escritor declarado.
    expect(incognita!.ownership.files).toEqual(["src/**"]);
  });

  it("nenhuma declarada mantém o caminho legado (inventário compartilhado)", () => {
    const tasks = planWavePackTasks({
      ...base,
      stories: [
        { id: "a", epicStoryId: "1.1", title: "A", body: "" },
        { id: "b", epicStoryId: "1.2", title: "B", body: "" },
      ],
    });

    for (const task of tasks) {
      expect(task.ownership.domains).not.toContain(
        WAVE_PACK_DISJOINT_FILES_DOMAIN,
      );
    }
  });
});

describe("extractStoriesFromPromotedPlanSummary — formato Superpowers (### Task N:)", () => {
  const SUPERPOWERS_PLAN = `
# Plano de implementação

### Task 1: Criar o modelo de dados
- [ ] escreva src/models/order.ts com o schema
- [ ] verifique com npm run typecheck

### Task 2: Ligar o endpoint
- [ ] escreva src/routes/order.ts chamando o modelo
- [ ] verifique com npx vitest run src/routes/order.test.ts
`;

  it("fatia tasks ### Task N: como stories de epicStoryId 1.N", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SUPERPOWERS_PLAN);
    expect(stories.map((s) => s.epicStoryId)).toEqual(["1.1", "1.2"]);
    expect(stories[0]?.title).toBe("Criar o modelo de dados");
    expect(stories[1]?.title).toBe("Ligar o endpoint");
  });

  it("ownership por arquivo sai do corpo da task, primeiro dono vence", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SUPERPOWERS_PLAN);
    expect(stories[0]?.ownershipFiles).toEqual(["src/models/order.ts"]);
    expect(stories[1]?.ownershipFiles).toEqual([
      "src/routes/order.ts",
      "src/routes/order.test.ts",
    ]);
  });

  it("plano híbrido (Story BMAD + Task Superpowers) fatia em ordem de aparição", () => {
    const hybrid = `### Story 2.1: legado\n\nbody a\n\n### Task 3: novo\n\nbody b\n`;
    const stories = extractStoriesFromPromotedPlanSummary(hybrid);
    expect(stories.map((s) => s.epicStoryId)).toEqual(["2.1", "1.3"]);
    expect(stories[0]?.body).toBe("body a");
    expect(stories[1]?.body).toBe("body b");
  });

  it("assertWavePackStoriesReady aceita ≥2 tasks Superpowers", () => {
    const stories = extractStoriesFromPromotedPlanSummary(SUPERPOWERS_PLAN);
    expect(() =>
      assertWavePackStoriesReady(stories, "plano superpowers"),
    ).not.toThrow();
  });
});
