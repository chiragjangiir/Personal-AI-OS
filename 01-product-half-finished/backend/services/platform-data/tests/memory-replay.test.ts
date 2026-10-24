import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryAuthorityRepository } from "../src/memory-authority-repository.ts";

test("memory migration keeps object versions as strict TEXT and down migration is non-destructive", async () => {
  const coreUp = await readFile(new URL("../../../migrations/0001_idempotency_outbox.up.sql", import.meta.url), "utf8");
  const up = await readFile(new URL("../../../migrations/0003_memory_authority.up.sql", import.meta.url), "utf8");
  const down = await readFile(new URL("../../../migrations/0003_memory_authority.down.sql", import.meta.url), "utf8");
  assert.match(up, /candidate_object_version TEXT NOT NULL/);
  assert.match(up, /memory_object_version TEXT NOT NULL/);
  assert.match(up, /memory_versions_object_version_ck/);
  assert.match(up, /watermark TEXT NOT NULL DEFAULT '1'/);
  assert.match(up, /UPDATE memory_authority_clock SET watermark = '1'[^;]*watermark = '0'/iu);
  assert.match(up, /ALTER TABLE memory_authority_clock ALTER COLUMN watermark SET DEFAULT '1'/iu);
  assert.match(up, /DROP CONSTRAINT IF EXISTS memory_authority_clock_watermark_check/iu);
  assert.match(up, /memory_versions_one_current_per_slot_uq/);
  assert.match(coreUp, /claim_token_sha256/);
  assert.doesNotMatch(up, /NUMERIC\s*\(/iu);
  assert.doesNotMatch(down, /\b(DROP|DELETE|TRUNCATE)\b/iu);
});

test("production repository exposes no fallback identity issuer", () => {
  const repository = new MemoryAuthorityRepository({ connect() { throw new Error("not called"); } } as never);
  assert.equal(repository.environment, "production");
  assert.equal(repository.canonicalIdentity, undefined);
});
