import assert from "node:assert/strict";
import test from "node:test";

import type { PairStackObservation, StackObservation } from "../src/phase-b-contracts";
import {
  classifyRegisteredStackObservation,
  classifyStackPairObservation,
  observePairStacks,
} from "../src/stack-observer";
import { parseAssetResponse } from "../src/immich-v310-adapter";
import {
  createRegistrationModel,
  deriveIdempotencyKey,
  derivePairId,
  RegistrationProtocolError,
} from "../src/registration-protocol";

const JPG = "00000000-0000-4000-8000-000000000101";
const ARW = "00000000-0000-4000-8000-000000000102";
const THIRD = "00000000-0000-4000-8000-000000000103";
const STACK_A = "00000000-0000-4000-8000-000000000111";
const STACK_B = "00000000-0000-4000-8000-000000000112";
const DEPLOYMENT = "synthetic-deployment-v1";

function none(): StackObservation {
  return { kind: "NONE", observedAt: "2026-09-10T00:00:00.000Z" };
}

function unknown(): StackObservation {
  return { kind: "UNKNOWN", reason: "synthetic unknown", observedAt: "2026-09-10T00:00:00.000Z" };
}

function present(stackId: string, primaryAssetId: string, members: string[]): StackObservation {
  return {
    kind: "PRESENT",
    stackId,
    primaryAssetId,
    reportedAssetCount: members.length,
    visibleMemberIds: members,
    membershipComplete: false,
    observedAt: "2026-09-10T00:00:00.000Z",
  };
}

test("B1 stack observer protects ordinary and inconsistent Stack states", () => {
  const cases: Array<[string, StackObservation, StackObservation, string]> = [
    ["both none", none(), none(), "NO_STACK"],
    ["same stack jpg primary", present(STACK_A, JPG, [JPG, ARW]), present(STACK_A, JPG, [JPG, ARW]), "EXTERNAL_EQUIVALENT"],
    ["same stack arw primary", present(STACK_A, ARW, [JPG, ARW]), present(STACK_A, ARW, [JPG, ARW]), "EXTERNAL_PRIMARY_CONFLICT"],
    ["third member", present(STACK_A, JPG, [JPG, ARW, THIRD]), present(STACK_A, JPG, [JPG, ARW, THIRD]), "STACK_HAS_OTHER_ASSETS"],
    ["different stacks", present(STACK_A, JPG, [JPG]), present(STACK_B, ARW, [ARW]), "STACK_SPLIT_CONFLICT"],
    ["one side only", none(), present(STACK_A, JPG, [JPG]), "STACK_PARTIAL_CONFLICT"],
    ["unknown", unknown(), none(), "STACK_STATE_UNKNOWN"],
  ];
  for (const [name, jpg, arw, expected] of cases) {
    assert.equal(classifyStackPairObservation(jpg, arw, JPG, ARW), expected, name);
  }

  const registered: PairStackObservation = {
    jpgAssetId: JPG,
    arwAssetId: ARW,
    jpg: present(STACK_A, JPG, [JPG, ARW]),
    arw: present(STACK_A, JPG, [JPG, ARW]),
    classification: "EXTERNAL_EQUIVALENT",
    observedAt: "2026-09-10T00:00:00.000Z",
  };
  assert.equal(classifyRegisteredStackObservation(registered, { stackId: STACK_A, jpgAssetId: JPG, arwAssetId: ARW, primaryAssetId: JPG }), "REGISTERED_OBSERVED");
  const drifted: PairStackObservation = { ...registered, jpg: present(STACK_A, ARW, [JPG, ARW]), classification: "EXTERNAL_PRIMARY_CONFLICT" };
  assert.equal(classifyRegisteredStackObservation(drifted, { stackId: STACK_A, jpgAssetId: JPG, arwAssetId: ARW, primaryAssetId: JPG }), "DRIFTED");
});

test("B1 observer preserves Asset detail assetCount and fails closed on hidden third members", async () => {
  const detail = (id: string) => parseAssetResponse({
    id,
    ownerId: "00000000-0000-4000-8000-000000000201",
    libraryId: "00000000-0000-4000-8000-000000000202",
    originalFileName: id === JPG ? "A.JPG" : "A.ARW",
    stack: { id: STACK_A, primaryAssetId: JPG, assetCount: 3 },
  }, "DETAIL");
  const observation = await observePairStacks({
    async getAsset(id: string) { return detail(id); },
    async getStack() { return { id: STACK_A, primaryAssetId: JPG, assets: [JPG, ARW], source: "SYNTHETIC" as const }; },
  }, {
    ownerId: "00000000-0000-4000-8000-000000000201",
    jpgAssetId: JPG,
    arwAssetId: ARW,
    now: () => "2026-09-10T00:00:00.000Z",
  });
  assert.equal(observation.jpg.kind === "PRESENT" && observation.jpg.reportedAssetCount, 3);
  assert.equal(observation.arw.kind === "PRESENT" && observation.arw.reportedAssetCount, 3);
  assert.equal(observation.classification, "STACK_HAS_OTHER_ASSETS");
  assert.equal(classifyRegisteredStackObservation(observation, { stackId: STACK_A, jpgAssetId: JPG, arwAssetId: ARW, primaryAssetId: JPG }), "DRIFTED");
});

test("B1 Map reducer blocks conflicts and makes prepare/reconcile idempotent", () => {
  const ownerId = "00000000-0000-4000-8000-000000000201";
  const pairId = derivePairId({ deploymentId: DEPLOYMENT, ownerId, jpgAssetId: JPG, arwAssetId: ARW });
  const idempotencyKey = deriveIdempotencyKey({ pairId, planDigest: "plan", evidenceDigest: "evidence", expectedBeforeDigest: "before" });
  const input = {
    pairId,
    deploymentId: DEPLOYMENT,
    ownerId,
    jpgAssetId: JPG,
    arwAssetId: ARW,
    planDigest: "plan",
    evidenceDigest: "evidence",
    expectedBeforeDigest: "before",
    idempotencyKey,
    stackClassification: "NO_STACK" as const,
  };
  const model = createRegistrationModel();
  const first = model.prepare(input);
  assert.equal(first.changed, true);
  const second = model.prepare(input);
  assert.equal(second.idempotent, true);
  assert.equal(model.getState().operations.size, 1);
  assert.throws(
    () => model.prepare({ ...input, evidenceDigest: "different-evidence" }),
    (error: unknown) => error instanceof RegistrationProtocolError && error.code === "idempotency-mismatch",
  );

  const operationId = [...model.getState().operations.keys()][0];
  model.recordDispatchIntent(operationId);
  model.markUncertain(operationId);
  const unattributed = model.reconcile(operationId, { kind: "EQUIVALENT_WITHOUT_RESPONSE_ID" });
  assert.match(unattributed.message, /unattributed/);
  assert.equal(model.getState().pairs.get(pairId)?.state, "UNATTRIBUTED");
  assert.equal(model.getState().operations.get(operationId)?.state, "UNCERTAIN");

  const blocked = createRegistrationModel().prepare({ ...input, pairId: "blocked-pair", idempotencyKey: "blocked-idempotency", stackClassification: "EXTERNAL_EQUIVALENT" });
  assert.equal(blocked.state.pairs.get("blocked-pair")?.state, "BLOCKED");
  assert.equal(blocked.state.operations.size, 0);

  assert.throws(
    () => model.prepare({ ...input, pairId: "other-pair", idempotencyKey: "other-idempotency" }),
    (error: unknown) => error instanceof RegistrationProtocolError && error.code === "asset-claim-conflict",
  );
});

test("B1 acknowledged remote result commits only after matching read-only reconcile", () => {
  const model = createRegistrationModel();
  const input = {
    pairId: "pair-commit",
    deploymentId: DEPLOYMENT,
    ownerId: "00000000-0000-4000-8000-000000000201",
    jpgAssetId: JPG,
    arwAssetId: ARW,
    planDigest: "plan",
    evidenceDigest: "evidence",
    expectedBeforeDigest: "before",
    idempotencyKey: "commit-idempotency",
    stackClassification: "NO_STACK" as const,
  };
  model.prepare(input);
  const operationId = [...model.getState().operations.keys()][0];
  model.recordDispatchIntent(operationId);
  model.recordAcknowledgement(operationId, STACK_A);
  model.markUncertain(operationId);
  model.reconcile(operationId, { kind: "REMOTE_CONFIRMED", stackId: STACK_A, equivalent: true });
  assert.equal(model.getState().operations.get(operationId)?.state, "COMMITTED");
  assert.equal(model.getState().pairs.get(input.pairId)?.state, "REGISTERED");
  assert.throws(
    () => model.recordDispatchIntent(operationId),
    (error: unknown) => error instanceof RegistrationProtocolError && error.code === "invalid-transition",
  );
});
