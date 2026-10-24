"""A9 executor protocol and cashier workflow. Only injected deterministic inputs can pay."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
from dataclasses import dataclass, fields, replace
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


_PAID_VALUE = re.compile(r"支付成功|付款成功|已完成支付|已支付|已付款")
_FIELD_NAME = r"(?:支付|付款|交易|扣款|订单)(?:状态|结果)"
_CURRENT_FIELD = re.compile(r"(?:(?:本单|当前订单))?(?P<field>" + _FIELD_NAME + r")\s*[：:]?\s*(?P<value>.*)")
_FIELD_MARKER = re.compile(_FIELD_NAME)
CURRENT_ORDER_TITLES = frozenset({"订单详情", "支付结果", "付款结果"})
_UNPAID_VALUE = re.compile(r"(?:订单)?(?:未|待)(?:完成)?(?:支付|付款|付|结算)")
_UNRESOLVED = re.compile(r"(?:未|待)(?:完成)?(?:支付|付款|付|结算)|(?:支付|付款|交易|扣款)(?:中|失败|关闭|取消|未完成|处理中)|处理中|失败|^未$")
_ORDER_PROGRESS = re.compile(r"商家正在备餐|骑手已接单|申请售后|下单成功|成功下单")
_ORDER_CLOSED = re.compile(r"(?:订单)?(?:已)?(?:关闭|取消)|已取消订单")
_PRE_ORDER = re.compile(r"订单尚未创建|尚未下单|未下单")
_DEBIT_FRAGMENT = re.compile(r"(?:已(?:完成?)?|未|待)[支付扣结]|(?:支付|付款|交易|扣款)(?:状|结|成)$")
_PARTIAL = re.compile(r"部分.*(?:支付|付款|扣款)|(?:支付|付款|扣款).*部分")
CANCELLED_STATUS = re.compile(r"(?:订单状态[：:]\s*)?(?:订单已取消|已取消订单|已取消)")


@dataclass(frozen=True)
class PaymentField:
    text: str
    bounds: tuple[int, int, int, int] = (0, 0, 0, 0)
    container: tuple | None = None
    section: str | None = None
    region: tuple | None = None
    merchant: bool = False
    source: str = "native"
    binding_text: str | None = None
    section_instance: tuple | None = None
    heading: bool = False
    eligible: bool = False


@dataclass(frozen=True)
class PaymentEvidence:
    signs: tuple[str, ...]
    statuses: tuple[str, ...]
    state: str
    tokens: frozenset[str]
    control_texts: tuple[str, ...]
    non_debit_signs: tuple[str, ...]
    non_debit_state: str | None


def payment_evidence(texts, page_title=None, *, binding=None, observation=None):
    """Recognize only complete current-order fields; retain all other possible debit text as unresolved.

    Full matches define supported status scopes. Searching detects ambiguity only; it never supplies a value.
    The same immutable observation/binding is used for every input check and receipt.
    """
    scoped = bool(binding and observation and observation.region is not None and page_title in CURRENT_ORDER_TITLES
                  and not observation.scope_unresolved and binding.complete and binding.input_matches(observation, later=True))
    signs, statuses, states, tokens, controls, non_debit, unpaid_states = [], [], set(), set(), [], [], set()
    for entry in texts:
        context = entry if isinstance(entry, PaymentField) else None
        text = context.text if context else entry
        controls.append(text)
        if context and context.merchant:
            continue  # A merchant's name, product or remark cannot supply a payment field.
        field = _CURRENT_FIELD.fullmatch(text)
        value = field["value"] if field else text
        paid = bool(_PAID_VALUE.fullmatch(value) or (field and field["field"] in
                    {"支付状态", "支付结果", "付款状态", "付款结果", "交易状态", "交易结果"}
                    and re.fullmatch(r"(?:交易)?成功", value)))
        unpaid = bool(_UNPAID_VALUE.fullmatch(value) or _PRE_ORDER.fullmatch(value))
        progress = bool(_ORDER_PROGRESS.fullmatch(value))
        closed = bool(_ORDER_CLOSED.fullmatch(value))
        negative = bool(_UNRESOLVED.fullmatch(value))
        debit = "扣款" in text or "已扣" in text or bool(_PARTIAL.search(text))
        possible = bool(_FIELD_MARKER.search(text) or _PAID_VALUE.search(text)
                        or _UNRESOLVED.search(text) or _DEBIT_FRAGMENT.search(text))
        if not (paid or unpaid or progress or closed or debit or possible):
            continue
        statuses.append(text)  # Preserve the whole source statement, including every unsupported prefix.
        if _PAID_VALUE.search(text):
            tokens.add("paid")
        if context and context.eligible and context.heading and context.section_instance == getattr(observation, "region", None) and scoped:
            controls[-1] = ""
            continue
        if paid or unpaid or progress or closed or negative or debit or (field and not value) or (not field and possible):
            controls[-1] = ""
        # Neither a foreign/unknown prefix nor a truncated value matches an approved current field/value.
        current = (scoped and context and context.eligible and context.region == observation.region
                   and context.section_instance == observation.region and context.section in CURRENT_ORDER_TITLES)
        if not current or debit or not (paid or unpaid or progress):
            states.add("unknown")
        elif paid:
            signs.append(text)
            states.add("paid")
            tokens.add("paid")
        elif unpaid:
            states.add("unpaid")
            non_debit.append(text)
            unpaid_states.add("pre_order" if _PRE_ORDER.fullmatch(value) else "unpaid")
        elif progress:
            tokens.add("order_created")
    state = next(iter(states)) if len(states) == 1 else "unknown" if states else "absent"
    if state != "paid":
        signs = []
    if state != "unpaid" or tokens:
        non_debit = []
    non_debit_state = next(iter(unpaid_states)) if non_debit and len(unpaid_states) == 1 else None
    return PaymentEvidence(tuple(signs), tuple(statuses), state, frozenset(tokens), tuple(controls), tuple(non_debit), non_debit_state)


def optional_text(value):
    """A9 optional identity data is omitted if unreadable, never shortened into another identity."""
    return value if isinstance(value, str) and 0 < len(value) <= 200 else None


@dataclass(frozen=True)
class CheckpointConfig:
    card_ttl_s: float = 300
    max_recards: int = 2
    phase_extra_s: float = 60
    open_retry_s: float = 30
    retry_initial_s: float = 0.5
    retry_max_s: float = 3
    http_timeout_s: float = 30
    poll_wait_ms: int = 25000
    deadline_grace_s: float = 5
    result_wait_s: float = 15
    result_poll_s: float = 1
    cancel_steps: int = 15
    cancel_timeout_s: float = 180

    @classmethod
    def from_env(cls):
        defaults = cls()
        values = {f.name: type(getattr(defaults, f.name))(os.environ.get(
            "PAIOS_PAYMENT_" + f.name.upper(), getattr(defaults, f.name))) for f in fields(cls)}
        if any(not math.isfinite(v) or v < 0 for v in values.values()) or not 0 < values["poll_wait_ms"] <= 25000:
            raise PaymentError("PAYMENT_CONFIGURATION_INVALID")
        if not all(values[k] > 0 for k in ("http_timeout_s", "retry_initial_s", "retry_max_s", "result_poll_s")):
            raise PaymentError("PAYMENT_CONFIGURATION_INVALID")
        return cls(**values)


class PaymentError(RuntimeError):
    def __init__(self, code, status=0):
        super().__init__(code)
        self.code, self.status = code, status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise PaymentError("PAYMENT_REDIRECT_REFUSED")


class PaymentHTTPClient:
    """HTTP framing only; no policy, decisions, model transport or secret-bearing errors."""
    def __init__(self, base_url, key, config=None):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1", "localhost"}
                or url.username or url.password or url.query or url.fragment or not key):
            raise PaymentError("PAYMENT_CONFIGURATION_REQUIRED")
        self.base = base_url.rstrip("/") + "/internal/payment/executor"
        self._key, self.config = key, config or CheckpointConfig.from_env()
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    @classmethod
    def from_env(cls, config=None):
        try:
            url, key_file = os.environ["PAIOS_PAYMENT_URL"], os.environ["PAIOS_PAYMENT_KEY_FILE"]
            key = Path(key_file).read_text().strip()
        except (KeyError, OSError, UnicodeError):
            raise PaymentError("PAYMENT_CONFIGURATION_REQUIRED") from None
        return cls(url, key, config)

    async def request(self, method, path, body=None, timeout_s=None):
        def send():
            request = Request(self.base + path, method=method,
                data=None if body is None else json.dumps(body, ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + self._key})
            try:
                with self._opener.open(request, timeout=timeout_s or self.config.http_timeout_s) as response:
                    if response.status != 200:
                        raise PaymentError("PAYMENT_HTTP_ERROR", response.status)
                    payload = response.read(131073)
                if len(payload) > 131072:
                    raise ValueError("response too large")
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError("response must be an object")
                return value
            except HTTPError as exc:
                try:
                    code = json.loads(exc.read(4096)).get("error_code", "")
                except (ValueError, AttributeError, UnicodeError):
                    code = ""
                raise PaymentError(code if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code)
                                   else "PAYMENT_HTTP_ERROR", exc.code) from None
            except (URLError, TimeoutError, OSError):
                raise PaymentError("PAYMENT_AUTHORITY_UNAVAILABLE") from None
            except (ValueError, UnicodeError):
                raise PaymentError("PAYMENT_RESPONSE_INVALID") from None
        return await asyncio.to_thread(send)


@dataclass(frozen=True)
class Screen:
    amount_fen: int | None
    checkout: str = "order_card"
    payee: str | None = None
    items: tuple[str, ...] = ()
    delivery: str | None = None
    screen_sha256: str = ""
    read_at: str = ""
    pay_buttons: tuple[tuple[int, int], ...] = ()
    verify: bool = False
    paid_signs: tuple[str, ...] = ()
    order_id: str | None = None
    cancelled_signs: tuple[str, ...] = ()
    payment_statuses: tuple[str, ...] = ()
    charge_labels: tuple[str, ...] = ()
    payee_conflict: bool = False
    page_title: str | None = None
    order_namespace: str | None = None
    item_identity: tuple[tuple[str, str], ...] = ()
    item_facts: tuple[tuple[str, str], ...] = ()
    item_conflict: bool = False
    amount_conflict: bool = False
    region: tuple | None = None
    status_fields: tuple[PaymentField, ...] | None = None
    scope_unresolved: bool = False

    def evidence(self, binding=None):
        binding = binding or PaymentBinding(self.order_id, optional_text(self.payee), self.amount_fen,
                                            self.order_namespace, self.item_identity, self.item_facts)
        fields = self.status_fields if self.status_fields is not None else tuple(
            PaymentField(t, region=self.region, section=self.page_title, section_instance=self.region, eligible=True) for t in
            (*self.paid_signs, *(t for t in self.payment_statuses if t not in self.paid_signs)))
        evidence = payment_evidence(fields, self.page_title, binding=binding, observation=self)
        return replace(evidence, state="unknown", signs=(), non_debit_signs=(), non_debit_state=None) if self.scope_unresolved else evidence

    def reconciliation(self, binding):
        evidence = self.evidence(binding)
        signs = evidence.signs if evidence.state == "paid" else evidence.non_debit_signs
        state = evidence.state if signs and len(signs) <= 16 and all(len(t) <= 200 for t in signs) else "unknown"
        if state == "unpaid" and not binding.input_matches(self, later=True):
            state = "unknown"
        return {**binding.wire(), "state": state, "signs": list(signs) if state != "unknown" else [],
                "read_at": self.read_at}


@dataclass(frozen=True)
class PaymentBinding:
    order_id: str | None
    payee: str | None
    amount_fen: int | None
    order_namespace: str | None = None
    item_identity: tuple[tuple[str, str], ...] = ()
    item_facts: tuple[tuple[str, str], ...] = ()
    grant_id: str | None = None
    max_taps: int = 0
    deadline: float = 0

    @property
    def complete(self):
        return bool(optional_text(self.order_id) and optional_text(self.order_namespace)
                    and self.item_identity and self.payee and self.amount_fen)

    def conflicts(self, screen):
        facts = dict(self.item_facts)
        return (screen.payee_conflict or screen.amount_conflict or screen.item_conflict
                or (screen.order_namespace is not None and self.order_namespace is not None
                    and screen.order_namespace != self.order_namespace)
                or any(key in facts and facts[key] != value for key, value in screen.item_facts)
                or (screen.item_identity and self.item_identity and screen.item_identity != self.item_identity)
                or (screen.order_id is not None and self.order_id is not None
                and screen.order_id != self.order_id) or (screen.payee is not None and self.payee is not None
                and optional_text(screen.payee) != self.payee)
                or (screen.amount_fen is not None and screen.amount_fen != self.amount_fen))

    def input_matches(self, screen, later=False):
        return (not self.conflicts(screen) and screen.amount_fen == self.amount_fen
                and (not self.order_id or screen.order_id == self.order_id)
                and (not self.payee or optional_text(screen.payee) == self.payee)
                and (not self.order_namespace or screen.order_namespace == self.order_namespace)
                and (not self.item_identity or screen.item_identity == self.item_identity)
                and (not later or bool(self.order_id and self.payee and self.order_namespace and self.item_identity
                    and screen.order_namespace == self.order_namespace and screen.item_identity == self.item_identity)))

    def receipt_matches(self, screen):
        return (bool(self.order_id and self.order_namespace and self.item_identity)
                and screen.order_id == self.order_id and screen.order_namespace == self.order_namespace
                and not self.conflicts(screen))

    def wire(self):
        return dict(order_id=self.order_id, order_namespace=self.order_namespace, payee=self.payee,
                    amount_fen=self.amount_fen, item_identity=[list(pair) for pair in self.item_identity])


class PaymentCheckpoint:
    """The executor owns this workflow, never the authorization or a second payment ledger."""
    def __init__(self, client, read, tap, cancel_order, config=None):
        self.client, self.read, self.tap, self.cancel_order = client, read, tap, cancel_order
        self.config = config or CheckpointConfig.from_env()
        self.payment_id = None
        self.binding = None
        self.steps = 0
        self.tap_pending = False
        self.input_attempted = False
        self.screen = None
        self.baseline_signs = set()
        self.first_surface = None

    @property
    def order_id(self):
        return self.binding.order_id if self.binding else None

    async def post(self, operation, body):
        return await self.client.request("POST", f"/payments/{self.payment_id}/{operation}", body)

    async def cancel_before_open(self):
        self.phase_end = time.monotonic() + self.config.cancel_timeout_s
        return await self._unpaid("JOB_CANCELLED", abort=False)

    async def run(self, intent_id, job_id, app):
        try:
            budget = self.config.card_ttl_s * (1 + self.config.max_recards) + self.config.phase_extra_s
            self.phase_end = time.monotonic() + budget
            async with asyncio.timeout(budget):
                return await self._run(intent_id, job_id, app)
        except asyncio.CancelledError:
            return await self._unknown() if self.steps or self.tap_pending else await self._unpaid("JOB_CANCELLED")
        except TimeoutError:
            return await self._unknown() if self.steps or self.tap_pending else await self._unpaid("expired", abort=False)
        except PaymentError as exc:
            if self.steps or self.tap_pending:
                return await self._unknown()
            if not self.payment_id and exc.code == "SCREEN_UNREADABLE":
                return self._answer(False, "【没有付款】屏幕读不到；未尝试取消未付款订单，请在 App 里核对。")
            return await self._unpaid(exc.code)
        except (KeyError, TypeError, ValueError):
            # Malformed authority replies cross the HTTP boundary; never escape as a paid-shaped result.
            return await self._unknown() if self.steps or self.tap_pending else await self._unpaid("PAYMENT_RESPONSE_INVALID")

    async def _run(self, intent_id, job_id, app):
        self.screen = await self.read()
        self.binding = PaymentBinding(self.screen.order_id, optional_text(self.screen.payee), self.screen.amount_fen,
                                     self.screen.order_namespace, self.screen.item_identity, self.screen.item_facts)
        self._baseline(self.screen)
        if self.screen.evidence(self.binding).state in {"paid", "unknown"}:
            return await self._unknown()  # An already paid/ambiguous order cannot justify another charge input.
        if self.screen.verify:
            return await self._unpaid("VERIFICATION_REQUIRED")
        if not self.screen.amount_fen:
            raise PaymentError("SCREEN_UNREADABLE")
        s = self.screen
        body = dict(intent_id=intent_id, job_id=job_id, seq=1, app=app, checkout=s.checkout,
                    amount_fen=s.amount_fen, payee=optional_text(s.payee), items=list(s.items), delivery=optional_text(s.delivery),
                    screen_sha256=s.screen_sha256, read_at=s.read_at)
        end = time.monotonic() + self.config.open_retry_s
        delay = self.config.retry_initial_s
        while True:
            try:
                opened_at = time.monotonic()
                opened = await self.client.request("POST", "/checkpoints", body,
                    timeout_s=min(self.config.http_timeout_s, max(end - time.monotonic(), 0.001)))
                break
            except PaymentError as exc:
                if (exc.status < 500 and exc.code != "PAYMENT_AUTHORITY_UNAVAILABLE") or time.monotonic() >= end:
                    raise
                await asyncio.sleep(min(delay, max(0, end - time.monotonic())))
                delay = min(delay * 2, self.config.retry_max_s)
        self.payment_id = opened["payment_id"]
        phase_end = self.phase_end
        deadline = self._deadline(opened, phase_end, opened_at)
        version = 0
        while time.monotonic() < deadline:
            try:
                polled_at = time.monotonic()
                view = await self.client.request("GET", f"/payments/{self.payment_id}?" + urlencode({
                    "wait_ms": min(self.config.poll_wait_ms, max(0, int((deadline - time.monotonic()) * 1000))),
                    "after_version": version}), timeout_s=min(self.config.http_timeout_s, max(deadline - time.monotonic(), 0.001)))
            except PaymentError as exc:
                if exc.status < 500 and exc.code != "PAYMENT_AUTHORITY_UNAVAILABLE":
                    raise
                await asyncio.sleep(min(self.config.retry_max_s, max(0, deadline - time.monotonic())))
                continue
            version = view["version"]
            if view["payment_id"] != self.payment_id:
                raise PaymentError("PAYMENT_RESPONSE_INVALID")
            deadline = self._deadline(view, phase_end, polled_at)
            state = view["state"]
            if state == "granted" and "grant" in view:
                grant = view["grant"]
                self.binding = replace(self.binding, grant_id=grant["grant_id"], amount_fen=grant["amount_fen"],
                    max_taps=grant["max_taps"], deadline=polled_at + (grant["expires_at_ms"] - view["server_now_ms"]) / 1000)
                self.screen = await self.read()
                self._baseline(self.screen)
                if self.screen.verify:
                    return await self._unpaid("VERIFICATION_REQUIRED")
                if not self.screen.amount_fen:
                    return await self._unpaid("SCREEN_UNREADABLE")
                if (replace(self.binding, amount_fen=self.screen.amount_fen).conflicts(self.screen)
                        or (self.binding.order_id and self.screen.order_id != self.binding.order_id)
                        or (self.binding.payee and optional_text(self.screen.payee) != self.binding.payee)):
                    return await self._unpaid("SCREEN_UNREADABLE")
                if self.screen.amount_fen != self.binding.amount_fen:
                    changed = await self.post("amount-changed", dict(grant_id=self.binding.grant_id,
                        read_amount_fen=self.screen.amount_fen, payee=optional_text(self.screen.payee), items=list(self.screen.items),
                        screen_sha256=self.screen.screen_sha256))
                    self.payment_id = changed["next"]["payment_id"]
                    deadline = min(phase_end, polled_at + max(0,
                        (changed["next"]["expires_at_ms"] - view["server_now_ms"]) / 1000) + self.config.deadline_grace_s)
                    self.binding = replace(self.binding, grant_id=None)
                    version = 0
                    continue
                return await self._pay(view.get("method"))
            if state in {"paid", "outcome_unknown", "paying"}:
                # Resuming a consumed grant never resumes physical input.
                return self._answer(False, "【付款结果不明】付款状态需要只读核对；不会再付一次。", outcome="unknown")
            if state == "superseded" and view.get("next_payment_id"):
                self.payment_id, version = view["next_payment_id"], 0
                # The new card has its own clock; its first poll supplies the authoritative expiry.
                deadline = phase_end
                continue
            if state in {"cancelled", "expired", "failed", "superseded"}:
                return await self._unpaid(view.get("reason") or state, abort=False)
        return await self._unpaid("expired", abort=False)

    def _deadline(self, view, phase_end, observed_at):
        return min(phase_end, observed_at + max(0, (view["expires_at_ms"] - view["server_now_ms"]) / 1000)
                   + self.config.deadline_grace_s)

    async def _pay(self, method):
        binding = self.binding  # Frozen once a grant is accepted; all inputs and receipts use this same binding.
        while True:
            s = self.screen
            if s.evidence(binding).state in {"paid", "unknown"}:
                return await self._unknown()
            if not binding.input_matches(s, later=bool(self.steps)):
                return await self._unknown()
            if len(s.pay_buttons) != 1:
                return await self._unknown() if self.steps else await self._unpaid("PAY_BUTTON_NOT_FOUND")
            if time.monotonic() >= binding.deadline or self.steps >= binding.max_taps:
                return await self._unknown() if self.steps else await self._unpaid("PAYMENT_GRANT_EXPIRED")
            non_debit = self._non_debit(s) if self.steps else None
            if self.steps and not non_debit:
                return await self._unknown()
            self.tap_pending = True
            try:
                receipt = await self.post("tap", dict(grant_id=binding.grant_id, step=self.steps + 1,
                    read_amount_fen=s.amount_fen, screen_sha256=s.screen_sha256, order_binding=binding.wire(),
                    **({"non_debit": non_debit} if non_debit else {})))
            except PaymentError as exc:
                if 400 <= exc.status < 500:
                    self.tap_pending = False
                raise
            if (receipt.get("ok") is not True or (self.steps and receipt.get("non_debit_admitted") is not True)
                    or time.monotonic() >= binding.deadline):
                return await self._unknown()
            self.steps += 1
            self.tap_pending = False
            # The write-ahead round trip can outlive or change the UI. Consume its step, but never its stale input.
            self.screen = fresh = await self.read()
            if (not binding.input_matches(fresh, later=self.steps > 1) or fresh.pay_buttons != s.pay_buttons
                    or len(fresh.pay_buttons) != 1 or fresh.verify or fresh.checkout != s.checkout
                    or fresh.order_id != s.order_id or fresh.payee != s.payee
                    or fresh.charge_labels != s.charge_labels or fresh.page_title != s.page_title
                    or fresh.evidence(binding).state in {"paid", "unknown"}
                    or (self.steps > 1 and not self._non_debit(fresh))
                    or time.monotonic() >= binding.deadline):
                return await self._unknown()
            if not self.input_attempted:
                self._baseline(fresh)
                self.first_surface = fresh
            try:
                self.input_attempted = True
                if await self.tap(*fresh.pay_buttons[0]) is False:
                    return await self._unknown()
            except Exception:  # Input may already have reached Android. Never replay or expose driver errors.
                return await self._unknown()
            end = time.monotonic() + self.config.result_wait_s
            while True:
                self.screen = await asyncio.wait_for(self.read(), max(0.001, end - time.monotonic()))
                evidence = self.screen.evidence(self.binding)
                if binding.conflicts(self.screen) or evidence.state == "unknown":
                    return await self._unknown()
                signs = self._receipt_signs(evidence)
                if signs:
                    result = await self._result("paid", signs=signs)
                    if result.get("state") != "paid":
                        return await self._unknown()
                    label = {"card": "点卡片", "voice": "声纹", "auto": "免密"}.get(method)
                    amount = f"{binding.amount_fen / 100:.2f}".rstrip("0").rstrip(".")
                    return self._answer(True, f"【已付款】¥{amount} {binding.payee or ''}"
                                        + (f"；{label}" if label else ""))
                if self.screen.verify:
                    await self._result("not_paid", "VERIFICATION_REQUIRED")
                    return self._answer(False, "【没有付款】收银台要你自己验证；未取消订单，请你自己完成验证。")
                if self.screen.pay_buttons and self.steps < binding.max_taps and self._non_debit(self.screen):
                    break
                if evidence.state in {"paid", "unpaid"}:
                    return await self._unknown()
                if time.monotonic() >= end:
                    return await self._unknown()
                await asyncio.sleep(min(self.config.result_poll_s, max(0, end - time.monotonic())))

    def _baseline(self, screen):
        self.baseline_signs.update(screen.evidence(self.binding).tokens & {"paid"})

    def _non_debit(self, screen):
        """Only the source's explicit unpaid forward state can permit another potentially debiting input."""
        evidence, first = screen.evidence(self.binding), self.first_surface
        # A result heading, a relabel or returning to an earlier order page is not a forward no-charge proof.
        first_evidence = first.evidence(self.binding) if first else None
        first_state = first_evidence.non_debit_state if first_evidence else None
        forward = first and first.checkout == "order_card" and (
            screen.checkout == "cashier" or (first_state == "pre_order" and evidence.non_debit_state == "unpaid"))
        if (not forward or first_evidence.state in {"paid", "unknown"} or self.baseline_signs
                or not self.binding.input_matches(screen, later=True) or screen.verify
                or not evidence.non_debit_signs or len(evidence.non_debit_signs) > 16
                or any(len(t) > 200 for t in evidence.non_debit_signs)):
            return None
        return dict(state=evidence.non_debit_state, scope="current_order",
                    transition="order_card_to_cashier" if screen.checkout == "cashier" else "pre_order_to_unpaid",
                    signs=list(evidence.non_debit_signs), read_at=screen.read_at)

    def _receipt_signs(self, evidence):
        s = self.screen
        if (not self.binding.receipt_matches(s) or evidence.state != "paid" or self.baseline_signs
                or len(evidence.signs) > 16 or any(len(t) > 200 for t in evidence.signs)):
            return ()
        return evidence.signs

    async def _result(self, outcome, reason=None, signs=()):
        s = self.screen
        return await self.post("result", dict(grant_id=self.binding.grant_id, outcome=outcome,
            signs=list(signs), screen_sha256=s.screen_sha256, **({"reason": reason} if reason else {})))

    async def _settle(self, work):
        task = asyncio.create_task(work)
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass  # Once cleanup starts, all callers join this same task before releasing the phone.
        return task.result()

    async def _unknown(self, reason=None):
        return await self._settle(self._finish_unknown(reason))

    async def _finish_unknown(self, reason):
        if self.payment_id and self.binding.grant_id:
            try:
                if self.steps or self.tap_pending:
                    await self._result("unknown", reason)
                else:
                    await self.post("abort", dict(grant_id=self.binding.grant_id, reason="SCREEN_UNREADABLE"))
            except PaymentError:
                pass  # The authority's write-ahead result timer reconciles an unreachable result endpoint.
        item = dict(self.binding.item_facts).get("name") or dict(self.binding.item_facts).get("sku")
        return self._answer(False, "【付款结果不明】" + ("点了付款但没看到结果" if self.input_attempted else "付款状态没有确认")
                            + "，已停止，我先只读核对一下订单；不会再付一次。"
                            + f"本次订单 {self.binding.order_id or '无法确认'}，金额 "
                            + (f"¥{self.binding.amount_fen / 100:.2f}" if self.binding.amount_fen else "无法确认")
                            + f"，收款方 {self.binding.payee or '无法确认'}，商品 {item or '无法确认'}。", outcome="unknown")

    async def _unpaid(self, reason, abort=True):
        return await self._settle(self._cleanup_unpaid(reason, abort))

    async def _cleanup_unpaid(self, reason, abort):
        if abort and self.payment_id:
            code = reason if reason in {"VERIFICATION_REQUIRED", "SCREEN_UNREADABLE", "PAY_BUTTON_NOT_FOUND", "JOB_CANCELLED"} else "EXECUTOR_LOST"
            try:
                await self.post("abort", {"reason": code, **({"grant_id": self.binding.grant_id} if self.binding.grant_id else {})})
            except PaymentError:
                pass  # Cleanup must still run when the authority has already closed the card or is unreachable.
        if reason == "VERIFICATION_REQUIRED":
            cleanup = "未取消订单，请你自己完成验证。"
        else:
            remaining = self.phase_end - time.monotonic()
            if remaining <= 0:
                cancelled = {"outcome": "not_attempted", "detail": "付款阶段时限已到，请在 App 核对"}
            else:
                try:
                    cancelled = await asyncio.wait_for(self.cancel_order(), min(self.config.cancel_timeout_s, remaining))
                except TimeoutError:
                    cancelled = {"outcome": "failed", "detail": "取消超时，请在 App 核对"}
            if self.payment_id:
                try:
                    await self.post("order-cancel", cancelled)
                except PaymentError:
                    pass  # Tell the owner the physical cleanup result even if its audit delivery fails.
            cleanup = {"done": "千问里的未付款订单已取消。", "failed": "千问里的未付款订单没取消成功。",
                       "not_attempted": "未尝试取消未付款订单，请你在 App 里核对。"}[cancelled["outcome"]]
        line = {"cancelled": "你取消了", "JOB_CANCELLED": "你取消了", "expired": "超过付款卡期限没确认",
                "PAYMENT_RECARD_LIMIT": "金额变了，已停止", "SCREEN_UNREADABLE": "屏幕读不到",
                "PAY_BUTTON_NOT_FOUND": "没有找到唯一的付款按钮", "VERIFICATION_REQUIRED": "收银台要你自己验证",
                "PAYMENT_CHECKPOINT_ACTIVE": "付款卡已满（最多 2 笔），请先完成或取消一笔已有付款后再申请；不会重试这次付款检查，也不会自动取消其他付款",
                "APPROVAL_BUSY": "待处理授权已满（最多 2 个），请先处理已有授权；有未完成付款时先完成或取消；不会重试这次付款检查，也不会自动取消其他付款"}.get(reason, "付款授权不可用")
        return self._answer(False, f"【没有付款】{line}；{cleanup}")

    def _answer(self, success, answer, *, outcome="unpaid"):
        from payment_lineage import remember
        return {"success": success, "answer": answer[:4000], "payment_outcome": "paid" if success else outcome,
                **({"payment_binding": remember(self.binding)} if self.binding else {})}
