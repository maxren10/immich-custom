import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOperationalPathSafe,
  assertPathDisjoint,
  assertSampleRootAllowed,
  IMMICH_ORIGIN,
  ReadonlyPolicy,
  ReadonlyPolicyError,
  normalizeSafeWindowsPath,
} from "../src/readonly-policy";
import { ImmichReadClient, type FetchLike } from "../src/immich-read-client";

const ASSET_ID = "00000000-0000-4000-8000-000000000001";

test("all write or unknown endpoints are rejected before mock fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  };
  const client = new ImmichReadClient({ apiKey: "secret-do-not-echo", fetchImpl });
  const denied = [
    { method: "POST", path: "/api/stacks" },
    { method: "DELETE", path: `/api/assets/${ASSET_ID}` },
    { method: "POST", path: "/api/trash/empty" },
    { method: "PATCH", path: "/api/libraries/library" },
    { method: "POST", path: "/api/jobs" },
    { method: "GET", path: "/api/unknown" },
  ];

  for (const request of denied) {
    await assert.rejects(client.request(request), ReadonlyPolicyError);
  }
  assert.equal(fetchCalls, 0);
});

test("metadata allowlist is strict and the client sends only safe flags", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ assets: [], nextPage: null }), { status: 200 });
  };
  const client = new ImmichReadClient({ apiKey: "secret-value", fetchImpl });
  await client.requestJson({
    method: "POST",
    path: "/api/search/metadata",
    body: {
      ownerId: "owner",
      libraryId: "library",
      page: 1,
      size: 100,
      withStacked: true,
      withExif: false,
      withDeleted: false,
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${IMMICH_ORIGIN}/api/search/metadata`);
  assert.equal(calls[0].init.redirect, "error");
  assert.match(String(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization), /Bearer secret-value/);
  assert.rejects(
    client.request({
      method: "POST",
      path: "/api/search/metadata",
      body: {
        ownerId: "owner",
        libraryId: "library",
        page: 1,
        size: 100,
        withStacked: true,
        withExif: false,
        withDeleted: false,
        arbitraryWriteIntent: true,
      },
    }),
    ReadonlyPolicyError,
  );
  assert.equal(calls.length, 1);
});

test("redirects are rejected and 401/403 are not retried", async () => {
  let calls = 0;
  let sleeps = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response(null, { status: 401 });
  };
  const client = new ImmichReadClient({
    apiKey: "secret-value",
    fetchImpl,
    sleep: async () => {
      sleeps += 1;
    },
  });
  await assert.rejects(client.request({ method: "GET", path: "/api/server/ping" }));
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);

  const redirectClient = new ImmichReadClient({
    apiKey: "secret-value",
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.invalid" } }),
  });
  await assert.rejects(redirectClient.request({ method: "GET", path: "/api/server/ping" }));
});

test("429 and selected 5xx responses use a finite retry budget", async () => {
  const statuses = [429, 503, 200];
  let calls = 0;
  let sleeps = 0;
  const client = new ImmichReadClient({
    apiKey: "secret-value",
    maxRetries: 2,
    retryDelayMs: 0,
    sleep: async () => {
      sleeps += 1;
    },
    fetchImpl: async () => {
      const status = statuses[calls] ?? 200;
      calls += 1;
      return new Response("{}", { status });
    },
  });
  await client.request({ method: "GET", path: "/api/server/ping" });
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});

test("Windows lexical/path containment guards reject protected and unsafe paths without filesystem access", () => {
  assert.equal(normalizeSafeWindowsPath("C:/synthetic/output"), "C:\\synthetic\\output");
  assert.throws(() => normalizeSafeWindowsPath("C:\\synthetic\\..\\outside"), ReadonlyPolicyError);
  assert.throws(() => normalizeSafeWindowsPath("\\\\server\\share\\photo"), ReadonlyPolicyError);
  assert.throws(() => normalizeSafeWindowsPath("C:\\synthetic\\report.txt:secret"), ReadonlyPolicyError);

  const sample = assertSampleRootAllowed("I:\\photos\\PHOTOMANAGER_TEST\\synthetic");
  assert.equal(sample, "I:\\photos\\PHOTOMANAGER_TEST\\synthetic");
  assert.throws(() => assertSampleRootAllowed("I:\\photos\\unmodified"), ReadonlyPolicyError);
  assert.throws(
    () => assertOperationalPathSafe("I:\\photos\\unmodified\\report", sample),
    ReadonlyPolicyError,
  );
  assert.throws(() => assertOperationalPathSafe("I:\\photos", sample), ReadonlyPolicyError);
  assert.throws(() => assertPathDisjoint("C:\\out", "C:\\out\\temp"), ReadonlyPolicyError);
});
