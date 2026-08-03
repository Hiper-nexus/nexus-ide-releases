import { describe, expect, it } from "vitest";
import {
  storiesForWavePackTemplate,
  WAVE_PACK_TEMPLATE_IDS,
  WAVE_PACK_TEMPLATES,
  wavePackTemplateById,
} from "./wave-pack-templates";

describe("wave-pack-templates", () => {
  it("exposes stable Landing / SaaS / Fix ids", () => {
    expect(WAVE_PACK_TEMPLATE_IDS).toEqual(["landing", "saas", "fix"]);
    expect(WAVE_PACK_TEMPLATES.map((t) => t.id)).toEqual([
      "landing",
      "saas",
      "fix",
    ]);
  });

  it("declares fan-out of at least 2 stories per template", () => {
    expect(storiesForWavePackTemplate("landing")).toHaveLength(3);
    expect(storiesForWavePackTemplate("saas")).toHaveLength(5);
    expect(storiesForWavePackTemplate("fix")).toHaveLength(2);
    for (const template of WAVE_PACK_TEMPLATES) {
      expect(template.stories.length).toBeGreaterThanOrEqual(2);
      expect(wavePackTemplateById(template.id).label).toBe(template.label);
      for (const story of template.stories) {
        expect(story.id).toMatch(/^story-\d+-\d+$/);
        expect(story.title.length).toBeGreaterThan(0);
        expect(story.body.length).toBeGreaterThan(0);
      }
    }
  });
});
