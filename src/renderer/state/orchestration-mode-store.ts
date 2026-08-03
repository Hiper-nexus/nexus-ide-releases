/**
 * Choice dialog for Pack vs Guiado before plan→code promotion.
 * Substantive topology choice — not a cosmetic confirm in front of native review.
 */
import { create } from "zustand";
import type { MissionOrchestrationMode } from "../../shared/mission-wave-pack";

export type PromoteOrchestrationChoice = Extract<
  MissionOrchestrationMode,
  "pack" | "guided"
>;

export interface OrchestrationModeRequest {
  readonly title: string;
  readonly body: string;
  readonly storyCount: number;
  readonly recommended: PromoteOrchestrationChoice;
}

interface PendingChoice extends OrchestrationModeRequest {
  resolve(choice: PromoteOrchestrationChoice | null): void;
}

interface OrchestrationModeStore {
  pending: PendingChoice | null;
  queue: PendingChoice[];
  ask(request: OrchestrationModeRequest): Promise<PromoteOrchestrationChoice | null>;
  decide(choice: PromoteOrchestrationChoice | null): void;
}

export const useOrchestrationModeStore = create<OrchestrationModeStore>(
  (set, get) => ({
    pending: null,
    queue: [],
    ask: (request) =>
      new Promise<PromoteOrchestrationChoice | null>((resolve) => {
        const entry: PendingChoice = { ...request, resolve };
        const { pending, queue } = get();
        if (pending) set({ queue: [...queue, entry] });
        else set({ pending: entry });
      }),
    decide: (choice) => {
      const { pending, queue } = get();
      if (!pending) return;
      const [next, ...rest] = queue;
      set({ pending: next ?? null, queue: rest });
      pending.resolve(choice);
    },
  }),
);

export function askPromoteOrchestrationMode(
  request: OrchestrationModeRequest,
): Promise<PromoteOrchestrationChoice | null> {
  return useOrchestrationModeStore.getState().ask(request);
}
