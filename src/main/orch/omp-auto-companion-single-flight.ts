/**
 * Prevents concurrent worker spawns from each scheduling their own automatic
 * Oh My Pi companion before the first companion reaches durable mission state.
 */
export class OmpAutoCompanionSingleFlight {
  readonly #active = new Set<string>();

  start(
    missionKey: string,
    task: () => Promise<void>,
    onError: (cause: unknown) => void,
  ): boolean {
    if (this.#active.has(missionKey)) return false;
    this.#active.add(missionKey);
    let flight: Promise<void>;
    try {
      flight = task();
    } catch (cause) {
      this.#active.delete(missionKey);
      onError(cause);
      return true;
    }
    void flight
      .catch(onError)
      .finally(() => {
        this.#active.delete(missionKey);
      });
    return true;
  }
}
