# Capability contracts v1

A capability package is one Agent Plugins v1 directory. It has root
`plugin.json`, optional `mcp.json`, `skills/`, its server code, `fake/`, and
`tests/contract.yaml`. The examples here are manifest fixtures, not runnable
packages. Their fake commands and test paths describe the eventual package.

The portable manifest fields come from the public Agent Plugins specification.
Our manifest schema validates only `extensions["ai.yimi.capability"]`.
Use the upstream wrapper schema as well when validating a whole `plugin.json`.
`upstream/plugin-1.0.0.schema.json` is an unmodified copy from
[Agent Plugins](https://github.com/agentplugins/agent-plugins-spec/blob/main/schemas/1.0.0/plugin.schema.json).
There are no credentials in these fixtures; `secrets` admits only `{name}`.

The extension declares compatibility, the runtime server, allowed scopes,
network egress, tools, staging commands, tests, and provenance. Network egress
is a declaration; container policy enforces it. Allowed scopes are `owner`,
`owner_uncertain`, `guest`, `build`, and Hermes's derived `care` tool scope.

Each tool declares exactly one of `effect` and `effect_by_arg`. The latter
maps one argument JSONPath to a map of literal argument values and effects,
for example `{"$.output":{"workspace":"workspace","owner_drive":"owner_data"}}`.
An unmapped argument has no declared effect; a future gateway must reject it.
There is no guessed default. `target` also uses JSONPath into tool arguments.
`retry`, `check_with`, `task_type`, `context_inject`, and `long_running` describe
the tool. Missing optional fields do not grant permissions or inject context.
Yimi-maintained packages cannot declare `spend` or `self_change`, including in
any argument branch. `effect-classes.v1.json` maps all nine classes to existing
gates and records the exact current `requested` semantics.

`owner_requested` is a reserved boolean argument. The model judges whether
the owner explicitly requested this specific effect. The gateway consumes it
before execution. Identity or an owner-initiated turn cannot substitute for it.
All observe calls use role scope only. Only requested sends have remembered
consent; account and delete follow the existing `effectConsent`.

A package returns a receipt as MCP `structuredContent`, declares the receipt
schema in its tool `outputSchema`, and supplies one text block in `content`.
The Python and TS helpers provide state constructors, effect/value/unknown
builders and `to_mcp_result(body, summary?)`. A unit is mandatory in `value`;
use `none` only for a truly unitless value. `ref` may be null when no evidence
reference exists. Values are atomic numbers, strings, booleans, or null.
Their provenance is `observed`, `computed`, `inferred`, or `peer`.

The five package-authored fact kinds are status, effects, values/content,
unknowns, and next-step permission. Every receipt supplies those containers.
Only `status.state` is required inside status; timestamps, reason and progress
are optional. An unfinished operation may have a null `ended_at`. Every value
requires key, value, unit, provenance, source, and as_of. Each effect requires
kind, target, action, verification, evidence, and ref. Empty evidence is allowed
for an unverified effect. `next` requires retry and waiting_on; the remaining
next-step fields are optional. `needs_confirmation` is a prompt identifier or
description, or null. `until` is a date-time or null.

Delivery and already-reported facts belong to the future platform ledger.
Packages do not author the sixth fact kind. Extra receipt fields are permitted
for additive evolution and do not become authoritative platform facts.
The optional job id identifies the execution authority's job. Its nonnegative
integer revision must strictly increase for that job. Schema validation checks
one snapshot; the future ledger must compare revisions without taking job
state ownership from the executor.

At the package trust boundary, call `admitReceipt(raw)` exactly once with the
decoded `structuredContent`. It neither unwraps MCP envelopes nor guesses old
tool formats. It validates using the integration service's existing Ajv 8.20.0,
then qualifies claims without changing the original input:

1. A succeeded receipt with unverified effects becomes partial if some effects
   are verified or service_ack, or unknown if none are. An unknowns entry with
   about=contradiction records the conflict. Read-only success needs no effects.
2. A failed receipt whose reason has a TIMEOUT or DISCONNECTED token becomes
   unknown with retry=after_check. Tokens use uppercase underscore-separated
   families, such as MIJIA_TIMEOUT or TRANSPORT_DISCONNECTED_BEFORE_ACK.
3. Missing or empty value units are contract violations.
4. A package-written rejected becomes unknown with a contract violation note.
   Only the gateway can record a genuine pre-execution rejection.
5. Invalid, unsupported-version, and non-receipt inputs become unknown with
   CAPABILITY_RECEIPT_INVALID. No legacy success flag is treated as evidence.

`gateway-api.v1.json` is OpenAPI 3.1 and uses the documented Hermes v0.22.5
hook payload names pinned to commit bf0203a794a07aac3ff764972ab9087baa4e4f4e.
The legacy telemetry_schema_version marker is optional on the RPC wire.
Decide returns exactly allow, modify with args, block with message, or approve
with message and rule_key, all discriminated by action. Receipt returns only
model_view. Observe and lineage return 204 with no response body.
Hermes shallow-merges modify args; omission cannot delete owner_requested.
The P1 plugin must prove that consumption before any real tool is executed.

Receipt versions are integers. A version only adds optional fields and retains
existing meanings and enum values. Incompatible changes require a new integer.
Package releases use semver. The gateway API version is an integer, declared
by compat.gateway_api and x-yimi-gateway-api; OpenAPI info.version is its string.
No runtime, tool, plugin, skill, or native patch is wired to these files yet.

Run TS tests with the integration service's existing node --test runner on
tests/capability-contracts.test.ts. Run Python tests with pytest on
capability/sdk/python/test_yimi_receipt.py. Both use existing dependencies.
