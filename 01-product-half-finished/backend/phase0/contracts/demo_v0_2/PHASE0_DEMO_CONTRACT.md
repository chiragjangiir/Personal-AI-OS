# Phase 0 Demo Session / Event / RTC Contract

**Status:** `NON_CANONICAL / EPHEMERAL / PHASE0_ONLY`  
**Schema version:** `phase0-demo/0.2`  
**Event namespace:** `paios.phase0.demo.*`  
**Gate scope:** P0-01 through P0-05 only  

## 1. Authority and boundary

This contract exists only to make the Phase 0 terminal-loop demonstration interoperable. It is not a Phase 1 domain contract, does not amend the Canonical Glossary, and creates no authoritative personal state. It MUST NOT be imported into `/contracts`, used as a database migration source, or treated as evidence that Memory, Context, Governance, Device Registry, or Tool Gateway has been unfrozen.

The only permitted shape is:

```text
real device signal
  -> upstream transport / official SDK
  -> Phase 0 event envelope or media reference
  -> Windows Demo Gateway and temporary session
  -> model result
  -> one selected delivery device
```

LiveKit remains the RTC transport. This contract maps identifiers and payloads onto LiveKit; it does not reimplement WebRTC, signaling, codecs, reconnection, or media transport.

## 2. Frozen invariants

1. Every interoperable event uses `schema_version = "phase0-demo/0.2"` and an `event_type` in `paios.phase0.demo.*`.
2. Every event is session-scoped, expiring, non-authoritative, and removable. PostgreSQL is not required and no Phase 0 event becomes a personal fact.
3. The event envelope carries JSON metadata only. Audio, images, and video are transported by an upstream media track or an ephemeral object and appear in events only as `media_ref` metadata.
4. A Watch never masquerades as an RTC participant. Apple Watch data travels `WatchConnectivity -> paired iPhone -> LiveKit`, while the original Watch identity and sequence are preserved in `origin`.
5. A final transcript may enter the model path. Interim transcript text is display-only upstream state and MUST NOT be emitted as `paios.phase0.demo.transcript.final`.
6. A model result is explicitly `non_authoritative: true`. It cannot update Memory, Personal Model, Relationship, policy, consent, or authorization.
7. One session has one active delivery device lease. Every delivery request names exactly one target and sets `suppress_other_devices: true`.
8. Idempotency and ordering survive reconnects. A reconnect changes `connection.id`, increments `connection.epoch` by exactly one, and does not reset or fabricate a logical stream's acknowledged `sequence.number`.
9. LiveKit credentials and provider secrets are out-of-band. Credential-like keys and values, including a credential pasted into `error.message`, are forbidden in events, fixtures, logs, and the temporary store.
10. A session has one start and a closed lifecycle. End/cleanup without start, a second start, any event after cleanup, and a false-zero cleanup receipt are hard rejects. Phase 0 cleanup does not prove Phase 1 deletion semantics.
11. The sole Gateway RTC publisher ID is `windows_gateway_01`. Its `participant.identity`, participant `attributes.device_id`, and every Gateway-owned event `origin.device_id` are exactly equal; aliases are forbidden.
12. The Gateway may publish or reconnect-replay only Gateway-owned envelopes with that exact origin. It is not a generic relay. Watch through its paired iPhone remains the sole relay defined by this version.
13. A session and every retry/replay stream use exactly one `schema_version`. `phase0-demo/0.1` and `phase0-demo/0.2` never mix or translate within a session.

## 3. Event envelope

The machine-readable authority is [`session-event.schema.json`](./session-event.schema.json). All properties are closed; consumers MUST reject unknown fields instead of guessing their meaning.

| Field | Meaning |
|---|---|
| `schema_version` | Exact compatibility boundary, fixed to `phase0-demo/0.2`. |
| `event_type` | Closed namespaced discriminator. |
| `event_id` | UUID for this emitted envelope. |
| `session_id` | Opaque temporary session identifier; maps to one LiveKit room. |
| `trace_id` | UUID shared by one user-visible task timeline. |
| `occurred_at` | Source-observed UTC time. |
| `expires_at` | Hard upper bound for event availability; cleanup may remove it earlier. |
| `origin` | Physical origin device and optional relay. |
| `connection` | Current transport connection and monotonically increasing reconnect epoch. |
| `sequence` | Monotonic number within `(session_id, origin.device_id, stream_id)`. |
| `idempotency_key` | Retry identity within a session. |
| `payload` | Event-specific, closed payload selected by `event_type`. |

### 3.1 Idempotency

- The gateway MUST enforce uniqueness of both `event_id` and `(session_id, idempotency_key)` before display, model invocation, delivery, or state mutation.
- Before cleanup, the sole retry no-op is retransmission of the identical canonical envelope: the same `schema_version`, `event_type`, `event_id`, `session_id`, `trace_id`, `occurred_at`, `expires_at`, complete `origin` (including relay), complete `connection`, complete `sequence`, `idempotency_key`, and `payload`.
- Any drift in that canonical envelope is a conflict. Reusing the idempotency key is `IDEMPOTENCY_CONFLICT`; reusing only the event ID is `EVENT_ID_CONFLICT`.
- Receive time, attempt count, socket identity, and other receive metadata are outside the event envelope. They may vary without changing the retransmitted canonical bytes and MUST NOT be inserted into the event.
- Cleanup terminality is evaluated before retry dedupe. After cleanup, an old event's exact envelope is `EVENT_AFTER_CLEANUP`; at most the identical `session.cleanup.completed` receipt itself remains a no-op.

### 3.2 Sequence and reconnect

- Sequence starts at `1` for each logical stream and increases strictly.
- Events numbered `2` or above include `previous_event_id` from the same stream.
- A gap is observable and may be reported; consumers MUST NOT invent missing events.
- `paios.phase0.demo.connection.reconnected` carries the old/new connection IDs, the last acknowledged sequence, and the first replay sequence.
- The first replay may repeat a previously accepted event only as the exact canonical-envelope retry defined above.
- Reconnect MUST preserve `session_id`, `origin.device_id`, and `sequence.stream_id`; `connection.epoch` must equal the previously observed epoch plus one. The new `connection.id` differs from every ID previously used by that RTC publisher, and `resumed_from_connection_id` names the immediately current old ID rather than any older connection.
- `last_acked_sequence` equals the actually observed head of the resumed logical stream, and `replay_from_sequence` equals both `last_acked_sequence + 1` and the reconnect event's sequence number. A producer cannot claim an unseen acknowledgement range.

### 3.3 Cross-event bindings and lifecycle

- Payload `device_id`, when present, equals `origin.device_id`.
- A confirmation response binds the referenced request's session, `confirmation_id`, target responder, and allowed choice.
- Model inputs/results, delivery references, and handoff completions cannot reference another session. Model result modalities are a subset of those requested.
- A capture stop closes that `(session_id, origin.device_id, capture_kind, sequence.stream_id)` stream. A later capture start requires a new `sequence.stream_id`; restarting the stopped stream cannot re-enable later transcript/frame output.
- Exactly one non-retry `session.started` opens a session. End and cleanup require that start; cleanup is terminal for subsequent events, and `cleanup.completed_at` cannot precede `session.ended_at`.
- The compatibility test implements these rules as a deterministic reference validator only. Consumer A still must enforce them in its own granted runtime; this contract does not implement or approve that runtime.

## 4. Event catalog

| Event | Required purpose |
|---|---|
| `paios.phase0.demo.session.started` | Open a bounded temporary session and name its active device. |
| `paios.phase0.demo.session.ended` | Stop inputs/outputs and request cleanup. |
| `paios.phase0.demo.session.cleanup.completed` | Non-personal receipt that temporary state/media references were removed. |
| `paios.phase0.demo.device.status` | Display online/offline status and upstream capabilities. |
| `paios.phase0.demo.device.telemetry` | Ephemeral Gate telemetry such as battery, temperature, FPS, and RTT. |
| `paios.phase0.demo.capture.status` | Make explicit audio/location/workout/camera capture visible and stoppable. |
| `paios.phase0.demo.transcript.final` | Carry only a finalized transcript for the model path. |
| `paios.phase0.demo.location.observed` | Carry one foreground/authorized location or activity observation. |
| `paios.phase0.demo.workout.metric` | Carry Watch Workout metrics through the paired iPhone relay. |
| `paios.phase0.demo.confirmation.requested` | Ask one target device for a bounded choice. |
| `paios.phase0.demo.confirmation.responded` | Return the selected choice, preserving the physical origin. |
| `paios.phase0.demo.media.referenced` | Announce an upstream/ephemeral media object without embedding bytes. |
| `paios.phase0.demo.model.requested` | Bind model input event IDs and requested output modalities. |
| `paios.phase0.demo.model.result` | Return non-authoritative text, audio reference, or AR card output. |
| `paios.phase0.demo.delivery.requested` | Route one result to exactly one active device. |
| `paios.phase0.demo.delivery.acknowledged` | Record rendered/played/failed/stale-lease disposition. |
| `paios.phase0.demo.handoff.requested` | Request active-device transfer using an expected lease version. |
| `paios.phase0.demo.handoff.completed` | Confirm a higher lease version and suppression of the old output. |
| `paios.phase0.demo.connection.reconnected` | Record resumable transport recovery without resetting logical order. |

## 5. Device and relay rules

Allowed Phase 0 device classes are `windows_gateway`, `iphone`, `apple_watch`, `rayneo`, and `web_mobile`.

For `origin.device_class = windows_gateway`:

- the canonical RTC publisher device ID is exactly `windows_gateway_01`;
- `participant.identity`, participant `attributes.device_id`, and `origin.device_id` are exactly `windows_gateway_01`;
- `windows-gateway`, `windows_gateway`, and other aliases are hard rejects;
- the participant may publish only Gateway-owned origins, including reconnect replay;
- preserving a Web, iPhone, Watch, RayNeo, agent, or other foreign origin under the Gateway participant is an unauthorized generic relay and is rejected.

For `origin.device_class = apple_watch`:

- `origin.relay` is mandatory;
- `relay_device_class` is exactly `iphone`;
- `transport` is exactly `watch_connectivity`;
- `relay_device_id` differs from the Watch `device_id`;
- the LiveKit participant is the relay iPhone, but dedupe and sequence keys use the Watch `origin.device_id`.

Non-Watch origins MUST NOT add a relay object in this version. A native Watch-to-RTC path requires a future contract version and cannot be silently introduced.

## 6. Media and model result

`media_ref` is non-authoritative metadata, not media content. `locator` may use only `livekit://` or `ephemeral://` and MUST NOT contain credentials, user-info, query, fragment, or a signed URL. Its own `expires_at` cannot exceed the enclosing event's expiry or actual session end plus 60 minutes. Every `ephemeral_object` includes a positive `byte_length` and lowercase SHA-256. `kind` and `mime_type` must agree (`audio/*`, `image/*`, or `video/*`).

For `transport = livekit_track`, the sole locator grammar is `livekit://<session_id>/<rtc_publisher_identity>/<publication_sid>`. The three path components are unescaped contract identifiers: the first equals the enclosing `event.session_id` and therefore the LiveKit room name; the second equals the participant that actually published the RTC packet/track; and the third equals both `media_ref.media_id` and the installed rtc-node `RemoteTrackPublication.sid`. `RemoteTrackPublication.name`, name-or-SID fallback, aliases, and locator reinterpretation are forbidden. The publisher is `origin.device_id` for native iPhone/RayNeo input, `origin.relay.relay_device_id` for Watch input, and exactly `windows_gateway_01` for Gateway-generated output. Watch `origin.device_id` remains the Watch and is never rewritten to the relay.

A locator and `media_id` are claims only. A LiveKit reference becomes an observed media resource only after the Gateway obtains authoritative room/participant publication evidence for the exact `(session_id, rtc_publisher_identity, publication_sid)` tuple. A wrong-room, wrong-publisher, wrong-track, mismatched-ID, or phantom claim is rejected and counts as zero observed media. Cleanup counts distinct observed tuples once and only after authoritative LiveKit room deletion or verified room absence; otherwise the cleanup claim is rejected. These observations and cleanup receipts remain ephemeral and non-authoritative.

Model outputs are closed to:

- `text`: bounded UTF-8 text;
- `audio`: a `media_ref` for generated audio;
- `ar_card`: a bounded card identifier, title, and body.

Every `model.result` identifies a request in the same session, returns only requested modalities, reports the selected provider/model label for reproducibility, reports latency, and remains non-authoritative. A successful result has outputs and no error; a failed result has a bounded error object and no outputs. The error message is diagnostic text, never a credential channel: bare JWTs, GitHub tokens, AWS access-key IDs, authorization/bearer material, provider secrets, and signed URLs are hard rejects. The same value scan applies to `media_ref.locator`, including a JWT embedded in an otherwise schema-valid locator.

Credential-value scanning is deterministic and bounded. It scans the original string, validates every percent escape, decodes at most one layer as strict UTF-8, and scans that once-decoded form too. Invalid escapes or a remaining `%HH` escape (which would require a second decoding layer) are rejected. JWT detection accepts base64url segments with header length at least 8, payload length at least 2, and signature length at least 6 only when the header decodes to a JSON object, avoiding ordinary dotted host/path false positives. Signed-credential names are recognized case-insensitively in URL query, fragment, or path form, including a once-percent-encoded key such as `X-Amz-%53ignature`.

## 7. Handoff and delivery

The Gateway owns only an ephemeral integer `active_device_lease_version` inside this demo session.

1. `handoff.requested` names distinct `from_device_id` and `to_device_id` values and the expected lease version. A second handoff cannot reserve the same session/expected-version compare-and-swap slot.
2. `handoff.completed` single-consumes its request and performs a compare-and-swap: current active device/version must still equal the request's `from_device_id`/expected version. It sets `active_device_id = to_device_id`, increments the current lease by exactly one, and sets `old_device_output_suppressed = true`. A stale or repeated completion is non-mutating and cannot roll the lease backward.
3. A `delivery.requested` targets one device and carries the lease version used for arbitration.
4. At acknowledgement time, target device and lease must equal the current active device and lease. A client receiving an older lease acknowledges `ignored_stale_lease`; `rendered` or `played` on an old device after handoff is a hard reject even if a stale completion attempted a rollback.
5. No broadcast delivery is defined by this contract.

## 8. Credential, TTL, and cleanup profile

| Item | Maximum | Rule |
|---|---:|---|
| LiveKit access token | 15 minutes | Room- and participant-scoped, delivered out-of-band, memory-only on clients. |
| Temporary session | 4 hours | Default should be 2 hours; no cross-day continuity. |
| Event envelope | 24 hours from `occurred_at` | Normally removed at session cleanup, earlier than this ceiling. |
| Raw image/frame or generated audio | 60 minutes after session end | Prefer upstream track lifetime; any ephemeral object must be deleted. |
| Confirmation request | 5 minutes | Expired requests cannot be acted on. |
| Cleanup completion | 5 minutes after stop/end | Remove events, temporary session row, media objects, and cached model inputs/outputs. |
| Cleanup receipt | 1 hour | Contains counts/status only, then is removed too. |

The Gateway MAY use an in-memory store or a single temporary local table. It MUST NOT call it authoritative, replicate it into Phase 1 stores, or omit TTL deletion. A cleanup receipt cannot predate session end or claim zero removed events/session rows/media/model cache when the same validated timeline observed those temporary resources. Crash recovery may remove all Phase 0 sessions rather than preserve them.

## 9. RTC mapping

[`rtc-mapping.yaml`](./rtc-mapping.yaml) freezes the LiveKit mapping:

- one room per `session_id`;
- `participant.identity` from the RTC-publishing device (the paired iPhone for Watch events);
- every LiveKit locator is `livekit://<session_id>/<participant.identity>/<RemoteTrackPublication.sid>`, with `media_id` equal to that SID and no publication-name fallback;
- the Gateway resolves `rtc_publisher_device_id` to exactly `windows_gateway_01` for identity, `attributes.device_id`, and Gateway event origin;
- Gateway outbound publication and reconnect replay are limited to that locally owned origin; generic relay is forbidden;
- original physical source preserved in `origin`;
- reliable data topic `paios.phase0.demo.event` for contract events;
- lossy data allowed only for replaceable telemetry;
- audio/video transported as upstream tracks; data packets carry references only;
- credentials delivered out-of-band and never persisted.

## 10. Consumer compatibility rules

- A consumer supporting `phase0-demo/0.2` MUST reject another `schema_version` and unknown `event_type`.
- A room/session fixes its schema version at start. A v0.1 envelope in a v0.2 session or replay, and a v0.2 envelope in a v0.1 session or replay, are hard rejects rather than translations.
- Gateway identity aliases and Gateway publication of a foreign origin are hard rejects before any display, model invocation, delivery, or state mutation.
- Producers MUST NOT add fields under the same version. Additive or breaking shape changes both require a new demo schema version and a T01 Interface Change Packet.
- Unknown fields, unknown enum values, credential-like keys or raw/encoded values, invalid or nested percent encoding, raw media bytes, invalid Watch relay, an unbound or unobserved LiveKit track claim, connection-ID reuse, capture-stream resurrection, non-monotonic sequence/lease, idempotency conflicts, terminal cleanup bypass, TTL overflow, stale handoff/delivery lease, or a model result marked authoritative are hard rejects.
- The LiveKit binding in this document is an in-place `phase0-demo/0.2` clarification and fail-closed hardening of the existing `livekit_track` meaning. It adds no field, transport, authority, persistence, or later-phase behavior; producers that relied on arbitrary track text were never proving an actual media resource and must update before Interface Packet rollout.
- `tests/test_contract_compatibility.py` is the executable compatibility gate. Passing it proves schema/fixture consistency only; it does not prove a real-device Gate.

### 10.1 v0.1 disposition and rollback

`phase0-demo/0.1` remains immutable and is superseded only for newly created G-A1 sessions. It is never reinterpreted as v0.2. Existing v0.1 rooms/tokens are drained or cleaned under their original contract; they are not upgraded in place. Rollback stops new v0.2 session creation, cleans v0.2 temporary sessions, and may resume untouched v0.1 behavior only as v0.1—not as an alias or translation of v0.2.

## 11. Interface Packet

Consumers A/B/C/D receive exactly three interface artifacts:

1. `session-event.schema.json` — envelope and event payload authority;
2. `rtc-mapping.yaml` — LiveKit transport mapping and security/TTL profile;
3. `examples/valid-events.json` — one executable multi-device timeline.

No consumer may fork the envelope, rename fields locally, let Watch publish as a direct participant, embed raw media, or create a second session authority. Requested changes stop the affected path and return to T01; migration requests are out of scope for Phase 0.
