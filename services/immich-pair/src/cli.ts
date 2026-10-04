import { redactConfig, parseConfig } from "./config";
import { A_PHASE_CONTRACT } from "./contracts";
import { ExifToolReader } from "./exif-reader";
import { scanLocalSample } from "./local-sample";
import { planPairs } from "./pairing";
import { writeReport, ReportWriterError } from "./report-writer";
import { ALLOWED_SAMPLE_ROOT, IMMICH_ORIGIN, PROTECTED_SCAN_ROOTS } from "./readonly-policy";
import { readPhaseBConfig, redactPhaseBConfig, PhaseBConfigError } from "./phase-b-config";
import { createCredentialProvider } from "./credential-provider";
import { PhaseBDetailReadClient, PhaseBReadClient } from "./phase-b-read-client";
import { enumeratePhaseBInventory, verifyPhaseBCompatibility } from "./phase-b-inventory";
import { buildPhaseBDetailEnrichmentPlan } from "./phase-b-detail-plan";
import { runPhaseBDetailEnrichment } from "./phase-b-detail-runner";
import { createRegistrationModel, deriveIdempotencyKey, derivePairId } from "./registration-protocol";
import { writePhaseBReport, PhaseBReportWriterError } from "./phase-b-report-writer";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_REGISTRY_PATH,
  LOCAL_MOCK_CONFIRMATION,
  type StackLiveBatchProgress,
} from "./stack-write-contracts";
import { buildStackBatchPlan, loadStackBatchPlan, writeStackBatchPlan, StackWritePlanError } from "./stack-write-plan";
import { loadStackLiveBatchPlan, prepareStackLiveBatchPlan, writeStackLiveBatchPlan, StackLiveBatchPlanError } from "./stack-live-batch-plan";
import { PairRegistry, PairRegistryError } from "./pair-registry";
import { LiveStackWriteTransport, MockStackWriteTransport } from "./stack-write-client";
import { applyStackBatch, runLiveStackBatch, runLiveStackSmoke, StackBatchCoordinatorError } from "./stack-registration";
import { runLiveStackBatchV2 } from "./stack-registration";
import { assertLiveBatchStaticGate, assertLiveBatchStaticGateV2, assertLiveSmokeStaticGate, assertMockApplyGate, confirmationDigest, deriveLiveBatchConfirmation, deriveLiveBatchConfirmationV2, deriveLiveSmokeConfirmation, deriveStackOperationId, StackWritePolicyError } from "./stack-write-policy";
import { AllLibrariesPlanError, inspectAllLibraries, loadStackBatchPlanV2, writeAllLibrariesReport } from "./all-libraries-plan";
import { isCanonicalUuid } from "./immich-v310-adapter";
import { loadStackLiveBatchPlanV2, prepareStackLiveBatchPlanV2, writeStackLiveBatchPlanV2 } from "./stack-live-batch-plan";

const CONFIG_FLAGS = new Set([
  "--config",
  "--mode",
  "--origin",
  "--api-key",
  "--owner",
  "--library",
  "--sample-root",
  "--report-dir",
  "--exiftool-path",
  "--output",
  "--temp",
  "--allow-original",
]);

function hasExplicitConfig(argv: readonly string[]): boolean {
  return argv.some((token) => CONFIG_FLAGS.has(token));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  }
  return "command failed";
}

function printHelp(): void {
  console.log("Usage: npm run cli -- <doctor|scan --dry-run> [explicit config options]");
  console.log("Phase A is read-only and executable=false; no default path or network scope is inferred.");
  console.log("LOCAL_SAMPLE_DRY_RUN requires explicit mode, ownerId, sampleRoot, reportDir, and exiftoolPath.");
  console.log("Usage: npm run cli -- phase-b <protocol-check|compat|inventory|live-detail|live-smoke|live-batch|batch ...>");
  console.log("Batch: phase-b batch preview|plan|apply|resume|status; plan/apply/resume are offline mock-only in this node.");
  console.log(`Batch apply requires --transport mock and --confirm ${LOCAL_MOCK_CONFIRMATION}; default registry is ${DEFAULT_REGISTRY_PATH}.`);
  console.log("Live smoke: phase-b live-smoke prepare|run; run requires exact --transport live plus one explicit plan digest, pair id, operation id, and bound confirmation.");
  console.log("Live batch: phase-b live-batch prepare|run|resume; every invocation requires a confirmation-bound positive --max-new-posts no greater than candidateCount; run/resume may add exact --progress terminal.");
  console.log("All libraries V2: phase-b all-libraries inspect|prepare|run|resume; V2 has no slicing and run/resume require confirmation-bound --concurrency from 1 to 64.");
  console.log("Phase B0/B1 is read-only: protocol-check may export a synthetic report; live-detail requires exactly one --config, optional --resume-run-dir, and one secret line on non-TTY stdin.");
}

function scanFailureCode(error: unknown): number {
  if (error instanceof ReportWriterError) {
    return 6;
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "config") {
      return 4;
    }
    if (
      code === "sample-root-denied" ||
      code === "protected-root" ||
      code === "reparse-point" ||
      code === "path-safety" ||
      code === "path-shape" ||
      code === "path-absolute" ||
      code === "path-unc" ||
      code === "path-traversal" ||
      code === "path-ads" ||
      code === "path-overlap" ||
      code === "path-probe"
    ) {
      return 5;
    }
  }
  return 3;
}

function phaseBFailureCode(error: unknown): number {
  if (error instanceof PhaseBReportWriterError) return 6;
  if (error instanceof PhaseBConfigError) return 4;
  return 10;
}

function phaseBArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new PhaseBConfigError("cli", `${flag} requires an explicit value`);
  }
  return value;
}

export interface PhaseBLiveDetailArgs {
  configPath: string;
  resumeRunDir?: string;
}

type BatchAction = "preview" | "plan" | "apply" | "resume" | "status";
type LiveSmokeAction = "prepare" | "run";
type LiveBatchAction = "prepare" | "run" | "resume";

function parseBatchFlags(args: readonly string[], action: BatchAction): Map<string, string> {
  const allowed = action === "preview" || action === "plan"
    ? new Set(["--source-run", "--config", "--output", "--deployment-id"])
    : action === "status"
      ? new Set(["--db"])
      : new Set(["--plan", "--db", "--transport", "--confirm", "--max-operations", "--config"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!allowed.has(token)) throw new PhaseBConfigError("cli", `batch ${action} received an unknown option`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PhaseBConfigError("cli", `${token} requires one value`);
    if (values.has(token)) throw new PhaseBConfigError("cli", `${token} may only be supplied once`);
    values.set(token, value);
    index += 1;
  }
  return values;
}

function requiredBatchFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new PhaseBConfigError("cli", `batch requires ${name}`);
  return value;
}

function parsePositiveFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new PhaseBConfigError("cli", `${name} must be a positive integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new PhaseBConfigError("cli", `${name} is too large`);
  return result;
}

function batchSummary(plan: ReturnType<typeof buildStackBatchPlan>): Record<string, unknown> {
  return {
    status: plan.status,
    schema: plan.schema,
    planDigest: plan.planDigest,
    sourceRunId: plan.sourceRunId,
    candidatePairs: plan.counts.candidatePairs,
    excludedAmbiguousGroups: plan.counts.excludedAmbiguousGroups,
    excludedOtherGroups: plan.counts.excludedOtherGroups,
    blockedByCurrentStack: plan.counts.blockedByCurrentStack,
    concurrency: plan.gate.concurrency,
    maxAttemptsPerPair: plan.gate.maxAttemptsPerPair,
    transport: plan.gate.transport,
    executable: plan.executable,
    canBeUsedForStackWrite: plan.canBeUsedForStackWrite,
    network: "not attempted",
  };
}

function assertPlanConfigMatches(plan: ReturnType<typeof loadStackBatchPlan>, configPath: string | undefined): void {
  if (configPath === undefined) return;
  const config = readPhaseBConfig(configPath);
  if (config.mode !== "B1_READONLY" || config.ownerId !== plan.ownerId || config.libraryIds.length !== plan.libraryIds.length || config.libraryIds.some((id) => !plan.libraryIds.includes(id))) {
    throw new PhaseBConfigError("scope", "batch config scope does not match the persisted plan");
  }
}

async function phaseBBatch(action: BatchAction, rest: readonly string[]): Promise<number> {
  try {
    const flags = parseBatchFlags(rest, action);
    if (action === "preview" || action === "plan") {
      const config = readPhaseBConfig(requiredBatchFlag(flags, "--config"));
      if (config.mode !== "B1_READONLY") throw new PhaseBConfigError("mode", "batch plan requires mode B1_READONLY");
      const plan = buildStackBatchPlan({
        sourceRunDir: requiredBatchFlag(flags, "--source-run"),
        reportDir: config.reportDir,
        ownerId: config.ownerId,
        libraryIds: config.libraryIds,
        deploymentId: flags.get("--deployment-id"),
      });
      if (action === "preview") {
        console.log(JSON.stringify(batchSummary(plan), null, 2));
        return plan.status === "READY" ? 0 : 10;
      }
      const output = flags.get("--output") ?? path.win32.join(config.reportDir, `stack-batch-plan-${plan.sourceRunId}.json`);
      const written = writeStackBatchPlan(output, plan);
      console.log(JSON.stringify({ ...batchSummary(plan), planPath: written.path, bytes: written.bytes, sha256: written.sha256 }, null, 2));
      return plan.status === "READY" ? 0 : 10;
    }
    if (action === "status") {
      const dbPath = flags.get("--db") ?? DEFAULT_REGISTRY_PATH;
      const registry = PairRegistry.open(dbPath);
      try { console.log(JSON.stringify({ ...registry.status(), network: "not attempted", transport: "mock-only" }, null, 2)); } finally { registry.close(); }
      return 0;
    }
    const plan = loadStackBatchPlan(requiredBatchFlag(flags, "--plan"));
    assertPlanConfigMatches(plan, flags.get("--config"));
    const transport = flags.get("--transport");
    if (transport !== "mock") throw new StackWritePolicyError("transport-denied", "batch apply/resume requires explicit --transport mock in this node");
    const token = flags.get("--confirm");
    if (action === "apply" && token === undefined) throw new StackWritePolicyError("confirmation", `batch apply requires --confirm ${LOCAL_MOCK_CONFIRMATION}`);
    if (token !== undefined) assertMockApplyGate(plan, transport, token);
    const maxOperations = parsePositiveFlag(flags.get("--max-operations"), "--max-operations");
    const dbPath = flags.get("--db") ?? DEFAULT_REGISTRY_PATH;
    const registry = PairRegistry.initialize(dbPath, { registryId: plan.registryId, deploymentId: plan.deploymentId });
    try {
      const mockStatePath = path.win32.join(path.win32.dirname(registry.filePath), `${path.win32.basename(registry.filePath)}.mock-server-${plan.planDigest}.json`);
      const mock = new MockStackWriteTransport(plan, { statePath: mockStatePath });
      const result = await applyStackBatch({ registry, plan, readGateway: mock, writeTransport: mock, transport: "mock", confirmationToken: token, maxOperations });
      console.log(JSON.stringify({ ...result, registryPath: registry.filePath, mockServerStatePath: mockStatePath, network: "not attempted", confirmation: token === undefined ? "not supplied; reconcile-only for persisted intents" : "accepted in memory; token not persisted", confirmationDigest: token === undefined ? undefined : confirmationDigest(token) }, null, 2));
      return result.status === "COMPLETED" || result.status === "PAUSED" ? 0 : result.status === "UNCERTAIN" ? 11 : 10;
    } finally { registry.close(); }
  } catch (error) {
    console.error(`phase-b batch ${action}: ${safeErrorMessage(error)}`);
    return error instanceof PairRegistryError ? 9 : error instanceof StackWritePlanError ? 10 : error instanceof StackBatchCoordinatorError ? 10 : 10;
  }
}

function parseLiveSmokeFlags(args: readonly string[], action: LiveSmokeAction): Map<string, string> {
  const allowed = action === "prepare"
    ? new Set(["--plan", "--plan-digest", "--pair-id"])
    : new Set(["--plan", "--plan-digest", "--pair-id", "--operation-id", "--confirm", "--transport", "--db"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") || isSecretLikeCliToken(token)) throw new PhaseBConfigError("cli", "live-smoke never accepts positional or credential-like arguments");
    if (!allowed.has(token)) throw new PhaseBConfigError("cli", `live-smoke ${action} received an unknown option`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PhaseBConfigError("cli", `${token} requires one value`);
    if (values.has(token)) throw new PhaseBConfigError("cli", `${token} may only be supplied once`);
    values.set(token, value);
    index += 1;
  }
  return values;
}

function requiredLiveSmokeFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new PhaseBConfigError("cli", `live-smoke requires ${name}`);
  return value;
}

async function phaseBLiveSmoke(action: LiveSmokeAction, rest: readonly string[]): Promise<number> {
  try {
    const flags = parseLiveSmokeFlags(rest, action);
    if (action === "run" && requiredLiveSmokeFlag(flags, "--transport") !== "live") {
      throw new StackWritePolicyError("transport-denied", "live-smoke run requires exact --transport live");
    }
    const planPath = requiredLiveSmokeFlag(flags, "--plan");
    const planDigest = requiredLiveSmokeFlag(flags, "--plan-digest");
    const pairId = requiredLiveSmokeFlag(flags, "--pair-id");
    const plan = loadStackBatchPlan(planPath);
    const operationId = action === "prepare" ? deriveStackOperationId(pairId) : requiredLiveSmokeFlag(flags, "--operation-id");
    const confirmation = action === "prepare" ? deriveLiveSmokeConfirmation(planDigest, pairId, operationId) : requiredLiveSmokeFlag(flags, "--confirm");
    const binding = { planDigest, pairId, operationId, confirmation };
    const pair = assertLiveSmokeStaticGate(plan, binding);
    if (action === "prepare") {
      console.log(JSON.stringify({
        status: "READY_FOR_EXPLICIT_LIVE_SMOKE",
        planPath,
        planDigest,
        pairId: pair.pairId,
        operationId,
        confirmation,
        assetIds: [pair.jpgAssetId, pair.rawAssetId],
        requestBody: { assetIds: [pair.jpgAssetId, pair.rawAssetId] },
        transportRequirement: "--transport live",
        network: "not attempted",
        credential: "not read",
      }, null, 2));
      return 0;
    }
    // Every static binding check above completes before registry mutation,
    // credential acquisition, transport construction, or fetch.
    const dbPath = flags.get("--db") ?? DEFAULT_REGISTRY_PATH;
    const registry = PairRegistry.initialize(dbPath, { registryId: plan.registryId, deploymentId: plan.deploymentId });
    try {
      const credentialProvider = createCredentialProvider("PROMPT", { prompt: () => readPipedSecret("live-smoke") });
      const credential = await credentialProvider.acquire();
      const transport = new LiveStackWriteTransport({ credential });
      const result = await runLiveStackSmoke({ registry, plan, binding, readGateway: transport, writeTransport: transport });
      console.log(JSON.stringify({ ...result, registryPath: registry.filePath, transport: "live-smoke-single-pair", confirmation: "accepted in memory; plaintext not persisted" }, null, 2));
      return result.status === "COMPLETED" ? 0 : result.status === "UNCERTAIN" ? 11 : 10;
    } finally { registry.close(); }
  } catch (error) {
    console.error(`phase-b live-smoke ${action}: ${safeErrorMessage(error)}`);
    return error instanceof PairRegistryError ? 9 : 10;
  }
}

function parseLiveBatchFlags(args: readonly string[], action: LiveBatchAction): Map<string, string> {
  const allowed = action === "prepare"
    ? new Set(["--source-plan", "--source-plan-digest", "--output", "--max-new-posts"])
    : new Set(["--plan", "--plan-digest", "--candidate-count", "--deployment-id", "--max-new-posts", "--confirm", "--transport", "--db", "--progress"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") || isSecretLikeCliToken(token)) throw new PhaseBConfigError("cli", "live-batch never accepts positional or credential-like arguments");
    if (!allowed.has(token)) throw new PhaseBConfigError("cli", `live-batch ${action} received an unknown option`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PhaseBConfigError("cli", `${token} requires one value`);
    if (values.has(token)) throw new PhaseBConfigError("cli", `${token} may only be supplied once`);
    values.set(token, value);
    index += 1;
  }
  return values;
}

function requiredLiveBatchFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new PhaseBConfigError("cli", `live-batch requires ${name}`);
  return value;
}

function liveBatchMaxNewPosts(flags: Map<string, string>, candidateCount: number): number {
  const text = requiredLiveBatchFlag(flags, "--max-new-posts");
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > candidateCount) throw new PhaseBConfigError("cli", "live-batch --max-new-posts must be a positive safe integer no greater than candidateCount");
  return Number(text);
}

export function formatLiveBatchTerminalProgress(progress: StackLiveBatchProgress, elapsedMs: number): string {
  const width = 20;
  const ratio = progress.candidateCount === 0 ? 0 : Math.min(1, progress.committed / progress.candidateCount);
  const filled = Math.round(ratio * width);
  const elapsedSeconds = Math.max(0, elapsedMs) / 1000;
  const rate = elapsedSeconds > 0 ? progress.posts / elapsedSeconds : 0;
  const remaining = Math.max(0, progress.candidateCount - progress.committed);
  const eta = rate > 0 ? `${Math.ceil(remaining / rate)}s` : "--";
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${progress.committed}/${progress.candidateCount} ${(ratio * 100).toFixed(2)}% posts=${progress.posts} elapsed=${elapsedSeconds.toFixed(1)}s rate=${rate.toFixed(2)}/s ETA=${eta} status=${progress.status}`;
}

async function phaseBLiveBatch(action: LiveBatchAction, rest: readonly string[]): Promise<number> {
  try {
    const flags = parseLiveBatchFlags(rest, action);
    if (action === "prepare") {
      const sourcePlanPath = requiredLiveBatchFlag(flags, "--source-plan");
      const sourcePlanDigest = requiredLiveBatchFlag(flags, "--source-plan-digest");
      const outputPath = requiredLiveBatchFlag(flags, "--output");
      const plan = prepareStackLiveBatchPlan(sourcePlanPath, sourcePlanDigest);
      const maxNewPosts = liveBatchMaxNewPosts(flags, plan.counts.candidatePairs);
      const written = writeStackLiveBatchPlan(outputPath, plan);
      console.log(JSON.stringify({
        status: "READY_FOR_EXPLICIT_LIVE_BATCH",
        schema: plan.schema,
        sourcePlanPath,
        sourcePlanDigest: plan.sourcePlanDigest,
        planPath: written.path,
        planDigest: plan.planDigest,
        candidateCount: plan.counts.candidatePairs,
        assetCount: plan.counts.assets,
        deploymentId: plan.deploymentId,
        maxNewPosts,
        confirmation: deriveLiveBatchConfirmation(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, maxNewPosts),
        transportRequirement: "--transport live",
        concurrency: plan.policy.concurrency,
        network: "not attempted",
        credential: "not read",
        registry: "not opened",
      }, null, 2));
      return 0;
    }
    if (requiredLiveBatchFlag(flags, "--transport") !== "live") throw new StackWritePolicyError("transport-denied", "live-batch run/resume requires exact --transport live");
    const progressMode = flags.get("--progress");
    if (progressMode !== undefined && progressMode !== "terminal") throw new PhaseBConfigError("cli", "live-batch --progress accepts only exact value terminal");
    const planPath = requiredLiveBatchFlag(flags, "--plan");
    const planDigest = requiredLiveBatchFlag(flags, "--plan-digest");
    const candidateText = requiredLiveBatchFlag(flags, "--candidate-count");
    if (!/^[1-9][0-9]*$/.test(candidateText) || !Number.isSafeInteger(Number(candidateText))) throw new PhaseBConfigError("cli", "live-batch --candidate-count must be a positive safe integer");
    const plan = loadStackLiveBatchPlan(planPath);
    const binding = {
      planDigest,
      candidateCount: Number(candidateText),
      deploymentId: requiredLiveBatchFlag(flags, "--deployment-id"),
      maxNewPosts: liveBatchMaxNewPosts(flags, plan.counts.candidatePairs),
      confirmation: requiredLiveBatchFlag(flags, "--confirm"),
    };
    assertLiveBatchStaticGate(plan, binding);
    // Static grammar, exact transport, file integrity, count, deployment, and
    // confirmation binding all complete before DB, stdin, transport, or fetch.
    const dbPath = flags.get("--db") ?? DEFAULT_REGISTRY_PATH;
    const registry = PairRegistry.initialize(dbPath, { registryId: plan.registryId, deploymentId: plan.deploymentId });
    try {
      const credential = await createCredentialProvider("PROMPT", { prompt: () => readPipedSecret("live-batch") }).acquire();
      const transport = new LiveStackWriteTransport({ credential });
      const progressStartedAt = Date.now();
      const progress = progressMode === "terminal"
        ? (event: StackLiveBatchProgress): void => { console.error(formatLiveBatchTerminalProgress(event, Date.now() - progressStartedAt)); }
        : undefined;
      const result = await runLiveStackBatch({ registry, plan, binding, readGateway: transport, writeTransport: transport, progress });
      console.log(JSON.stringify({ ...result, mode: action, registryPath: registry.filePath, transport: "live", concurrency: plan.policy.concurrency, confirmation: "accepted in memory; plaintext not persisted" }, null, 2));
      return result.status === "COMPLETED" || result.status === "PAUSED" ? 0 : result.status === "STOPPED" ? 11 : 10;
    } finally { registry.close(); }
  } catch (error) {
    console.error(`phase-b live-batch ${action}: ${safeErrorMessage(error)}`);
    return error instanceof PairRegistryError ? 9 : error instanceof StackLiveBatchPlanError ? 10 : 10;
  }
}

type AllLibrariesAction = "inspect" | "prepare" | "run" | "resume";

function parseAllLibrariesFlags(args: readonly string[], action: AllLibrariesAction): Map<string, string> {
  const allowed = action === "inspect"
    ? new Set(["--owner", "--library-scope", "--library-id", "--report-dir", "--page-size", "--detail-concurrency", "--deployment-id"])
    : action === "prepare"
      ? new Set(["--source-plan", "--source-plan-digest", "--output", "--concurrency"])
      : new Set(["--plan", "--plan-digest", "--candidate-count", "--deployment-id", "--library-scope-digest", "--concurrency", "--confirm", "--transport", "--db", "--progress"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--") || isSecretLikeCliToken(token) || !allowed.has(token)) throw new PhaseBConfigError("cli", `all-libraries ${action} received an unknown, positional, or credential-like option`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(token)) throw new PhaseBConfigError("cli", `${token} requires exactly one value`);
    values.set(token, value); index += 1;
  }
  return values;
}

function requireAllLibrariesFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name); if (value === undefined || value.length === 0) throw new PhaseBConfigError("cli", `all-libraries requires ${name}`); return value;
}

function boundedAllLibrariesInteger(flags: Map<string, string>, name: string, minimum: number, maximum: number, fallback?: number): number {
  const text = flags.get(name);
  if (text === undefined && fallback !== undefined) return fallback;
  if (text === undefined || !/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum || Number(text) > maximum) throw new PhaseBConfigError("cli", `${name} must be a safe integer from ${minimum} to ${maximum}`);
  return Number(text);
}

async function phaseBAllLibraries(action: AllLibrariesAction, rest: readonly string[]): Promise<number> {
  try {
    const flags = parseAllLibrariesFlags(rest, action);
    if (action === "inspect") {
      const scope = requireAllLibrariesFlag(flags, "--library-scope");
      if (scope !== "all" && scope !== "uuid" && scope !== "null") throw new PhaseBConfigError("scope", "--library-scope must be exact all, uuid, or null");
      const libraryId = flags.get("--library-id");
      if ((scope === "uuid") !== (libraryId !== undefined)) throw new PhaseBConfigError("scope", "uuid scope requires --library-id; all/null forbid it");
      const ownerId = requireAllLibrariesFlag(flags, "--owner");
      if (!isCanonicalUuid(ownerId) || (libraryId !== undefined && !isCanonicalUuid(libraryId))) throw new PhaseBConfigError("scope", "owner and optional library id must be canonical UUIDs");
      const reportDir = requireAllLibrariesFlag(flags, "--report-dir");
      const pageSize = boundedAllLibrariesInteger(flags, "--page-size", 1, 100, 100);
      const detailConcurrency = boundedAllLibrariesInteger(flags, "--detail-concurrency", 1, 16, 4);
      const credential = await createCredentialProvider("PROMPT", { prompt: () => readPipedSecret("all-libraries inspect") }).acquire();
      const gateway = new PhaseBReadClient({ credential });
      const plan = await inspectAllLibraries(gateway, { ownerId, scope, ...(libraryId === undefined ? {} : { libraryId }), pageSize, detailConcurrency, deploymentId: flags.get("--deployment-id") });
      const written = writeAllLibrariesReport(reportDir, plan);
      console.log(JSON.stringify({ status: plan.status, schema: plan.schema, planDigest: plan.planDigest, libraryScopeDigest: plan.libraryScopeDigest, libraryBindings: plan.libraryBindings, counts: plan.counts, inspectPolicy: plan.inspectPolicy, ...written, writeTransport: "not constructed", stackWrites: 0, credential: "read once from non-TTY stdin; plaintext not persisted" }, null, 2));
      return plan.status === "READY" || plan.status === "NO_ACTION" ? 0 : 10;
    }
    const concurrency = boundedAllLibrariesInteger(flags, "--concurrency", 1, 64);
    if (action === "prepare") {
      const sourcePath = requireAllLibrariesFlag(flags, "--source-plan");
      const sourceDigest = requireAllLibrariesFlag(flags, "--source-plan-digest");
      const plan = prepareStackLiveBatchPlanV2(sourcePath, sourceDigest);
      const written = writeStackLiveBatchPlanV2(requireAllLibrariesFlag(flags, "--output"), plan);
      console.log(JSON.stringify({ status: "READY_FOR_EXPLICIT_ALL_LIBRARIES_V2", schema: plan.schema, sourcePlanDigest: plan.sourcePlanDigest, planPath: written.path, planDigest: plan.planDigest, candidateCount: plan.counts.candidatePairs, deploymentId: plan.deploymentId, libraryScopeDigest: plan.libraryScopeDigest, concurrency, confirmation: deriveLiveBatchConfirmationV2(plan.planDigest, plan.counts.candidatePairs, plan.deploymentId, plan.libraryScopeDigest, concurrency), transportRequirement: "--transport live", slicing: "not supported", network: "not attempted", credential: "not read", registry: "not opened" }, null, 2));
      return 0;
    }
    if (requireAllLibrariesFlag(flags, "--transport") !== "live") throw new StackWritePolicyError("transport-denied", "all-libraries V2 run/resume requires exact --transport live");
    const progressMode = flags.get("--progress");
    if (progressMode !== undefined && progressMode !== "terminal") throw new PhaseBConfigError("cli", "all-libraries --progress accepts only exact terminal");
    const plan = loadStackLiveBatchPlanV2(requireAllLibrariesFlag(flags, "--plan"));
    const countText = requireAllLibrariesFlag(flags, "--candidate-count");
    if (!/^[1-9][0-9]*$/.test(countText) || !Number.isSafeInteger(Number(countText))) throw new PhaseBConfigError("cli", "--candidate-count must be a positive safe integer");
    const binding = { planDigest: requireAllLibrariesFlag(flags, "--plan-digest"), candidateCount: Number(countText), deploymentId: requireAllLibrariesFlag(flags, "--deployment-id"), libraryScopeDigest: requireAllLibrariesFlag(flags, "--library-scope-digest"), concurrency, confirmation: requireAllLibrariesFlag(flags, "--confirm") };
    assertLiveBatchStaticGateV2(plan, binding);
    const registry = PairRegistry.initialize(flags.get("--db") ?? DEFAULT_REGISTRY_PATH, { registryId: plan.registryId, deploymentId: plan.deploymentId });
    try {
      const credential = await createCredentialProvider("PROMPT", { prompt: () => readPipedSecret(`all-libraries ${action}`) }).acquire();
      const transport = new LiveStackWriteTransport({ credential });
      const startedAt = Date.now();
      const progress = progressMode === "terminal" ? (event: StackLiveBatchProgress): void => { console.error(formatLiveBatchTerminalProgress(event, Date.now() - startedAt)); } : undefined;
      const result = await runLiveStackBatchV2({ registry, plan, binding, readGateway: transport, writeTransport: transport, progress });
      console.log(JSON.stringify({ ...result, mode: action, registryPath: registry.filePath, transport: "live", slicing: "not supported", confirmation: "accepted in memory; plaintext not persisted" }, null, 2));
      return result.status === "COMPLETED" ? 0 : result.status === "STOPPED" ? 11 : 10;
    } finally { registry.close(); }
  } catch (error) {
    console.error(`phase-b all-libraries ${action}: ${safeErrorMessage(error)}`);
    return error instanceof PairRegistryError ? 9 : error instanceof AllLibrariesPlanError || error instanceof StackLiveBatchPlanError ? 10 : 10;
  }
}

function isSecretLikeCliToken(token: string): boolean {
  return /^--(?:api[-_]?key|password|secret|token|authorization|bearer|credential)(?:=|$)/i.test(token);
}

/**
 * The live entry point has a deliberately smaller grammar than the offline
 * commands. Parse it before reading config or stdin so a typo or attempted
 * secret flag cannot reach the credential or network boundary.
 */
export function parsePhaseBLiveDetailArgs(args: readonly string[]): PhaseBLiveDetailArgs {
  let configPath: string | undefined;
  let resumeRunDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new PhaseBConfigError("cli", "live-detail accepts flags only; positional arguments are not allowed");
    }
    if (isSecretLikeCliToken(token)) {
      throw new PhaseBConfigError("cli", "live-detail never accepts credential-like command-line arguments");
    }
    if (token !== "--config" && token !== "--resume-run-dir") {
      throw new PhaseBConfigError("cli", "live-detail received an unknown option");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new PhaseBConfigError("cli", `${token} requires one value`);
    }
    index += 1;
    if (token === "--config") {
      if (configPath !== undefined) {
        throw new PhaseBConfigError("cli", "live-detail accepts exactly one --config option");
      }
      configPath = value;
    } else {
      if (resumeRunDir !== undefined) {
        throw new PhaseBConfigError("cli", "live-detail accepts at most one --resume-run-dir option");
      }
      resumeRunDir = value;
    }
  }
  if (configPath === undefined) {
    throw new PhaseBConfigError("cli", "live-detail requires exactly one --config value");
  }
  return resumeRunDir === undefined ? { configPath } : { configPath, resumeRunDir };
}

function phaseBProtocolCheck(reportDir: string | undefined): number {
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const deploymentId = "synthetic-deployment-v1";
  const jpgAssetId = "00000000-0000-4000-8000-000000000002";
  const arwAssetId = "00000000-0000-4000-8000-000000000003";
  const planDigest = "synthetic-plan";
  const evidenceDigest = "synthetic-evidence";
  const expectedBeforeDigest = "synthetic-before";
  const pairId = derivePairId({ deploymentId, ownerId, jpgAssetId, arwAssetId });
  const idempotencyKey = deriveIdempotencyKey({ pairId, planDigest, evidenceDigest, expectedBeforeDigest });
  const model = createRegistrationModel();
  const prepared = model.prepare({
    pairId,
    deploymentId,
    ownerId,
    jpgAssetId,
    arwAssetId,
    planDigest,
    evidenceDigest,
    expectedBeforeDigest,
    idempotencyKey,
    stackClassification: "NO_STACK",
  });
  const payload: Record<string, unknown> = {
    phase: "B",
    subphase: "B1",
    status: "OFFLINE_IMPLEMENTED",
    prepared: prepared.changed,
    executable: false,
    canBeUsedForStackWrite: false,
    network: "not attempted",
  };
  if (reportDir !== undefined) {
    const scopeDigest = createHash("sha256").update(`${ownerId}:synthetic`, "utf8").digest("hex");
    const report = writePhaseBReport({
      reportDir,
      subphase: "B1",
      mode: "B1_READONLY",
      source: "SYNTHETIC",
      scopeDigest,
      gateFailures: ["LIVE_READ_NOT_RUN"],
      registrations: [prepared.state.pairs.get(pairId)!],
      issues: [{ issueId: "offline-live-not-run", code: "LIVE_READ_NOT_RUN", severity: "INFO", message: "synthetic protocol check only; no live API or credential was used" }],
    });
    payload.report = { runId: report.runId, runDir: report.runDir, manifest: report.manifest };
  }
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

async function readPipedSecret(command = "live-detail"): Promise<string> {
  if (process.stdin.isTTY) {
    throw new PhaseBConfigError("credential-source", `${command} requires one API key line on non-TTY stdin; no interactive echoing is provided`);
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  const lineEnd = input.indexOf("\n");
  if (lineEnd >= 0 && input.slice(lineEnd + 1).length > 0) {
    throw new PhaseBConfigError("credential-source", `${command} stdin must contain exactly one API key line`);
  }
  if (lineEnd >= 0) {
    const line = input.slice(0, lineEnd);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  return input;
}

async function phaseBLiveDetail(rest: readonly string[]): Promise<number> {
  try {
    const parsedArgs = parsePhaseBLiveDetailArgs(rest);
    const config = readPhaseBConfig(parsedArgs.configPath);
    if (config.mode !== "B1_READONLY") {
      throw new PhaseBConfigError("mode", "live-detail requires mode B1_READONLY");
    }
    const credentialProvider = createCredentialProvider("PROMPT", { prompt: readPipedSecret });
    const credential = await credentialProvider.acquire();
    const scope = { ownerId: config.ownerId, libraryIds: config.libraryIds };
    const metadataClient = new PhaseBReadClient({ credential });
    const compatibility = await verifyPhaseBCompatibility(metadataClient, scope);
    if (compatibility.status !== "COMPATIBLE") {
      console.log(JSON.stringify({ status: "INCOMPATIBLE", compatibility: { status: compatibility.status, issues: compatibility.issues }, executable: false, canBeUsedForStackWrite: false }, null, 2));
      return 10;
    }
    const inventory = await enumeratePhaseBInventory(metadataClient, scope);
    if (inventory.status !== "COMPLETE" || inventory.stability !== "TWO_PASS_STABLE") {
      console.log(JSON.stringify({ status: "INVENTORY_INCOMPLETE", inventory: { status: inventory.status, stability: inventory.stability, issues: inventory.issues }, executable: false, canBeUsedForStackWrite: false }, null, 2));
      return 10;
    }
    const plan = buildPhaseBDetailEnrichmentPlan(inventory);
    if (plan.status !== "READY") {
      console.log(JSON.stringify({ status: "DETAIL_PLAN_BLOCKED", plan, executable: false, canBeUsedForStackWrite: false }, null, 2));
      return 10;
    }
    // This is intentionally a distinct client. Its public surface is only
    // getAsset and its internal PhaseBReadClient is forced to maxRetries=0.
    const detailClient = new PhaseBDetailReadClient({ credential });
    const result = await runPhaseBDetailEnrichment({
      reportDir: config.reportDir,
      plan,
      inventory,
      gateway: detailClient,
      ownerId: config.ownerId,
      libraryIds: config.libraryIds,
      serverVersion: compatibility.version?.version,
      sourceSnapshotDigest: undefined,
      resumeRunDir: parsedArgs.resumeRunDir,
    });
    console.log(JSON.stringify({ status: result.status, runDir: result.runDir, summary: result.summary, manifest: result.manifest ?? null, executable: false, canBeUsedForStackWrite: false }, null, 2));
    return result.status === "COMPLETED" || result.status === "COMPLETED_WITH_ISSUES" ? 0 : 10;
  } catch (error) {
    console.error(`phase-b live-detail: ${safeErrorMessage(error)}`);
    return phaseBFailureCode(error);
  }
}

async function phaseBMain(args: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand === "protocol-check") {
    try {
      return phaseBProtocolCheck(phaseBArgValue(rest, "--report-dir"));
    } catch (error) {
      console.error(`phase-b protocol-check: ${safeErrorMessage(error)}`);
      return phaseBFailureCode(error);
    }
  }
  if (subcommand === "live-detail") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      printHelp();
      return 0;
    }
    return phaseBLiveDetail(rest);
  }
  if (subcommand === "live-smoke") {
    const [action, ...liveSmokeRest] = rest;
    if (action === undefined || action === "--help" || action === "-h") {
      printHelp();
      return action === undefined ? 2 : 0;
    }
    if (action !== "prepare" && action !== "run") {
      console.error("phase-b live-smoke: unknown action");
      return 2;
    }
    return phaseBLiveSmoke(action, liveSmokeRest);
  }
  if (subcommand === "live-batch") {
    const [action, ...liveBatchRest] = rest;
    if (action === undefined || action === "--help" || action === "-h") {
      printHelp();
      return action === undefined ? 2 : 0;
    }
    if (action !== "prepare" && action !== "run" && action !== "resume") {
      console.error("phase-b live-batch: unknown action");
      return 2;
    }
    return phaseBLiveBatch(action, liveBatchRest);
  }
  if (subcommand === "all-libraries") {
    const [action, ...allLibrariesRest] = rest;
    if (action === undefined || action === "--help" || action === "-h") { printHelp(); return action === undefined ? 2 : 0; }
    if (action !== "inspect" && action !== "prepare" && action !== "run" && action !== "resume") {
      console.error("phase-b all-libraries: unknown action"); return 2;
    }
    return phaseBAllLibraries(action, allLibrariesRest);
  }
  if (subcommand === "batch") {
    const [action, ...batchRest] = rest;
    if (action === undefined || action === "--help" || action === "-h") {
      printHelp();
      return action === undefined ? 2 : 0;
    }
    if (action !== "preview" && action !== "plan" && action !== "apply" && action !== "resume" && action !== "status") {
      console.error("phase-b batch: unknown action");
      printHelp();
      return 2;
    }
    return phaseBBatch(action, batchRest);
  }
  if (subcommand === "preview" || subcommand === "plan" || subcommand === "apply" || subcommand === "resume" || subcommand === "status") {
    return phaseBBatch(subcommand, rest);
  }
  if (subcommand === "compat" || subcommand === "inventory") {
    if (!rest.includes("--offline")) {
      console.error("phase-b: live compat/inventory is not executed in this B0/B1 offline node; use --offline or an explicitly authorized live follow-up");
      return 10;
    }
    const configPath = phaseBArgValue(rest, "--config");
    if (configPath === undefined) {
      console.error("phase-b: --offline compat/inventory still requires an explicit no-secret --config for scope metadata");
      return 4;
    }
    try {
      const config = readPhaseBConfig(configPath);
      console.log(JSON.stringify({ status: "OFFLINE_IMPLEMENTED", config: redactPhaseBConfig(config), liveRead: false, network: "not attempted", executable: false, canBeUsedForStackWrite: false }, null, 2));
      return 0;
    } catch (error) {
      console.error(`phase-b ${subcommand}: ${safeErrorMessage(error)}`);
      return phaseBFailureCode(error);
    }
  }
  if (["registry", "prepare", "stack-commit", "reconcile"].includes(subcommand)) {
    console.error(`phase-b ${subcommand}: this capability is explicitly denied in B0/B1; no database, original reader, or Immich write transport was invoked`);
    return 10;
  }
  console.error("phase-b: unknown subcommand");
  printHelp();
  return 2;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...commandArgs] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return command === undefined ? 2 : 0;
  }

  if (command === "doctor") {
    if (!hasExplicitConfig(commandArgs)) {
      console.log(
        JSON.stringify(
          {
            phase: A_PHASE_CONTRACT,
            configured: false,
            origin: IMMICH_ORIGIN,
            allowedSampleRoot: ALLOWED_SAMPLE_ROOT,
            protectedScanRoots: PROTECTED_SCAN_ROOTS,
            network: "not attempted",
          },
          null,
          2,
        ),
      );
      return 0;
    }
    try {
      const config = parseConfig(commandArgs);
      console.log(JSON.stringify({ phase: A_PHASE_CONTRACT, configured: true, config: redactConfig(config) }, null, 2));
      console.log("doctor: network not attempted");
      return 0;
    } catch (error) {
      console.error(`doctor: ${safeErrorMessage(error)}`);
      return 2;
    }
  }

  if (command === "phase-b") {
    return phaseBMain(commandArgs);
  }

  if (command === "scan") {
    if (!commandArgs.includes("--dry-run")) {
      console.error("scan: only --dry-run is available in Phase A");
      return 2;
    }
    const configArgs = commandArgs.filter((token) => token !== "--dry-run");
    let config;
    try {
      config = parseConfig(configArgs);
    } catch (error) {
      console.error(`scan: ${safeErrorMessage(error)}`);
      return scanFailureCode(error);
    }
    if (config.mode !== "LOCAL_SAMPLE_DRY_RUN" || config.reportDir === undefined || config.exiftoolPath === undefined) {
      console.error("scan: LOCAL_SAMPLE_DRY_RUN configuration is required; no network or default path was used");
      return 4;
    }

    const startedAt = Date.now();
    let scanResult;
    try {
      const exifReader = new ExifToolReader(config.exiftoolPath);
      scanResult = await scanLocalSample({
        sampleRoot: config.scope.sampleRoot,
        ownerId: config.scope.ownerId,
        exifReader,
        includeSha256: config.includeSha256,
      });
    } catch (error) {
      console.error(`scan: ${safeErrorMessage(error)}`);
      return scanFailureCode(error);
    }

    // An unavailable extractor or an unstable/incomplete source snapshot
    // cannot produce a completed report. Stop before planning/writing so no
    // manifest can falsely certify a failed input read.
    if (scanResult.extractorUnavailable) {
      console.error("scan: ExifTool metadata extraction was unavailable; no completed report was written");
      return 4;
    }
    if (scanResult.status === "INCOMPLETE") {
      console.error("scan: source enumeration or snapshot was incomplete; no completed report was written");
      return 3;
    }

    const plan = planPairs(scanResult.assets, scanResult.issues);
    let report;
    try {
      report = writeReport({
        reportDir: config.reportDir,
        sampleRoot: scanResult.sampleRoot,
        assets: scanResult.assets,
        plan,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error(`scan: ${safeErrorMessage(error)}`);
      return scanFailureCode(error);
    }

    console.log(
      JSON.stringify(
        {
          status: report.manifest.status,
          runId: report.runId,
          runDir: report.runDir,
          assets: report.manifest.counts.assets,
          pairs: report.manifest.counts.pairs,
          issues: report.manifest.counts.issues,
          executable: false,
          canBeUsedForPhaseB: false,
        },
        null,
        2,
      ),
    );

    return plan.issues.length > 0 ? 2 : 0;
  }

  console.error("unknown command");
  printHelp();
  return 2;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
