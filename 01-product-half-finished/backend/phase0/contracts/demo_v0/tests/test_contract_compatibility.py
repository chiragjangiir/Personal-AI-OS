"""Executable compatibility gate for the Phase 0 demo-only contract.

Run without repository dependency files:
    uv run --no-project --with jsonschema==4.25.1 --with pyyaml==6.0.2 python -I -B tests/test_contract_compatibility.py

This validates contract artifacts and synthetic fixtures. It is not real-device
evidence and cannot pass P0-01 through P0-05 by itself.
"""

from __future__ import annotations

import base64
import copy
import json
import re
import unittest
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import yaml
from jsonschema import Draft202012Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "session-event.schema.json"
MAPPING_PATH = ROOT / "rtc-mapping.yaml"
VALID_PATH = ROOT / "examples" / "valid-events.json"
INVALID_PATH = ROOT / "examples" / "invalid-events.json"
CONTRACT_PATH = ROOT / "PHASE0_DEMO_CONTRACT.md"

EXPECTED_VERSION = "phase0-demo/0.1"
EXPECTED_NAMESPACE = "paios.phase0.demo."
FORBIDDEN_EVENT_KEYS = {
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "api_key",
    "secret",
    "password",
    "signed_url",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def pointer_tokens(path: str) -> list[str]:
    if not path.startswith("/"):
        raise ValueError(f"JSON Pointer must start with '/': {path}")
    return [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]


def apply_mutations(document: Any, mutations: list[dict[str, Any]]) -> Any:
    result = copy.deepcopy(document)
    for mutation in mutations:
        tokens = pointer_tokens(mutation["path"])
        parent = result
        for token in tokens[:-1]:
            parent = parent[int(token)] if isinstance(parent, list) else parent[token]
        leaf = tokens[-1]
        operation = mutation["op"]
        if isinstance(parent, list):
            index = int(leaf)
            if operation == "remove":
                parent.pop(index)
            elif operation in {"add", "replace"}:
                parent[index] = copy.deepcopy(mutation["value"])
            else:
                raise ValueError(f"Unsupported mutation operation: {operation}")
        elif operation == "remove":
            del parent[leaf]
        elif operation in {"add", "replace"}:
            parent[leaf] = copy.deepcopy(mutation["value"])
        else:
            raise ValueError(f"Unsupported mutation operation: {operation}")
    return result


def walk_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_keys(child)


def walk_media_refs(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        if {"media_id", "kind", "transport", "locator", "expires_at"}.issubset(value):
            yield value
        for child in value.values():
            yield from walk_media_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_media_refs(child)


def canonical_envelope_fingerprint(event: dict[str, Any]) -> str:
    """Fingerprint every canonical field; receive metadata is not an event field."""
    return json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def walk_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from walk_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_strings(child)


CREDENTIAL_VALUE_PATTERN = re.compile(
    r"(?ix)(?:"
    r"authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|"
    r"api[_ -]?key\s*[:=]|(?:access[_ -]?)?token\s*[:=]|password\s*[:=]|secret\s*[:=]|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|"
    r"\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b"
    r")"
)
JWT_CANDIDATE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{6,})(?![A-Za-z0-9_-])"
)
URL_CANDIDATE_PATTERN = re.compile(r"(?i)(?:https?|livekit|ephemeral)://[^\s\"'<>]+")
SIGNED_URL_COMPONENT_PATTERN = re.compile(
    r"(?i)(?:[/?#&;])(?:x-amz-signature|x-amz-credential|awsaccesskeyid|signature|sig|signed|token|access_token)(?:=|/)[^\s/?#&;]+"
)
PERCENT_ESCAPE_PATTERN = re.compile(r"%[0-9A-Fa-f]{2}")
MAX_CREDENTIAL_SCAN_LENGTH = 16384


def percent_decode_once(value: str) -> tuple[list[str], bool]:
    """Return raw/once-decoded variants plus an invalid-or-nested flag."""
    variants = [value]
    if len(value) > MAX_CREDENTIAL_SCAN_LENGTH:
        return variants, True
    if "%" not in value:
        return variants, False
    index = 0
    while index < len(value):
        if value[index] != "%":
            index += 1
            continue
        if index + 2 >= len(value) or not re.fullmatch(r"[0-9A-Fa-f]{2}", value[index + 1 : index + 3]):
            return variants, True
        index += 3
    try:
        decoded = urllib.parse.unquote_to_bytes(value).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return variants, True
    if len(decoded) > MAX_CREDENTIAL_SCAN_LENGTH:
        return variants, True
    variants.append(decoded)
    # A surviving escape would require a forbidden second decoding pass.
    return variants, bool(PERCENT_ESCAPE_PATTERN.search(decoded))


def contains_jwt(value: str) -> bool:
    for candidate in JWT_CANDIDATE_PATTERN.finditer(value):
        header = candidate.group(1)
        try:
            decoded_header = base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
            header_object = json.loads(decoded_header.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(header_object, dict):
            return True
    return False


def contains_signed_url(value: str) -> bool:
    return any(SIGNED_URL_COMPONENT_PATTERN.search(match.group(0)) for match in URL_CANDIDATE_PATTERN.finditer(value))


def credential_value_findings(value: str) -> tuple[bool, bool]:
    variants, invalid_encoding = percent_decode_once(value)
    found = any(
        CREDENTIAL_VALUE_PATTERN.search(variant)
        or contains_jwt(variant)
        or contains_signed_url(variant)
        for variant in variants
    )
    return found or invalid_encoding, invalid_encoding


def rtc_publisher_device_id(origin: dict[str, Any]) -> str:
    return origin.get("relay", {}).get("relay_device_id", origin["device_id"])


def semantic_errors(events: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    event_fingerprints: dict[str, str] = {}
    event_by_id: dict[str, dict[str, Any]] = {}
    idempotency: dict[tuple[str, str], str] = {}
    stream_state: dict[tuple[str, str, str], tuple[int, str]] = {}
    handoff_requests: dict[str, dict[str, Any]] = {}
    handoff_expected_leases: dict[tuple[str, int], str] = {}
    consumed_handoff_requests: set[str] = set()
    delivery_requests: dict[str, dict[str, Any]] = {}
    active_device: dict[str, tuple[str, int]] = {}
    started_sessions: set[str] = set()
    ended_sessions: dict[str, datetime] = {}
    cleaned_sessions: set[str] = set()
    cleanup_deadline: dict[str, datetime] = {}
    connection_state: dict[tuple[str, str], tuple[str, int]] = {}
    connection_ids_seen: dict[tuple[str, str], set[str]] = {}
    capture_state: dict[tuple[str, str, str], tuple[str, str]] = {}
    session_media_expiries: list[tuple[str, datetime]] = []
    session_activity: dict[str, dict[str, int]] = {}

    for event in events:
        event_id = event["event_id"]
        event_type = event["event_type"]
        session_id = event["session_id"]
        occurred_at = parse_time(event["occurred_at"])
        expires_at = parse_time(event["expires_at"])
        fingerprint = canonical_envelope_fingerprint(event)
        idem_key = (session_id, event["idempotency_key"])

        prior_event_fingerprint = event_fingerprints.get(event_id)
        prior_idem_fingerprint = idempotency.get(idem_key)
        exact_retry = prior_event_fingerprint == fingerprint and prior_idem_fingerprint == fingerprint
        cleanup_receipt_retry = exact_retry and event_type == "paios.phase0.demo.session.cleanup.completed"
        if session_id in cleaned_sessions and not cleanup_receipt_retry:
            # Cleanup is terminal and is checked before retry dedupe. An old
            # event cannot regain no-op status after its session was removed.
            errors.append("EVENT_AFTER_CLEANUP")
        if exact_retry:
            # The sole retry no-op: byte-equivalent canonical envelope. Any
            # receive time / attempt count belongs outside this contract. Only
            # the cleanup receipt itself may still no-op after cleanup.
            continue
        conflict = False
        if prior_event_fingerprint is not None:
            errors.append("EVENT_ID_CONFLICT")
            conflict = True
        if prior_idem_fingerprint is not None:
            errors.append("IDEMPOTENCY_CONFLICT")
            conflict = True
        if conflict:
            continue
        event_fingerprints[event_id] = fingerprint
        event_by_id[event_id] = event
        idempotency[idem_key] = fingerprint

        activity = session_activity.setdefault(
            session_id,
            {"events": 0, "media_objects": 0, "model_cache_entries": 0},
        )
        if event_type != "paios.phase0.demo.session.cleanup.completed":
            activity["events"] += 1

        if not event_type.startswith(EXPECTED_NAMESPACE):
            errors.append("EVENT_NAMESPACE_INVALID")
        if expires_at <= occurred_at:
            errors.append("EVENT_EXPIRY_NOT_AFTER_OCCURRENCE")
        if (expires_at - occurred_at).total_seconds() > 86400:
            errors.append("EVENT_TTL_EXCEEDED")
        if FORBIDDEN_EVENT_KEYS.intersection(key.lower() for key in walk_keys(event)):
            errors.append("CREDENTIAL_KEY_EMBEDDED")
        credential_findings = [credential_value_findings(value) for value in walk_strings(event)]
        if any(found for found, _ in credential_findings):
            errors.append("CREDENTIAL_VALUE_EMBEDDED")
        if any(invalid_encoding for _, invalid_encoding in credential_findings):
            errors.append("CREDENTIAL_VALUE_ENCODING_INVALID")

        if session_id not in cleaned_sessions and session_id in ended_sessions and event_type != "paios.phase0.demo.session.cleanup.completed":
            errors.append("EVENT_AFTER_SESSION_END")
        if event_type != "paios.phase0.demo.session.started" and session_id not in started_sessions:
            errors.append("SESSION_NOT_STARTED")

        origin = event["origin"]
        if origin["device_class"] == "apple_watch":
            relay = origin["relay"]
            if relay["relay_device_id"] == origin["device_id"]:
                errors.append("WATCH_RELAY_SELF_REFERENCE")

        payload = event["payload"]
        if "device_id" in payload and payload["device_id"] != origin["device_id"]:
            errors.append("ORIGIN_PAYLOAD_DEVICE_MISMATCH")

        media_refs = list(walk_media_refs(payload))
        for media_ref in media_refs:
            activity["media_objects"] += 1
            session_media_expiries.append((session_id, parse_time(media_ref["expires_at"])))
            if parse_time(media_ref["expires_at"]) > expires_at:
                errors.append("MEDIA_EXPIRES_AFTER_EVENT")
            if "?" in media_ref["locator"] or "#" in media_ref["locator"]:
                errors.append("MEDIA_LOCATOR_CONTAINS_CREDENTIAL_CHANNEL")
            if media_ref["transport"] == "ephemeral_object" and (
                not isinstance(media_ref.get("byte_length"), int)
                or media_ref.get("byte_length", 0) <= 0
                or not re.fullmatch(r"[a-f0-9]{64}", str(media_ref.get("sha256", "")))
            ):
                errors.append("EPHEMERAL_MEDIA_INTEGRITY_MISSING")
            expected_mime_prefix = {"audio": "audio/", "image": "image/", "video": "video/"}[media_ref["kind"]]
            if not media_ref["mime_type"].startswith(expected_mime_prefix):
                errors.append("MEDIA_KIND_MIME_MISMATCH")
            capture_kind = None
            if media_ref["capture_mode"] == "microphone":
                capture_kind = "audio"
            elif media_ref["capture_mode"] in {"user_triggered_frame", "periodic_frame", "low_fps_visual_stream"}:
                capture_kind = "camera"
            capture = capture_state.get((session_id, origin["device_id"], capture_kind)) if capture_kind else None
            if capture and capture[0] == "stopped":
                errors.append("CAPTURE_OUTPUT_AFTER_STOP")

        sequence = event["sequence"]
        stream_key = (session_id, origin["device_id"], sequence["stream_id"])
        previous = stream_state.get(stream_key)
        if previous is None:
            if sequence["number"] != 1:
                errors.append("SEQUENCE_START_NOT_ONE")
        else:
            previous_number, previous_event_id = previous
            if sequence["number"] <= previous_number:
                errors.append("SEQUENCE_NOT_INCREASING")
            elif sequence["number"] != previous_number + 1:
                errors.append("SEQUENCE_GAP")
            if sequence.get("previous_event_id") != previous_event_id:
                errors.append("PREVIOUS_EVENT_MISMATCH")
        stream_state[stream_key] = (sequence["number"], event_id)

        publisher_key = (session_id, rtc_publisher_device_id(origin))
        previous_connection = connection_state.get(publisher_key)
        seen_connection_ids = connection_ids_seen.setdefault(publisher_key, set())
        connection = event["connection"]
        if event_type == "paios.phase0.demo.connection.reconnected":
            reconnect_identity_valid = True
            if previous_connection is None:
                errors.append("RECONNECT_PREVIOUS_CONNECTION_NOT_FOUND")
                reconnect_identity_valid = False
            else:
                if connection["epoch"] != previous_connection[1] + 1:
                    errors.append("RECONNECT_EPOCH_NOT_INCREMENTED")
                    reconnect_identity_valid = False
                if connection.get("resumed_from_connection_id") != previous_connection[0]:
                    errors.append("RECONNECT_PREVIOUS_CONNECTION_MISMATCH")
                    reconnect_identity_valid = False
                if connection["id"] == previous_connection[0] or connection["id"] in seen_connection_ids:
                    errors.append("RECONNECT_IDENTITY_REUSE")
                    reconnect_identity_valid = False
            if reconnect_identity_valid:
                connection_state[publisher_key] = (connection["id"], connection["epoch"])
                seen_connection_ids.add(connection["id"])
        elif previous_connection is None:
            connection_state[publisher_key] = (connection["id"], connection["epoch"])
            seen_connection_ids.add(connection["id"])
        elif (connection["id"], connection["epoch"]) != previous_connection:
            errors.append("CONNECTION_IDENTITY_DRIFT")

        if event_type == "paios.phase0.demo.session.started":
            if session_id in started_sessions:
                errors.append("DUPLICATE_SESSION_START")
                continue
            credential_expiry = parse_time(payload["credential_lease"]["expires_at"])
            if not 0 < (credential_expiry - occurred_at).total_seconds() <= 900:
                errors.append("CREDENTIAL_TTL_EXCEEDED")
            session_expiry = parse_time(payload["session_expires_at"])
            if not 0 < (session_expiry - occurred_at).total_seconds() <= 14400:
                errors.append("SESSION_TTL_EXCEEDED")
            if not 0 <= (parse_time(payload["cleanup_deadline_at"]) - session_expiry).total_seconds() <= 300:
                errors.append("SESSION_CLEANUP_SLA_INVALID")
            active_device[session_id] = (
                payload["active_device_id"],
                payload["active_device_lease_version"],
            )
            started_sessions.add(session_id)

        elif event_type == "paios.phase0.demo.capture.status":
            capture_key = (session_id, payload["device_id"], payload["capture_kind"])
            prior_capture = capture_state.get(capture_key)
            if payload["status"] == "started" and prior_capture and prior_capture[0] == "stopped":
                if sequence["stream_id"] == prior_capture[1]:
                    errors.append("CAPTURE_STREAM_RESTART_AFTER_STOP")
                    # Keep the old stream terminal so later transcript/frame
                    # output cannot exploit a rejected restart.
                else:
                    capture_state[capture_key] = ("started", sequence["stream_id"])
            elif prior_capture and sequence["stream_id"] != prior_capture[1]:
                errors.append("CAPTURE_STREAM_ID_MISMATCH")
            else:
                capture_state[capture_key] = (payload["status"], sequence["stream_id"])

        elif event_type == "paios.phase0.demo.transcript.final":
            capture = capture_state.get((session_id, origin["device_id"], "audio"))
            if capture and capture[0] == "stopped":
                errors.append("CAPTURE_OUTPUT_AFTER_STOP")

        elif event_type == "paios.phase0.demo.confirmation.requested":
            confirmation_expiry = parse_time(payload["expires_at"])
            if not 0 < (confirmation_expiry - occurred_at).total_seconds() <= 300:
                errors.append("CONFIRMATION_TTL_EXCEEDED")

        elif event_type == "paios.phase0.demo.confirmation.responded":
            request = event_by_id.get(payload["request_event_id"])
            if not request or request["event_type"] != "paios.phase0.demo.confirmation.requested":
                errors.append("CONFIRMATION_REQUEST_NOT_FOUND")
            else:
                if request["session_id"] != session_id:
                    errors.append("CONFIRMATION_REQUEST_SESSION_MISMATCH")
                if payload["confirmation_id"] != request["payload"]["confirmation_id"]:
                    errors.append("CONFIRMATION_ID_MISMATCH")
                if origin["device_id"] != request["payload"]["target_device_id"]:
                    errors.append("CONFIRMATION_WRONG_RESPONDER")
                if payload["choice"] not in request["payload"]["choices"]:
                    errors.append("CONFIRMATION_CHOICE_INVALID")

        elif event_type == "paios.phase0.demo.model.requested":
            if any(input_id not in event_by_id for input_id in payload["input_event_ids"]):
                errors.append("MODEL_INPUT_EVENT_NOT_FOUND")
            if any(
                input_id in event_by_id and event_by_id[input_id]["session_id"] != session_id
                for input_id in payload["input_event_ids"]
            ):
                errors.append("MODEL_INPUT_CROSS_SESSION_REFERENCE")
            activity["model_cache_entries"] += 1

        elif event_type == "paios.phase0.demo.model.result":
            request = event_by_id.get(payload["request_event_id"])
            if not request or request["event_type"] != "paios.phase0.demo.model.requested":
                errors.append("MODEL_REQUEST_NOT_FOUND")
            elif request["session_id"] != session_id:
                errors.append("MODEL_RESULT_CROSS_SESSION_REFERENCE")
            else:
                requested_outputs = set(request["payload"]["requested_outputs"])
                if any(output["modality"] not in requested_outputs for output in payload.get("outputs", [])):
                    errors.append("MODEL_UNREQUESTED_OUTPUT_MODALITIES")
            for output in payload.get("outputs", []):
                if output["modality"] == "audio" and output["media_ref"]["kind"] != "audio":
                    errors.append("MODEL_AUDIO_OUTPUT_KIND_INVALID")
            activity["model_cache_entries"] += 1

        elif event_type == "paios.phase0.demo.handoff.requested":
            handoff_requests[event_id] = event
            if payload["from_device_id"] == payload["to_device_id"]:
                errors.append("HANDOFF_FROM_EQUALS_TO")
            lease_key = (session_id, payload["expected_active_device_lease_version"])
            if lease_key in handoff_expected_leases:
                errors.append("DUAL_HANDOFF_SAME_EXPECTED_LEASE")
            else:
                handoff_expected_leases[lease_key] = event_id
            current = active_device.get(session_id)
            if current and (
                payload["from_device_id"] != current[0]
                or payload["expected_active_device_lease_version"] != current[1]
            ):
                errors.append("HANDOFF_EXPECTATION_STALE")

        elif event_type == "paios.phase0.demo.handoff.completed":
            request = handoff_requests.get(payload["request_event_id"])
            if not request or request["payload"]["handoff_id"] != payload["handoff_id"]:
                errors.append("HANDOFF_REQUEST_NOT_FOUND")
            else:
                request_payload = request["payload"]
                completion_valid = True
                if payload["request_event_id"] in consumed_handoff_requests:
                    errors.append("HANDOFF_REQUEST_ALREADY_CONSUMED")
                    completion_valid = False
                if request["session_id"] != session_id:
                    errors.append("HANDOFF_REQUEST_SESSION_MISMATCH")
                    completion_valid = False
                if payload["from_device_id"] != request_payload["from_device_id"] or payload["to_device_id"] != request_payload["to_device_id"]:
                    errors.append("HANDOFF_ENDPOINT_MISMATCH")
                    completion_valid = False
                if payload["active_device_id"] != payload["to_device_id"]:
                    errors.append("HANDOFF_ACTIVE_DEVICE_MISMATCH")
                    completion_valid = False
                if payload["active_device_lease_version"] != request_payload["expected_active_device_lease_version"] + 1:
                    errors.append("HANDOFF_LEASE_NOT_INCREMENTED")
                    completion_valid = False
                current = active_device.get(session_id)
                expected_current = (
                    request_payload["from_device_id"],
                    request_payload["expected_active_device_lease_version"],
                )
                if current != expected_current:
                    errors.append("HANDOFF_COMPLETION_CAS_ROLLBACK")
                    completion_valid = False
                if current and payload["active_device_lease_version"] != current[1] + 1:
                    errors.append("HANDOFF_LEASE_NOT_MONOTONIC")
                    completion_valid = False
                if completion_valid:
                    consumed_handoff_requests.add(payload["request_event_id"])
                    active_device[session_id] = (
                        payload["active_device_id"],
                        payload["active_device_lease_version"],
                    )

        elif event_type == "paios.phase0.demo.delivery.requested":
            delivery_requests[event_id] = event
            current = active_device.get(session_id)
            if not current or payload["target_device_id"] != current[0] or payload["active_device_lease_version"] != current[1]:
                errors.append("DELIVERY_NOT_ON_ACTIVE_LEASE")
            result = event_by_id.get(payload["result_event_id"])
            if not result or result["event_type"] != "paios.phase0.demo.model.result":
                errors.append("DELIVERY_RESULT_NOT_FOUND")
            elif result["session_id"] != session_id:
                errors.append("DELIVERY_RESULT_SESSION_MISMATCH")

        elif event_type == "paios.phase0.demo.delivery.acknowledged":
            request = delivery_requests.get(payload["delivery_event_id"])
            if not request:
                errors.append("DELIVERY_REQUEST_NOT_FOUND")
            elif (
                payload["target_device_id"] != request["payload"]["target_device_id"]
                or payload["active_device_lease_version"] != request["payload"]["active_device_lease_version"]
            ):
                errors.append("DELIVERY_ACK_MISMATCH")
            elif request["session_id"] != session_id:
                errors.append("DELIVERY_REQUEST_SESSION_MISMATCH")
            current = active_device.get(session_id)
            stale = not current or (
                payload["target_device_id"], payload["active_device_lease_version"]
            ) != current
            if origin["device_id"] != payload["target_device_id"]:
                errors.append("DELIVERY_ACK_ORIGIN_MISMATCH")
            if stale and payload["disposition"] != "ignored_stale_lease":
                errors.append("STALE_OLD_DEVICE_ACK_RENDERED")
            if not stale and payload["disposition"] == "ignored_stale_lease":
                errors.append("CURRENT_LEASE_ACK_MARKED_STALE")

        elif event_type == "paios.phase0.demo.connection.reconnected":
            if payload["new_connection_id"] != event["connection"]["id"] or payload["previous_connection_id"] != event["connection"]["resumed_from_connection_id"]:
                errors.append("RECONNECT_CONNECTION_MISMATCH")
            if payload["resume_stream_id"] != event["sequence"]["stream_id"]:
                errors.append("RECONNECT_STREAM_MISMATCH")
            if payload["replay_from_sequence"] != payload["last_acked_sequence"] + 1:
                errors.append("RECONNECT_REPLAY_RANGE_INVALID")
            if (
                previous is None
                or payload["last_acked_sequence"] != previous[0]
                or payload["replay_from_sequence"] != sequence["number"]
            ):
                errors.append("RECONNECT_ACK_SEQUENCE_FABRICATION")

        elif event_type == "paios.phase0.demo.session.ended":
            ended_at = parse_time(payload["ended_at"])
            deadline = parse_time(payload["cleanup_deadline_at"])
            if not 0 <= (deadline - ended_at).total_seconds() <= 300:
                errors.append("SESSION_END_CLEANUP_SLA_INVALID")
            cleanup_deadline[session_id] = deadline
            ended_sessions[session_id] = ended_at

        elif event_type == "paios.phase0.demo.session.cleanup.completed":
            completed_at = parse_time(payload["completed_at"])
            if session_id not in cleanup_deadline or completed_at > cleanup_deadline[session_id]:
                errors.append("CLEANUP_DEADLINE_MISSED")
            if session_id in ended_sessions and completed_at < ended_sessions[session_id]:
                errors.append("CLEANUP_COMPLETED_BEFORE_SESSION_END")
            if (expires_at - completed_at).total_seconds() > 3600:
                errors.append("CLEANUP_RECEIPT_TTL_EXCEEDED")
            prior_activity = session_activity[session_id]
            removed = payload["removed"]
            if (
                (prior_activity["events"] > 0 and removed["events"] == 0)
                or (session_id in started_sessions and removed["session_rows"] == 0)
                or (prior_activity["media_objects"] > 0 and removed["media_objects"] == 0)
                or (prior_activity["model_cache_entries"] > 0 and removed["model_cache_entries"] == 0)
            ):
                errors.append("FALSE_ZERO_CLEANUP_RECEIPT")
            cleaned_sessions.add(session_id)

    for session_id, media_expiry in session_media_expiries:
        if session_id in ended_sessions and media_expiry > ended_sessions[session_id] + timedelta(hours=1):
            errors.append("MEDIA_OVER_60M_AFTER_SESSION_END")

    return errors


class Phase0ContractCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = load_json(SCHEMA_PATH)
        cls.mapping = yaml.safe_load(MAPPING_PATH.read_text(encoding="utf-8"))
        cls.valid_fixture = load_json(VALID_PATH)
        cls.invalid_fixture = load_json(INVALID_PATH)
        cls.events = cls.valid_fixture["events"]
        cls.events_by_id = {event["event_id"]: event for event in cls.events}
        cls.validator = Draft202012Validator(cls.schema, format_checker=FormatChecker())

    def test_schema_is_valid_draft_2020_12(self) -> None:
        Draft202012Validator.check_schema(self.schema)
        self.assertEqual(self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(self.schema["properties"]["schema_version"]["const"], EXPECTED_VERSION)

    def test_all_valid_events_pass_schema(self) -> None:
        for event in self.events:
            with self.subTest(event_id=event["event_id"], event_type=event["event_type"]):
                errors = sorted(self.validator.iter_errors(event), key=lambda error: list(error.path))
                self.assertEqual([], [f"/{'/'.join(map(str, error.path))}: {error.message}" for error in errors])

    def test_valid_timeline_passes_cross_event_semantics(self) -> None:
        self.assertEqual([], semantic_errors(self.events))

    def test_valid_fixture_covers_every_event_discriminator_once(self) -> None:
        schema_event_types = set(self.schema["properties"]["event_type"]["enum"])
        fixture_event_types = [event["event_type"] for event in self.events]
        self.assertEqual(schema_event_types, set(fixture_event_types))
        self.assertEqual(len(schema_event_types), len(fixture_event_types))

    def test_schema_negative_cases_are_rejected(self) -> None:
        for case in self.invalid_fixture["schema_cases"]:
            with self.subTest(case=case["name"]):
                event = apply_mutations(self.events_by_id[case["source_event_id"]], case["mutations"])
                self.assertEqual("SCHEMA_INVALID", case["expected_code"])
                self.assertFalse(self.validator.is_valid(event), f"negative fixture unexpectedly passed: {case['name']}")

    def test_semantic_negative_cases_are_schema_valid_but_rejected(self) -> None:
        for case in self.invalid_fixture["semantic_cases"]:
            with self.subTest(case=case["name"]):
                timeline = copy.deepcopy(self.events)
                index = next(i for i, event in enumerate(timeline) if event["event_id"] == case["source_event_id"])
                timeline[index] = apply_mutations(timeline[index], case["mutations"])
                schema_errors = [error.message for event in timeline for error in self.validator.iter_errors(event)]
                self.assertEqual([], schema_errors, f"semantic case must remain schema-valid: {case['name']}")
                self.assertIn(case["expected_code"], semantic_errors(timeline))

    def test_semantic_pair_cases_are_rejected(self) -> None:
        for case in self.invalid_fixture["semantic_pair_cases"]:
            with self.subTest(case=case["name"]):
                first = copy.deepcopy(self.events_by_id[case["source_event_id"]])
                second = apply_mutations(first, case["second_mutations"])
                self.assertTrue(self.validator.is_valid(first))
                self.assertTrue(self.validator.is_valid(second))
                self.assertIn(case["expected_code"], semantic_errors([first, second]))

    def test_exact_idempotent_retry_is_a_noop(self) -> None:
        control = self.valid_fixture["retry_control"]
        first = copy.deepcopy(self.events_by_id[control["source_event_id"]])
        retry = copy.deepcopy(first)
        self.assertTrue(self.validator.is_valid(retry))
        self.assertEqual([], semantic_errors([first, retry]))
        self.assertIn("receive metadata is outside the envelope", control["rule"])

    def test_retry_drift_in_any_canonical_envelope_field_is_rejected(self) -> None:
        source = self.events_by_id["00000000-0000-4000-8000-000000000006"]
        drift_cases = {
            "schema_version": [{"op": "replace", "path": "/schema_version", "value": "phase0-demo/0.2"}],
            "event_type": [{"op": "replace", "path": "/event_type", "value": "paios.phase0.demo.device.telemetry"}],
            "event_id": [{"op": "replace", "path": "/event_id", "value": "30000000-0000-4000-8000-000000000001"}],
            "session_id": [{"op": "replace", "path": "/session_id", "value": "phase0_demo_session_002"}],
            "trace_id": [{"op": "replace", "path": "/trace_id", "value": "30000000-0000-4000-8000-000000000002"}],
            "occurred_at": [{"op": "replace", "path": "/occurred_at", "value": "2026-07-21T09:01:01Z"}],
            "expires_at": [{"op": "replace", "path": "/expires_at", "value": "2026-07-21T10:04:59Z"}],
            "origin": [{"op": "replace", "path": "/origin/relay/relay_device_id", "value": "iphone_02"}],
            "connection": [{"op": "replace", "path": "/connection/id", "value": "iphone_conn_02"}],
            "sequence": [{"op": "replace", "path": "/sequence/stream_id", "value": "workout_run_02"}],
            "idempotency_key": [{"op": "replace", "path": "/idempotency_key", "value": "watch-workout-002"}],
            "payload": [{"op": "replace", "path": "/payload/metrics/0/value", "value": 133}],
        }
        for field, mutations in drift_cases.items():
            with self.subTest(field=field):
                retry = apply_mutations(source, mutations)
                detected = semantic_errors([copy.deepcopy(source), retry])
                self.assertTrue(
                    {"IDEMPOTENCY_CONFLICT", "EVENT_ID_CONFLICT"}.intersection(detected),
                    f"canonical drift was accepted for {field}: {detected}",
                )

    def test_t14_hostile_semantic_regressions(self) -> None:
        def timeline() -> list[dict[str, Any]]:
            return copy.deepcopy(self.events)

        cases: list[tuple[str, str, list[dict[str, Any]]]] = []

        hostile = timeline()
        hostile[1]["payload"]["device_id"] = "rayneo_01"
        cases.append(("DEVICE_PAYLOAD_ORIGIN_ID_MISMATCH", "ORIGIN_PAYLOAD_DEVICE_MISMATCH", hostile))

        hostile = timeline()
        hostile[7]["payload"]["confirmation_id"] = "confirmation_002"
        cases.append(("CONFIRMATION_ID_MISMATCH", "CONFIRMATION_ID_MISMATCH", hostile))

        hostile = timeline()
        hostile[7]["origin"]["device_id"] = "watch_02"
        cases.append(("CONFIRMATION_WRONG_RESPONDER", "CONFIRMATION_WRONG_RESPONDER", hostile))

        hostile = copy.deepcopy(self.events[:5])
        retry = copy.deepcopy(hostile[-1])
        retry["trace_id"] = "30000000-0000-4000-8000-000000000004"
        hostile.append(retry)
        cases.append(("RETRY_TRACE_ID_DRIFT", "IDEMPOTENCY_CONFLICT", hostile))

        hostile = copy.deepcopy(self.events[:6])
        retry = copy.deepcopy(hostile[-1])
        retry["origin"]["relay"]["relay_device_id"] = "iphone_02"
        retry["connection"]["id"] = "iphone_conn_02"
        hostile.append(retry)
        cases.append(("WATCH_RETRY_RELAY_IDENTITY_DRIFT", "IDEMPOTENCY_CONFLICT", hostile))

        hostile = timeline()
        hostile[11]["session_id"] = "phase0_demo_session_002"
        cases.append(("MODEL_RESULT_CROSS_SESSION_REFERENCE", "MODEL_RESULT_CROSS_SESSION_REFERENCE", hostile))

        hostile = timeline()
        hostile[10]["payload"]["requested_outputs"] = ["text"]
        cases.append(("MODEL_UNREQUESTED_OUTPUT_MODALITIES", "MODEL_UNREQUESTED_OUTPUT_MODALITIES", hostile))

        hostile = timeline()
        hostile[8]["payload"]["media_ref"]["transport"] = "ephemeral_object"
        hostile[8]["payload"]["media_ref"]["locator"] = "ephemeral://phase0/frame/rayneo_frame_001"
        cases.append(("EPHEMERAL_MEDIA_WITHOUT_HASH_OR_LENGTH", "EPHEMERAL_MEDIA_INTEGRITY_MISSING", hostile))

        hostile = timeline()
        hostile[8]["payload"]["media_ref"]["mime_type"] = "audio/wav"
        cases.append(("MEDIA_KIND_MIME_MISMATCH", "MEDIA_KIND_MIME_MISMATCH", hostile))

        hostile = timeline()
        hostile[8]["payload"]["media_ref"]["expires_at"] = "2026-07-21T10:20:01Z"
        hostile[8]["expires_at"] = "2026-07-21T10:20:01Z"
        cases.append(("MEDIA_OVER_60M_AFTER_SESSION_END", "MEDIA_OVER_60M_AFTER_SESSION_END", hostile))

        hostile = timeline()
        capture_stop = copy.deepcopy(hostile[2])
        capture_stop["event_id"] = "30000000-0000-4000-8000-000000000011"
        capture_stop["occurred_at"] = "2026-07-21T09:00:10Z"
        capture_stop["idempotency_key"] = "iphone-audio-stop-001"
        capture_stop["sequence"] = {
            "stream_id": "audio_capture",
            "number": 2,
            "previous_event_id": hostile[2]["event_id"],
        }
        capture_stop["payload"]["status"] = "stopped"
        capture_stop["payload"]["observed_at"] = "2026-07-21T09:00:10Z"
        hostile.insert(3, capture_stop)
        cases.append(("TRANSCRIPT_AFTER_CAPTURE_STOP", "CAPTURE_OUTPUT_AFTER_STOP", hostile))

        hostile = timeline()
        late_event = copy.deepcopy(hostile[1])
        late_event["event_id"] = "30000000-0000-4000-8000-000000000012"
        late_event["occurred_at"] = "2026-07-21T09:24:10Z"
        late_event["expires_at"] = "2026-07-21T10:24:10Z"
        late_event["connection"] = {"id": "iphone_conn_02", "epoch": 1, "state": "connected"}
        late_event["sequence"] = {
            "stream_id": "device_status",
            "number": 2,
            "previous_event_id": hostile[1]["event_id"],
        }
        late_event["idempotency_key"] = "iphone-online-after-cleanup-001"
        late_event["payload"]["observed_at"] = "2026-07-21T09:24:10Z"
        hostile.append(late_event)
        cases.append(("EVENT_AFTER_CLEANUP_COMPLETED", "EVENT_AFTER_CLEANUP", hostile))

        hostile = timeline()
        for counter in hostile[-1]["payload"]["removed"]:
            hostile[-1]["payload"]["removed"][counter] = 0
        cases.append(("FALSE_ZERO_CLEANUP_RECEIPT", "FALSE_ZERO_CLEANUP_RECEIPT", hostile))

        hostile = timeline()
        hostile[16]["connection"]["epoch"] = 9
        cases.append(("RECONNECT_EPOCH_SKIP", "RECONNECT_EPOCH_NOT_INCREMENTED", hostile))

        hostile = timeline()
        hostile[16]["payload"]["last_acked_sequence"] = 999
        hostile[16]["payload"]["replay_from_sequence"] = 1000
        cases.append(("RECONNECT_ACK_SEQUENCE_FABRICATION", "RECONNECT_ACK_SEQUENCE_FABRICATION", hostile))

        hostile = copy.deepcopy(self.events[:13])
        second_handoff = copy.deepcopy(hostile[-1])
        second_handoff["event_id"] = "30000000-0000-4000-8000-000000000016"
        second_handoff["idempotency_key"] = "handoff-request-002"
        second_handoff["sequence"] = {
            "stream_id": "gateway_control",
            "number": 6,
            "previous_event_id": hostile[-1]["event_id"],
        }
        second_handoff["payload"]["handoff_id"] = "handoff_002"
        second_handoff["payload"]["to_device_id"] = "watch_01"
        hostile.append(second_handoff)
        cases.append(("DUAL_HANDOFF_SAME_EXPECTED_LEASE", "DUAL_HANDOFF_SAME_EXPECTED_LEASE", hostile))

        hostile = timeline()
        hostile[14]["payload"]["target_device_id"] = "iphone_01"
        hostile[14]["payload"]["active_device_lease_version"] = 1
        hostile[15]["origin"] = {
            "device_id": "iphone_01",
            "device_class": "iphone",
            "client_instance_id": "iphone_client_01",
        }
        hostile[15]["connection"] = {"id": "iphone_conn_01", "epoch": 0, "state": "connected"}
        hostile[15]["payload"]["target_device_id"] = "iphone_01"
        hostile[15]["payload"]["active_device_lease_version"] = 1
        cases.append(("STALE_OLD_DEVICE_ACK_RENDERED", "STALE_OLD_DEVICE_ACK_RENDERED", hostile))

        hostile = timeline()
        hostile[11]["payload"]["status"] = "failure"
        del hostile[11]["payload"]["outputs"]
        hostile[11]["payload"]["error"] = {
            "code": "provider_error",
            "message": "Authorization: Bearer sk-secret-123456",
            "retryable": False,
        }
        cases.append(("SECRET_VALUE_IN_MODEL_ERROR", "CREDENTIAL_VALUE_EMBEDDED", hostile))

        hostile = timeline()
        hostile[12]["payload"]["to_device_id"] = "iphone_01"
        cases.append(("HANDOFF_FROM_EQUALS_TO", "HANDOFF_FROM_EQUALS_TO", hostile))

        hostile = [copy.deepcopy(self.events[0])]
        second_start = copy.deepcopy(hostile[0])
        second_start["event_id"] = "30000000-0000-4000-8000-000000000020"
        second_start["occurred_at"] = "2026-07-21T09:00:01Z"
        second_start["idempotency_key"] = "session-start-002"
        second_start["sequence"] = {
            "stream_id": "gateway_control",
            "number": 2,
            "previous_event_id": hostile[0]["event_id"],
        }
        second_start["payload"]["active_device_id"] = "rayneo_01"
        hostile.append(second_start)
        cases.append(("DUPLICATE_SESSION_START_RESETS_LEASE", "DUPLICATE_SESSION_START", hostile))

        hostile = copy.deepcopy(self.events[17:19])
        cases.append(("END_AND_CLEANUP_WITHOUT_START", "SESSION_NOT_STARTED", hostile))

        frozen_matrix = self.invalid_fixture["t14_hostile_regressions"]
        self.assertEqual(
            [(item["name"], item["expected_code"]) for item in frozen_matrix],
            [(name, expected_code) for name, expected_code, _ in cases],
        )
        self.assertEqual(21, len(cases))
        for matrix_item, (name, expected_code, hostile_timeline) in zip(frozen_matrix, cases):
            with self.subTest(hostile=name, expected_code=expected_code):
                detected = semantic_errors(hostile_timeline)
                self.assertIn(expected_code, detected, f"false accept for {name}: {detected}")
                if matrix_item["enforcement"] == "schema_and_semantic":
                    self.assertTrue(
                        any(not self.validator.is_valid(event) for event in hostile_timeline),
                        f"schema failed to close static hostile case: {name}",
                    )

    def test_t14_revise_semantic_regressions(self) -> None:
        def failed_model_timeline(message: str) -> list[dict[str, Any]]:
            hostile = copy.deepcopy(self.events)
            result = hostile[11]["payload"]
            result["status"] = "failure"
            del result["outputs"]
            result["error"] = {
                "code": "provider_error",
                "message": message,
                "retryable": False,
            }
            return hostile

        def handoff_chain_to_lease_three() -> list[dict[str, Any]]:
            chain = copy.deepcopy(self.events[:14])
            request_two = copy.deepcopy(self.events[12])
            request_two["event_id"] = "40000000-0000-4000-8000-000000000201"
            request_two["occurred_at"] = "2026-07-21T09:02:10Z"
            request_two["idempotency_key"] = "handoff-request-002"
            request_two["sequence"] = {
                "stream_id": "gateway_control",
                "number": 7,
                "previous_event_id": chain[-1]["event_id"],
            }
            request_two["payload"] = {
                "handoff_id": "handoff_002",
                "from_device_id": "rayneo_01",
                "to_device_id": "iphone_01",
                "expected_active_device_lease_version": 2,
                "reason": "demo_step",
            }
            completion_two = copy.deepcopy(self.events[13])
            completion_two["event_id"] = "40000000-0000-4000-8000-000000000202"
            completion_two["occurred_at"] = "2026-07-21T09:02:12Z"
            completion_two["idempotency_key"] = "handoff-complete-002"
            completion_two["sequence"] = {
                "stream_id": "gateway_control",
                "number": 8,
                "previous_event_id": request_two["event_id"],
            }
            completion_two["payload"] = {
                "handoff_id": "handoff_002",
                "request_event_id": request_two["event_id"],
                "from_device_id": "rayneo_01",
                "to_device_id": "iphone_01",
                "active_device_id": "iphone_01",
                "active_device_lease_version": 3,
                "old_device_output_suppressed": True,
                "completed_at": "2026-07-21T09:02:12Z",
            }
            chain.extend([request_two, completion_two])
            return chain

        def stale_first_completion(chain: list[dict[str, Any]]) -> dict[str, Any]:
            stale = copy.deepcopy(self.events[13])
            stale["event_id"] = "40000000-0000-4000-8000-000000000203"
            stale["occurred_at"] = "2026-07-21T09:02:13Z"
            stale["idempotency_key"] = "handoff-complete-001-new-envelope"
            stale["sequence"] = {
                "stream_id": "gateway_control",
                "number": 9,
                "previous_event_id": chain[-1]["event_id"],
            }
            stale["payload"]["completed_at"] = "2026-07-21T09:02:13Z"
            return stale

        cases: list[tuple[str, str, list[dict[str, Any]]]] = []
        credential_values = [
            (
                "CREDENTIAL_VALUE_CHANNEL_OPEN_NAKED_JWT_ERROR",
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2Nzg5MA",
            ),
            (
                "CREDENTIAL_VALUE_CHANNEL_OPEN_GITHUB_TOKEN_ERROR",
                "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
            ),
            (
                "CREDENTIAL_VALUE_CHANNEL_OPEN_AWS_ACCESS_KEY_ERROR",
                "AKIAABCDEFGHIJKLMNOP",
            ),
            (
                "CREDENTIAL_VALUE_CHANNEL_OPEN_SIGNED_URL_ERROR",
                "https://s3.example.invalid/object?X-Amz-Signature=abcdef1234567890",
            ),
        ]
        for name, value in credential_values:
            cases.append((name, "CREDENTIAL_VALUE_EMBEDDED", failed_model_timeline(value)))

        hostile = copy.deepcopy(self.events)
        media_ref = hostile[8]["payload"]["media_ref"]
        media_ref["transport"] = "ephemeral_object"
        media_ref["locator"] = (
            "ephemeral://eyJhbGciOiJIUzI1NiJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
            "c2lnbmF0dXJlMTIzNDU2Nzg5MA"
        )
        media_ref["byte_length"] = 128
        media_ref["sha256"] = "a" * 64
        cases.append(("CREDENTIAL_VALUE_CHANNEL_OPEN_JWT_MEDIA_LOCATOR", "CREDENTIAL_VALUE_EMBEDDED", hostile))

        hostile = copy.deepcopy(self.events)
        media_ref = hostile[8]["payload"]["media_ref"]
        media_ref["transport"] = "ephemeral_object"
        media_ref["locator"] = "ephemeral://bucket/frame?X-Amz-Signature=abcdef1234567890"
        media_ref["byte_length"] = 128
        media_ref["sha256"] = "b" * 64
        cases.append(("CREDENTIAL_VALUE_CHANNEL_OPEN_SIGNED_MEDIA_LOCATOR", "CREDENTIAL_VALUE_EMBEDDED", hostile))

        rollback = handoff_chain_to_lease_three()
        self.assertEqual([], semantic_errors(rollback), "lease 1 -> 2 -> 3 setup must be valid")
        rollback.append(stale_first_completion(rollback))
        cases.append(("HANDOFF_COMPLETION_CAS_ROLLBACK", "HANDOFF_COMPLETION_CAS_ROLLBACK", rollback))
        cases.append(("HANDOFF_REQUEST_SINGLE_CONSUME", "HANDOFF_REQUEST_ALREADY_CONSUMED", copy.deepcopy(rollback)))

        non_monotonic = handoff_chain_to_lease_three()
        request_three = copy.deepcopy(self.events[12])
        request_three["event_id"] = "40000000-0000-4000-8000-000000000204"
        request_three["occurred_at"] = "2026-07-21T09:02:14Z"
        request_three["idempotency_key"] = "handoff-request-003"
        request_three["sequence"] = {
            "stream_id": "gateway_control",
            "number": 9,
            "previous_event_id": non_monotonic[-1]["event_id"],
        }
        request_three["payload"] = {
            "handoff_id": "handoff_003",
            "from_device_id": "iphone_01",
            "to_device_id": "rayneo_01",
            "expected_active_device_lease_version": 3,
            "reason": "demo_step",
        }
        completion_three = copy.deepcopy(self.events[13])
        completion_three["event_id"] = "40000000-0000-4000-8000-000000000205"
        completion_three["occurred_at"] = "2026-07-21T09:02:15Z"
        completion_three["idempotency_key"] = "handoff-complete-003"
        completion_three["sequence"] = {
            "stream_id": "gateway_control",
            "number": 10,
            "previous_event_id": request_three["event_id"],
        }
        completion_three["payload"] = {
            "handoff_id": "handoff_003",
            "request_event_id": request_three["event_id"],
            "from_device_id": "iphone_01",
            "to_device_id": "rayneo_01",
            "active_device_id": "rayneo_01",
            "active_device_lease_version": 3,
            "old_device_output_suppressed": True,
            "completed_at": "2026-07-21T09:02:15Z",
        }
        non_monotonic.extend([request_three, completion_three])
        cases.append(("HANDOFF_LEASE_MONOTONIC", "HANDOFF_LEASE_NOT_MONOTONIC", non_monotonic))

        stale_delivery = copy.deepcopy(rollback)
        delivery = copy.deepcopy(self.events[14])
        delivery["event_id"] = "40000000-0000-4000-8000-000000000206"
        delivery["occurred_at"] = "2026-07-21T09:02:14Z"
        delivery["idempotency_key"] = "delivery-request-stale-002"
        delivery["sequence"] = {
            "stream_id": "gateway_control",
            "number": 10,
            "previous_event_id": stale_delivery[-1]["event_id"],
        }
        ack = copy.deepcopy(self.events[15])
        ack["event_id"] = "40000000-0000-4000-8000-000000000207"
        ack["occurred_at"] = "2026-07-21T09:02:15Z"
        ack["idempotency_key"] = "delivery-ack-stale-002"
        ack["payload"]["delivery_event_id"] = delivery["event_id"]
        ack["payload"]["acknowledged_at"] = "2026-07-21T09:02:15Z"
        stale_delivery.extend([delivery, ack])
        cases.append(("HANDOFF_STALE_DELIVERY_ACK_AFTER_ROLLBACK", "STALE_OLD_DEVICE_ACK_RENDERED", stale_delivery))

        hostile = copy.deepcopy(self.events)
        hostile[16]["connection"]["id"] = "iphone_conn_01"
        hostile[16]["payload"]["new_connection_id"] = "iphone_conn_01"
        cases.append(("RECONNECT_IDENTITY_REUSE", "RECONNECT_IDENTITY_REUSE", hostile))

        hostile = copy.deepcopy(self.events)
        hostile[16]["connection"]["resumed_from_connection_id"] = "iphone_conn_00"
        hostile[16]["payload"]["previous_connection_id"] = "iphone_conn_00"
        cases.append(("RECONNECT_WRONG_CURRENT_CHAIN", "RECONNECT_PREVIOUS_CONNECTION_MISMATCH", hostile))

        same_stream = copy.deepcopy(self.events[:3])
        capture_stop = copy.deepcopy(self.events[2])
        capture_stop["event_id"] = "40000000-0000-4000-8000-000000000208"
        capture_stop["occurred_at"] = "2026-07-21T09:00:07Z"
        capture_stop["idempotency_key"] = "iphone-audio-stop-002"
        capture_stop["sequence"] = {
            "stream_id": "audio_capture",
            "number": 2,
            "previous_event_id": self.events[2]["event_id"],
        }
        capture_stop["payload"]["status"] = "stopped"
        capture_stop["payload"]["observed_at"] = "2026-07-21T09:00:07Z"
        capture_restart = copy.deepcopy(self.events[2])
        capture_restart["event_id"] = "40000000-0000-4000-8000-000000000209"
        capture_restart["occurred_at"] = "2026-07-21T09:00:09Z"
        capture_restart["idempotency_key"] = "iphone-audio-restart-002"
        capture_restart["sequence"] = {
            "stream_id": "audio_capture",
            "number": 3,
            "previous_event_id": capture_stop["event_id"],
        }
        capture_restart["payload"]["observed_at"] = "2026-07-21T09:00:09Z"
        same_stream.extend([capture_stop, capture_restart, copy.deepcopy(self.events[3])])
        cases.append(("CAPTURE_SAME_STREAM_RESTART_AFTER_STOP", "CAPTURE_STREAM_RESTART_AFTER_STOP", same_stream))

        hostile = copy.deepcopy(self.events)
        hostile.append(copy.deepcopy(self.events[1]))
        cases.append(("CLEANUP_OLD_EVENT_EXACT_RETRY_TERMINAL", "EVENT_AFTER_CLEANUP", hostile))

        hostile = copy.deepcopy(self.events)
        hostile[-1]["occurred_at"] = "2026-07-21T09:19:59Z"
        hostile[-1]["expires_at"] = "2026-07-21T10:19:59Z"
        hostile[-1]["payload"]["completed_at"] = "2026-07-21T09:19:59Z"
        cases.append(("CLEANUP_COMPLETED_BEFORE_SESSION_END", "CLEANUP_COMPLETED_BEFORE_SESSION_END", hostile))

        frozen_matrix = self.invalid_fixture["t14_revise_regressions"]
        self.assertEqual(
            [(item["name"], item["expected_code"]) for item in frozen_matrix],
            [(name, expected_code) for name, expected_code, _ in cases],
        )
        self.assertEqual(15, len(cases))
        for name, expected_code, hostile_timeline in cases:
            with self.subTest(hostile=name, expected_code=expected_code):
                detected = semantic_errors(hostile_timeline)
                self.assertIn(expected_code, detected, f"false accept for {name}: {detected}")

    def test_t14_revise_positive_controls(self) -> None:
        fixture_controls = self.valid_fixture["state_machine_controls"]
        self.assertTrue(fixture_controls["capture_restart_after_stop_requires_new_stream_id"])
        self.assertTrue(fixture_controls["reconnect_requires_never_used_connection_id"])
        self.assertTrue(fixture_controls["handoff_completion_request_single_consume"])
        self.assertEqual(
            "identical_cleanup_completed_receipt_only",
            fixture_controls["cleanup_terminal_retry_exception"],
        )
        capture = copy.deepcopy(self.events[:3])
        capture_stop = copy.deepcopy(self.events[2])
        capture_stop["event_id"] = "40000000-0000-4000-8000-000000000301"
        capture_stop["occurred_at"] = "2026-07-21T09:00:07Z"
        capture_stop["idempotency_key"] = "iphone-audio-stop-003"
        capture_stop["sequence"] = {
            "stream_id": "audio_capture",
            "number": 2,
            "previous_event_id": self.events[2]["event_id"],
        }
        capture_stop["payload"]["status"] = "stopped"
        capture_stop["payload"]["observed_at"] = "2026-07-21T09:00:07Z"
        new_capture = copy.deepcopy(self.events[2])
        new_capture["event_id"] = "40000000-0000-4000-8000-000000000302"
        new_capture["occurred_at"] = "2026-07-21T09:00:09Z"
        new_capture["idempotency_key"] = "iphone-audio-new-stream-001"
        new_capture["sequence"] = {"stream_id": "audio_capture_002", "number": 1}
        new_capture["payload"]["observed_at"] = "2026-07-21T09:00:09Z"
        capture.extend([capture_stop, new_capture, copy.deepcopy(self.events[3])])

        cleanup_retry = copy.deepcopy(self.events)
        cleanup_retry.append(copy.deepcopy(self.events[-1]))
        controls = [
            ("CAPTURE_NEW_STREAM_AFTER_STOP", capture),
            ("CLEANUP_RECEIPT_EXACT_RETRY", cleanup_retry),
        ]
        self.assertEqual(
            [item["name"] for item in self.invalid_fixture["t14_revise_controls"]],
            [name for name, _ in controls],
        )
        for name, control_timeline in controls:
            with self.subTest(control=name):
                self.assertEqual([], semantic_errors(control_timeline))

    def test_t14_final_credential_normalization_regressions(self) -> None:
        jwt = "eyJhbGciOiJIUzI1NiJ9.e30.AAAAAAAAAAAA"

        def failed_model_timeline(message: str) -> list[dict[str, Any]]:
            hostile = copy.deepcopy(self.events)
            result = hostile[11]["payload"]
            result["status"] = "failure"
            del result["outputs"]
            result["error"] = {
                "code": "provider_error",
                "message": message,
                "retryable": False,
            }
            return hostile

        cases: list[tuple[str, str, list[dict[str, Any]]]] = []
        cases.append(("JWT_SHORT_PAYLOAD_MODEL_ERROR", "CREDENTIAL_VALUE_EMBEDDED", failed_model_timeline(jwt)))

        hostile = copy.deepcopy(self.events)
        hostile[8]["payload"]["media_ref"]["locator"] = f"livekit://{jwt}"
        self.assertTrue(self.validator.is_valid(hostile[8]), "JWT locator must exercise semantic value closure")
        cases.append(("JWT_SHORT_PAYLOAD_LIVEKIT_LOCATOR", "CREDENTIAL_VALUE_EMBEDDED", hostile))

        encoded_jwt = jwt.replace(".", "%2E")
        cases.append(("JWT_PERCENT_ENCODED_DOTS", "CREDENTIAL_VALUE_EMBEDDED", failed_model_timeline(encoded_jwt)))
        cases.append(
            (
                "SIGNED_URL_PERCENT_ENCODED_KEY",
                "CREDENTIAL_VALUE_EMBEDDED",
                failed_model_timeline(
                    "https://s3.example.invalid/object?X-Amz-%53ignature=abcdef1234567890"
                ),
            )
        )
        cases.append(
            (
                "SIGNED_URL_PATH_STYLE",
                "CREDENTIAL_VALUE_EMBEDDED",
                failed_model_timeline(
                    "https://s3.example.invalid/object/X-Amz-Signature/abcdef1234567890"
                ),
            )
        )
        mixed_case_jwt = jwt.replace(".", "%2e", 1).replace(".", "%2E", 1)
        cases.append(
            ("MIXED_CASE_PERCENT_ENCODING", "CREDENTIAL_VALUE_EMBEDDED", failed_model_timeline(mixed_case_jwt))
        )
        double_encoded_jwt = jwt.replace(".", "%252E")
        cases.append(
            ("DOUBLE_PERCENT_ENCODING", "CREDENTIAL_VALUE_ENCODING_INVALID", failed_model_timeline(double_encoded_jwt))
        )
        cases.append(
            (
                "INVALID_PERCENT_ENCODING",
                "CREDENTIAL_VALUE_ENCODING_INVALID",
                failed_model_timeline("provider returned invalid escape %2G"),
            )
        )

        frozen_matrix = self.invalid_fixture["t14_credential_final_regressions"]
        self.assertEqual(
            [(item["name"], item["expected_code"]) for item in frozen_matrix],
            [(name, expected_code) for name, expected_code, _ in cases],
        )
        self.assertEqual(8, len(cases))
        for name, expected_code, hostile_timeline in cases:
            with self.subTest(hostile=name, expected_code=expected_code):
                detected = semantic_errors(hostile_timeline)
                self.assertIn(expected_code, detected, f"false accept for {name}: {detected}")

    def test_t14_final_ordinary_livekit_locator_control(self) -> None:
        fixture_control = self.valid_fixture["credential_scan_controls"]
        self.assertTrue(fixture_control["scan_raw_and_once_percent_decoded"])
        self.assertTrue(fixture_control["invalid_or_nested_percent_encoding_rejected"])
        control = copy.deepcopy(self.events)
        control[8]["payload"]["media_ref"]["locator"] = fixture_control["ordinary_livekit_locator_allowed"]
        self.assertTrue(self.validator.is_valid(control[8]))
        self.assertEqual(
            ["ORDINARY_LIVEKIT_LOCATOR"],
            [item["name"] for item in self.invalid_fixture["t14_credential_final_controls"]],
        )
        self.assertEqual([], semantic_errors(control))

    def test_rtc_mapping_matches_schema_and_security_profile(self) -> None:
        self.assertEqual(EXPECTED_VERSION, self.mapping["schema_version"])
        self.assertEqual(["NON_CANONICAL", "EPHEMERAL", "PHASE0_ONLY"], self.mapping["status"])
        self.assertEqual("paios.phase0.demo", self.mapping["namespace"])
        self.assertEqual("LiveKit", self.mapping["upstream"]["transport"])
        self.assertEqual("v1.13.4", self.mapping["upstream"]["server_version"])
        self.assertEqual("paios.phase0.demo.event", self.mapping["data_packet"]["topic"])
        self.assertFalse(self.mapping["data_packet"]["raw_media_bytes_allowed"])
        self.assertFalse(self.mapping["watch_relay"]["direct_rtc_publish_allowed"])
        self.assertEqual("watch_connectivity", self.mapping["watch_relay"]["device_transport"])
        self.assertEqual("origin.relay.relay_device_id", self.mapping["watch_relay"]["rtc_participant_identity_source"])
        self.assertEqual("relay_publisher", self.mapping["watch_relay"]["rtc_participant_attributes_source"])
        self.assertEqual("event.origin", self.mapping["watch_relay"]["original_watch_identity_location"])
        self.assertIn("origin.relay", self.mapping["watch_relay"]["preserve_fields"])
        self.assertIn("connection", self.mapping["watch_relay"]["preserve_fields"])
        self.assertEqual("rtc_publisher_device_id", self.mapping["participant"]["attributes"]["device_id"])
        self.assertFalse(self.mapping["credentials"]["persisted"])
        self.assertFalse(self.mapping["credentials"]["logged"])
        self.assertEqual(900, self.mapping["credentials"]["max_access_token_ttl_seconds"])
        self.assertIn("bearer_credential", self.mapping["credentials"]["forbidden_values_include"])
        self.assertIn("jwt", self.mapping["credentials"]["forbidden_values_include"])
        self.assertIn("signed_url_or_locator", self.mapping["credentials"]["forbidden_values_include"])
        self.assertEqual(1, self.mapping["credentials"]["value_normalization"]["percent_decode_max_layers"])
        self.assertTrue(self.mapping["credentials"]["value_normalization"]["scan_raw_value"])
        self.assertTrue(self.mapping["credentials"]["value_normalization"]["scan_once_decoded_value"])
        self.assertTrue(self.mapping["credentials"]["value_normalization"]["invalid_percent_encoding_rejected"])
        self.assertTrue(self.mapping["credentials"]["value_normalization"]["nested_percent_encoding_rejected"])
        self.assertEqual(2, self.mapping["credentials"]["jwt_detection"]["payload_min_base64url_chars"])
        self.assertEqual(
            ["query", "fragment", "path"],
            self.mapping["credentials"]["signed_url_credential_locations"],
        )
        self.assertEqual(86400, self.mapping["retention"]["event_max_ttl_seconds"])
        self.assertFalse(self.mapping["retention"]["authoritative_store_allowed"])
        self.assertTrue(self.mapping["idempotency"]["retry_noop_requires_identical_canonical_envelope"])
        self.assertFalse(self.mapping["idempotency"]["receive_metadata_in_envelope_allowed"])
        self.assertEqual("IDEMPOTENCY_CONFLICT", self.mapping["idempotency"]["drift_result"])
        self.assertEqual(1, self.mapping["reconnect"]["increment_connection_epoch_exactly_by"])
        self.assertTrue(self.mapping["reconnect"]["new_connection_id_must_differ_from_all_prior_ids"])
        self.assertTrue(self.mapping["reconnect"]["resumed_from_must_equal_current_connection_id"])
        self.assertTrue(self.mapping["reconnect"]["last_acked_sequence_must_equal_observed_stream_head"])
        self.assertEqual(["byte_length", "sha256"], self.mapping["media"]["ephemeral_object_integrity_required"])
        self.assertTrue(self.mapping["media"]["kind_mime_match_required"])
        self.assertFalse(self.mapping["delivery"]["stale_lease_render_or_play_allowed"])
        self.assertTrue(self.mapping["delivery"]["ack_target_and_lease_must_equal_current_active"])
        self.assertTrue(self.mapping["handoff"]["request_single_consume"])
        self.assertEqual(1, self.mapping["handoff"]["lease_monotonic_increment_exactly_by"])
        self.assertFalse(self.mapping["handoff"]["invalid_completion_mutates_active_lease"])
        self.assertTrue(self.mapping["lifecycle"]["require_single_session_start"])
        self.assertTrue(self.mapping["lifecycle"]["reject_event_after_cleanup"])
        self.assertTrue(self.mapping["lifecycle"]["cleanup_terminal_check_before_retry_dedupe"])
        self.assertEqual(
            "paios.phase0.demo.session.cleanup.completed",
            self.mapping["lifecycle"]["post_cleanup_retry_noop_event"],
        )
        self.assertTrue(self.mapping["capture"]["stopped_stream_terminal"])
        self.assertTrue(self.mapping["capture"]["restart_requires_new_sequence_stream_id"])
        mapped_types = set(self.mapping["data_packet"]["reliable_event_types"]) | set(self.mapping["data_packet"]["lossy_event_types"])
        self.assertEqual(set(self.schema["properties"]["event_type"]["enum"]), mapped_types)
        self.assertEqual(["paios.phase0.demo.device.telemetry"], self.mapping["data_packet"]["lossy_event_types"])
        self.assertEqual(FORBIDDEN_EVENT_KEYS, set(self.mapping["credentials"]["forbidden_event_keys"]))

    def test_contract_markers_are_explicit(self) -> None:
        contract = CONTRACT_PATH.read_text(encoding="utf-8")
        for marker in ("NON_CANONICAL", "EPHEMERAL", "PHASE0_ONLY", EXPECTED_VERSION, "paios.phase0.demo.*"):
            self.assertIn(marker, contract)
        self.assertIn("MUST NOT be imported into `/contracts`", contract)
        self.assertIn("Passing it proves schema/fixture consistency only", contract)
        self.assertIn("sole retry no-op", contract)
        self.assertIn("reference validator only", contract)
        self.assertIn("single-consumes", contract)
        self.assertIn("Cleanup terminality is evaluated before retry dedupe", contract)
        self.assertIn("decodes at most one layer", contract)


if __name__ == "__main__":
    unittest.main(verbosity=2)
