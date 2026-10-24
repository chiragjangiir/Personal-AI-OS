"""A9 against an isolated HTTP authority and injected screens/inputs. Never connects a phone."""
import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent))
from payment_checkpoint import CheckpointConfig, PaymentCheckpoint, PaymentError, PaymentHTTPClient, Screen
import server
from payment_capture_fixture import frame


CARD = Screen(1660, payee="一点点", items=("香柠养乐多",), pay_buttons=((100, 200),),
              screen_sha256="a" * 64, read_at="2026-10-15T10:00:00.000Z", order_id="current-order-1",
              order_namespace="com.aliyun.tongyi", page_title="订单详情", region=("fixture",),
              item_identity=(("name", "香柠养乐多"), ("spec", "大杯"), ("quantity", "1")),
              item_facts=(("name", "香柠养乐多"), ("spec", "大杯"), ("quantity", "1")))
PAID = replace(CARD, pay_buttons=(), paid_signs=("支付成功",))


def observed_guard(nodes, png):
    # Only attach real native ancestry. Every caller supplies its own complete or incomplete facts.
    tree = ET.Element("hierarchy", width="1080", height="4000")
    root = ET.SubElement(tree, "node", text="", bounds="[0,0][1080,4000]")
    for text, x0, y0, x1, y1 in dict.fromkeys(nodes):
        ET.SubElement(root, "node", text=text, bounds=f"[{x0},{y0}][{x1},{y1}]")
    with mock.patch.object(server, "_observation", return_value=ET.tostring(tree)):
        native = server._tree()
    return SimpleNamespace(_seen=mock.AsyncMock(return_value=native + nodes), native_nodes=native,
                           shown=nodes, png=frame((1080,4000), png), capture_unresolved=False, app_namespace="com.aliyun.tongyi")


async def parsed_screen(texts, cashier=False):
    nodes = [(text, 0, i * 100, 200, i * 100 + 50) for i, text in enumerate(texts)]
    guard = observed_guard(nodes, "|".join(texts).encode())
    with mock.patch.object(server, "_at_checkout", return_value=cashier):
        return await server._payment_screen(guard)


class CheckpointHTTP(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.config = replace(CheckpointConfig(), open_retry_s=1, retry_initial_s=0.005,
            retry_max_s=0.005, poll_wait_ms=10, deadline_grace_s=0.01, result_wait_s=1, result_poll_s=0.005)
        self.events, self.calls = [], []
        self.started = time.monotonic()
        self.ttl, self.grant_ttl, self.amount = 5000, 10000, 1660
        self.state, self.seq, self.reject_tap, self.reject_open = "granted", 1, 0, 0
        self.down, self.method, self.cancelled = False, None, 0
        self.on_tap = None
        self.non_debit_admitted = True
        self.open_error = "PAYMENT_INTENT_SCOPE_DENIED"
        app = web.Application()
        app.router.add_route("*", "/internal/payment/executor/{tail:.*}", self.handle)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        self.client = PaymentHTTPClient(self.base, "synthetic-executor-key", self.config)
        self.addAsyncCleanup(self.runner.cleanup)

    def clock(self):
        return 100000 + int((time.monotonic() - self.started) * 1000)

    async def handle(self, request):
        self.assertEqual(request.headers["Authorization"], "Bearer synthetic-executor-key")
        path = request.match_info["tail"]
        body = await request.json() if request.method == "POST" else None
        self.calls.append((path, body))
        if path == "checkpoints":
            self.events.append("open")
            if self.reject_open:
                return web.json_response({"error_code": self.open_error}, status=self.reject_open)
            self.expires = self.clock() + self.ttl
            return web.json_response(dict(payment_id="pay-1", state="awaiting_owner", expires_at_ms=self.expires, server_now_ms=self.clock()))
        operation = path.split("/")[-1]
        if request.method == "GET":
            if self.down:
                return web.json_response({"error_code": "PAYMENT_AUTHORITY_UNAVAILABLE"}, status=503)
            await asyncio.sleep(0.005)
            value = dict(payment_id=f"pay-{self.seq}", state=self.state, version=self.seq,
                         expires_at_ms=self.expires, server_now_ms=self.clock())
            if self.state == "granted":
                value["grant"] = dict(grant_id=f"grant-private-{self.seq}", amount_fen=self.amount,
                                      expires_at_ms=self.clock() + self.grant_ttl, max_taps=2)
            if self.method:
                value["method"] = self.method
            return web.json_response(value)
        self.events.append(operation + (str(body["step"]) if operation == "tap" else ""))
        if operation == "tap":
            if self.reject_tap:
                return web.json_response({"error_code": "PAYMENT_GRANT_EXPIRED"}, status=self.reject_tap)
            self.assertEqual(body["read_amount_fen"], self.amount)
            if self.on_tap:
                await self.on_tap(body["step"])
            if body["step"] == 2:
                first = next(value for path, value in self.calls if path.endswith("/tap") and value["step"] == 1)
                self.assertEqual(body["order_binding"], first["order_binding"])
                self.assertEqual(body["non_debit"]["scope"], "current_order")
                self.assertTrue(body["non_debit"]["signs"])
                return web.json_response({"ok": True, **({"non_debit_admitted": True} if self.non_debit_admitted else {})})
        if operation == "amount-changed":
            self.seq += 1
            self.amount = body["read_amount_fen"]
            self.expires = self.clock() + self.ttl
            return web.json_response(dict(state="superseded", next=dict(payment_id=f"pay-{self.seq}", expires_at_ms=self.expires)))
        if operation == "result":
            return web.json_response({"state": {"paid": "paid", "unknown": "outcome_unknown", "not_paid": "failed"}[body["outcome"]]})
        return web.json_response({"ok": True})

    async def run_screens(self, screens, *, tap_error=False, tap_false=False, tap_at=(100, 200)):
        iterator = iter(screens)
        last = screens[-1]
        async def read():
            nonlocal last
            last = next(iterator, last)
            return last
        async def tap(*at):
            self.events.append("input")
            self.assertEqual(at, tap_at)
            if tap_error:
                raise RuntimeError("input reply unknown grant-private-1")
            return not tap_false
        async def cancel():
            self.cancelled += 1
            self.events.append("cancel-order")
            return {"outcome": "done"}
        result = await PaymentCheckpoint(self.client, read, tap, cancel, self.config).run("pi-owner", "job-1", "千问")
        self.assertNotIn("grant-private", json.dumps(result))
        self.assertNotIn("synthetic-executor-key", json.dumps(result))
        return result

    async def test_I1_I2_I8_happy_path_requires_write_ahead_200(self):
        result = await self.run_screens([CARD, CARD, CARD, PAID])
        self.assertTrue(result["success"], result)
        self.assertTrue(result["answer"].startswith("【已付款】¥16.6 一点点"))
        self.assertEqual(self.events, ["open", "tap1", "input", "result"])

    async def test_lost_http_ack_never_replays_a_write_or_physical_input(self):
        request = self.client.request
        for lost in ("tap1", "tap2", "result"):
            with self.subTest(lost=lost):
                self.events.clear()
                self.calls.clear()
                async def discard_ack(method, path, body=None, timeout_s=None):
                    reply = await request(method, path, body, timeout_s)
                    operation = path.rsplit("/", 1)[-1]
                    name = operation + str(body["step"]) if operation == "tap" else operation
                    if name == lost:
                        raise PaymentError("PAYMENT_AUTHORITY_UNAVAILABLE")
                    return reply
                cashier = replace(CARD, checkout="cashier", payment_statuses=("支付状态：未支付",))
                screens = [CARD, CARD, CARD, cashier, cashier, PAID] if lost == "tap2" else [CARD, CARD, CARD, PAID]
                with mock.patch.object(self.client, "request", side_effect=discard_ack):
                    result = await self.run_screens(screens)
                self.assertEqual(result["payment_outcome"], "unknown", self.events)
                self.assertEqual(self.events.count("input"), 0 if lost == "tap1" else 1)
                self.assertEqual(self.events.count("tap1"), 1)
                self.assertEqual(self.events.count("tap2"), int(lost == "tap2"))
                self.assertNotIn("cancel-order", self.events)

    async def test_restarted_consumed_checkpoint_never_resumes_physical_input(self):
        for state in ("paying", "paid", "outcome_unknown"):
            with self.subTest(state=state):
                self.events.clear()
                self.calls.clear()
                self.state = state
                result = await self.run_screens([CARD])
                self.assertEqual(result["payment_outcome"], "unknown")
                self.assertEqual(self.events, ["open"])

    async def test_I2_amount_change_before_first_tap_opens_new_card(self):
        changed = replace(CARD, amount_fen=1860)
        result = await self.run_screens([CARD, changed, changed, changed, replace(PAID, amount_fen=1860)])
        self.assertTrue(result["success"], result)
        self.assertEqual(self.events, ["open", "amount-changed", "tap1", "input", "result"])
        self.assertEqual(self.seq, 2)

    async def test_I2_I3_second_step_equal_or_changed_never_recards_a_tapped_grant(self):
        for amount, paid, taps in ((1660, True, 2), (1860, False, 1)):
            with self.subTest(amount=amount):
                self.events.clear()
                cashier = replace(CARD, checkout="cashier", amount_fen=amount, payment_statuses=("支付状态：未支付",))
                result = await self.run_screens([CARD, CARD, CARD, cashier, cashier, PAID])
                self.assertEqual(result["success"], paid)
                self.assertEqual(self.events.count("input"), taps)
                self.assertNotIn("amount-changed", self.events)
                if paid:
                    self.assertEqual(self.events, ["open", "tap1", "input", "tap2", "input", "result"])
                else:
                    self.assertTrue(result["answer"].startswith("【付款结果不明】"))

    async def test_I3_same_button_after_tap_is_not_a_second_step(self):
        for after in (CARD, replace(CARD, screen_sha256="b" * 64), replace(CARD, pay_buttons=((101, 200),))):
            with self.subTest(after=after):
                self.events.clear()
                result = await self.run_screens([CARD, CARD, CARD, after])
                self.assertFalse(result["success"])
                self.assertEqual(self.events, ["open", "tap1", "input", "result"])

    async def test_I3_second_input_requires_authority_evidence_admission_ack(self):
        self.non_debit_admitted = False
        unpaid = replace(CARD, checkout="cashier", payment_statuses=("支付状态：未支付",))
        result = await self.run_screens([CARD, CARD, CARD, unpaid, unpaid, PAID])
        self.assertTrue(result["answer"].startswith("【付款结果不明】"))
        self.assertEqual(self.events, ["open", "tap1", "input", "tap2", "result"])
        self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I3_explicit_preorder_to_bound_unpaid_order_allows_one_debit(self):
        before = replace(CARD, payment_statuses=("订单尚未创建",))
        after = replace(CARD, payment_statuses=("订单状态：待付款",))
        result = await self.run_screens([before, before, before, after, after, PAID])
        self.assertTrue(result["success"], result)
        self.assertEqual(self.events, ["open", "tap1", "input", "tap2", "input", "result"])
        self.assertEqual(next(b for p, b in self.calls if p.endswith("/tap") and b["step"] == 2)["non_debit"]["transition"],
                         "pre_order_to_unpaid")

    async def test_I3_back_navigation_with_unpaid_text_is_not_forward_proof(self):
        before = replace(CARD, checkout="cashier", page_title="支付结果")
        after = replace(CARD, page_title="订单详情", payment_statuses=("支付状态：未支付",))
        result = await self.run_screens([before, before, before, after])
        self.assertFalse(result["success"])
        self.assertEqual(self.events, ["open", "tap1", "input", "result"])
        self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I2_I3_different_or_unidentifiable_second_order_never_gets_write_ahead(self):
        for initial, changes in ((CARD, {"order_id": "other-order", "payee": "其他商家"}),
                (CARD, {"order_id": "other-order"}), (CARD, {"payee": "其他商家"}),
                (CARD, {"order_id": None}), (CARD, {"payee": None}),
                (replace(CARD, order_id=None), {"order_id": "newly-visible-order"}),
                (replace(CARD, payee=None), {"payee": "newly-visible-shop"})):
            with self.subTest(initial_order=initial.order_id, changes=changes):
                self.events.clear()
                cashier = replace(initial, checkout="cashier", **changes)
                result = await self.run_screens([initial, initial, initial, cashier])
                self.assertFalse(result["success"])
                self.assertEqual(self.events, ["open", "tap1", "input", "result"])
                self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I1_I2_no_input_on_rejected_open_tap_expired_grant_or_ambiguous_button(self):
        for case in ("open", "tap", "expired", "zero", "two"):
            with self.subTest(case=case):
                self.events.clear()
                self.reject_open = 403 if case == "open" else 0
                self.reject_tap = 409 if case == "tap" else 0
                self.grant_ttl = -1 if case == "expired" else 500
                buttons = () if case == "zero" else ((100, 200), (300, 400)) if case == "two" else CARD.pay_buttons
                result = await self.run_screens([CARD, replace(CARD, pay_buttons=buttons)])
                self.assertFalse(result["success"])
                self.assertNotIn("input", self.events)
                self.assertIn("cancel-order", self.events)
                if case == "open":
                    self.assertEqual(self.events.count("open"), 1, "4xx is never retried")

    async def test_I1_overlapping_visible_controls_stay_ambiguous(self):
        nodes = [("订单详情", 0, 0, 200, 50), ("订单号：current-order-1", 0, 100, 200, 150),
                 ("总计 ¥16.60", 0, 200, 200, 250), ("收款方：一点点", 0, 300, 200, 350),
                 ("确认付款", 0, 400, 200, 450), ("提交订单", 0, 450, 200, 500),
                 ("商品名称：香柠养乐多", 0, 600, 200, 650), ("规格：大杯", 0, 700, 200, 750), ("数量：1", 0, 800, 200, 850)]
        guard = observed_guard(nodes + [nodes[4]], b"two-controls")
        with mock.patch.object(server, "_at_checkout", return_value=False):
            screen = await server._payment_screen(guard)
        self.assertEqual(len(screen.pay_buttons), 2)
        result = await self.run_screens([screen])
        self.assertFalse(result["success"])
        self.assertNotIn("input", self.events)
        self.assertNotIn("tap1", self.events)

    async def test_I10_verify_before_or_after_grant_leaves_order_for_owner(self):
        for screens, opened in (([replace(CARD, verify=True)], False), ([CARD, replace(CARD, verify=True)], True)):
            with self.subTest(opened=opened):
                self.events.clear()
                result = await self.run_screens(screens)
                self.assertIn("自己完成验证", result["answer"])
                self.assertNotIn("input", self.events)
                self.assertNotIn("cancel-order", self.events)
                self.assertEqual("open" in self.events, opened)

    async def test_I1_initial_unreadable_total_opens_no_card_and_makes_no_input(self):
        result = await self.run_screens([replace(CARD, amount_fen=None)])
        self.assertEqual(self.events, [])
        self.assertIn("屏幕读不到", result["answer"])
        self.assertIn("未尝试取消", result["answer"])

    async def test_I7_I10_cancel_during_handoff_never_opens_a_card(self):
        cancelled = mock.AsyncMock(return_value={"outcome": "done"})
        result = await PaymentCheckpoint(None, None, None, cancelled, self.config).cancel_before_open()
        self.assertIn("你取消了", result["answer"])
        self.assertEqual(self.events, [])
        cancelled.assert_awaited_once()

    async def test_I10_authority_down_or_ignored_card_deadline_always_cancels(self):
        for down in (False, True):
            with self.subTest(down=down):
                self.events.clear()
                self.ttl, self.state, self.down = 10, "awaiting_owner", down
                result = await self.run_screens([CARD])
                self.assertFalse(result["success"])
                self.assertIn("cancel-order", self.events)
                self.assertNotIn("input", self.events)

    async def test_I3_I8_unknown_input_and_result_never_retry(self):
        for failure in ("error", "false", "no-signs"):
            with self.subTest(failure=failure):
                self.events.clear()
                result = await self.run_screens([CARD, CARD, CARD, replace(CARD, pay_buttons=())],
                                               tap_error=failure == "error", tap_false=failure == "false")
                self.assertTrue(result["answer"].startswith("【付款结果不明】"))
                self.assertEqual(self.events.count("input"), 1)
                self.assertNotIn("cancel-order", self.events)

    async def test_I9_missing_configuration_and_nonlocal_urls_fail_closed(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(PaymentError, "PAYMENT_CONFIGURATION_REQUIRED"):
                PaymentHTTPClient.from_env()
        for url in ("http://example.invalid", "https://127.0.0.1", "http://user:secret@127.0.0.1"):
            with self.assertRaises(PaymentError):
                PaymentHTTPClient(url, "fake")
        # The fake validates the configured bearer; key separation is the authority's integration test.

    async def test_I2_I3_stale_amount_during_write_ahead_and_other_changes_dispatch_nothing(self):
        for step in (1, 2):
            for changes in ({"amount_fen": 1860}, {"pay_buttons": ()},
                    {"pay_buttons": ((101, 200),)}, {"pay_buttons": ((100, 200), (300, 400))},
                    {"verify": True}, {"order_id": "other-order"}, {"order_id": None},
                    {"payee": "其他商家"}, {"payee": None}, {"page_title": "支付结果"},
                    {"charge_labels": ("换了付款控件",)}):
                with self.subTest(step=step, changes=changes):
                    self.events.clear()
                    visible = CARD
                    async def read():
                        return visible
                    async def acknowledge(current_step):
                        nonlocal visible
                        if current_step == step:
                            visible = replace(visible, **changes)
                    async def tap(*where):
                        nonlocal visible
                        self.events.append("input")
                        self.assertEqual(where, (100, 200))
                        visible = replace(CARD, checkout="cashier", payment_statuses=("支付状态：未支付",))
                    self.on_tap = acknowledge
                    result = await PaymentCheckpoint(self.client, read, tap, mock.AsyncMock(), self.config).run("pi-owner", "job-1", "千问")
                    self.assertFalse(result["success"])
                    self.assertEqual(self.events.count("input"), step - 1)
                    self.assertEqual(self.events.count(f"tap{step}"), 1)
                    self.assertNotIn("amount-changed", self.events)
                    self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I2_I3_grant_expiring_during_post_ack_read_never_inputs(self):
        for step in (1, 2):
            with self.subTest(step=step):
                self.events.clear()
                self.grant_ttl = 500
                acknowledged = 0
                visible = CARD
                async def read():
                    if acknowledged == step:
                        await asyncio.sleep(.55)
                    return visible
                async def acknowledge(current_step):
                    nonlocal acknowledged
                    acknowledged = current_step
                async def tap(*where):
                    nonlocal visible
                    self.events.append("input")
                    visible = replace(CARD, checkout="cashier", payment_statuses=("支付状态：未支付",))
                self.on_tap = acknowledge
                result = await PaymentCheckpoint(self.client, read, tap, mock.AsyncMock(), self.config).run("pi-owner", "job-1", "千问")
                self.assertFalse(result["success"])
                self.assertEqual(self.events.count("input"), step - 1)
                self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I8_old_success_text_is_not_accepted_as_current_receipt(self):
        for initial, after in ((replace(CARD, paid_signs=("上一单：支付成功",)), replace(PAID, paid_signs=("支付状态：支付成功",))),
                (CARD, replace(PAID, order_id="old-order")), (CARD, replace(PAID, order_id=None)),
                (CARD, replace(PAID, paid_signs=("下单成功", "成功下单"))),
                (replace(CARD, paid_signs=("支付成功",)), PAID)):
            with self.subTest(initial=initial.paid_signs, after=after):
                self.events.clear()
                self.calls.clear()
                result = await self.run_screens([initial, initial, initial, after])
                self.assertFalse(result["success"])
                if initial.paid_signs:
                    self.assertEqual(self.events, [], "Pre-existing ambiguous/paid status is not a new charge authorization")
                    self.assertEqual(self.calls, [])
                else:
                    self.assertEqual(self.events.count("input"), 1)
                    self.assertEqual(self.calls[-1][1]["outcome"], "unknown")
                    self.assertEqual(self.calls[-1][1]["signs"], [])

    async def test_I3_existing_paid_or_unresolved_state_never_gets_a_first_input(self):
        for phase in ("initial", "granted", "ack"):
            for status in ("支付状态：已支付", "扣款状态：处理中", "支付结果：未"):
                with self.subTest(phase=phase, status=status):
                    self.events.clear(); self.calls.clear()
                    changed = replace(CARD, payment_statuses=(status,))
                    screens = [changed] if phase == "initial" else [CARD, changed] if phase == "granted" else [CARD, CARD, changed]
                    result = await self.run_screens(screens)
                    self.assertTrue(result["answer"].startswith("【付款结果不明】"))
                    self.assertNotIn("input", self.events)
                    self.assertNotIn("cancel-order", self.events, "Never cancel a possibly paid order")
                    if phase == "initial":
                        self.assertEqual(self.calls, [])
                    elif phase == "granted":
                        self.assertEqual(self.events, ["open", "abort"])
                    else:
                        self.assertEqual(self.events, ["open", "tap1", "result"])
                        self.assertEqual(self.calls[-1][1]["outcome"], "unknown")

    async def test_I3_unpaid_fulfilment_and_conflicting_status_are_never_payment_proof(self):
        cases = [((label, "支付状态：未支付"), False) for label in ("商家正在备餐", "骑手已接单", "申请售后", "下单成功", "成功下单")]
        cases += [((label,), False) for label in ("商家正在备餐", "骑手已接单", "申请售后", "下单成功", "成功下单")]
        # Review sharper_cases: retain incomplete/status-result fields and all negative aliases, not just 状态.
        cases += [(("支付成功", status), False) for status in ("支付状态：未支付", "付款状态：处理中", "未完成支付",
            "支付状态：", "支付状态：未", "付款中", "订单未付款", "交易关闭", "支付结果：失败", "支付结果：未",
            "交易状态：未付", "交易状态：失败", "未结算", "未付", "交易失败", "付款结果：", "订单状态：未",
            "交易结果：处理中", "付款状态", "支付结果：支付成功，支付状态：未支付")]
        cases += [(statuses, False) for statuses in (("支付状态：", "已支付"), ("支付状态：已完成",))]
        cases += [((label,), True) for label in ("支付成功", "付款成功", "已支付", "已完成支付", "支付状态：已支付",
            "付款状态：已付款", "支付状态： 已支付", "支付结果：成功", "付款结果：付款成功", "交易状态：已支付")]
        cases += [(("商家正在备餐", "支付成功"), True)]
        cases += [(("订单状态：商家正在备餐", "支付成功"), True)]
        for statuses, paid in cases:
            with self.subTest(statuses=statuses):
                self.events.clear()
                taps = []
                async def read():
                    texts = ["订单详情", "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点",
                             "商品名称：香柠养乐多", "规格：大杯", "数量：1"]
                    texts += list(statuses) if taps else ["支付状态：未支付", "确认付款"]
                    screen = await parsed_screen(texts)
                    if taps:
                        for field in statuses:
                            if "状态" in field or "结果" in field:
                                self.assertIn(field, screen.payment_statuses, "Incomplete fields must survive the producer")
                    return screen
                async def tap(*where):
                    taps.append(where)
                result = await PaymentCheckpoint(self.client, read, tap, mock.AsyncMock(), self.config).run("pi-owner", "job-1", "千问")
                self.assertEqual(result["success"], paid)
                self.assertEqual(len(taps), 1)
                self.assertEqual(self.calls[-1][1]["outcome"], "paid" if paid else "unknown")
                if not paid:
                    self.assertEqual(self.calls[-1][1]["signs"], [])
                    self.assertIn("只读核对", result["answer"])

    async def test_I2_I3_receipt_uses_the_immutable_grant_binding(self):
        cases = (({}, True), ({"order_id": "other-order"}, False), ({"order_id": None}, False),
                 ({"payee": "其他商家"}, False), ({"amount_fen": 1860}, False),
                 ({"payee": None}, False), ({"amount_fen": None}, False),
                 ({"payee": None, "amount_fen": None}, False), ({"payee_conflict": True}, False),
                 ({"amount_conflict": True, "amount_fen": None}, False), ({"item_conflict": True}, False),
                 ({"order_namespace": "other.app"}, False), ({"order_namespace": None}, False),
                 ({"item_identity": (("sku", "other-product"), ("quantity", "1"))}, False),
                 ({"item_facts": (("name", "其他商品"),), "item_identity": ()}, False),
                 ({"item_facts": (), "item_identity": ()}, False))
        for changes, paid in cases:
            with self.subTest(changes=changes):
                self.events.clear()
                result = await self.run_screens([CARD, CARD, CARD, replace(PAID, **changes)])
                self.assertEqual(result["success"], paid)
                self.assertEqual(self.events, ["open", "tap1", "input", "result"])
                self.assertEqual(self.calls[-1][1]["outcome"], "paid" if paid else "unknown")
                self.assertEqual(self.calls[-1][1]["signs"], ["支付成功"] if paid else [])
                if paid:
                    self.assertIn("¥16.6 一点点", result["answer"])

    async def test_I2_receipt_total_and_payee_conflicts_survive_the_real_parser(self):
        for total, payees, paid in (("总计 ¥18.60", ["一点点"], False), ("总计 ¥16.60", ["其他商家"], False),
                ("实付款 ¥18.60", ["一点点"], False), (None, [], False), ("总计 ¥16.60", ["一点点"], True),
                ("总计 ¥16.60", ["一点点", "其他商家"], False), ("总计 ¥16.60 实付 ¥14.60", ["一点点"], False)):
            with self.subTest(total=total, payees=payees):
                self.events.clear()
                receipt = await parsed_screen(["订单详情", "订单号：current-order-1", "商品名称：香柠养乐多", "规格：大杯", "数量：1", "支付成功"]
                    + ([total] if total else []) + ["收款方：" + value for value in payees])
                self.assertEqual(receipt.amount_fen, None if not total or "14.60" in total or len(payees) > 1 else 1860 if "18.60" in total else 1660)
                if len(payees) > 1:
                    self.assertTrue(receipt.payee_conflict)
                    self.assertEqual(receipt.evidence().state, "unknown")
                self.assertEqual(receipt.pay_buttons, (), "A receipt total/status is not a charge control")
                result = await self.run_screens([CARD, CARD, CARD, receipt])
                self.assertEqual(result["success"], paid)
                self.assertEqual(self.events, ["open", "tap1", "input", "result"])
                self.assertEqual(self.calls[-1][1]["outcome"], "paid" if paid else "unknown")

    async def test_I1_I2_I3_surface_navigation_continues_with_one_grant(self):
        for first, second in (("立即购买", "确认付款"), ("立即购买", "确认"), ("确认", "确认付款"), ("去支付", "支付")):
            with self.subTest(first=first, second=second):
                self.events.clear()
                stage = 0
                async def seen():
                    texts = ["订单详情" if stage == 0 else "支付结果", "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点"]
                    texts += [first] if stage == 0 else [second, "支付状态：未支付"] if stage == 1 else ["支付状态：已支付"]
                    texts += ["商品名称：香柠养乐多", "规格：大杯", "数量：1"]
                    guard.shown = [(t, 0, i * 100, 200, i * 100 + 50) for i, t in enumerate(texts)]
                    guard.png = "|".join(texts).encode()
                    observed = observed_guard(guard.shown, guard.png)
                    guard.native_nodes = observed.native_nodes
                    guard.png = observed.png
                    guard.capture_unresolved = False
                    return guard.native_nodes + guard.shown
                async def tap(*where):
                    nonlocal stage
                    self.events.append("input")
                    self.assertEqual(where, (100, 425))
                    stage += 1
                phone = SimpleNamespace(tap=mock.AsyncMock(side_effect=tap))
                guard = server.CheckoutStop(phone, "pi-owner")
                guard.app_namespace = "com.aliyun.tongyi"
                with mock.patch.object(guard, "_seen", side_effect=seen), mock.patch.object(server, "_at_checkout", side_effect=lambda: stage > 0):
                    with self.assertRaises(server._CheckpointReached):
                        await guard.tap(100, 425)
                    phone.tap.assert_not_awaited()
                    result = await PaymentCheckpoint(self.client, lambda: server._payment_screen(guard), phone.tap,
                        mock.AsyncMock(), self.config).run("pi-owner", "job-1", "千问")
                self.assertTrue(result["success"], result)
                self.assertEqual(self.events, ["open", "tap1", "input", "tap2", "input", "result"])
                self.assertEqual(self.seq, 1)
                self.assertEqual([body["grant_id"] for path, body in self.calls if path.endswith("/tap")][-2:],
                                 ["grant-private-1", "grant-private-1"])

    async def test_I3_relabelled_payment_control_is_never_a_new_step(self):
        for first, label in (("确认付款 ¥16.60", "确认付款 ¥16.6"), ("确认付款", "确认 付款 ¥16.60"),
                ("确认付款", "立即支付"), ("确认付款", "付款"), ("免密支付", "确认付款"),
                ("下单并支付", "确认付款"), ("立即购买", "确认付款")):
            with self.subTest(first=first, label=label):
                self.events.clear()
                before = await parsed_screen(["订单详情", "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点", first, "商品名称：香柠养乐多", "规格：大杯", "数量：1"])
                after = await parsed_screen(["订单详情", "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点", label, "商品名称：香柠养乐多", "规格：大杯", "数量：1"])
                self.assertEqual(before.page_title, after.page_title)
                result = await self.run_screens([before, before, before, after], tap_at=(100, 425))
                self.assertFalse(result["success"])
                self.assertEqual(self.events, ["open", "tap1", "input", "result"])

    async def test_I3_result_page_heading_is_distinct_from_an_incomplete_field(self):
        for title in ("订单详情", "支付结果", "付款结果"):
            for field in (None, "支付结果：", "支付状态", "交易结果：未"):
                with self.subTest(title=title, field=field):
                    self.events.clear()
                    receipt = await parsed_screen([title, "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点",
                        "商品名称：香柠养乐多", "规格：大杯", "数量：1", "支付成功"] + ([field] if field else []))
                    self.assertEqual(receipt.page_title, title)
                    if field:
                        self.assertIn(field, receipt.payment_statuses)
                    result = await self.run_screens([CARD, CARD, CARD, receipt])
                    self.assertEqual(result["success"], field is None)
                    self.assertEqual(self.events, ["open", "tap1", "input", "result"])
                    self.assertEqual(self.calls[-1][1]["outcome"], "unknown" if field else "paid")

    async def test_I3_I10_capacity_409s_are_distinct_never_retried_and_leave_other_payments_alone(self):
        for code, wording in (("PAYMENT_CHECKPOINT_ACTIVE", "付款卡已满（最多 2 笔）"), ("APPROVAL_BUSY", "待处理授权已满（最多 2 个）")):
            with self.subTest(code=code):
                self.calls.clear()
                self.events.clear()
                self.reject_open, self.open_error = 409, code
                result = await self.run_screens([CARD])
                self.assertFalse(result["success"])
                self.assertIn(wording, result["answer"])
                self.assertIn("先完成或取消", result["answer"])
                self.assertIn("不会重试", result["answer"])
                self.assertIn("不会自动取消其他付款", result["answer"])
                self.assertEqual(self.events, ["open", "cancel-order"])
                self.assertEqual([path for path, _ in self.calls], ["checkpoints"])

    async def test_I8_result_evidence_bounds_are_lossless_or_unknown(self):
        for signs, paid in ((("支付成功",) * 16, True), (("支付状态：" + " " * 191 + "支付成功",), True),
                (("支付成功",) * 17, False), (("支付成功" + "字" * 197,), False)):
            with self.subTest(count=len(signs), length=len(signs[0])):
                result = await self.run_screens([CARD, CARD, CARD, replace(PAID, paid_signs=signs)])
                self.assertEqual(result["success"], paid)
                self.assertEqual(self.calls[-1][1]["outcome"], "paid" if paid else "unknown")
                self.assertEqual(self.calls[-1][1]["signs"], list(signs) if paid else [])

    async def test_I8_poll_method_is_optional_and_uses_authority_label(self):
        for method, label in ((None, None), ("card", "点卡片"), ("voice", "声纹"), ("auto", "免密")):
            with self.subTest(method=method):
                self.method = method
                result = await self.run_screens([CARD, CARD, CARD, PAID])
                self.assertTrue(result["success"])
                self.assertEqual(result["answer"].split("；")[1:], [label] if label else [])

    async def test_I2_optional_payee_delivery_bounds_use_code_points_and_never_truncate(self):
        for length in (200, 201):
            with self.subTest(length=length):
                value = "🍵" * length
                screen = replace(CARD, payee=value, delivery=value)
                result = await self.run_screens([screen, screen, screen, replace(PAID, payee=value)])
                self.assertEqual(result["success"], length == 200)
                body = next(body for path, body in reversed(self.calls) if path == "checkpoints")
                self.assertEqual(body["payee"], value if length == 200 else None)
                self.assertEqual(body["delivery"], value if length == 200 else None)
                if length == 201:
                    self.assertNotIn(value, result["answer"])

    async def test_I10_cancellation_joins_cleanup_even_on_http_error(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def cancel():
            self.cancelled += 1
            entered.set()
            await release.wait()
            return {"outcome": "done"}
        self.reject_open = 409
        checkpoint = PaymentCheckpoint(self.client, mock.AsyncMock(return_value=CARD), mock.AsyncMock(), cancel, self.config)
        task = asyncio.create_task(checkpoint.run("pi-owner", "job-1", "千问"))
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        self.assertFalse(task.done())
        release.set()
        result = await asyncio.wait_for(task, 1)
        self.assertIn("已取消", result["answer"])
        self.assertEqual(self.cancelled, 1)

    async def test_I10_superseded_card_adopts_new_authority_deadline(self):
        original = self.client.request
        polls = 0
        async def request(method, path, body=None, timeout_s=None):
            nonlocal polls
            if method == "GET":
                polls += 1
                if polls == 1:
                    return {"payment_id": "pay-1", "state": "superseded", "next_payment_id": "pay-2",
                            "version": 2, "expires_at_ms": self.clock() + 5000, "server_now_ms": self.clock()}
                if polls == 2:
                    return {"payment_id": "pay-2", "state": "awaiting_owner", "version": 1,
                            "expires_at_ms": self.clock() + 5, "server_now_ms": self.clock()}
                raise PaymentError("PAYMENT_AUTHORITY_UNAVAILABLE")
            return await original(method, path, body, timeout_s)
        self.client.request = request
        result = await asyncio.wait_for(self.run_screens([CARD]), 0.3)
        self.assertIn("已取消", result["answer"])
        self.assertGreaterEqual(polls, 2)

    async def test_I3_I10_global_checkpoint_budget_bounds_unresponsive_read(self):
        config = replace(self.config, card_ttl_s=0.01, max_recards=0, phase_extra_s=0)
        cancelled = mock.AsyncMock(return_value={"outcome": "done"})
        async def read():
            await asyncio.Event().wait()
        checkpoint = PaymentCheckpoint(self.client, read, mock.AsyncMock(), cancelled, config)
        result = await asyncio.wait_for(checkpoint.run("pi-owner", "job-1", "千问"), 0.3)
        self.assertTrue(result["answer"].startswith("【没有付款】"))
        cancelled.assert_not_awaited()
        self.assertIn("未尝试取消", result["answer"])


class AgentCheckpoint(unittest.IsolatedAsyncioTestCase):
    async def test_I2_I3_source_namespace_and_labelled_item_identity_survive_redraw(self):
        base = ["订单详情", "订单号：current-order-1", "总计 ¥16.60", "收款方：一点点",
                "商品名称：香柠养乐多", "规格：大杯", "数量：1", "立即购买"]
        first = await parsed_screen(base)
        redraw = await parsed_screen(["订单详情", "备注：订单附加提示", *base[1:], "备注：其他提示"])
        self.assertNotEqual(first.items, redraw.items)
        self.assertEqual(first.item_identity, redraw.item_identity)
        self.assertEqual(first.order_namespace, "com.aliyun.tongyi")
        ambiguous = await parsed_screen([*base, "实付 ¥14.60", "商品名称：其他商品"])
        self.assertTrue(ambiguous.amount_conflict)
        self.assertTrue(ambiguous.item_conflict)
        self.assertIsNone(ambiguous.amount_fen)
        self.assertEqual(ambiguous.item_identity, ())
        self.assertTrue(server._recognize_charge([(t, 0, i * 100, 200, i * 100 + 50)
                                                 for i, t in enumerate([*base, "实付 ¥14.60"])]).surface)

    async def test_I2_I3_app_namespace_is_observed_around_the_fresh_read(self):
        phone = SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame((1080,2400))))
        for before, after, expected in (("com.aliyun.tongyi", "com.aliyun.tongyi", "com.aliyun.tongyi"),
                                        ("com.aliyun.tongyi", "other.app", None), (None, None, None)):
            with self.subTest(before=before, after=after):
                guard = server.CheckoutStop(phone, "pi-owner")
                focus = [f"mCurrentFocus=Window{{u0 {p}/.Detail}}" if p else "unknown" for p in (before, after)]
                with mock.patch.object(server, "_shell", side_effect=focus), \
                     mock.patch.object(server, "_screen_nodes", return_value=[("总计 ¥16.60", 0, 0, 200, 50)]), \
                     mock.patch.object(server, "_observation", return_value=b'<hierarchy width="1080" height="2400"/>'):
                    await guard._seen()
                self.assertEqual(guard.app_namespace, expected)

    async def test_I1_model_paid_claim_without_cashier_is_not_a_receipt(self):
        class Handler:
            def __await__(self):
                async def done():
                    return SimpleNamespace(success=True, reason="我帮你付好了", steps=1)
                return done().__await__()
            cancel_run = mock.AsyncMock()
        config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
        with mock.patch.object(server, "_load_model"), mock.patch.object(server, "_bind"), \
             mock.patch.object(server, "ConfigLoader", SimpleNamespace(load=lambda _: config), create=True), \
             mock.patch.object(server, "MobileAgent", return_value=SimpleNamespace(run=lambda: Handler()), create=True), \
             mock.patch.object(server, "_count_steps", new=mock.AsyncMock()), \
             mock.patch.object(server, "_screen_signs", new=mock.AsyncMock(return_value=set())), \
             mock.patch.object(server, "_payment_screen", new=mock.AsyncMock(return_value=replace(CARD, amount_fen=None, pay_buttons=()))):
            result = await server._agent("点一杯", 10, "pi-owner", driver=mock.Mock(), app="千问")
        self.assertFalse(result["success"])
        self.assertTrue(result["answer"].startswith("【没有付款】"))
        self.assertNotIn("付好了", result["answer"])

    async def test_I2_fresh_ocr_tree_merge_has_one_button_and_integer_total(self):
        nodes = [("订单详情", 0, 0, 100, 50), ("总计 ¥16.60", 0, 50, 100, 100),
                 ("收款方：一点点", 0, 100, 100, 150), ("支付宝付款", 0, 200, 100, 250),
                 ("订单号：current-order-1", 0, 300, 200, 350), ("商品名称：香柠养乐多", 0, 400, 200, 450),
                 ("规格：大杯", 0, 500, 200, 550), ("数量：1", 0, 600, 200, 650)]
        guard = observed_guard(nodes + [nodes[3]], b"fresh-screen")
        with mock.patch.object(server, "_at_checkout", return_value=False):
            screen = await server._payment_screen(guard)
        self.assertEqual((screen.amount_fen, screen.payee, screen.pay_buttons), (1660, "一点点", ((50, 225),)))
        self.assertIsNone(server._order_total([("总计 ¥16.600", 0, 0, 100, 50)]))

    async def test_I1_checkpoint_screen_uses_release_controls_and_confirmation_surface(self):
        for label in ("提交订单", "免密下单", "确认付款 ¥16.60", "合计¥16.6提交订单", "支付", "支付 ¥16.60",
                      "一键下单", "下单并支付", "免密购买", "确认", "提交", "立即", "立即购买"):
            with self.subTest(label=label):
                nodes = [("订单详情", 0, 0, 200, 50), ("总计 ¥16.60", 0, 100, 100, 150),
                         (label, 0, 200, 100, 250), ("订单号：current-order-1", 0, 300, 200, 350),
                         ("收款方：一点点", 0, 400, 200, 450), ("商品名称：香柠养乐多", 0, 500, 200, 550),
                         ("规格：大杯", 0, 600, 200, 650), ("数量：1", 0, 700, 200, 750)]
                guard = observed_guard(nodes + [nodes[2]], b"charge-screen")
                with mock.patch.object(server, "_at_checkout", return_value=False):
                    screen = await server._payment_screen(guard)
                self.assertEqual((screen.amount_fen, screen.pay_buttons), (1660, ((50, 225),)))
        for label in ("立即购买", "支付方式", "去结算"):
            with self.subTest(navigation=label):
                screen = await parsed_screen(["商品 ¥16.60", label])
                self.assertEqual((screen.amount_fen, screen.pay_buttons), (None, ()), "Navigation off the charge surface")
        for label in ("支付方式", "去结算"):
            with self.subTest(total_navigation=label):
                screen = await parsed_screen(["订单详情", "总计 ¥16.60", "订单号：current-order-1",
                    "收款方：一点点", "商品名称：香柠养乐多", "规格：大杯", "数量：1", label])
                self.assertEqual((screen.amount_fen, screen.pay_buttons), (1660, ()))

    async def test_I1_status_and_result_text_are_not_checkpoint_controls(self):
        for status in ("支付状态：未支付", "支付结果：未", "交易状态：失败", "支付成功", "下单成功", "成功下单",
                       "历史支付状态：已支付", "历史支付结果：成功", "扣款状态：处理中", "部分支付"):
            with self.subTest(status=status):
                screen = await parsed_screen(["订单详情", "订单号：current-order-1", "总计 ¥16.60", "确认", status,
                    "收款方：一点点", "商品名称：香柠养乐多", "规格：大杯", "数量：1"])
                self.assertEqual(screen.pay_buttons, ((100, 325),))
                self.assertEqual(screen.charge_labels, ("确认",))
                self.assertIn(status, screen.payment_statuses)
                # One object retains release refusal risk and excludes status from actionable candidates.
                nodes = [("总计 ¥16.60", 0, 0, 200, 50), ("确认", 0, 300, 200, 350), (status, 0, 700, 200, 750)]
                charge = server._recognize_charge(nodes)
                self.assertTrue(charge.activates("tap", (100, 325), {}))
                self.assertEqual(charge.activates("tap", (100, 725), {}), status not in {"交易状态：失败", "扣款状态：处理中"})
                self.assertEqual(tuple(n[0] for n in charge.candidates), ("确认",))

    async def test_I1_mixed_status_and_charge_text_still_refuses_or_checkpoints(self):
        for text in ("支付状态：未支付，确认付款", "支付失败，重新支付", "支付结果：付款", "订单状态：立即购买"):
            for intent in (None, "pi-owner"):
                with self.subTest(text=text, intent=bool(intent)):
                    nodes = [("总计 ¥16.60", 0, 0, 200, 50), (text, 0, 300, 200, 350)]
                    phone = SimpleNamespace(tap=mock.AsyncMock())
                    guard = server.CheckoutStop(phone, intent)
                    guard.shown = nodes
                    with mock.patch.object(guard, "_seen", new=mock.AsyncMock(return_value=nodes)), \
                         mock.patch.object(server, "_at_checkout", return_value=False):
                        with self.assertRaises(server._CheckpointReached if intent else server._Refused):
                            await guard.tap(100, 325)
                    self.assertEqual(guard.reached.is_set(), bool(intent))
                    phone.tap.assert_not_awaited()

    async def test_I1_unknown_submit_total_is_never_tried_or_opened_as_a_payment(self):
        for action, args in (("tap", (50, 225)), ("press_key_code", (66,))):
            with self.subTest(action=action):
                nodes = [("提交订单", 0, 200, 100, 250)]
                phone = SimpleNamespace(tap=mock.AsyncMock(), press_key_code=mock.AsyncMock())
                guard = server.CheckoutStop(phone, "pi-owner")
                guard.shown, guard.png = nodes, b"unreadable-total"
                client = SimpleNamespace(request=mock.AsyncMock())
                with mock.patch.object(guard, "_seen", new=mock.AsyncMock(return_value=nodes)), \
                     mock.patch.object(server, "_at_checkout", return_value=False), \
                     mock.patch.object(PaymentHTTPClient, "from_env", return_value=client):
                    with self.assertRaises(server._CheckpointReached):
                        await getattr(guard, action)(*args)
                    result = await server._checkpoint_payment(guard, None, "千问")
                self.assertTrue(result["answer"].startswith("【付款结果不明】"))
                phone.tap.assert_not_awaited()
                phone.press_key_code.assert_not_awaited()
                client.request.assert_not_awaited()

    async def test_I8_order_status_is_scoped_to_detail_and_unique_order_identity(self):
        for extra, identity, signs in ((["订单详情", "订单号：current-order-1", "支付成功"], "current-order-1", ("支付成功",)),
                (["订单详情", "订单号：current-order-1", "支付成功", "发消息或按住说话"], "current-order-1", ()),
                (["历史订单", "订单号：old-order", "上一单：支付成功"], "old-order", ()),
                (["订单详情", "订单号：current-order-1", "订单编号：old-order", "支付成功"], None, ()),
                (["订单详情", "订单号：current-order-1", "下单成功", "成功下单"], "current-order-1", ())):
            with self.subTest(extra=extra):
                screen = await parsed_screen([*extra, "总计 ¥16.60", "商家：一点点", "SKU：tea-1", "数量：1"])
                self.assertEqual((screen.order_id, screen.evidence().signs), (identity, signs))
                if "发消息或按住说话" in extra or "历史订单" in extra:
                    self.assertEqual(screen.evidence().state, "unknown")
                if "上一单：支付成功" in extra:
                    self.assertIn("上一单：支付成功", screen.payment_statuses)

    async def test_I2_screen_optional_identity_bounds_are_lossless_code_points(self):
        for length in (200, 201):
            with self.subTest(length=length):
                payee, delivery = "🍵" * length, "配送至" + "家" * (length - 3)
                nodes = [("订单详情", 0, 0, 100, 50), ("收款方：" + payee, 0, 50, 100, 100),
                         (delivery, 0, 100, 100, 150), ("总计 ¥16.60", 0, 200, 200, 250),
                         ("订单号：current-order-1", 0, 300, 200, 350), ("商品名称：香柠养乐多", 0, 400, 200, 450),
                         ("规格：大杯", 0, 500, 200, 550), ("数量：1", 0, 600, 200, 650)]
                guard = observed_guard(nodes, b"bounded-order")
                with mock.patch.object(server, "_at_checkout", return_value=False):
                    screen = await server._payment_screen(guard)
                self.assertEqual(screen.payee, payee if length == 200 else None)
                self.assertEqual(screen.delivery, delivery if length == 200 else None)

    async def test_I10_order_cancel_honours_agent_result_and_fresh_target_order_evidence(self):
        cancelled = replace(CARD, pay_buttons=(), cancelled_signs=("订单已取消",))
        for success, before, after, expected in ((True, CARD, cancelled, "done"),
                (False, CARD, cancelled, "failed"), (True, CARD, replace(cancelled, order_id="old-order"), "failed"),
                (True, CARD, replace(cancelled, order_id=None), "failed"), (True, cancelled, cancelled, "failed"),
                (True, CARD, PAID, "failed")):
            with self.subTest(success=success, order=after.order_id, expected=expected):
                class Handler:
                    def __await__(self):
                        async def done():
                            return SimpleNamespace(success=success, reason="取消已完成" if success else "没取消成功", steps=1)
                        return done().__await__()
                    cancel_run = mock.AsyncMock()
                driver = SimpleNamespace(press_key_code=mock.AsyncMock())
                config = SimpleNamespace(agent=SimpleNamespace())
                with mock.patch.object(server, "MobileAgent", return_value=SimpleNamespace(run=lambda: Handler()), create=True) as agent, \
                     mock.patch.object(server, "_payment_screen", new=mock.AsyncMock(side_effect=[before, after])):
                    result = await server._cancel_order(config, driver, CheckpointConfig(), CARD.order_id)
                self.assertEqual(result["outcome"], expected)
                self.assertIn("目标订单号：current-order-1", agent.call_args.kwargs["goal"])
                driver.press_key_code.assert_awaited_once_with(4)

    async def test_I1_each_trigger_joins_agent_before_checkpoint_outside_agent_timeout(self):
        to_thread = asyncio.to_thread
        async def static_observation(fn, *args, **kwargs):
            # This leaf is a static mock; thread scheduling is outside this lifecycle assertion.
            if fn is server._at_checkout:
                return fn(*args, **kwargs)
            return await to_thread(fn, *args, **kwargs)
        inputs = {"pay-button": ("tap", (100, 200)), "long-press": ("swipe", (100, 200, 100, 200, 1000)),
                  "swipe-end": ("swipe", (400, 600, 100, 200)), "drag-end": ("drag", (400, 600, 100, 200)),
                  "enter": ("press_key_code", (66,)), "dpad-center": ("press_key_code", (23,)),
                  "confirm": ("press_button", ("confirm",)), "cashier-input": ("input_text", ("never typed",))}
        for trigger, cancel in ((a, b) for a in (*inputs, "finished") for b in (False, True)):
            with self.subTest(trigger=trigger, cancel=cancel):
                events = []
                cleaning, release = asyncio.Event(), asyncio.Event()
                phone = mock.Mock(**{name: mock.AsyncMock() for name in {"screenshot", *(v[0] for v in inputs.values())}})
                config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
                class Handler:
                    def __await__(self):
                        async def work():
                            if trigger != "finished":
                                try:
                                    action, args = inputs[trigger]
                                    await getattr(guard, action)(*args)
                                except server._CheckpointReached:
                                    pass  # A tool may catch it; the independent event must still stop this run.
                                await asyncio.Event().wait()
                            return SimpleNamespace(success=True, reason="到订单卡片", steps=1)
                        return work().__await__()
                    async def cancel_run(self):
                        cleaning.set()
                        await release.wait()
                        events.append("joined")
                def agent(**kwargs):
                    nonlocal guard
                    guard = kwargs["driver"]
                    return SimpleNamespace(run=lambda: Handler())
                async def phase(*args, cancelled=False):
                    self.assertEqual(events, ["joined"])
                    await asyncio.sleep(0.03)
                    events.append("cancel-order" if cancelled else "checkpoint")
                    return {"success": not cancelled, "answer": "【没有付款】" if cancelled else "【已付款】"}
                guard = None
                with mock.patch.object(server, "_load_model"), mock.patch.object(server, "_bind"), \
                     mock.patch.object(server, "ConfigLoader", SimpleNamespace(load=lambda _: config), create=True), \
                     mock.patch.object(server, "MobileAgent", side_effect=agent, create=True), \
                     mock.patch.object(server, "_count_steps", new=mock.AsyncMock()), \
                     mock.patch.object(server, "_screen_signs", new=mock.AsyncMock(return_value=set())), \
                     mock.patch.object(server.CheckoutStop, "_seen", new=mock.AsyncMock(return_value=[("提交订单", 0, 0, 200, 400), ("总计 ¥16.60", 0, 500, 200, 550)])), \
                     mock.patch.object(server, "_at_checkout", return_value=trigger == "cashier-input"), \
                     mock.patch.object(server, "_payment_screen", new=mock.AsyncMock(return_value=CARD)), \
                     mock.patch.object(server, "_checkpoint_payment", side_effect=phase), \
                     mock.patch.object(server, "TASK_TIMEOUT_S", 0.02), \
                     mock.patch.object(asyncio, "to_thread", side_effect=static_observation):
                    task = asyncio.create_task(server._agent("点一杯", 10, "pi-owner", driver=phone, app="千问"))
                    await asyncio.wait_for(cleaning.wait(), 1)
                    self.assertEqual(events, [])
                    if cancel:
                        task.cancel()
                        await asyncio.sleep(0)
                    release.set()
                    result = await asyncio.wait_for(task, 1)
                self.assertEqual(result["success"], not cancel, {"result": result, "events": events})
                self.assertEqual(events, ["joined", "cancel-order" if cancel else "checkpoint"])
                phone.tap.assert_not_called()
                for action in {v[0] for v in inputs.values()}:
                    getattr(phone, action).assert_not_awaited()

    async def test_I14_real_executor_refuses_staging_payment_before_phone_access(self):
        with mock.patch.dict(os.environ, PAIOS_STAGE="staging"), mock.patch.object(server, "_shell") as device:
            result = await server._errand_task("购买", 10, None, None, "pi-owner", "千问", "fast")
        self.assertFalse(result["success"])
        device.assert_not_called()


if __name__ == "__main__":
    unittest.main()
