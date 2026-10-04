import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  PairStackJobCreateDto,
  PairStackJobCreateSchema,
  PairStackJobPhaseSchema,
  PairStackJobResponse,
  PairStackJobResponseDto,
  PairStackJobStatusSchema,
  PairStackJobTask,
  PairStackJobTaskSchema,
} from 'src/dtos/pair-stack-job.dto';
import { ConfigRepository } from 'src/repositories/config.repository';
import z from 'zod';

const RUNNER_TIMEOUT_MS = 5000;
const CONTROL_HEADER = 'X-Immich-Pair-Control';
const UNAVAILABLE_MESSAGE = 'Pair-stack runner is unavailable';

const RunnerTaskSchema = z
  .object({
    schema: z.literal('IMMICH_PAIR_STACK_TASK_STATUS_V1'),
    taskId: z.string(),
    requestId: z.string(),
    status: PairStackJobStatusSchema,
    phase: PairStackJobPhaseSchema,
    concurrency: z.number().int().min(1).max(64),
    startedAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().optional(),
    progress: z
      .object({
        determinate: z.boolean(),
        current: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        percent: z.number().min(0).max(100).nullable(),
      })
      .strict(),
    counts: z
      .object({
        prepared: z.number().int().nonnegative(),
        dispatchIntent: z.number().int().nonnegative(),
        acknowledged: z.number().int().nonnegative(),
        uncertain: z.number().int().nonnegative(),
        committed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        unattributed: z.number().int().nonnegative(),
        drifted: z.number().int().nonnegative(),
        posts: z.number().int().nonnegative(),
      })
      .strict(),
    error: z
      .object({
        kind: z.enum([
          'AUTHENTICATION',
          'PERMISSION',
          'VALIDATION',
          'NETWORK',
          'SCHEMA',
          'BLOCKED',
          'DRIFTED',
          'UNATTRIBUTED',
          'CONFLICT',
          'INTERNAL',
        ]),
        code: z.string(),
        message: z.string(),
        recoverable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

type PairStackJobCreateResult = {
  status: HttpStatus.OK | HttpStatus.ACCEPTED;
  response: PairStackJobResponseDto;
};

const taskErrorMap = {
  BLOCKED: {
    kind: 'BLOCKED' as const,
    code: 'PAIR_STACK_BLOCKED' as const,
    message: 'The pair-stack task is blocked and needs manual review',
    recoverable: false,
  },
  DRIFTED: {
    kind: 'DRIFTED' as const,
    code: 'PAIR_STACK_DRIFTED' as const,
    message: 'The pair-stack task detected source drift and needs manual review',
    recoverable: false,
  },
  UNATTRIBUTED: {
    kind: 'UNATTRIBUTED' as const,
    code: 'PAIR_STACK_UNATTRIBUTED' as const,
    message: 'The pair-stack task has unattributed operations and needs manual review',
    recoverable: false,
  },
  RUNNER_UNAVAILABLE: {
    kind: 'RUNNER' as const,
    code: 'PAIR_STACK_RUNNER_UNAVAILABLE' as const,
    message: UNAVAILABLE_MESSAGE,
    recoverable: true,
  },
  RUNNER_REJECTED: {
    kind: 'RUNNER' as const,
    code: 'PAIR_STACK_RUNNER_REJECTED' as const,
    message: 'Pair-stack runner rejected the request',
    recoverable: false,
  },
  FAILED: {
    kind: 'INTERNAL' as const,
    code: 'PAIR_STACK_FAILED' as const,
    message: 'The pair-stack task failed',
    recoverable: true,
  },
} as const;

const runnerErrorKey = new Set(Object.keys(taskErrorMap));

@Injectable()
export class PairStackJobService {
  constructor(private configRepository: ConfigRepository) {}

  async get(_auth: AuthDto): Promise<PairStackJobResponseDto> {
    await this.request('v1/health', { method: 'GET' });

    const response = await this.request('v1/tasks/current', { method: 'GET' }, { allowNotFound: true });
    if (response === null) {
      return { task: null };
    }

    return this.toPublicResponse(await this.readJson(response));
  }

  async create(auth: AuthDto, dto: PairStackJobCreateDto): Promise<PairStackJobCreateResult> {
    const parsed = PairStackJobCreateSchema.safeParse(dto);
    if (!parsed.success) {
      throw new BadRequestException('Invalid pair-stack job request');
    }

    const response = await this.request('v1/tasks', {
      method: 'POST',
      body: JSON.stringify({
        requestId: parsed.data.requestId,
        ownerId: auth.user.id,
        concurrency: parsed.data.concurrency,
      }),
    });
    if (response === null) {
      throw this.runnerUnavailable();
    }

    if (response.status !== HttpStatus.OK && response.status !== HttpStatus.ACCEPTED) {
      throw this.runnerUnavailable();
    }

    return {
      status: response.status,
      response: this.toPublicResponse(await this.readJson(response)),
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    options: { allowNotFound?: boolean } = {},
  ): Promise<Response | null> {
    const { runnerUrl, controlToken } = this.configRepository.getEnv().pairStack;
    if (!runnerUrl || !controlToken) {
      throw this.runnerUnavailable();
    }

    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set(CONTROL_HEADER, controlToken);
    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      const response = await fetch(new URL(path, runnerUrl), {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
      });

      if (response.status === HttpStatus.NOT_FOUND && options.allowNotFound) {
        return null;
      }

      if (!response.ok) {
        throw this.mapRunnerHttpError(response.status);
      }

      return response;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw this.runnerUnavailable();
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw this.runnerUnavailable();
    }
  }

  private toPublicResponse(body: unknown): PairStackJobResponse {
    const rawTask = this.getRawTask(body);
    if (rawTask === null) {
      return { task: null };
    }

    const task = RunnerTaskSchema.safeParse(rawTask);
    if (!task.success) {
      throw this.runnerUnavailable();
    }

    const mapped = PairStackJobTaskSchema.safeParse({
      id: task.data.taskId,
      requestId: task.data.requestId,
      status: task.data.status,
      phase: task.data.phase,
      concurrency: task.data.concurrency,
      startedAt: task.data.startedAt,
      updatedAt: task.data.updatedAt,
      finishedAt: task.data.finishedAt ?? null,
      progress: {
        determinate: task.data.progress.determinate,
        current: task.data.progress.current,
        total: task.data.progress.total,
        percent: task.data.progress.percent,
        posts: task.data.counts.posts,
      },
      counts: {
        prepared: task.data.counts.prepared,
        dispatchIntent: task.data.counts.dispatchIntent,
        acknowledged: task.data.counts.acknowledged,
        uncertain: task.data.counts.uncertain,
        committed: task.data.counts.committed,
        blocked: task.data.counts.blocked,
        unattributed: task.data.counts.unattributed,
        drifted: task.data.counts.drifted,
      },
      error: this.mapTaskError(task.data.error),
    });
    if (!mapped.success) {
      throw this.runnerUnavailable();
    }

    return { task: mapped.data };
  }

  private getRawTask(body: unknown): unknown | null {
    if (body === null || typeof body !== 'object') {
      throw this.runnerUnavailable();
    }

    if (Object.hasOwn(body, 'task')) {
      const task = (body as { task?: unknown }).task;
      return task === null ? null : task;
    }

    return body;
  }

  private mapTaskError(
    error: { code: string; kind: string; recoverable: boolean } | undefined,
  ): PairStackJobTask['error'] {
    if (error === undefined || error === null) {
      return null;
    }

    const key = [error.code, error.kind].find((value) => value && runnerErrorKey.has(value));
    const mapped = taskErrorMap[key as keyof typeof taskErrorMap] ?? taskErrorMap.FAILED;

    return {
      ...mapped,
      recoverable: error.recoverable,
    };
  }

  private mapRunnerHttpError(status: number): HttpException {
    if (status === HttpStatus.CONFLICT) {
      return new ConflictException({
        code: 'PAIR_STACK_ALREADY_RUNNING',
        message: 'A pair-stack task is already running',
      });
    }

    if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
      return new UnprocessableEntityException({
        code: 'PAIR_STACK_TASK_BLOCKED',
        message: 'The pair-stack task cannot be started or resumed automatically',
      });
    }

    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      return new ServiceUnavailableException({
        code: 'PAIR_STACK_RUNNER_REJECTED',
        message: 'Pair-stack runner rejected the request',
      });
    }

    return this.runnerUnavailable();
  }

  private runnerUnavailable() {
    return new ServiceUnavailableException({
      code: 'PAIR_STACK_RUNNER_UNAVAILABLE',
      message: UNAVAILABLE_MESSAGE,
    });
  }
}
