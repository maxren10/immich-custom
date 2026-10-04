import assert from "node:assert/strict";
import test from "node:test";

import { enumerateInventory, enumerateTwoPassInventory } from "../src/inventory";

const SCOPE = {
  ownerId: "owner-1",
  libraryId: "library-1",
};

function asset(id: string, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ownerId: SCOPE.ownerId,
    libraryId: SCOPE.libraryId,
    originalFileName: name,
    ...overrides,
  };
}

function queuedClient(responses: unknown[]) {
  const bodies: unknown[] = [];
  let index = 0;
  return {
    bodies,
    client: {
      async requestJson<T>(request: { body?: unknown }): Promise<T> {
        bodies.push(request.body);
        const response = responses[index];
        index += 1;
        if (response instanceof Error) {
          throw response;
        }
        return response as T;
      },
    },
  };
}

test("two complete passes follow every nextPage and ignore misleading total", async () => {
  const responses = [
    { assets: [asset("a", "A.JPG")], nextPage: "page-2", total: 999 },
    { assets: [asset("b", "B.ARW")], nextPage: null, total: 999 },
    { assets: [asset("a", "A.JPG")], nextPage: "page-2", total: 999 },
    { assets: [asset("b", "B.ARW")], nextPage: null, total: 999 },
  ];
  const { client, bodies } = queuedClient(responses);
  const result = await enumerateTwoPassInventory(client, SCOPE);

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.stability, "TWO_PASS_STABLE");
  assert.equal(result.snapshotGuaranteed, false);
  assert.equal(result.assets.length, 2);
  assert.equal(result.pagesFetched, 4);
  assert.deepEqual(
    bodies.map((body) => (body as Record<string, unknown>).page),
    [1, "page-2", 1, "page-2"],
  );
  for (const body of bodies as Array<Record<string, unknown>>) {
    assert.equal(body.withStacked, true);
    assert.equal(body.withExif, false);
    assert.equal(body.withDeleted, false);
  }
});

test("owner/library filtering, duplicate IDs, and page loops make a pass incomplete", async (t) => {
  await t.test("owner boundary", async () => {
    const { client } = queuedClient([{ assets: [asset("a", "A.JPG", { ownerId: "other" })], nextPage: null }]);
    const result = await enumerateInventory(client, SCOPE);
    assert.equal(result.status, "INCOMPLETE");
    assert.match(result.error ?? "", /owner scope/);
  });

  await t.test("duplicate asset ID", async () => {
    const { client } = queuedClient([
      { assets: [asset("a", "A.JPG")], nextPage: "2" },
      { assets: [asset("a", "A-again.JPG")], nextPage: null },
    ]);
    const result = await enumerateInventory(client, SCOPE);
    assert.equal(result.status, "INCOMPLETE");
    assert.match(result.error ?? "", /duplicate asset ID/);
    assert.equal(result.pagesFetched, 2);
  });

  await t.test("page loop", async () => {
    const { client } = queuedClient([
      { assets: [], nextPage: "loop" },
      { assets: [], nextPage: "loop" },
    ]);
    const result = await enumerateInventory(client, SCOPE);
    assert.equal(result.status, "INCOMPLETE");
    assert.match(result.error ?? "", /page loop/);
    assert.equal(result.pagesFetched, 2);
  });
});

test("a changed second-pass summary is INCOMPLETE and UNSTABLE", async () => {
  const responses = [
    { assets: [asset("a", "A.JPG")], nextPage: null },
    { assets: [asset("a", "A.JPG"), asset("b", "B.ARW")], nextPage: null },
  ];
  const { client } = queuedClient(responses);
  const result = await enumerateTwoPassInventory(client, SCOPE);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.stability, "UNSTABLE");
  assert.equal(result.snapshotGuaranteed, false);
  assert.match(result.reason ?? "", /summaries changed/);
});
