import { describe, expect, it } from 'vitest';
import {
  missionPrepareRequestSchema,
  missionReviewSchema,
} from './mission-engine-contract';
import { PET_STUDIO_SQUAD } from './pet-studio';

const referenceImagePath =
  '/workspace/.nexus/attachments/pet-studio/cat-source.png';

const petPrepareRequest = {
  objective: 'Criar um pet Nexus a partir da imagem revisada.',
  title: 'Criar pet cat-source',
  contextPaths: [],
  roster: PET_STUDIO_SQUAD.agents,
  advanced: { lane: 'standard' as const },
  profile: {
    kind: 'pet-studio' as const,
    referenceImagePath,
  },
};

const attachment = {
  path: referenceImagePath,
  sha256: 'b'.repeat(64),
  size: 4_096,
};

describe('Pet Studio mission facade contract', () => {
  it('carries only the exact discriminated Pet image profile through prepare', () => {
    expect(missionPrepareRequestSchema.parse(petPrepareRequest)).toEqual(
      petPrepareRequest,
    );

    for (const profile of [
      { kind: 'pet-studio' },
      { kind: 'pet-studio', referenceImagePath, squadId: 'forged-squad' },
      { kind: 'pet-studio', referenceImagePath, allowDelegation: true },
      { kind: 'ordinary', referenceImagePath },
    ]) {
      expect(
        missionPrepareRequestSchema.safeParse({
          ...petPrepareRequest,
          profile,
        }).success,
      ).toBe(false);
    }
  });

  it('returns the exact governed attachment snapshot in the rendered review contract', () => {
    const review = {
      missionId: 'mission-pet-reviewed',
      title: petPrepareRequest.title,
      objective: petPrepareRequest.objective,
      workspaceLabel: 'workspace',
      contextPaths: [],
      roster: PET_STUDIO_SQUAD.agents,
      attachments: [attachment],
      permissions: [
        {
          id: 'pet-image-generation',
          label: 'Gerar imagens para este pet',
          detail: 'Somente pela skill nexus-pet-studio na sessão Codex revisada.',
        },
      ],
      warnings: ['A execução permanece em uma única sessão, sem delegação.'],
      reviewSha256: 'c'.repeat(64),
      createdAt: 1_786_000_000_000,
    };

    expect(missionReviewSchema.parse(review)).toEqual(review);
    expect(
      missionReviewSchema.safeParse({
        ...review,
        attachments: [{ ...attachment, sha256: 'not-a-snapshot' }],
      }).success,
    ).toBe(false);
  });
});
