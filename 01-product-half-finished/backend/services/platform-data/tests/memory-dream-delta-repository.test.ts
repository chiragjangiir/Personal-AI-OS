import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalObjectVersionRef } from "../../memory-os/src/canonical-ref.ts";
import { createMemoryDreamDeltaRepository } from "../src/memory-dream-delta-repository.ts";

const ref = (type: "Observation" | "TextEvidence", id: string) => createCanonicalObjectVersionRef({
  refType: type,
  refId: `01900000-0000-7000-8000-${id.padStart(12, "0")}`,
  objectVersion: "1",
  canonicalPayloadSha256: "b".repeat(64),
});

test("Dream writer surface accepts only an explicit owner-accepted projection", async () => {
  const repo = createMemoryDreamDeltaRepository({ connect() { throw new Error("not called"); } } as never);
  assert.equal(typeof repo.writeAcceptedDreamDelta, "function");
  assert.equal(typeof repo.readAcceptedDreamDeltas, "function");
  await assert.rejects(() => repo.writeAcceptedDreamDelta({
    ref: ref("Observation", "1601"),
    userId: "fixture-user",
    accepted: false as never,
    delta: { text: "ordinary observation" },
    sourceRefs: [ref("TextEvidence", "1602")],
    acceptedAt: "2026-08-23T00:00:00.000Z",
    authorityWatermark: { owner: "fixture" },
    idempotencyKey: "fixture-dream",
    fingerprint: "c".repeat(64) as never,
  }), /owner-accepted|pool|accepted/i);
});
