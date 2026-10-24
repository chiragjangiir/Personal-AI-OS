export * from "./admission.ts";
export * from "./canonical-ref.ts";
export * from "./canonical-issuer.ts";
export * from "./conflict-resolution.ts";
export * from "./context-compiler.ts";
export * from "./context-consumer-adapter.ts";
export * from "./derived-projection-service.ts";
export * from "./derived-query-merge.ts";
export * from "./deletion-attestation-adapter.ts";
export * from "./deletion-rebuild-service.ts";
export * from "./domain.ts";
export * from "./dream-candidates.ts";
export * from "./dream-run-service.ts";
export * from "./dream-application-service.ts";
export * from "./explicit-user-remember-service.ts";
export * from "./final-transcript-explicit-remember-adapter.ts";
export * from "./production-memory-ready.ts";
export * from "./production-memory-lifecycle.ts";
export * from "./memory-application-service.ts";
export * from "./memory-review-service.ts";
export * from "./ports.ts";
export * from "./rebuild-manifest.ts";

// Resolve same-named proposal types from the legacy rule modules above to the
// canonical closed T05 domain seam.  The explicit type exports also keep the
// stable foundation names available from the package barrel.
export type {
  CompilerQuery,
  EvidenceSourceClass,
  MemoryCandidateIntent,
  MemoryCandidateProposal,
  MemoryKind,
  MemoryQuerySnapshot,
  MemoryStatus,
  MemoryVersionRecord,
} from "./domain.ts";

export type {
  MemoryCanonicalAppendReceipt,
  MemoryCanonicalAppendWriter,
  MemoryCanonicalDeletionLifecycle,
  MemoryCanonicalVersionRead,
  MemoryCanonicalVersionReader,
  MemoryDeletionSuccessorReceipt,
} from "./ports.ts";
