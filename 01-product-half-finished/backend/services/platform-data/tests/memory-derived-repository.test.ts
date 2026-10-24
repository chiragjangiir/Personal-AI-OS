import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalObjectVersionRef, assertSha256 } from "../../memory-os/src/canonical-ref.ts";
import { createMemoryDerivedRepository } from "../src/memory-derived-repository.ts";

test("derived adapter exposes only authority ref, watermark, and config identity", () => {
  const repo = createMemoryDerivedRepository({ connect() { throw new Error("not called"); } } as never);
  assert.equal(typeof repo.writeProjection, "function");
  assert.equal(typeof repo.purgeAuthorityRefs, "function");
  const ref = createCanonicalObjectVersionRef({ refType: "PreferenceMemory", refId: "01900000-0000-7000-8000-000000001701", objectVersion: "1", canonicalPayloadSha256: "d".repeat(64) });
  const config = assertSha256("e".repeat(64));
  assert.deepEqual(Object.keys({ authorityRef: ref, authorityWatermark: { authority_seq: "1" }, configurationSha256: config }).sort(), ["authorityRef", "authorityWatermark", "configurationSha256"]);
});
