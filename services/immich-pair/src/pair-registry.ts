import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { assertNoReparseOrJunction, normalizeSafeWindowsPath } from "./readonly-policy";
import type {
  StackBatchApplyResult,
  StackBatchOperationState,
  StackBatchOperationView,
  StackBatchPairPlan,
  StackBatchPairState,
  StackBatchPairView,
  StackBatchPlan,
  StackBatchStatus,
  StackCreateReceipt,
  StackLiveBatchPlan,
  StackLiveBatchPlanV2,
} from "./stack-write-contracts";
import { deriveStackOperationId } from "./stack-write-policy";

export class PairRegistryError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PairRegistryError";
    this.code = code;
  }
}

interface RegistryOptions {
  registryId: string;
  deploymentId: string;
}

interface RegistryOperationRow {
  operation_id: string;
  pair_id: string;
  state: StackBatchOperationState;
  revision: number;
  attempt_count: number;
  response_stack_id: string | null;
  receipt_json: string | null;
  last_error: string | null;
  plan_digest: string;
}

interface RegistryPairRow {
  pair_id: string;
  state: StackBatchPairState;
  operation_id: string | null;
  managed_stack_id: string | null;
  revision: number;
}

function json(value: unknown): string { return JSON.stringify(value); }

function parseJson<T>(value: string, field: string): T {
  try { return JSON.parse(value) as T; } catch { throw new PairRegistryError("corrupt", `${field} contains invalid JSON`); }
}

function row<T>(value: unknown, field: string): T {
  if (value === undefined || value === null || typeof value !== "object") throw new PairRegistryError("not-found", `${field} was not found`);
  return value as T;
}

export class PairRegistry {
  public readonly filePath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(filePath: string, db: DatabaseSync) {
    this.filePath = filePath;
    this.db = db;
  }

  public static initialize(filePath: string, options: RegistryOptions): PairRegistry {
    const target = validateRegistryPath(filePath, true);
    const directory = process.platform === "win32" ? path.win32.dirname(target) : path.posix.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    if (process.platform === "win32") assertNoReparseOrJunction(directory);
    else assertNoPosixSymlinkOrReparse(directory);
    let db: DatabaseSync;
    try { db = new DatabaseSync(target); } catch { throw new PairRegistryError("open", "could not open the SQLite registry"); }
    const registry = new PairRegistry(target, db);
    try {
      registry.createSchema();
      registry.putInitialMeta(options);
      registry.migrateSchema();
      registry.assertMeta(options);
    } catch (error) {
      registry.close();
      if (error instanceof PairRegistryError) throw error;
      throw new PairRegistryError("schema", "could not initialize the SQLite registry schema");
    }
    return registry;
  }

  public static open(filePath: string, options?: Partial<RegistryOptions>): PairRegistry {
    const target = validateRegistryPath(filePath, false);
    if (!fs.existsSync(target)) throw new PairRegistryError("missing", "registry does not exist; status never creates a database");
    let db: DatabaseSync;
    try { db = new DatabaseSync(target); } catch { throw new PairRegistryError("open", "could not open the SQLite registry"); }
    const registry = new PairRegistry(target, db);
    try {
      registry.applyPragmas();
      registry.migrateSchema();
      registry.assertSchema();
      if (options?.registryId !== undefined && options?.deploymentId !== undefined) registry.assertMeta(options as RegistryOptions);
    } catch (error) {
      registry.close();
      if (error instanceof PairRegistryError) throw error;
      throw new PairRegistryError("schema", "registry schema is invalid or corrupt");
    }
    return registry;
  }

  private createSchema(): void {
    this.applyPragmas();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS registry_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS write_plans (
        plan_digest TEXT PRIMARY KEY NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batch_checkpoints (
        plan_digest TEXT PRIMARY KEY NOT NULL,
        next_index INTEGER NOT NULL,
        total_pairs INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_pairs (
        plan_digest TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        pair_index INTEGER NOT NULL,
        PRIMARY KEY (plan_digest,pair_id),
        UNIQUE (plan_digest,pair_index),
        FOREIGN KEY (plan_digest) REFERENCES write_plans(plan_digest),
        FOREIGN KEY (pair_id) REFERENCES pairs(pair_id)
      );
      CREATE TABLE IF NOT EXISTS pairs (
        pair_id TEXT PRIMARY KEY NOT NULL,
        plan_digest TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        jpg_asset_id TEXT NOT NULL,
        raw_asset_id TEXT NOT NULL,
        state TEXT NOT NULL,
        operation_id TEXT,
        managed_stack_id TEXT,
        revision INTEGER NOT NULL,
        FOREIGN KEY (plan_digest) REFERENCES write_plans(plan_digest)
      );
      CREATE TABLE IF NOT EXISTS asset_claims (
        asset_id TEXT PRIMARY KEY NOT NULL,
        pair_id TEXT NOT NULL,
        FOREIGN KEY (pair_id) REFERENCES pairs(pair_id)
      );
      CREATE TABLE IF NOT EXISTS authorizations (
        authorization_id TEXT PRIMARY KEY NOT NULL,
        plan_digest TEXT NOT NULL,
        confirmation_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_attempts INTEGER NOT NULL,
        consumed_attempts INTEGER NOT NULL,
        FOREIGN KEY (plan_digest) REFERENCES write_plans(plan_digest)
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        pair_id TEXT NOT NULL UNIQUE,
        plan_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        expected_before_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        response_stack_id TEXT,
        receipt_json TEXT,
        post_observation_json TEXT,
        last_error TEXT,
        FOREIGN KEY (pair_id) REFERENCES pairs(pair_id),
        FOREIGN KEY (plan_digest) REFERENCES write_plans(plan_digest)
      );
      CREATE TABLE IF NOT EXISTS operation_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        expected_before_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        response_stack_id TEXT,
        receipt_json TEXT,
        post_observation_json TEXT,
        last_error TEXT,
        archived_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        operation_id TEXT,
        pair_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        operation_id TEXT PRIMARY KEY NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
      );
      CREATE TABLE IF NOT EXISTS deployment_leases (
        deployment_id TEXT PRIMARY KEY NOT NULL,
        owner_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        expected_before_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        response_stack_id TEXT,
        receipt_json TEXT,
        post_observation_json TEXT,
        last_error TEXT,
        archived_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state);
      CREATE INDEX IF NOT EXISTS idx_pairs_state ON pairs(state);
    `);
  }

  private applyPragmas(): void {
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
  }

  private assertSchema(): void {
    const required = ["registry_meta", "write_plans", "batch_checkpoints", "pairs", "plan_pairs", "asset_claims", "authorizations", "operations", "operation_history", "journal_events", "receipts", "deployment_leases"];
    for (const name of required) {
      const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (found === undefined) throw new PairRegistryError("schema", `registry table is missing: ${name}`);
    }
  }

  private putInitialMeta(options: RegistryOptions): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT OR IGNORE INTO registry_meta(key,value) VALUES(?,?)");
    insert.run("schema_version", "2");
    insert.run("registry_id", options.registryId);
    insert.run("deployment_id", options.deploymentId);
    insert.run("created_at", now);
  }

  private migrateSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_pairs (
        plan_digest TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        pair_index INTEGER NOT NULL,
        PRIMARY KEY (plan_digest,pair_id),
        UNIQUE (plan_digest,pair_index),
        FOREIGN KEY (plan_digest) REFERENCES write_plans(plan_digest),
        FOREIGN KEY (pair_id) REFERENCES pairs(pair_id)
      );
      CREATE TABLE IF NOT EXISTS deployment_leases (
        deployment_id TEXT PRIMARY KEY NOT NULL,
        owner_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO plan_pairs(plan_digest,pair_id,pair_index)
        SELECT plan_digest,pair_id,rowid FROM pairs;
      UPDATE registry_meta SET value='2' WHERE key='schema_version' AND value='1';
    `);
  }

  private assertMeta(options: RegistryOptions): void {
    const get = (key: string): string => {
      const value = this.db.prepare("SELECT value FROM registry_meta WHERE key=?").get(key) as { value?: unknown } | undefined;
      if (value === undefined || typeof value.value !== "string") throw new PairRegistryError("meta", `registry metadata is missing: ${key}`);
      return value.value;
    };
    if (get("schema_version") !== "2") throw new PairRegistryError("schema", "unsupported registry schema version");
    if (get("registry_id") !== options.registryId) throw new PairRegistryError("registry-mismatch", "registryId does not match the batch plan");
    if (get("deployment_id") !== options.deploymentId) throw new PairRegistryError("deployment-mismatch", "deploymentId does not match the batch plan");
  }

  private transaction<T>(work: () => T): T {
    if (this.closed) throw new PairRegistryError("closed", "registry is already closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      if (error instanceof PairRegistryError) throw error;
      throw new PairRegistryError("transaction", "SQLite registry transaction failed");
    }
  }

  public preparePlan(plan: StackBatchPlan, now = new Date().toISOString()): { prepared: number; existing: number; blocked: number } {
    this.assertMeta({ registryId: plan.registryId, deploymentId: plan.deploymentId });
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO write_plans(plan_digest,plan_json,created_at) VALUES(?,?,?)").run(plan.planDigest, json(plan), now);
      const insertPair = this.db.prepare("INSERT INTO pairs(pair_id,plan_digest,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id,revision) VALUES(?,?,?,?,?,?,?,?,0)");
      const insertOperation = this.db.prepare("INSERT INTO operations(operation_id,pair_id,plan_digest,evidence_digest,expected_before_digest,request_digest,state,revision,attempt_count) VALUES(?,?,?,?,?,?,?,?,0)");
      const insertClaim = this.db.prepare("INSERT INTO asset_claims(asset_id,pair_id) VALUES(?,?)");
      const insertMembership = this.db.prepare("INSERT OR IGNORE INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,?)");
      let prepared = 0;
      let existing = 0;
      let blocked = 0;
      for (const [pairIndex, pair] of plan.pairs.entries()) {
        const old = this.db.prepare("SELECT pair_id,plan_digest,state FROM pairs WHERE pair_id=?").get(pair.pairId) as { pair_id: string; plan_digest: string; state: string } | undefined;
        if (old !== undefined) {
          if (old.plan_digest !== plan.planDigest) throw new PairRegistryError("pair-mismatch", "pair id is already bound to a different plan");
          insertMembership.run(plan.planDigest, pair.pairId, pairIndex);
          existing += 1;
          continue;
        }
        const conflict = this.db.prepare("SELECT asset_id,pair_id FROM asset_claims WHERE asset_id IN (?,?)").all(pair.jpgAssetId, pair.rawAssetId) as Array<{ asset_id: string; pair_id: string }>;
        if (conflict.length > 0) {
          insertPair.run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "BLOCKED", null);
          insertMembership.run(plan.planDigest, pair.pairId, pairIndex);
          this.appendJournal("PREPARE_BLOCKED_CLAIM", null, pair.pairId, { conflicts: conflict.map((entry) => entry.asset_id) }, now);
          blocked += 1;
          continue;
        }
        const opId = deriveStackOperationId(pair.pairId);
        insertPair.run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "PREPARED", opId);
        insertClaim.run(pair.jpgAssetId, pair.pairId);
        insertClaim.run(pair.rawAssetId, pair.pairId);
        insertOperation.run(opId, pair.pairId, plan.planDigest, plan.evidenceDigest, pair.expectedBeforeDigest, pair.requestDigest, "PREPARED", 0);
        insertMembership.run(plan.planDigest, pair.pairId, pairIndex);
        this.appendJournal("PREPARE", opId, pair.pairId, { planDigest: plan.planDigest }, now);
        prepared += 1;
      }
      this.db.prepare("INSERT INTO batch_checkpoints(plan_digest,next_index,total_pairs,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_digest) DO UPDATE SET total_pairs=excluded.total_pairs,updated_at=excluded.updated_at").run(plan.planDigest, 0, plan.pairs.length, now);
      return { prepared, existing, blocked };
    });
  }

  public prepareLiveSmokePair(plan: StackBatchPlan, pair: StackBatchPairPlan, operationId: string, now = new Date().toISOString()): { prepared: boolean; existing: boolean; blocked: boolean } {
    this.assertMeta({ registryId: plan.registryId, deploymentId: plan.deploymentId });
    if (plan.pairs.find((entry) => entry.pairId === pair.pairId) !== pair || operationId !== deriveStackOperationId(pair.pairId)) {
      throw new PairRegistryError("live-smoke-binding", "live-smoke pair or operation is not bound to the supplied plan");
    }
    return this.transaction(() => {
      const storedPlan = this.db.prepare("SELECT plan_json FROM write_plans WHERE plan_digest=?").get(plan.planDigest) as { plan_json: string } | undefined;
      if (storedPlan !== undefined && storedPlan.plan_json !== json(plan)) throw new PairRegistryError("plan-mismatch", "stored plan content does not match the supplied plan digest");
      this.db.prepare("INSERT OR IGNORE INTO write_plans(plan_digest,plan_json,created_at) VALUES(?,?,?)").run(plan.planDigest, json(plan), now);
      const old = this.db.prepare("SELECT pair_id,plan_digest,state,operation_id FROM pairs WHERE pair_id=?").get(pair.pairId) as { pair_id: string; plan_digest: string; state: string; operation_id: string | null } | undefined;
      if (old !== undefined) {
        if (old.plan_digest !== plan.planDigest || (old.operation_id !== null && old.operation_id !== operationId)) {
          throw new PairRegistryError("pair-mismatch", "live-smoke pair is already bound to a different plan or operation");
        }
        this.db.prepare("INSERT OR IGNORE INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,0)").run(plan.planDigest, pair.pairId);
        return { prepared: false, existing: true, blocked: old.state === "BLOCKED" || old.operation_id === null };
      }
      const conflicts = this.db.prepare("SELECT asset_id,pair_id FROM asset_claims WHERE asset_id IN (?,?)").all(pair.jpgAssetId, pair.rawAssetId) as Array<{ asset_id: string; pair_id: string }>;
      if (conflicts.length > 0) {
        this.db.prepare("INSERT INTO pairs(pair_id,plan_digest,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id,revision) VALUES(?,?,?,?,?,?,?,?,0)").run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "BLOCKED", null);
        this.db.prepare("INSERT INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,0)").run(plan.planDigest, pair.pairId);
        this.appendJournal("PREPARE_BLOCKED_CLAIM", null, pair.pairId, { mode: "LIVE_SMOKE", conflicts: conflicts.map((entry) => entry.asset_id) }, now);
        return { prepared: false, existing: false, blocked: true };
      }
      this.db.prepare("INSERT INTO pairs(pair_id,plan_digest,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id,revision) VALUES(?,?,?,?,?,?,?,?,0)").run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "PREPARED", operationId);
      this.db.prepare("INSERT INTO asset_claims(asset_id,pair_id) VALUES(?,?)").run(pair.jpgAssetId, pair.pairId);
      this.db.prepare("INSERT INTO asset_claims(asset_id,pair_id) VALUES(?,?)").run(pair.rawAssetId, pair.pairId);
      this.db.prepare("INSERT INTO operations(operation_id,pair_id,plan_digest,evidence_digest,expected_before_digest,request_digest,state,revision,attempt_count) VALUES(?,?,?,?,?,?,?,?,0)").run(operationId, pair.pairId, plan.planDigest, plan.evidenceDigest, pair.expectedBeforeDigest, pair.requestDigest, "PREPARED", 0);
      this.db.prepare("INSERT INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,0)").run(plan.planDigest, pair.pairId);
      this.appendJournal("PREPARE", operationId, pair.pairId, { mode: "LIVE_SMOKE", planDigest: plan.planDigest }, now);
      return { prepared: true, existing: false, blocked: false };
    });
  }

  public prepareLiveBatchPlan(plan: StackLiveBatchPlan | StackLiveBatchPlanV2, now = new Date().toISOString()): { prepared: number; existing: number; blocked: number } {
    this.assertMeta({ registryId: plan.registryId, deploymentId: plan.deploymentId });
    return this.transaction(() => {
      const storedPlan = this.db.prepare("SELECT plan_json FROM write_plans WHERE plan_digest=?").get(plan.planDigest) as { plan_json: string } | undefined;
      if (storedPlan !== undefined && storedPlan.plan_json !== json(plan)) throw new PairRegistryError("plan-mismatch", "stored live-batch plan content does not match its digest");
      this.db.prepare("INSERT OR IGNORE INTO write_plans(plan_digest,plan_json,created_at) VALUES(?,?,?)").run(plan.planDigest, json(plan), now);
      let prepared = 0;
      let existing = 0;
      let blocked = 0;
      for (const [pairIndex, pair] of plan.pairs.entries()) {
        const memberAssetIds = pair.assets.map((asset) => asset.assetId);
        const old = this.db.prepare("SELECT pair_id,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id FROM pairs WHERE pair_id=?").get(pair.pairId) as { pair_id: string; proposal_id: string; owner_id: string; jpg_asset_id: string; raw_asset_id: string; state: string; operation_id: string | null } | undefined;
        if (old !== undefined) {
          if (old.proposal_id !== pair.proposalId || old.owner_id !== pair.ownerId || old.jpg_asset_id !== pair.jpgAssetId || old.raw_asset_id !== pair.rawAssetId) throw new PairRegistryError("pair-mismatch", "canonical pair metadata differs from the live-batch plan");
          if (old.operation_id !== null) {
            const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(old.operation_id), "operation");
            const details = row<{ evidence_digest: string; expected_before_digest: string; request_digest: string }>(this.db.prepare("SELECT evidence_digest,expected_before_digest,request_digest FROM operations WHERE operation_id=?").get(old.operation_id), "operation details");
            const operationMatches = old.operation_id === deriveStackOperationId(pair.pairId)
              && details.evidence_digest === plan.sourceEvidenceDigest
              && details.expected_before_digest === pair.expectedBeforeDigest
              && details.request_digest === pair.requestDigest
              && operation.pair_id === pair.pairId;
            if (!operationMatches) {
              const canRestack = old.state === "REGISTERED"
                && operation.state === "COMMITTED"
                && pair.expectedBefore.classification === "NO_STACK"
                && old.operation_id === deriveStackOperationId(pair.pairId)
                && operation.pair_id === pair.pairId;
              if (!canRestack) throw new PairRegistryError("operation-mismatch", "canonical operation differs from the live-batch evidence");

              this.db.prepare(`
                INSERT INTO operation_history(
                  operation_id,pair_id,plan_digest,evidence_digest,expected_before_digest,request_digest,
                  state,revision,attempt_count,response_stack_id,receipt_json,post_observation_json,last_error,archived_at
                )
                SELECT operation_id,pair_id,plan_digest,evidence_digest,expected_before_digest,request_digest,
                  state,revision,attempt_count,response_stack_id,receipt_json,post_observation_json,last_error,?
                FROM operations WHERE operation_id=?
              `).run(now, old.operation_id);
              this.db.prepare("DELETE FROM receipts WHERE operation_id=?").run(old.operation_id);
              this.db.prepare(`
                UPDATE operations SET
                  plan_digest=?,evidence_digest=?,expected_before_digest=?,request_digest=?,
                  state='PREPARED',revision=revision+1,attempt_count=0,response_stack_id=NULL,
                  receipt_json=NULL,post_observation_json=NULL,last_error=NULL
                WHERE operation_id=?
              `).run(plan.planDigest, plan.sourceEvidenceDigest, pair.expectedBeforeDigest, pair.requestDigest, old.operation_id);
              this.db.prepare(`
                UPDATE pairs SET plan_digest=?,proposal_id=?,state='PREPARED',managed_stack_id=NULL,revision=revision+1
                WHERE pair_id=?
              `).run(plan.planDigest, pair.proposalId, pair.pairId);
              this.db.prepare("INSERT OR IGNORE INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,?)").run(plan.planDigest, pair.pairId, pairIndex);
              this.appendJournal("REPREPARE_AFTER_MANUAL_UNSTACK", old.operation_id, pair.pairId, { planDigest: plan.planDigest }, now);
              prepared += 1;
              continue;
            }
          }
          this.db.prepare("INSERT OR IGNORE INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,?)").run(plan.planDigest, pair.pairId, pairIndex);
          existing += 1;
          if (old.state === "BLOCKED" || old.operation_id === null) blocked += 1;
          continue;
        }
        const placeholders = memberAssetIds.map(() => "?").join(",");
        const conflicts = this.db.prepare(`SELECT asset_id,pair_id FROM asset_claims WHERE asset_id IN (${placeholders})`).all(...memberAssetIds) as Array<{ asset_id: string; pair_id: string }>;
        if (conflicts.length > 0) {
          this.db.prepare("INSERT INTO pairs(pair_id,plan_digest,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id,revision) VALUES(?,?,?,?,?,?,?,?,0)").run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "BLOCKED", null);
          this.db.prepare("INSERT INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,?)").run(plan.planDigest, pair.pairId, pairIndex);
          this.appendJournal("PREPARE_BLOCKED_CLAIM", null, pair.pairId, { mode: "LIVE_BATCH", conflicts: conflicts.map((entry) => entry.asset_id) }, now);
          blocked += 1;
          continue;
        }
        const operationId = deriveStackOperationId(pair.pairId);
        this.db.prepare("INSERT INTO pairs(pair_id,plan_digest,proposal_id,owner_id,jpg_asset_id,raw_asset_id,state,operation_id,revision) VALUES(?,?,?,?,?,?,?,?,0)").run(pair.pairId, plan.planDigest, pair.proposalId, pair.ownerId, pair.jpgAssetId, pair.rawAssetId, "PREPARED", operationId);
        const insertClaim = this.db.prepare("INSERT INTO asset_claims(asset_id,pair_id) VALUES(?,?)");
        for (const assetId of memberAssetIds) insertClaim.run(assetId, pair.pairId);
        this.db.prepare("INSERT INTO operations(operation_id,pair_id,plan_digest,evidence_digest,expected_before_digest,request_digest,state,revision,attempt_count) VALUES(?,?,?,?,?,?,?,?,0)").run(operationId, pair.pairId, plan.planDigest, plan.sourceEvidenceDigest, pair.expectedBeforeDigest, pair.requestDigest, "PREPARED", 0);
        this.db.prepare("INSERT INTO plan_pairs(plan_digest,pair_id,pair_index) VALUES(?,?,?)").run(plan.planDigest, pair.pairId, pairIndex);
        this.appendJournal("PREPARE", operationId, pair.pairId, { mode: "LIVE_BATCH", planDigest: plan.planDigest, sourcePlanDigest: plan.sourcePlanDigest }, now);
        prepared += 1;
      }
      this.db.prepare("INSERT INTO batch_checkpoints(plan_digest,next_index,total_pairs,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_digest) DO UPDATE SET total_pairs=excluded.total_pairs,updated_at=excluded.updated_at").run(plan.planDigest, 0, plan.pairs.length, now);
      return { prepared, existing, blocked };
    });
  }

  public acquireDeploymentLease(deploymentId: string, now = new Date().toISOString(), ttlMs = 24 * 60 * 60_000): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) throw new PairRegistryError("lease", "deployment lease TTL is invalid");
    const ownerToken = `lease-${randomBytes(24).toString("hex")}`;
    return this.transaction(() => {
      const current = this.db.prepare("SELECT owner_token,expires_at FROM deployment_leases WHERE deployment_id=?").get(deploymentId) as { owner_token: string; expires_at: string } | undefined;
      if (current !== undefined && Date.parse(current.expires_at) > Date.parse(now)) throw new PairRegistryError("lease-held", "another live-batch process holds the deployment lease");
      this.db.prepare("DELETE FROM deployment_leases WHERE deployment_id=?").run(deploymentId);
      this.db.prepare("INSERT INTO deployment_leases(deployment_id,owner_token,expires_at,acquired_at) VALUES(?,?,?,?)").run(deploymentId, ownerToken, new Date(Date.parse(now) + ttlMs).toISOString(), now);
      this.appendJournal("DEPLOYMENT_LEASE_ACQUIRED", null, null, { deploymentId }, now);
      return ownerToken;
    });
  }

  public releaseDeploymentLease(deploymentId: string, ownerToken: string, now = new Date().toISOString()): void {
    this.transaction(() => {
      const result = this.db.prepare("DELETE FROM deployment_leases WHERE deployment_id=? AND owner_token=?").run(deploymentId, ownerToken);
      if (Number(result.changes) === 1) this.appendJournal("DEPLOYMENT_LEASE_RELEASED", null, null, { deploymentId }, now);
    });
  }

  public createAuthorization(plan: StackBatchPlan | StackLiveBatchPlan | StackLiveBatchPlanV2, confirmationDigest: string, expiresAt: string, maxAttempts = plan.pairs.length, now = new Date().toISOString()): string {
    this.assertMeta({ registryId: plan.registryId, deploymentId: plan.deploymentId });
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new PairRegistryError("authorization", "authorization must have a positive attempt limit");
    const authorizationId = `auth-${plan.planDigest.slice(0, 32)}-${randomBytes(12).toString("hex")}`;
    this.transaction(() => {
      this.db.prepare("INSERT INTO authorizations(authorization_id,plan_digest,confirmation_digest,expires_at,max_attempts,consumed_attempts) VALUES(?,?,?,?,?,0)").run(authorizationId, plan.planDigest, confirmationDigest, expiresAt, maxAttempts);
      this.appendJournal("AUTHORIZATION_CREATED", null, null, { authorizationId, planDigest: plan.planDigest, expiresAt, maxAttempts }, now);
    });
    return authorizationId;
  }

  public getOperation(operationIdValue: string): StackBatchOperationView {
    const result = this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue) as RegistryOperationRow | undefined;
    const operation = row<RegistryOperationRow>(result, "operation");
    return this.operationView(operation);
  }

  public getOperationForPair(pairId: string): StackBatchOperationView | undefined {
    const result = this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE pair_id=?").get(pairId) as RegistryOperationRow | undefined;
    return result === undefined ? undefined : this.operationView(result);
  }

  private operationView(operation: RegistryOperationRow): StackBatchOperationView {
    const view: StackBatchOperationView = {
      operationId: operation.operation_id,
      pairId: operation.pair_id,
      state: operation.state,
      revision: operation.revision,
      attemptCount: operation.attempt_count,
      ...(operation.response_stack_id === null ? {} : { responseStackId: operation.response_stack_id }),
      ...(operation.receipt_json === null ? {} : { receipt: parseJson<StackCreateReceipt>(operation.receipt_json, "receipt") }),
      ...(operation.last_error === null ? {} : { lastError: operation.last_error }),
    };
    return view;
  }

  public recordDispatchIntent(operationIdValue: string, authorizationId: string, now = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state !== "PREPARED") return false;
      const auth = row<{ authorization_id: string; plan_digest: string; expires_at: string; max_attempts: number; consumed_attempts: number }>(this.db.prepare("SELECT authorization_id,plan_digest,expires_at,max_attempts,consumed_attempts FROM authorizations WHERE authorization_id=?").get(authorizationId), "authorization");
      const membership = this.db.prepare("SELECT 1 AS ok FROM plan_pairs WHERE plan_digest=? AND pair_id=?").get(auth.plan_digest, operation.pair_id);
      if (auth.plan_digest !== operation.plan_digest && membership === undefined) throw new PairRegistryError("authorization-mismatch", "authorization plan does not contain this canonical operation");
      if (Date.parse(auth.expires_at) <= Date.parse(now)) throw new PairRegistryError("authorization-expired", "batch authorization has expired");
      if (auth.consumed_attempts >= auth.max_attempts) throw new PairRegistryError("authorization-exhausted", "batch authorization attempt budget is exhausted");
      const changed = this.db.prepare("UPDATE operations SET state='DISPATCH_INTENT',revision=revision+1,attempt_count=attempt_count+1 WHERE operation_id=? AND state='PREPARED' AND revision=?").run(operationIdValue, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before dispatch intent");
      this.db.prepare("UPDATE authorizations SET consumed_attempts=consumed_attempts+1 WHERE authorization_id=? AND consumed_attempts<?").run(authorizationId, auth.max_attempts);
      this.appendJournal("DISPATCH_INTENT", operationIdValue, operation.pair_id, { authorizationId, attempt: operation.attempt_count + 1 }, now);
      return true;
    });
  }

  public recordAcknowledgement(operationIdValue: string, receipt: StackCreateReceipt, now = new Date().toISOString()): void {
    this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "ACKNOWLEDGED" || operation.state === "COMMITTED") return;
      if (operation.state !== "DISPATCH_INTENT") throw new PairRegistryError("invalid-transition", "only a persisted dispatch intent can be acknowledged");
      const changed = this.db.prepare("UPDATE operations SET state='ACKNOWLEDGED',revision=revision+1,response_stack_id=?,receipt_json=? WHERE operation_id=? AND state='DISPATCH_INTENT' AND revision=?").run(receipt.id, json(receipt), operationIdValue, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before acknowledgement");
      this.db.prepare("INSERT OR REPLACE INTO receipts(operation_id,receipt_json,created_at) VALUES(?,?,?)").run(operationIdValue, json(receipt), now);
      this.appendJournal("ACKNOWLEDGED", operationIdValue, operation.pair_id, { stackId: receipt.id }, now);
    });
  }

  public markUncertain(operationIdValue: string, reason: string, now = new Date().toISOString()): void {
    this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "UNCERTAIN") return;
      if (operation.state === "COMMITTED" || operation.state === "BLOCKED") return;
      const changed = this.db.prepare("UPDATE operations SET state='UNCERTAIN',revision=revision+1,last_error=? WHERE operation_id=? AND state=? AND revision=?").run(reason.slice(0, 500), operationIdValue, operation.state, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before uncertain transition");
      this.appendJournal("UNCERTAIN", operationIdValue, operation.pair_id, { reason: reason.slice(0, 500) }, now);
    });
  }

  public markUnattributed(operationIdValue: string, reason: string, now = new Date().toISOString()): void {
    this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "COMMITTED" || operation.state === "BLOCKED") return;
      if (operation.state !== "UNCERTAIN" && operation.state !== "DISPATCH_INTENT" && operation.state !== "ACKNOWLEDGED") throw new PairRegistryError("invalid-transition", "only an uncertain dispatch can become unattributed");
      if (operation.state !== "UNCERTAIN") {
        const changed = this.db.prepare("UPDATE operations SET state='UNCERTAIN',revision=revision+1,last_error=? WHERE operation_id=? AND state=? AND revision=?").run(reason.slice(0, 500), operationIdValue, operation.state, operation.revision);
        if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before unattributed transition");
      }
      this.db.prepare("UPDATE pairs SET state='UNATTRIBUTED',revision=revision+1 WHERE pair_id=? AND state IN ('PREPARED','UNATTRIBUTED')").run(operation.pair_id);
      this.appendJournal("UNATTRIBUTED", operationIdValue, operation.pair_id, { reason: reason.slice(0, 500) }, now);
    });
  }

  public markBlocked(operationIdValue: string, state: "BLOCKED" | "DRIFTED", reason: string, now = new Date().toISOString()): void {
    this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "COMMITTED") return;
      if (operation.state !== "PREPARED" && operation.state !== "ACKNOWLEDGED" && operation.state !== "DISPATCH_INTENT" && operation.state !== "UNCERTAIN") return;
      this.db.prepare("UPDATE operations SET state='BLOCKED',revision=revision+1,last_error=? WHERE operation_id=? AND revision=?").run(reason.slice(0, 500), operationIdValue, operation.revision);
      this.db.prepare("UPDATE pairs SET state=?,revision=revision+1 WHERE pair_id=?").run(state, operation.pair_id);
      this.appendJournal("BLOCKED", operationIdValue, operation.pair_id, { state, reason: reason.slice(0, 500) }, now);
    });
  }

  public retryTransientPreReadFailure(operationIdValue: string, now = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "PREPARED") return false;
      const transientPrefix = "fresh pre-write Asset read failed:";
      if (operation.state !== "BLOCKED" || operation.attempt_count !== 0 || operation.response_stack_id !== null || operation.receipt_json !== null || !operation.last_error?.startsWith(transientPrefix)) {
        throw new PairRegistryError("retry-pre-read", "only a zero-attempt transient pre-read failure can be retried");
      }
      const pair = row<{ state: string }>(this.db.prepare("SELECT state FROM pairs WHERE pair_id=?").get(operation.pair_id), "pair");
      if (pair.state !== "BLOCKED") throw new PairRegistryError("retry-pre-read", "transient pre-read retry requires a blocked pair");
      const changed = this.db.prepare("UPDATE operations SET state='PREPARED',revision=revision+1,last_error=NULL WHERE operation_id=? AND state='BLOCKED' AND revision=?").run(operationIdValue, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before transient pre-read retry");
      this.db.prepare("UPDATE pairs SET state='PREPARED',revision=revision+1 WHERE pair_id=? AND state='BLOCKED'").run(operation.pair_id);
      this.appendJournal("RETRY_TRANSIENT_PRE_READ", operationIdValue, operation.pair_id, { previousError: operation.last_error }, now);
      return true;
    });
  }

  public retryUnreceiptedNoStack(operationIdValue: string, observation: unknown, now = new Date().toISOString()): boolean {
    return this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "PREPARED") return false;
      if (operation.state !== "UNCERTAIN" || operation.attempt_count < 1 || operation.response_stack_id !== null || operation.receipt_json !== null || !operation.last_error?.startsWith("live-smoke POST result is unknown;")) {
        throw new PairRegistryError("retry-no-stack", "only an unreceipted uncertain dispatch can be retried after a fresh NO_STACK observation");
      }
      const changed = this.db.prepare("UPDATE operations SET state='PREPARED',revision=revision+1,post_observation_json=?,last_error=NULL WHERE operation_id=? AND state='UNCERTAIN' AND revision=?").run(json(observation), operationIdValue, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before NO_STACK retry");
      this.appendJournal("RETRY_UNRECEIPTED_NO_STACK", operationIdValue, operation.pair_id, { previousError: operation.last_error, attemptCount: operation.attempt_count }, now);
      return true;
    });
  }

  public commit(operationIdValue: string, stackId: string, postObservation: unknown, now = new Date().toISOString()): void {
    this.transaction(() => {
      const operation = row<RegistryOperationRow>(this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations WHERE operation_id=?").get(operationIdValue), "operation");
      if (operation.state === "COMMITTED") return;
      if ((operation.state !== "ACKNOWLEDGED" && operation.state !== "UNCERTAIN") || operation.response_stack_id !== stackId || operation.receipt_json === null) throw new PairRegistryError("commit-gate", "commit requires a persisted matching acknowledgement");
      const changed = this.db.prepare("UPDATE operations SET state='COMMITTED',revision=revision+1,post_observation_json=?,last_error=NULL WHERE operation_id=? AND state=? AND revision=?").run(json(postObservation), operationIdValue, operation.state, operation.revision);
      if (Number(changed.changes) !== 1) throw new PairRegistryError("revision", "operation revision changed before commit");
      this.db.prepare("UPDATE pairs SET state='REGISTERED',managed_stack_id=?,revision=revision+1 WHERE pair_id=?").run(stackId, operation.pair_id);
      this.appendJournal("COMMITTED", operationIdValue, operation.pair_id, { stackId }, now);
    });
  }

  public checkpoint(planDigest: string, nextIndex: number, totalPairs: number, now = new Date().toISOString()): void {
    if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || !Number.isSafeInteger(totalPairs) || totalPairs < 0 || nextIndex > totalPairs) throw new PairRegistryError("checkpoint", "checkpoint index is invalid");
    this.transaction(() => {
      this.db.prepare("INSERT INTO batch_checkpoints(plan_digest,next_index,total_pairs,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_digest) DO UPDATE SET next_index=excluded.next_index,total_pairs=excluded.total_pairs,updated_at=excluded.updated_at").run(planDigest, nextIndex, totalPairs, now);
      this.appendJournal("CHECKPOINT", null, null, { planDigest, nextIndex, totalPairs }, now);
    });
  }

  public status(planDigest?: string): StackBatchStatus {
    const meta = (key: string): string => String((this.db.prepare("SELECT value FROM registry_meta WHERE key=?").get(key) as { value: unknown } | undefined)?.value ?? "");
    const checkpoint = (planDigest === undefined
      ? this.db.prepare("SELECT plan_digest,next_index,total_pairs,updated_at FROM batch_checkpoints ORDER BY updated_at DESC LIMIT 1").get()
      : this.db.prepare("SELECT plan_digest,next_index,total_pairs,updated_at FROM batch_checkpoints WHERE plan_digest=?").get(planDigest)) as { plan_digest: string; next_index: number; total_pairs: number; updated_at: string } | undefined;
    const counts = { prepared: 0, dispatchIntent: 0, acknowledged: 0, uncertain: 0, committed: 0, blocked: 0, registered: 0, unattributed: 0, drifted: 0 };
    const operationRows = (planDigest === undefined
      ? this.db.prepare("SELECT operation_id,pair_id,state,revision,attempt_count,response_stack_id,receipt_json,last_error,plan_digest FROM operations ORDER BY rowid").all()
      : this.db.prepare("SELECT o.operation_id,o.pair_id,o.state,o.revision,o.attempt_count,o.response_stack_id,o.receipt_json,o.last_error,o.plan_digest FROM plan_pairs pp JOIN operations o ON o.pair_id=pp.pair_id WHERE pp.plan_digest=? ORDER BY pp.pair_index").all(planDigest)) as RegistryOperationRow[];
    for (const operation of operationRows) {
      if (operation.state === "PREPARED") counts.prepared += 1;
      else if (operation.state === "DISPATCH_INTENT") counts.dispatchIntent += 1;
      else if (operation.state === "ACKNOWLEDGED") counts.acknowledged += 1;
      else if (operation.state === "UNCERTAIN") counts.uncertain += 1;
      else if (operation.state === "COMMITTED") counts.committed += 1;
      else if (operation.state === "BLOCKED") counts.blocked += 1;
    }
    const pairRows = (planDigest === undefined
      ? this.db.prepare("SELECT pair_id,state,operation_id,managed_stack_id,revision FROM pairs ORDER BY rowid").all()
      : this.db.prepare("SELECT p.pair_id,p.state,p.operation_id,p.managed_stack_id,p.revision FROM plan_pairs pp JOIN pairs p ON p.pair_id=pp.pair_id WHERE pp.plan_digest=? ORDER BY pp.pair_index").all(planDigest)) as RegistryPairRow[];
    const pairs = pairRows.map((pair) => {
      if (pair.state === "REGISTERED") counts.registered += 1;
      else if (pair.state === "UNATTRIBUTED") counts.unattributed += 1;
      else if (pair.state === "DRIFTED") counts.drifted += 1;
      return { pairId: pair.pair_id, state: pair.state, ...(pair.operation_id === null ? {} : { operationId: pair.operation_id }), ...(pair.managed_stack_id === null ? {} : { managedStackId: pair.managed_stack_id }), revision: pair.revision } satisfies StackBatchPairView;
    });
    return {
      registryPath: this.filePath,
      registryId: meta("registry_id"),
      deploymentId: meta("deployment_id"),
      ...(checkpoint === undefined ? (planDigest === undefined ? {} : { planDigest }) : { planDigest: checkpoint.plan_digest }),
      checkpoint: checkpoint === undefined ? { nextIndex: 0, totalPairs: 0 } : { nextIndex: checkpoint.next_index, totalPairs: checkpoint.total_pairs, updatedAt: checkpoint.updated_at },
      counts,
      attempts: operationRows.reduce((sum, operation) => sum + operation.attempt_count, 0),
      journalEvents: planDigest === undefined
        ? Number((this.db.prepare("SELECT COUNT(*) AS count FROM journal_events").get() as { count: number }).count)
        : Number((this.db.prepare("SELECT COUNT(*) AS count FROM journal_events WHERE operation_id IN (SELECT o.operation_id FROM plan_pairs pp JOIN operations o ON o.pair_id=pp.pair_id WHERE pp.plan_digest=?) OR pair_id IN (SELECT pair_id FROM plan_pairs WHERE plan_digest=?) OR instr(payload_json, ?) > 0").get(planDigest, planDigest, planDigest) as { count: number }).count),
      operations: operationRows.map((operation) => this.operationView(operation)),
      pairs,
    };
  }

  public close(): void {
    if (!this.closed) { this.closed = true; this.db.close(); }
  }

  private appendJournal(eventType: string, operationIdValue: string | null, pairId: string | null, payload: unknown, createdAt: string): void {
    this.db.prepare("INSERT INTO journal_events(event_type,operation_id,pair_id,payload_json,created_at) VALUES(?,?,?,?,?)").run(eventType, operationIdValue, pairId, json(payload), createdAt);
  }
}

function validateRegistryPath(filePath: string, allowMissing: boolean): string {
  let target: string;
  if (process.platform === "win32") {
    try { target = normalizeSafeWindowsPath(filePath); } catch { throw new PairRegistryError("path", "registry path must be an absolute safe Windows path"); }
    if (path.win32.basename(target).toLowerCase() !== "pairs.sqlite") throw new PairRegistryError("path", "registry filename must be pairs.sqlite");
    if (!allowMissing && fs.existsSync(target)) {
      try { if (!fs.statSync(target).isFile()) throw new Error("not file"); } catch { throw new PairRegistryError("path", "registry path is not a regular file"); }
    }
    assertNoReparseOrJunction(path.win32.dirname(target));
    return target;
  }

  try { target = normalizeSafePosixPath(filePath); } catch { throw new PairRegistryError("path", "registry path must be an absolute safe POSIX path"); }
  if (path.posix.basename(target) !== "pairs.sqlite") throw new PairRegistryError("path", "registry filename must be pairs.sqlite");
  if (!allowMissing && fs.existsSync(target)) {
    try { if (!fs.statSync(target).isFile()) throw new Error("not file"); } catch { throw new PairRegistryError("path", "registry path is not a regular file"); }
  }
  // POSIX has no Windows junction/reparse-point equivalent. Walking existing
  // ancestors and the target with lstat rejects the applicable escape class:
  // symbolic links, including dangling links, before SQLite opens the file.
  assertNoPosixSymlinkOrReparse(target);
  return target;
}

function normalizeSafePosixPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("invalid path");
  if (!path.posix.isAbsolute(value) || value.includes("\\")) throw new Error("invalid POSIX path");
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") throw new Error("path traversal");
  }
  return path.posix.normalize(value);
}

function assertNoPosixSymlinkOrReparse(value: string): void {
  const segments = path.posix.normalize(value).split("/").filter(Boolean);
  let current = "/";
  for (const segment of segments) {
    current = path.posix.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") break;
      throw new PairRegistryError("path", "could not validate a registry path boundary");
    }
    if (stats.isSymbolicLink()) throw new PairRegistryError("path", "symbolic links are not allowed in the registry path");
  }
}
