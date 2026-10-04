import type { PairStackJobTaskDto } from '@immich/sdk';
import { getPairStackJob, startPairStackJob } from '$lib/services/pair-stack-job.service';

export const DEFAULT_PAIR_STACK_CONCURRENCY = 32;
export const MIN_PAIR_STACK_CONCURRENCY = 1;
export const MAX_PAIR_STACK_CONCURRENCY = 64;
const POLL_INTERVAL_MS = 2000;

export class PairStackJobManager {
  #task = $state<PairStackJobTaskDto | null>(null);
  #runnerAvailable = $state<boolean | undefined>();
  #refreshing = $state(false);
  #pollingInterval?: ReturnType<typeof setInterval>;
  #listenerCount = 0;
  #requestInFlight = false;

  get task() {
    return this.#task;
  }

  get runnerAvailable() {
    return this.#runnerAvailable;
  }

  get refreshing() {
    return this.#refreshing;
  }

  listen() {
    this.#listenerCount++;
    if (!this.#pollingInterval) {
      this.#pollingInterval = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    }

    void this.refresh();

    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }

      stopped = true;
      this.#listenerCount = Math.max(0, this.#listenerCount - 1);
      if (this.#listenerCount === 0 && this.#pollingInterval) {
        clearInterval(this.#pollingInterval);
        this.#pollingInterval = undefined;
      }
    };
  }

  async refresh() {
    if (this.#requestInFlight) {
      return;
    }

    this.#requestInFlight = true;
    this.#refreshing = true;
    try {
      const response = await getPairStackJob();
      this.#task = response.task;
      this.#runnerAvailable = true;
    } catch {
      // The pair-stack card is optional; an unavailable runner must not affect native queue loading.
      this.#runnerAvailable = false;
    } finally {
      this.#refreshing = false;
      this.#requestInFlight = false;
    }
  }

  async stack(concurrency: number) {
    return this.#submit(crypto.randomUUID(), concurrency);
  }

  async resume(task: PairStackJobTaskDto) {
    return this.#submit(task.requestId, task.concurrency);
  }

  async #submit(requestId: string, concurrency: number) {
    const response = await startPairStackJob({ requestId, concurrency });
    this.#task = response.task;
    this.#runnerAvailable = true;
    return response;
  }
}

export const pairStackJobManager = new PairStackJobManager();
