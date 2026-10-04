import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PairStackJobService } from 'src/services/pair-stack-job.service';
import { mockEnvData, newConfigRepositoryMock } from 'test/repositories/config.repository.mock';
import { factory } from 'test/small.factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runnerUrl = 'http://127.0.0.1:3031/';
const controlToken = 'server-control-token';

const runnerTask = (overrides: Record<string, unknown> = {}) => ({
  schema: 'IMMICH_PAIR_STACK_TASK_STATUS_V1',
  taskId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  status: 'RUNNING',
  phase: 'STACKING',
  concurrency: 32,
  startedAt: '2026-09-14T08:00:00.000Z',
  updatedAt: '2026-09-14T08:01:00.000Z',
  progress: { determinate: true, current: 2, total: 4, percent: 50 },
  counts: {
    prepared: 4,
    dispatchIntent: 2,
    acknowledged: 2,
    uncertain: 0,
    committed: 2,
    blocked: 0,
    unattributed: 0,
    drifted: 0,
    posts: 2,
  },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) => Response.json(body, { status });

describe(PairStackJobService.name, () => {
  const config = newConfigRepositoryMock();
  let sut: PairStackJobService;

  beforeEach(() => {
    config.getEnv.mockReturnValue(mockEnvData({ pairStack: { runnerUrl, controlToken } }));
    sut = new PairStackJobService(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies current status with the control token and a secret-free response', async () => {
    const rawTask = runnerTask({
      error: {
        kind: 'BLOCKED',
        code: 'PAIR_STACK_BLOCKED',
        message: 'secret-control-token /private/plan.json',
        recoverable: false,
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ task: rawTask }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await sut.get(factory.auth());

    expect(response.task).toMatchObject({
      id: rawTask.taskId,
      requestId: rawTask.requestId,
      status: rawTask.status,
      phase: rawTask.phase,
      error: {
        kind: 'BLOCKED',
        code: 'PAIR_STACK_BLOCKED',
        recoverable: false,
        message: 'The pair-stack task is blocked and needs manual review',
      },
    });
    expect(response.task).not.toHaveProperty('taskId');
    expect(JSON.stringify(response)).not.toContain(controlToken);
    expect(JSON.stringify(response)).not.toContain('/private/plan.json');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).toMatch(/^http:\/\/127\.0\.0\.1:3031\/v1\//);
      expect(new Headers(init?.headers).get('X-Immich-Pair-Control')).toBe(controlToken);
      expect(init?.body).toBeUndefined();
    }
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${runnerUrl}v1/health`);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${runnerUrl}v1/tasks/current`);
  });

  it('accepts the exact runner PairStackTaskStatusSnapshot shape and adapts its fields', async () => {
    const rawTask = runnerTask({
      status: 'SUCCEEDED',
      phase: 'FINALIZING',
      counts: { ...runnerTask().counts, posts: 7 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(rawTask));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sut.get(factory.auth())).resolves.toEqual({
      task: {
        id: rawTask.taskId,
        requestId: rawTask.requestId,
        status: rawTask.status,
        phase: rawTask.phase,
        concurrency: rawTask.concurrency,
        startedAt: new Date(rawTask.startedAt),
        updatedAt: new Date(rawTask.updatedAt),
        finishedAt: null,
        progress: { ...rawTask.progress, posts: 7 },
        counts: {
          prepared: rawTask.counts.prepared,
          dispatchIntent: rawTask.counts.dispatchIntent,
          acknowledged: rawTask.counts.acknowledged,
          uncertain: rawTask.counts.uncertain,
          committed: rawTask.counts.committed,
          blocked: rawTask.counts.blocked,
          unattributed: rawTask.counts.unattributed,
          drifted: rawTask.counts.drifted,
        },
        error: null,
      },
    });
  });

  it('binds ownerId from AuthDto and defaults concurrency to 32', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: runnerTask() }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const auth = factory.auth({ user: { id: ownerId } });

    const result = await sut.create(auth, {
      requestId: runnerTask().requestId,
      concurrency: undefined,
      ownerId: '44444444-4444-4444-8444-444444444444',
    } as any);

    expect(result.status).toBe(202);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      requestId: runnerTask().requestId,
      ownerId,
      concurrency: 32,
    });
    expect(JSON.stringify(fetchMock.mock.calls[0][1].body)).not.toContain(controlToken);
  });

  it('maps an idempotent runner response to HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: runnerTask() }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sut.create(factory.auth(), {
        requestId: runnerTask().requestId,
        concurrency: 64,
      }),
    ).resolves.toMatchObject({ status: 200, response: { task: { concurrency: 32 } } });
  });

  it('returns no task when the runner has no current task', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sut.get(factory.auth())).resolves.toEqual({ task: null });
  });

  it('maps runner conflicts without exposing the runner response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('control-token and /private/path', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sut.create(factory.auth(), { requestId: runnerTask().requestId, concurrency: 1 })).rejects.toEqual(
      expect.any(ConflictException),
    );
  });

  it('maps runner failures to a scoped 503 without leaking error details', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`fetch failed with ${controlToken} /private/path`));
    vi.stubGlobal('fetch', fetchMock);

    const error = await sut
      .create(factory.auth(), { requestId: runnerTask().requestId, concurrency: 1 })
      .catch((error_) => error_);

    expect(error).toEqual(expect.any(ServiceUnavailableException));
    expect(JSON.stringify(error)).not.toContain(controlToken);
    expect(JSON.stringify(error)).not.toContain('/private/path');
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: 'PAIR_STACK_RUNNER_UNAVAILABLE',
      message: 'Pair-stack runner is unavailable',
    });
  });

  it('does not call the runner when server-side configuration is incomplete', async () => {
    config.getEnv.mockReturnValue(mockEnvData({ pairStack: { runnerUrl, controlToken: undefined } }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sut.get(factory.auth())).rejects.toEqual(expect.any(ServiceUnavailableException));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
