/** Bounds concurrent async work (agents, gate processes). FIFO, no priorities. */
export class Semaphore {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid semaphore limit ${limit}`);
    this.#available = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#available++;
  }
}
