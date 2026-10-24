import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CredentialFenceError,
  createRealtimeCredentialFence,
  normalizeCredentialFenceTuple,
  type CredentialFenceTuple,
} from "../src/realtime-credential-fence.ts";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TUPLE: CredentialFenceTuple = Object.freeze({
  realtimeSessionRef: Object.freeze({
    ref_type: "RealtimeSession" as const,
    ref_id: "71111111-1111-7111-8111-111111111111",
    object_version: "1",
    canonical_payload_sha256: HASH,
  }),
  deviceLeaseRef: Object.freeze({
    ref_type: "DeviceLease" as const,
    ref_id: "72222222-2222-7211-8211-222222222222",
    object_version: "1",
    canonical_payload_sha256: HASH,
  }),
  continuityId: "continuity-fence-test",
  connectionEpoch: "9007199254740993",
  credentialGeneration: "9007199254740995",
});

class FakeClient {
  readonly statements: string[] = [];
  active = false;

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const query = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(query);
    if (query === "BEGIN" || query.startsWith("SET TRANSACTION") || query === "COMMIT" || query === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (query.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    if (query.includes("FROM public.realtime_external_effects")) {
      if (!this.active) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          effect_state: "in_flight",
          stage_state: { participant_disconnected: { state: "completed", updatedAt: "2026-09-01T00:00:00.000Z" } },
          fencing_epoch: "1",
          credential_generation: String(params[5]),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`UNHANDLED_FAKE_QUERY: ${query}`);
  }

  release(): void {}
}

export function credentialFenceFixture(): { readonly fence: ReturnType<typeof createRealtimeCredentialFence>; readonly client: FakeClient } {
  const client = new FakeClient();
  const pool = { connect: async () => client };
  return { fence: createRealtimeCredentialFence(pool as never), client };
}

