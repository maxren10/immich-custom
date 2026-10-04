import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPairStackJob, startPairStackJob } from '$lib/services/pair-stack-job.service';
import { PairStackJobManager } from './pair-stack-job-manager.svelte';

vi.mock('$lib/services/pair-stack-job.service', () => ({
  getPairStackJob: vi.fn(),
  startPairStackJob: vi.fn(),
}));

describe('PairStackJobManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getPairStackJob).mockResolvedValue({ task: null });
    vi.mocked(startPairStackJob).mockResolvedValue({ task: null });
  });

  it('polls while subscribed and submits only the public request fields', async () => {
    const manager = new PairStackJobManager();
    const stop = manager.listen();

    await vi.waitFor(() => expect(getPairStackJob).toHaveBeenCalledTimes(1));
    await manager.stack(32);

    expect(startPairStackJob).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      concurrency: 32,
    });
    expect(JSON.stringify(vi.mocked(startPairStackJob).mock.calls[0][0])).not.toMatch(
      /api.?key|control.?token|owner.?id/i,
    );

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(getPairStackJob).toHaveBeenCalledTimes(2));
    stop();
    const callCountAfterStop = vi.mocked(getPairStackJob).mock.calls.length;

    await vi.advanceTimersByTimeAsync(6000);
    expect(getPairStackJob).toHaveBeenCalledTimes(callCountAfterStop);
    vi.useRealTimers();
  });
});
