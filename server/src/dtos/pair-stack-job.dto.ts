import { createZodDto } from 'nestjs-zod';
import { isoDatetimeToDate } from 'src/validation';
import z from 'zod';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PairStackJobStatusSchema = z
  .enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED'])
  .meta({ id: 'PairStackJobStatus' });

export const PairStackJobPhaseSchema = z
  .enum(['INSPECTING', 'PREPARING', 'RECONCILING', 'STACKING', 'FINALIZING'])
  .meta({ id: 'PairStackJobPhase' });

const PairStackJobErrorKindSchema = z.enum(['BLOCKED', 'DRIFTED', 'UNATTRIBUTED', 'RUNNER', 'INTERNAL']);
const PairStackJobErrorCodeSchema = z.enum([
  'PAIR_STACK_BLOCKED',
  'PAIR_STACK_DRIFTED',
  'PAIR_STACK_UNATTRIBUTED',
  'PAIR_STACK_RUNNER_UNAVAILABLE',
  'PAIR_STACK_RUNNER_REJECTED',
  'PAIR_STACK_FAILED',
]);

const CanonicalUuidSchema = z.string().regex(CANONICAL_UUID, 'Invalid canonical UUID');

export const PairStackJobCreateSchema = z
  .object({
    requestId: CanonicalUuidSchema.describe('Idempotency request ID'),
    concurrency: z.int().min(1).max(64).default(32).describe('Runner concurrency (1-64)'),
  })
  .meta({ id: 'PairStackJobCreateDto' });

const PairStackJobProgressSchema = z
  .object({
    determinate: z.boolean().describe('Whether the progress has a known total'),
    current: z.int().min(0).describe('Current progress'),
    total: z.int().min(0).describe('Total progress'),
    percent: z.number().min(0).max(100).nullable().describe('Progress percentage'),
    posts: z.int().min(0).describe('Number of stack POST attempts'),
  })
  .meta({ id: 'PairStackJobProgressDto' });

const PairStackJobCountsSchema = z
  .object({
    prepared: z.int().min(0),
    dispatchIntent: z.int().min(0),
    acknowledged: z.int().min(0),
    uncertain: z.int().min(0),
    committed: z.int().min(0),
    blocked: z.int().min(0),
    unattributed: z.int().min(0),
    drifted: z.int().min(0),
  })
  .meta({ id: 'PairStackJobCountsDto' });

const PairStackJobErrorSchema = z
  .object({
    kind: PairStackJobErrorKindSchema,
    code: PairStackJobErrorCodeSchema,
    message: z.string().max(160),
    recoverable: z.boolean(),
  })
  .meta({ id: 'PairStackJobErrorDto' });

export const PairStackJobTaskSchema = z
  .object({
    id: CanonicalUuidSchema.describe('Task ID'),
    requestId: CanonicalUuidSchema.describe('Idempotency request ID'),
    status: PairStackJobStatusSchema,
    phase: PairStackJobPhaseSchema,
    concurrency: z.int().min(1).max(64),
    startedAt: isoDatetimeToDate,
    updatedAt: isoDatetimeToDate,
    finishedAt: isoDatetimeToDate.nullable(),
    progress: PairStackJobProgressSchema,
    counts: PairStackJobCountsSchema,
    error: PairStackJobErrorSchema.nullable(),
  })
  .meta({ id: 'PairStackJobTaskDto' });

const PairStackJobResponseSchema = z
  .object({
    task: PairStackJobTaskSchema.nullable(),
  })
  .meta({ id: 'PairStackJobResponseDto' });

export class PairStackJobCreateDto extends createZodDto(PairStackJobCreateSchema) {}
export class PairStackJobResponseDto extends createZodDto(PairStackJobResponseSchema) {}

export type PairStackJobTask = z.infer<typeof PairStackJobTaskSchema>;
export type PairStackJobResponse = z.infer<typeof PairStackJobResponseSchema>;
