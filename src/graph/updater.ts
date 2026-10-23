/**
 * Serialised, coalesced graph updates (ADR-0007). Every merge requests an update for its
 * merge sequence number; while one runs, further requests collapse into a single follow-up
 * update. `waitFor(seq)` resolves once an update that started after merge `seq` finished,
 * so a task that depends on merged work queries a graph that contains it.
 */
export class GraphUpdater {
  #covered: number;
  #requested: number;
  #running: Promise<void> | undefined;
  readonly #waiters: { seq: number; resolve: () => void }[] = [];

  constructor(
    /** Runs one update; failures are the callback's to report (the sequence still counts as covered). */
    readonly update: () => Promise<unknown>,
    covered = 0,
    readonly onCovered?: (seq: number) => Promise<void> | void,
  ) {
    this.#covered = covered;
    this.#requested = covered;
  }

  get covered(): number {
    return this.#covered;
  }

  request(seq: number): void {
    this.#requested = Math.max(this.#requested, seq);
    this.#running ??= this.#loop();
  }

  async #loop(): Promise<void> {
    try {
      while (this.#requested > this.#covered) {
        const target = this.#requested;
        try {
          await this.update();
        } catch {
          // The update callback reports its own failures; the merge still counts as covered.
        } finally {
          this.#covered = target;
          await this.onCovered?.(target);
          for (const w of this.#waiters.filter((x) => x.seq <= target)) w.resolve();
          this.#waiters.splice(
            0,
            this.#waiters.length,
            ...this.#waiters.filter((x) => x.seq > target),
          );
        }
      }
    } finally {
      this.#running = undefined;
    }
  }

  waitFor(seq: number): Promise<void> {
    if (seq <= this.#covered) return Promise.resolve();
    this.request(seq);
    return new Promise((resolve) => this.#waiters.push({ seq, resolve }));
  }

  /** Resolves when no update is running or pending. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }
}
