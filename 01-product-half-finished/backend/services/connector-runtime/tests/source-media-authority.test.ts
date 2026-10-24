import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SOURCE_MEDIA_CATALOG_PATH,
  SOURCE_MEDIA_PROCESS_ARG,
  SourceMediaAuthorityError,
  createSourceMediaAuthority,
  type SourceMediaIssueInput,
  type SourceVisualIssueInput,
  type SourceVisualMediaFormat,
} from "../src/source-media-authority.ts";

const NODE = process.execPath;
const SOURCE_MODULE = fileURLToPath(new URL("../src/source-media-authority.ts", import.meta.url));

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex");
}

function inputFor(tag: string, bytes: Uint8Array): SourceMediaIssueInput {
  return {
    userId: "t13-user-" + tag,
    realtimeSessionRef: { sessionRef: "t13-session-" + tag },
    continuityId: "t13-continuity-" + tag,
    purpose: "realtime-source-media",
    sessionId: "t13-session-id-" + tag,
    deviceId: "rayneo-x3pro-" + tag,
    clientInstanceId: "client-" + tag,
    segmentId: "segment-" + tag,
    startMs: 0,
    endMs: 1000,
    speakerLabel: "unknown",
    diarizationStatus: "window_local",
    observedAt: "2026-08-28T00:00:00.000Z",
    media: {
      format: "pcm_s16le",
      sampleRate: 16_000,
      channels: 1,
      sha256: hash(bytes),
      bytes,
    },
    idempotencyKey: "t13-source-media:" + tag,
    fingerprint: hash("fingerprint:" + tag),
  };
}

function issueProtocol(input: SourceMediaIssueInput): Record<string, unknown> {
  return {
    operation: "issue",
    user_id: input.userId,
    realtime_session_ref: input.realtimeSessionRef,
    continuity_id: input.continuityId,
    purpose: input.purpose,
    session_id: input.sessionId,
    device_id: input.deviceId,
    client_instance_id: input.clientInstanceId,
    segment_id: input.segmentId,
    start_ms: input.startMs,
    end_ms: input.endMs,
    speaker_label: input.speakerLabel,
    diarization_status: input.diarizationStatus,
    observed_at: input.observedAt,
    media: {
      format: input.media.format,
      sample_rate: input.media.sampleRate,
      channels: input.media.channels,
      sha256: input.media.sha256,
      bytes_base64: Buffer.from(input.media.bytes).toString("base64"),
    },
    idempotency_key: input.idempotencyKey,
    fingerprint: input.fingerprint,
  };
}

function visualInputFor(
  tag: string,
  bytes: Uint8Array,
  format: SourceVisualMediaFormat,
): SourceVisualIssueInput {
  return {
    userId: "t13-visual-user-" + tag,
    realtimeSessionRef: { sessionRef: "t13-visual-session-" + tag },
    continuityId: "t13-visual-continuity-" + tag,
    purpose: "realtime-source-visual",
    sessionId: "t13-visual-session-id-" + tag,
    deviceId: "rayneo-x3pro-" + tag,
    clientInstanceId: "visual-client-" + tag,
    captureId: "rayneo-capture-" + tag,
    capturedAt: "2026-08-28T00:00:01.000Z",
    media: {
      format,
      width: 2,
      height: 2,
      sha256: hash(bytes),
      bytes,
    },
    idempotencyKey: "t13-source-visual:" + tag,
    fingerprint: hash("visual-fingerprint:" + tag),
  };
}

function visualIssueProtocol(input: SourceVisualIssueInput): Record<string, unknown> {
  return {
    operation: "issue_visual",
    user_id: input.userId,
    realtime_session_ref: input.realtimeSessionRef,
    continuity_id: input.continuityId,
    purpose: input.purpose,
    session_id: input.sessionId,
    device_id: input.deviceId,
    client_instance_id: input.clientInstanceId,
    capture_id: input.captureId,
    captured_at: input.capturedAt,
    media: {
      format: input.media.format,
      width: input.media.width,
      height: input.media.height,
      sha256: input.media.sha256,
      bytes_base64: Buffer.from(input.media.bytes).toString("base64"),
    },
    idempotency_key: input.idempotencyKey,
    fingerprint: input.fingerprint,
  };
}

async function lineIterator(child: ChildProcessWithoutNullStreams): Promise<AsyncIterator<string>> {
  const chunks: string[] = [];
  let pendingResolve: ((line: string) => void) | undefined;
  let pendingReject: ((error: Error) => void) | undefined;
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (pendingResolve !== undefined) {
        const resolveLine = pendingResolve;
        pendingResolve = undefined;
        pendingReject = undefined;
        resolveLine(line);
      } else {
        chunks.push(line);
      }
    }
  });
  child.on("close", () => {
    if (pendingReject !== undefined) {
      pendingReject(new Error("source-media authority process closed before response"));
      pendingResolve = undefined;
      pendingReject = undefined;
    }
  });
  return {
    next: () =>
      new Promise<IteratorResult<string>>((resolveNext, rejectNext) => {
        const line = chunks.shift();
        if (line !== undefined) {
          resolveNext({ done: false, value: line });
          return;
        }
        pendingResolve = (value) => resolveNext({ done: false, value });
        pendingReject = rejectNext;
      }),
  };
}

async function startProcess(): Promise<{
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
}> {
  const child = spawn(NODE, ["--experimental-strip-types", SOURCE_MODULE, SOURCE_MEDIA_PROCESS_ARG], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await once(child, "spawn");
  const lines = await lineIterator(child);
  return { child, lines };
}

async function request(
  child: ChildProcessWithoutNullStreams,
  lines: AsyncIterator<string>,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  child.stdin.write(JSON.stringify(value) + "\n");
  const next = await lines.next();
  assert.equal(next.done, false);
  return JSON.parse(next.value) as Record<string, unknown>;
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  lines: AsyncIterator<string>,
): Promise<void> {
  const response = await request(child, lines, { operation: "close" });
  assert.deepEqual(response, { ok: true, closed: true });
  child.stdin.end();
  await once(child, "close");
}

test("source authority issues canonical refs and reads controlled PCM bytes", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255]);
  const authority = createSourceMediaAuthority();
  try {
    const receipt = await authority.issueWithReceipt(inputFor("direct", bytes));
    assert.equal(receipt.sourceArtifactRef.refType, "SourceArtifact");
    assert.equal(receipt.artifactVersionRef.refType, "ArtifactVersion");
    assert.equal(Object.keys(receipt.sourceArtifactRef).sort().join(","), "canonicalPayloadSha256,objectVersion,refId,refType");
    assert.equal(Object.keys(receipt.artifactVersionRef).sort().join(","), "canonicalPayloadSha256,objectVersion,refId,refType");
    const read = await authority.read({
      ref: receipt.artifactVersionRef,
      expectedContentSha256: receipt.contentSha256,
    });
    assert.deepEqual(Buffer.from(read.bytes), Buffer.from(bytes));
    assert.deepEqual(read.sourceArtifactRef, receipt.sourceArtifactRef);
    assert.deepEqual(read.artifactVersionRef, receipt.artifactVersionRef);
    assert.equal(read.contentSha256, hash(bytes));
  } finally {
    await authority.close();
  }
});

test("source authority issues native PNG and JPEG visual records", { concurrency: false }, async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const authority = createSourceMediaAuthority();
  try {
    for (const [tag, bytes, format] of [
      ["png", png, "image/png"],
      ["jpeg", jpeg, "image/jpeg"],
    ] as const) {
      const input = visualInputFor(tag, bytes, format);
      const receipt = await authority.issueVisualWithReceipt(input);
      assert.equal(receipt.mediaKind, "visual");
      assert.equal(receipt.captureId, input.captureId);
      assert.equal(receipt.capturedAt, input.capturedAt);
      assert.equal(receipt.format, format);
      assert.equal(receipt.width, 2);
      assert.equal(receipt.height, 2);
      const read = await authority.readVisual({
        ref: receipt.artifactVersionRef,
        expectedContentSha256: input.media.sha256,
      });
      assert.deepEqual(Buffer.from(read.bytes), Buffer.from(bytes));
      assert.deepEqual(read.sourceArtifactRef, receipt.sourceArtifactRef);
      assert.deepEqual(read.artifactVersionRef, receipt.artifactVersionRef);
      assert.equal(read.mediaKind, "visual");
    }
  } finally {
    await authority.close();
  }
});

test("visual authority rejects hash, dimension, format, and audio-field drift", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const valid = visualInputFor("negative", bytes, "image/png");
  const authority = createSourceMediaAuthority();
  try {
    const wrongHash: SourceVisualIssueInput = {
      ...valid,
      media: {
        ...valid.media,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
    await assert.rejects(
      authority.issueVisual(wrongHash),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_MEDIA_HASH_MISMATCH",
    );

    const wrongDimension: SourceVisualIssueInput = {
      ...valid,
      media: { ...valid.media, width: 0 },
    };
    await assert.rejects(
      authority.issueVisual(wrongDimension),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_INPUT_INVALID",
    );

    const wrongFormat: SourceVisualIssueInput = {
      ...valid,
      media: {
        ...valid.media,
        format: "pcm_s16le" as unknown as SourceVisualMediaFormat,
      },
    };
    await assert.rejects(
      authority.issueVisual(wrongFormat),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_INPUT_INVALID",
    );

    const withAudioFields = {
      ...valid,
      segmentId: "must-not-be-accepted",
      startMs: 0,
      endMs: 1,
      speakerLabel: "unknown",
      diarizationStatus: "degraded",
    } as unknown as SourceVisualIssueInput;
    await assert.rejects(
      authority.issueVisual(withAudioFields),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_INPUT_INVALID",
    );
  } finally {
    await authority.close();
  }
});

test("visual idempotency stays bound to capture and media identity", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const original = visualInputFor("binding-conflict", bytes, "image/jpeg");
  const authority = createSourceMediaAuthority();
  try {
    await authority.issueVisualWithReceipt(original);
    const bindingDrift: SourceVisualIssueInput = {
      ...original,
      userId: "different-visual-user",
    };
    await assert.rejects(
      authority.issueVisual(bindingDrift),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_IDEMPOTENCY_CONFLICT",
    );

    const mediaDriftBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x4a, 0x46]);
    const sameKeyDrift: SourceVisualIssueInput = {
      ...original,
      fingerprint: hash("visual-fingerprint-drift"),
      media: {
        ...original.media,
        bytes: mediaDriftBytes,
        sha256: hash(mediaDriftBytes),
      },
    };
    await assert.rejects(
      authority.issueVisual(sameKeyDrift),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_VISUAL_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await authority.close();
  }
});

test("source authority rejects a supplied media hash before CAS publication", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([10, 11, 12, 13]);
  const valid = inputFor("hash-negative", bytes);
  const invalid: SourceMediaIssueInput = {
    ...valid,
    media: {
      ...valid.media,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  };
  const authority = createSourceMediaAuthority();
  try {
    await assert.rejects(
      authority.issue(invalid),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_MEDIA_HASH_MISMATCH",
    );
  } finally {
    await authority.close();
  }
});

test("idempotency replay is bound to the original user and session", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([30, 31, 32, 33]);
  const original = inputFor("binding-conflict", bytes);
  const authority = createSourceMediaAuthority();
  try {
    await authority.issueWithReceipt(original);
    const drifted: SourceMediaIssueInput = {
      ...original,
      userId: "different-user",
    };
    await assert.rejects(
      authority.issue(drifted),
      (error: unknown) =>
        error instanceof SourceMediaAuthorityError &&
        error.code === "SOURCE_MEDIA_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await authority.close();
  }
});

test("stdio authority survives independent process restart and reads the same refs", { concurrency: false }, async () => {
  const bytes = Uint8Array.from([20, 21, 22, 23, 24, 25]);
  const input = inputFor("process-restart", bytes);
  const first = await startProcess();
  let issueResponse: Record<string, unknown>;
  try {
    issueResponse = await request(first.child, first.lines, issueProtocol(input));
    assert.equal(issueResponse.ok, true);
    assert.equal((issueResponse.artifact_version_ref as Record<string, unknown>).refType, "ArtifactVersion");
    await stopProcess(first.child, first.lines);
  } catch (error) {
    first.child.kill();
    throw error;
  }

  const second = await startProcess();
  try {
    const readResponse = await request(second.child, second.lines, {
      operation: "read",
      ref: issueResponse.artifact_version_ref,
      content_sha256: input.media.sha256,
    });
    assert.equal(readResponse.ok, true);
    assert.deepEqual(readResponse.source_artifact_ref, issueResponse.source_artifact_ref);
    assert.deepEqual(readResponse.artifact_version_ref, issueResponse.artifact_version_ref);
    assert.equal(readResponse.content_sha256, input.media.sha256);
    assert.deepEqual(
      Buffer.from(readResponse.bytes_base64 as string, "base64"),
      Buffer.from(bytes),
    );
    await stopProcess(second.child, second.lines);
  } catch (error) {
    second.child.kill();
    throw error;
  }
});

test("stdio visual authority survives restart with native refs and metadata", { concurrency: false }, async () => {
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const inputs = [
    visualInputFor("process-png", pngBytes, "image/png"),
    visualInputFor("process-jpeg", jpegBytes, "image/jpeg"),
  ];
  const first = await startProcess();
  const issueResponses: Record<string, unknown>[] = [];
  try {
    for (const input of inputs) {
      const response = await request(first.child, first.lines, visualIssueProtocol(input));
      assert.equal(response.ok, true);
      assert.equal(response.media_kind, "visual");
      assert.equal(response.capture_id, input.captureId);
      assert.equal(response.captured_at, input.capturedAt);
      assert.equal(response.format, input.media.format);
      assert.equal(response.width, input.media.width);
      assert.equal(response.height, input.media.height);
      issueResponses.push(response);
    }
    await stopProcess(first.child, first.lines);
  } catch (error) {
    first.child.kill();
    throw error;
  }

  const second = await startProcess();
  try {
    for (const [index, input] of inputs.entries()) {
      const issueResponse = issueResponses[index];
      assert.notEqual(issueResponse, undefined);
      const readResponse = await request(second.child, second.lines, {
        operation: "read_visual",
        ref: issueResponse?.artifact_version_ref,
        content_sha256: input.media.sha256,
      });
      assert.equal(readResponse.ok, true);
      assert.deepEqual(readResponse.source_artifact_ref, issueResponse?.source_artifact_ref);
      assert.deepEqual(readResponse.artifact_version_ref, issueResponse?.artifact_version_ref);
      assert.equal(readResponse.content_sha256, input.media.sha256);
      assert.equal(readResponse.media_kind, "visual");
      assert.equal(readResponse.capture_id, input.captureId);
      assert.equal(readResponse.captured_at, input.capturedAt);
      assert.equal(readResponse.format, input.media.format);
      assert.equal(readResponse.width, input.media.width);
      assert.equal(readResponse.height, input.media.height);
      assert.deepEqual(
        Buffer.from(readResponse.bytes_base64 as string, "base64"),
        Buffer.from(input.media.bytes),
      );
    }
    await stopProcess(second.child, second.lines);
  } catch (error) {
    second.child.kill();
    throw error;
  }

  const catalog = JSON.parse(await readFile(SOURCE_MEDIA_CATALOG_PATH, "utf8")) as {
    visualArtifacts?: Array<Record<string, unknown>>;
    visualVersions?: Array<Record<string, unknown>>;
  };
  assert.equal(Array.isArray(catalog.visualArtifacts), true);
  assert.equal(Array.isArray(catalog.visualVersions), true);
  assert.equal(
    inputs.every((input) =>
      catalog.visualVersions?.some(
        (version) =>
          version.mediaKind === "visual" &&
          version.captureId === input.captureId &&
          version.contentSha256 === input.media.sha256,
      ),
    ),
    true,
  );
});
