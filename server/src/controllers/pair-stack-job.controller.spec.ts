import { PairStackJobController } from 'src/controllers/pair-stack-job.controller';
import { PairStackJobService } from 'src/services/pair-stack-job.service';
import request from 'supertest';
import { factory } from 'test/small.factory';
import { ControllerContext, controllerSetup } from 'test/utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe(PairStackJobController.name, () => {
  let ctx: ControllerContext;
  const service = {
    get: vi.fn(),
    create: vi.fn(),
  };

  beforeAll(async () => {
    ctx = await controllerSetup(PairStackJobController, [{ provide: PairStackJobService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ctx.reset();
  });

  it('protects GET /jobs/stack with authentication', async () => {
    service.get.mockResolvedValue({ task: null });

    await request(ctx.getHttpServer()).get('/jobs/stack');

    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it('returns the current task from GET /jobs/stack', async () => {
    const auth = factory.auth({ user: { isAdmin: true } });
    ctx.authenticate.mockResolvedValue(auth);
    service.get.mockResolvedValue({ task: null });

    const { status, body } = await request(ctx.getHttpServer()).get('/jobs/stack');

    expect(status).toBe(200);
    expect(body).toEqual({ task: null });
    expect(service.get).toHaveBeenCalledWith(auth);
  });

  it('protects POST /jobs/stack, defaults concurrency, and ignores browser ownerId', async () => {
    const auth = factory.auth({ user: { id: '33333333-3333-4333-8333-333333333333', isAdmin: true } });
    const requestId = '22222222-2222-4222-8222-222222222222';
    ctx.authenticate.mockResolvedValue(auth);
    service.create.mockResolvedValue({ status: 202, response: { task: null } });

    const { status, body } = await request(ctx.getHttpServer())
      .post('/jobs/stack')
      .send({ requestId, ownerId: '44444444-4444-4444-8444-444444444444' });

    expect(status).toBe(202);
    expect(body).toEqual({ task: null });
    expect(service.create).toHaveBeenCalledWith(auth, { requestId, concurrency: 32 });
  });

  it('preserves HTTP 200 for an idempotent POST /jobs/stack', async () => {
    const auth = factory.auth({ user: { isAdmin: true } });
    const requestId = '22222222-2222-4222-8222-222222222222';
    ctx.authenticate.mockResolvedValue(auth);
    service.create.mockResolvedValue({ status: 200, response: { task: null } });

    const { status } = await request(ctx.getHttpServer()).post('/jobs/stack').send({ requestId, concurrency: 64 });

    expect(status).toBe(200);
    expect(service.create).toHaveBeenCalledWith(auth, { requestId, concurrency: 64 });
  });

  it.each([0, 65, 1.5])('rejects invalid concurrency %s', async (concurrency) => {
    const auth = factory.auth({ user: { isAdmin: true } });
    ctx.authenticate.mockResolvedValue(auth);

    const { status } = await request(ctx.getHttpServer())
      .post('/jobs/stack')
      .send({ requestId: '22222222-2222-4222-8222-222222222222', concurrency });

    expect(status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
});
