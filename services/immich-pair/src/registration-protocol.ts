import { createHash } from "node:crypto";

import type {
  RegistrationEvent,
  RegistrationOperation,
  RegistrationPair,
  RegistrationPairInput,
  RegistrationState,
  ReconcileObservation,
  TransitionResult,
} from "./phase-b-contracts";

export class RegistrationProtocolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "RegistrationProtocolError";
    this.code = code;
  }
}

export class PhaseBStageDeniedError extends RegistrationProtocolError {
  public constructor(action: string) {
    super("stage-denied", `${action} is not available in Phase B0/B1; no remote write was attempted`);
  }
}

function cloneState(state: RegistrationState): RegistrationState {
  return {
    pairs: new Map([...state.pairs.entries()].map(([key, value]) => [key, { ...value }])),
    operations: new Map([...state.operations.entries()].map(([key, value]) => [key, { ...value }])),
    claims: new Map(state.claims),
  };
}

export function emptyRegistrationState(): RegistrationState {
  return { pairs: new Map(), operations: new Map(), claims: new Map() };
}

function operationIdFor(input: RegistrationPairInput): string {
  return `op-${input.idempotencyKey.slice(0, 32)}`;
}

function getOperation(state: RegistrationState, operationId: string): RegistrationOperation {
  const operation = state.operations.get(operationId);
  if (operation === undefined) {
    throw new RegistrationProtocolError("operation-not-found", "registration operation was not found");
  }
  return operation;
}

function getPairForOperation(state: RegistrationState, operation: RegistrationOperation): RegistrationPair {
  const pair = state.pairs.get(operation.pairId);
  if (pair === undefined) {
    throw new RegistrationProtocolError("pair-not-found", "registration pair was not found");
  }
  return pair;
}

function requireState(operation: RegistrationOperation, allowed: readonly RegistrationOperation["state"][]): void {
  if (!allowed.includes(operation.state)) {
    throw new RegistrationProtocolError("invalid-transition", `operation cannot transition from ${operation.state}`);
  }
}

function deriveDigest(domain: string, value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ domain, ...value }), "utf8").digest("hex");
}

export function derivePairId(input: Pick<RegistrationPairInput, "deploymentId" | "ownerId" | "jpgAssetId" | "arwAssetId">): string {
  return deriveDigest("immich-pair/pair/v1", {
    deploymentId: input.deploymentId,
    ownerId: input.ownerId,
    jpgAssetId: input.jpgAssetId,
    arwAssetId: input.arwAssetId,
  });
}

export function deriveIdempotencyKey(input: Pick<RegistrationPairInput, "pairId" | "planDigest" | "evidenceDigest" | "expectedBeforeDigest">): string {
  return deriveDigest("immich-pair/create-stack/v1", {
    pairId: input.pairId,
    planDigest: input.planDigest,
    evidenceDigest: input.evidenceDigest,
    expectedBeforeDigest: input.expectedBeforeDigest,
  });
}

function prepare(state: RegistrationState, input: RegistrationPairInput): TransitionResult {
  const existingOperation = [...state.operations.values()].find((operation) => operation.idempotencyKey === input.idempotencyKey);
  if (existingOperation !== undefined) {
    if (
      existingOperation.pairId !== input.pairId ||
      existingOperation.deploymentId !== input.deploymentId ||
      existingOperation.planDigest !== input.planDigest ||
      existingOperation.evidenceDigest !== input.evidenceDigest ||
      existingOperation.expectedBeforeDigest !== input.expectedBeforeDigest
    ) {
      throw new RegistrationProtocolError("idempotency-mismatch", "the idempotency key is already bound to different registration semantics");
    }
    return { state, changed: false, idempotent: true, message: "the same idempotency key already has an operation" };
  }
  const existingPair = state.pairs.get(input.pairId);
  if (existingPair !== undefined) {
    throw new RegistrationProtocolError("pair-exists", "a pair id cannot be prepared with a different operation");
  }
  if (input.jpgAssetId === input.arwAssetId) {
    throw new RegistrationProtocolError("asset-conflict", "a pair cannot claim the same Asset twice");
  }
  if (input.stackClassification !== "NO_STACK") {
    const blocked: RegistrationPair = {
      pairId: input.pairId,
      deploymentId: input.deploymentId,
      ownerId: input.ownerId,
      jpgAssetId: input.jpgAssetId,
      arwAssetId: input.arwAssetId,
      state: "BLOCKED",
      stackClassification: input.stackClassification,
      revision: 0,
    };
    const next = cloneState(state);
    next.pairs.set(input.pairId, blocked);
    return { state: next, changed: true, idempotent: false, message: "stack observation blocked preparation" };
  }
  for (const assetId of [input.jpgAssetId, input.arwAssetId]) {
    const claimedBy = state.claims.get(assetId);
    if (claimedBy !== undefined && claimedBy !== input.pairId) {
      throw new RegistrationProtocolError("asset-claim-conflict", `Asset is already claimed by another pair: ${assetId}`);
    }
  }
  const next = cloneState(state);
  const operationId = operationIdFor(input);
  const pair: RegistrationPair = {
    pairId: input.pairId,
    deploymentId: input.deploymentId,
    ownerId: input.ownerId,
    jpgAssetId: input.jpgAssetId,
    arwAssetId: input.arwAssetId,
    state: "PREPARED",
    stackClassification: input.stackClassification,
    operationId,
    revision: 0,
  };
  const operation: RegistrationOperation = {
    operationId,
    idempotencyKey: input.idempotencyKey,
    pairId: input.pairId,
    deploymentId: input.deploymentId,
    state: "PREPARED",
    planDigest: input.planDigest,
    evidenceDigest: input.evidenceDigest,
    expectedBeforeDigest: input.expectedBeforeDigest,
    revision: 0,
  };
  next.pairs.set(pair.pairId, pair);
  next.operations.set(operationId, operation);
  next.claims.set(input.jpgAssetId, input.pairId);
  next.claims.set(input.arwAssetId, input.pairId);
  return { state: next, changed: true, idempotent: false, message: "pair and operation prepared in memory" };
}

function transitionDispatchIntent(state: RegistrationState, operationId: string): TransitionResult {
  const operation = getOperation(state, operationId);
  requireState(operation, ["PREPARED"]);
  const next = cloneState(state);
  const updated = next.operations.get(operationId)!;
  updated.state = "DISPATCH_INTENT";
  updated.revision += 1;
  return { state: next, changed: true, idempotent: false, message: "dispatch intent recorded; no transport is available in B0/B1" };
}

function transitionAcknowledge(state: RegistrationState, operationId: string, responseStackId: string): TransitionResult {
  const operation = getOperation(state, operationId);
  requireState(operation, ["DISPATCH_INTENT"]);
  if (responseStackId.length === 0) {
    throw new RegistrationProtocolError("response-shape", "an acknowledgement requires a non-empty Stack id");
  }
  const next = cloneState(state);
  const updated = next.operations.get(operationId)!;
  updated.state = "ACKNOWLEDGED";
  updated.responseStackId = responseStackId;
  updated.revision += 1;
  return { state: next, changed: true, idempotent: false, message: "remote acknowledgement recorded for later read-only reconcile" };
}

function transitionUncertain(state: RegistrationState, operationId: string): TransitionResult {
  const operation = getOperation(state, operationId);
  requireState(operation, ["DISPATCH_INTENT", "ACKNOWLEDGED"]);
  const next = cloneState(state);
  const updated = next.operations.get(operationId)!;
  updated.state = "UNCERTAIN";
  updated.revision += 1;
  return { state: next, changed: true, idempotent: false, message: "remote result is uncertain; automatic re-dispatch is forbidden" };
}

function transitionReconcile(state: RegistrationState, operationId: string, observation: ReconcileObservation): TransitionResult {
  const operation = getOperation(state, operationId);
  const pair = getPairForOperation(state, operation);
  const next = cloneState(state);
  const updated = next.operations.get(operationId)!;
  const updatedPair = next.pairs.get(pair.pairId)!;
  if (observation.kind === "REMOTE_CONFIRMED") {
    requireState(operation, ["ACKNOWLEDGED", "UNCERTAIN"]);
    if (operation.responseStackId !== observation.stackId || !observation.equivalent) {
      throw new RegistrationProtocolError("reconcile-mismatch", "remote Stack did not match the persisted acknowledgement");
    }
    updated.state = "COMMITTED";
    updatedPair.state = "REGISTERED";
    updated.revision += 1;
    updatedPair.revision += 1;
    return { state: next, changed: true, idempotent: false, message: "local registration committed after independent observation" };
  }
  if (observation.kind === "EQUIVALENT_WITHOUT_RESPONSE_ID") {
    requireState(operation, ["UNCERTAIN", "DISPATCH_INTENT"]);
    updated.state = "UNCERTAIN";
    updatedPair.state = "UNATTRIBUTED";
    updated.revision += 1;
    updatedPair.revision += 1;
    return { state: next, changed: true, idempotent: false, message: "equivalent Stack observed without reliable response id; ownership remains unattributed" };
  }
  if (observation.kind === "NO_STACK_OBSERVED") {
    requireState(operation, ["UNCERTAIN", "DISPATCH_INTENT"]);
    updated.state = "UNCERTAIN";
    updated.revision += 1;
    return { state: next, changed: true, idempotent: false, message: "no Stack observation does not prove a possibly late request was not applied" };
  }
  requireState(operation, ["UNCERTAIN", "ACKNOWLEDGED", "DISPATCH_INTENT"]);
  updated.state = "BLOCKED";
  updatedPair.state = "DRIFTED";
  updated.revision += 1;
  updatedPair.revision += 1;
  return { state: next, changed: true, idempotent: false, message: `reconcile blocked: ${observation.reason}` };
}

export function reduceRegistration(state: RegistrationState, event: RegistrationEvent): TransitionResult {
  switch (event.type) {
    case "PREPARE":
      return prepare(state, event.input);
    case "DISPATCH_INTENT":
      return transitionDispatchIntent(state, event.operationId);
    case "ACKNOWLEDGE":
      return transitionAcknowledge(state, event.operationId, event.responseStackId);
    case "MARK_UNCERTAIN":
      return transitionUncertain(state, event.operationId);
    case "RECONCILE":
      return transitionReconcile(state, event.operationId, event.observation);
  }
}

export interface RegistrationModel {
  getState(): RegistrationState;
  apply(event: RegistrationEvent): TransitionResult;
  prepare(input: RegistrationPairInput): TransitionResult;
  recordDispatchIntent(operationId: string): TransitionResult;
  recordAcknowledgement(operationId: string, responseStackId: string): TransitionResult;
  markUncertain(operationId: string): TransitionResult;
  reconcile(operationId: string, observation: ReconcileObservation): TransitionResult;
}

export function createRegistrationModel(initial: RegistrationState = emptyRegistrationState()): RegistrationModel {
  let state = cloneState(initial);
  const apply = (event: RegistrationEvent): TransitionResult => {
    const result = reduceRegistration(state, event);
    state = result.state;
    return result;
  };
  return {
    getState: () => cloneState(state),
    apply,
    prepare: (input) => apply({ type: "PREPARE", input }),
    recordDispatchIntent: (operationId) => apply({ type: "DISPATCH_INTENT", operationId }),
    recordAcknowledgement: (operationId, responseStackId) => apply({ type: "ACKNOWLEDGE", operationId, responseStackId }),
    markUncertain: (operationId) => apply({ type: "MARK_UNCERTAIN", operationId }),
    reconcile: (operationId, observation) => apply({ type: "RECONCILE", operationId, observation }),
  };
}

/** Explicit B0/B1 boundary: these entry points never call a transport. */
export function assertPhaseB1WriteDenied(action: "SQLITE_FACTORY" | "ORIGINAL_READER" | "STACK_WRITE_TRANSPORT" | "REGISTRY_INIT" | "STACK_COMMIT"): never {
  throw new PhaseBStageDeniedError(action);
}

export function createPhaseB1WriteTransport(): never {
  return assertPhaseB1WriteDenied("STACK_WRITE_TRANSPORT");
}
