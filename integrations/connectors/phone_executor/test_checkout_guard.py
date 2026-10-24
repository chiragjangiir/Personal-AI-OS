"""The pay guard must see an image-rendered order card: 千问's 「支付宝付款」 is not in the accessibility tree.
Run with the executor's interpreter: .venv/bin/python -I test_checkout_guard.py"""
import asyncio
import base64
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from payment_capture_fixture import frame

W, H = 1264, 2780
CJK_FONT = os.environ.get('PAIOS_TEST_CJK_FONT', '/System/Library/Fonts/Hiragino Sans GB.ttc')
PAY = (632, 2380)  # centre of the 支付宝付款 button drawn below
CHARGE_REFUSAL = "这一下会直接付款（小额免密不弹收银台）：没有用户付款授权，不点，立即结束并汇报订单信息。"
SUBMIT_LABELS = ("提交订单", "确认下单", "立即下单", "免密下单", "确认购买", "一键购买")
POINTER_INPUTS = (("tap", PAY, {}), ("swipe", (*PAY, *PAY), {"duration_ms": 1500}),
                  ("swipe", (*PAY, 400, 1000), {}), ("swipe", (400, 1000, *PAY), {}),
                  ("drag", (*PAY, 400, 1000), {}), ("drag", (400, 1000, *PAY), {}))
CONFIRM_INPUTS = tuple(("press_key_code", (key,), {}) for key in (66, 23, 160, "ENTER", "DPAD_CENTER", "NUMPAD_ENTER")) + (
    ("press_key_code", (), {"key_code": 66}), ("press_button", ("enter",), {}),
    ("press_button", (), {"button": "confirm"}))


def native(nodes=()):
    read = server._NativeRead((W,H))
    read.extend(nodes)
    return read


def order_card(remote: bool = False) -> bytes:
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(CJK_FONT, 46)
    d.text((80, 1500), "请核对商品和地址信息，确认无误后付款。", fill="black", font=font)
    d.text((80, 1700), "示例茶饮-中杯  实付¥13", fill="black", font=font)
    d.text((80, 1900), "配送至 示例市样例区示例路1号", fill="black", font=font)
    d.text((80, 2100), "总计 ¥16.6", fill="black", font=font)
    d.rounded_rectangle((180, 2300, 1084, 2460), 40, fill="#1677ff")
    d.text((PAY[0] - 125, PAY[1] - 30), "支付宝付款", fill="white", font=font)
    d.text((80, 2600), "发消息或按住说话...", fill="gray", font=font)
    out = io.BytesIO()
    if remote:
        img.thumbnail((1600, 1600), Image.Resampling.BILINEAR)
        img.save(out, "JPEG", quality=75)
        return server._ScreenImage(out.getvalue(), (W,H))
    img.thumbnail((1600,1600), Image.Resampling.BILINEAR)
    img.save(out, "PNG")
    return server._ScreenImage(out.getvalue(), (W,H))


class Phone:
    def __init__(self, png: bytes | None):
        self.png, self.taps = png, []

    async def screenshot(self, hide_overlay: bool = True) -> bytes:
        if self.png is None:
            raise ConnectionError("portal gone")
        return self.png

    async def tap(self, x, y):
        self.taps.append((x, y))


class CheckoutGuard(unittest.TestCase):
    def setUp(self):
        self.saved = server._tree, server._shell, server._at_checkout
        server._tree = lambda: native()  # the WebView card exposes nothing to accessibility
        server._shell = lambda cmd, **_: "Physical size: 1264x2780" if cmd == "wm size" else ""
        server._at_checkout = lambda: False

    def tearDown(self):
        server._tree, server._shell, server._at_checkout = self.saved

    def tap(self, payment_intent, x, y, png=None):
        phone = Phone(order_card() if png is None else png or None)
        guard = server.CheckoutStop(phone, payment_intent)
        try:
            asyncio.run(guard.tap(x, y))
            return phone.taps, None
        except RuntimeError as e:
            return phone.taps, str(e)

    def test_unauthorised_tap_on_image_rendered_pay_button_is_refused(self):
        t = time.time()
        taps, refused = self.tap(None, *PAY)
        print(f"guard decision {1000 * (time.time() - t):.0f} ms")
        self.assertEqual(taps, [])
        self.assertIn("直接付款", refused)

    def test_other_taps_on_the_same_screen_go_through(self):
        taps, refused = self.tap(None, 400, 2630)
        self.assertIsNone(refused)
        self.assertEqual(taps, [(400, 2630)])

    def test_I1_I2_intent_stops_model_and_preserves_order_total_for_checkpoint(self):
        nodes = server._screen_nodes(order_card(), W, H)
        self.assertEqual(server._order_total(nodes), 16.6)
        self.assertEqual(self.tap("pi-order", *PAY), ([], ""))

    def test_remote_image_keeps_payment_label_amount_and_native_tap_coordinates(self):
        image = order_card(remote=True)
        self.assertIn("直接付款", self.tap(None, *PAY, png=image)[1])
        self.assertEqual(self.tap("pi-order", *PAY, png=image), ([], ""))

    def test_image_only_cashier_checks_bare_total_even_with_a_lower_marked_amount(self):
        at = (150, 720)
        with mock.patch.object(server, "_at_checkout", return_value=True):
            for label in ("免密支付", "确认付款"):
                image = page("优惠 ¥13", "16.60", label)
                taps, refused = self.tap(None, *at, png=image)
                self.assertEqual(taps, [])
                self.assertIn("直接付款", refused)
                self.assertEqual(self.tap("pi-order", *at, png=image), ([], ""))

    def test_I1_intent_never_allows_the_agent_to_tap_a_verification_cashier(self):
        image = page("¥16.60", "请输入支付密码", "确认付款")
        with mock.patch.object(server, "_at_checkout", return_value=True), \
             mock.patch.object(server, "_tree", return_value=native([("¥13", 0, 0, 100, 50)])):
            taps, refused = self.tap("pi-order", 150, 720, png=image)
        self.assertEqual(taps, [])
        self.assertEqual(refused, "")

    def test_warm_remote_driver_preserves_native_grounding_reports_failure_and_releases_helper(self):
        server._load_model()
        from mobilerun.tools.ui.screenshot_provider import ScreenshotOnlyStateProvider
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        with tempfile.TemporaryDirectory() as tmp:
            adb, log = Path(tmp) / 'adb', Path(tmp) / 'requests'
            payload = base64.b64encode(order_card(remote=True)).decode()
            adb.write_text(f'''#!{sys.executable}
import json, sys
from pathlib import Path
log = Path({str(log)!r})
with log.open('a') as out:
    out.write('start\\n'); out.flush()
    print(json.dumps({{"kind": "ready"}}), flush=True)
    for i, command in enumerate(sys.stdin):
        out.write(command); out.flush()
        result = {{"kind": "screen", "width": {W}, "height": {H}, "data": {payload!r}}} if i < 2 else {{"kind": "error", "stage": "encode", "detail": "encoder failed", "elapsed_ms": 6200}}
        print(json.dumps(result), flush=True)
    out.write('eof\\n')
''')
            adb.chmod(0o700)
            async def run():
                async with server._device_lease():
                    driver = await server._driver()
                    image = await driver.screenshot()
                    self.assertEqual(Image.open(io.BytesIO(image)).size, (727, 1600))
                    self.assertEqual(image.capture_size, (W,H))
                    state = await ScreenshotOnlyStateProvider(driver, use_normalized=True).get_state()
                    self.assertEqual(state.convert_point(500, 500), (W // 2, H // 2))
                    with self.assertRaises(DeviceDisconnectedError) as failure:
                        await server.CheckoutStop(driver).tap(*PAY)
                    self.assertIn('stage=encode', str(failure.exception))
                    self.assertIn('encoder failed; device elapsed=6200 ms', str(failure.exception))
            identity = f'capture-test-{os.getpid()}'
            lease = Path('/tmp') / f'paios-phone-{identity.replace("-", "_")}.lock'
            self.addCleanup(lease.unlink, missing_ok=True)
            with mock.patch.object(server, 'ADB', str(adb)), mock.patch.object(server, 'PHONE_SERIAL', identity), \
                 mock.patch.object(server, 'SERIAL', '10.1.2.3:5555'), \
                 mock.patch.object(server, 'CONFIG', str(Path(__file__).with_name('mobilerun-config.example.yaml'))), \
                 mock.patch.object(server, '_preflight', return_value=False), \
                 mock.patch.object(server.AndroidDriver, 'connect', new=mock.AsyncMock()):
                asyncio.run(run())
            calls = log.read_text().splitlines()
            self.assertEqual(calls.count('start'), 1)
            self.assertEqual(calls[-1], 'eof')

    def test_a_ride_is_called_only_when_the_user_asked_for_one(self):
        card = page("特惠快车 ¥26.3~36.6", "确认（26.3~34.3元起）")
        at = (300, 520)  # on the 确认（…元起） line drawn by page()
        phone = Phone(card); guard = server.CheckoutStop(phone)
        with self.assertRaises(RuntimeError) as refused:
            asyncio.run(guard.tap(*at))
        self.assertIn("会叫车", str(refused.exception))
        self.assertEqual(phone.taps, [])
        phone = Phone(card); asyncio.run(server.CheckoutStop(phone, ride_ok=True).tap(*at))
        self.assertEqual(phone.taps, [at])

    def test_the_cancel_run_may_tap_cancel_while_calling_a_car_stays_blocked(self):
        at = (150, 520)  # on the second line drawn by page()
        phone = Phone(page("正在为你呼叫附近司机", "取消呼叫")); asyncio.run(server.CheckoutStop(phone).tap(*at))
        self.assertEqual(phone.taps, [at], "取消呼叫 undoes a ride; it is not calling one")
        for label in ("立即叫车", "呼叫快车"):
            phone = Phone(page("特惠快车 ¥26.3~36.6", label))
            with self.assertRaises(RuntimeError):
                asyncio.run(server.CheckoutStop(phone).tap(*at))
            self.assertEqual(phone.taps, [], label)

    def test_unreadable_screen_fails_closed(self):
        taps, refused = self.tap(None, 400, 2630, png=b"")
        self.assertEqual(taps, [])
        self.assertIn("读不到屏幕内容", refused)

    def test_native_text_cannot_allow_a_tap_when_ocr_reads_nothing(self):
        with mock.patch.object(server, "_tree", return_value=native([("首页", 0, 0, 100, 50)])):
            taps, refused = self.tap(None, 400, 2630, png=page())
        self.assertEqual(taps, [])
        self.assertIn("读不到任何文字", refused)

    def test_image_rendered_submit_controls_are_refused(self):
        for label in SUBMIT_LABELS + ("一键下单", "下单并支付", "免密购买"):
            with self.subTest(label=label):
                taps, refused = self.tap(None, 150, 520, png=page("总计 ¥16.6", label))
                self.assertEqual(taps, [])
                self.assertIn("直接付款", refused)


class QwenChatInputs(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, message, *, charge=None, intent=None, editable=True):
        button = f'<node text="{charge}" clickable="true" bounds="[500,900][660,940]"/>' if charge else ''
        xml = f'''<hierarchy width="720" height="1280">
          <node bounds="[0,0][720,1280]">
            <node class="android.widget.EditText" editable="{str(editable).lower()}"
                  text="{message}" bounds="[56,850][664,960]"/>
            <node content-desc="发送" clickable="true" bounds="[622,970][664,1014]"/>
            {button}
          </node></hierarchy>'''
        shown = [("差¥23.9起送，去凑单", 180, 390, 520, 430),
                 ("请核对商品和地址信息，确认无误后付款。", 50, 526, 643, 564),
                 (message, 56, 852, 664, 945)]
        if charge:
            shown.append((charge, 500, 900, 660, 940))
        phone = SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame((720, 1280))), tap=mock.AsyncMock())
        guard = server.CheckoutStop(phone, intent)
        with mock.patch.object(server, '_observation', return_value=xml), \
             mock.patch.object(server, '_screen_nodes', return_value=shown), \
             mock.patch.object(server, '_at_checkout', return_value=False), \
             mock.patch.object(server, '_locked', return_value=False), \
             mock.patch.object(server, '_shell', return_value='com.aliyun.tongyi/com.ucpro.MainActivity'):
            if charge or not editable:
                expected = server._CheckpointReached if intent else server._Refused
                with self.assertRaises(expected):
                    await guard.tap(*( (600, 920) if charge else (643, 992) ))
                phone.tap.assert_not_awaited()
                self.assertEqual(guard.reached.is_set(), bool(intent))
            else:
                await guard.tap(643, 992)
                phone.tap.assert_awaited_once_with(643, 992)
                self.assertFalse(guard.reached.is_set())

    async def test_run3_change_shop_message_send_does_not_reach_payment_checkpoint(self):
        for intent in (None, 'pi-owner'):
            for message in ('帮我换到乐购汪生活超市下单农夫山泉550ml一瓶', '帮我购买一瓶矿泉水'):
                with self.subTest(intent=intent, message=message):
                    await self.exercise(message, intent=intent)

    async def test_chat_text_cannot_hide_separate_charge_controls(self):
        for intent in (None, 'pi-owner'):
            for charge in ('免密支付', '提交订单', '确认付款', '合计¥16.6提交订单'):
                with self.subTest(intent=intent, charge=charge):
                    await self.exercise('帮我下单，' + charge, charge=charge, intent=intent)

    async def test_purchase_text_without_native_editable_provenance_still_stops(self):
        for intent in (None, 'pi-owner'):
            await self.exercise('帮我下单农夫山泉550ml一瓶', intent=intent, editable=False)


class ChargeInputs(unittest.IsolatedAsyncioTestCase):
    """Synthetic tree/OCR observations only; assert refusal before any driver input."""

    def setUp(self):
        self.total = [("实付 ¥13", 80, 1700, 500, 1760), ("总计", 80, 2100, 180, 2160),
                      ("¥16.6", 200, 2100, 400, 2160)]
        self.control = ("提交订单", 500, 2340, 850, 2420)
        for patch in (mock.patch.object(server, "_shell", return_value=f"Physical size: {W}x{H}"),
                      mock.patch.object(server, "_locked", return_value=False),
                      mock.patch.object(server, "_preflight", side_effect=AssertionError("unexpected device recovery"))):
            patch.start(); self.addCleanup(patch.stop)
        self.ocr = self.enterContext(mock.patch.object(server, "_screen_nodes", return_value=self.total + [self.control]))
        self.tree = self.enterContext(mock.patch.object(server, "_tree", return_value=native()))
        self.cashier = self.enterContext(mock.patch.object(server, "_at_checkout", return_value=False))

    async def check_input(self, input_, intent=None, refused="直接付款", ride_ok=False):
        action, args, kwargs = input_
        driver = mock.Mock(screenshot=mock.AsyncMock(return_value=frame((W,H))))
        dispatch = mock.AsyncMock(return_value=None)
        setattr(driver, action, dispatch)
        guard = server.CheckoutStop(driver, intent, ride_ok)
        if refused == "checkpoint":
            with self.assertRaises(server._CheckpointReached):
                await getattr(guard, action)(*args, **kwargs)
            self.assertTrue(guard.reached.is_set())
            dispatch.assert_not_awaited()
        elif refused:
            with self.assertRaisesRegex(server._Refused, refused) as failure:
                await getattr(guard, action)(*args, **kwargs)
            if refused == "直接付款":
                self.assertEqual(str(failure.exception), CHARGE_REFUSAL)
            self.assertFalse(guard.reached.is_set())
            dispatch.assert_not_awaited()
        else:
            await getattr(guard, action)(*args, **kwargs)
            self.assertFalse(guard.reached.is_set())
            dispatch.assert_awaited_once_with(*args, **kwargs)
        return {"physical_inputs": dispatch.await_count, "checkpoint": guard.reached.is_set()}

    async def test_ride_activation_matrix_requires_host_authority(self):
        inputs = POINTER_INPUTS + CONFIRM_INPUTS + (
            ("tap", (PAY[0],), {"y": PAY[1]}),
            ("tap", (), {"x": PAY[0], "y": PAY[1]}),
            ("swipe", (PAY[0],), {"y1": PAY[1], "x2": 400, "y2": 1000}),
            ("drag", (400, 1000), {"x2": PAY[0], "y2": PAY[1]}))
        for label in ("确认（26.3~34.3元起）", "立即叫车", "呼叫快车"):
            self.ocr.return_value = [("特惠快车 ¥26.3~36.6", 80, 200, 800, 260),
                                     (label, *self.control[1:])]
            self.assertIs(server._confirmation_surface(self.ocr.return_value), False)
            for input_ in inputs:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_, refused="会叫车")
                    await self.check_input(input_, "pi-model-claim", refused="会叫车")
                    await self.check_input(input_, refused=None, ride_ok=True)
        self.ocr.return_value = []
        for ride_ok in (False, True):
            for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                with self.subTest(ride_ok=ride_ok, input=input_):
                    await self.check_input(input_, refused="读不到任何文字", ride_ok=ride_ok)

    async def test_ride_cancel_back_and_navigation_stay_available(self):
        self.ocr.return_value = [("确认（26.3~34.3元起）", *self.control[1:]),
                                 ("取消呼叫", 500, 2430, 850, 2480),
                                 ("地址", 200, 800, 500, 1000)]
        # Cancel is close enough to hit the ride margin; its exact bounds take precedence.
        inputs = (("tap", (600,), {"y": 2450}), ("tap", (400, 900), {}),
                  ("swipe", (600, 2450, 600, 2450), {"duration_ms": 1000}),
                  ("drag", (400, 900, 400, 1100), {}),
                  ("press_button", (), {"button": "back"}),
                  ("press_key_code", (4,), {}), ("press_key_code", ("KEYCODE_BACK",), {}))
        for input_ in inputs:
            with self.subTest(input=input_):
                await self.check_input(input_, refused=None)
        # Starting on cancel cannot authorize a gesture that ends on the call control.
        await self.check_input(("swipe", (600, 2450, *PAY), {}), refused="会叫车")
        self.ocr.return_value = [("首页", 80, 200, 800, 260)]
        for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
            await self.check_input(input_, refused=None)

    async def test_ride_sdk_long_press_uses_guarded_swipe(self):
        from mobilerun.agent.utils.actions import long_press, long_press_at
        self.ocr.return_value = [("确认（26.3~34.3元起）", *self.control[1:])]
        for ride_ok in (False, True):
            for action, args in ((long_press, (0,)), (long_press_at, PAY)):
                with self.subTest(ride_ok=ride_ok, action=action.__name__):
                    driver = SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame((W,H))),
                                             swipe=mock.AsyncMock())
                    guard = server.CheckoutStop(driver, ride_ok=ride_ok)
                    ctx = SimpleNamespace(driver=guard, macro_recorder=None,
                        state_provider=SimpleNamespace(), ui=SimpleNamespace(
                            get_element_coords=lambda _: PAY, convert_point=lambda x,y: (x,y)))
                    if not ride_ok and action is long_press:
                        with self.assertRaisesRegex(server._Refused, "会叫车"):
                            await action(*args, ctx=ctx)
                    else:
                        result = await action(*args, ctx=ctx)
                        self.assertEqual(result.success, ride_ok)
                        if not ride_ok:
                            self.assertIn("会叫车", result.summary)
                    if ride_ok:
                        driver.swipe.assert_awaited_once_with(*PAY, *PAY, 1000)
                    else:
                        driver.swipe.assert_not_awaited()

    async def test_I1_guard_control_matrix_both_modes(self):
        charges = SUBMIT_LABELS + ("支付宝付款", "免密支付", "确认付款", "确认支付", "立即支付", "立即付款", "去支付", "去付款",
                                  "确认付款 ¥16.60", "合计¥16.6提交订单", "支付", "支付 ¥16.60", "立即购买")
        navigation = ("支付方式", "去结算")
        for intent in (None, "pi-owner"):
            rows = []
            for label in charges + navigation:
                self.ocr.return_value = self.total + [(label, *self.control[1:])]
                for action, args, kwargs in POINTER_INPUTS + CONFIRM_INPUTS:
                    with self.subTest(intent=bool(intent), label=label, action=action, args=args, kwargs=kwargs):
                        charge = label in charges or action in ("press_key_code", "press_button")
                        expected = ("checkpoint" if intent else "直接付款") if charge else None
                        result = await self.check_input((action, args, kwargs), intent, expected)
                        rows.append({"charge": charge, **result})
            print("guard_control_matrix " + json.dumps({"mode": "intent" if intent else "no_intent", "cases": len(rows),
                "charge_cases": sum(r["charge"] for r in rows),
                "charge_physical_inputs": sum(r["physical_inputs"] for r in rows if r["charge"]),
                "checkpoints": sum(r["checkpoint"] for r in rows),
                "navigation_dispatches": sum(r["physical_inputs"] for r in rows if not r["charge"])}, sort_keys=True))

    async def test_release_status_risk_is_not_an_actionable_checkpoint_control(self):
        for cashier in (False, True):
            self.cashier.return_value = cashier
            for total in ([], self.total):
                for label in ("支付成功", "支付状态：未支付", "订单状态：下单成功"):
                    node = (label, *self.control[1:])
                    self.ocr.return_value = total + [node]
                    recognition = server._recognize_charge(self.ocr.return_value, cashier, self.ocr.return_value)
                    with self.subTest(cashier=cashier, total=bool(total), label=label):
                        self.assertTrue(server._charge_control(label))
                        self.assertIn(node, recognition.risk_candidates)
                        self.assertEqual(recognition.candidates, ())
                        for input_ in (POINTER_INPUTS[0], CONFIRM_INPUTS[0]):
                            await self.check_input(input_)
                            await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_conflicting_totals_preserve_release_confirmation_risk(self):
        self.ocr.return_value = [("总计 ¥16.60", 80, 1700, 500, 1760),
                                 ("实付 ¥14.60", 80, 2100, 500, 2160),
                                 ("确认", *self.control[1:])]
        self.assertIsNone(server._order_total(self.ocr.return_value))
        self.assertIs(server._confirmation_surface(self.ocr.return_value), True)
        for input_ in (POINTER_INPUTS[0], CONFIRM_INPUTS[0]):
            await self.check_input(input_)
            await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_submit_controls_refuse_tap_long_press_swipe_endpoints_and_drag(self):
        for label in SUBMIT_LABELS + ("支付宝付款", "免密支付", "确认付款", "确认支付", "立即支付", "立即付款", "去支付", "去付款"):
            self.ocr.return_value = self.total + [(label, *self.control[1:])]
            for input_ in POINTER_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_)
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_confirm_keys_refuse_confirmation_surfaces(self):
        for label in SUBMIT_LABELS:
            self.ocr.return_value = self.total + [(label, *self.control[1:])]
            for input_ in CONFIRM_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_)
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_I1_intent_intercepts_all_new_controls_and_inputs(self):
        for label in SUBMIT_LABELS:
            self.ocr.return_value = self.total + [(label, *self.control[1:])]
            for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_keyword_and_mixed_coordinates_cannot_bypass_guard(self):
        for input_ in (("tap", (), {"x": PAY[0], "y": PAY[1]}), ("tap", (PAY[0],), {"y": PAY[1]}),
                       ("swipe", (), {"x1": PAY[0], "y1": PAY[1], "x2": 400, "y2": 1000}),
                       ("drag", (400, 1000), {"x2": PAY[0], "y2": PAY[1]})):
            with self.subTest(input=input_):
                await self.check_input(input_)
                await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_navigation_quantity_and_whole_label_matching(self):
        for label in ("支付方式", "付款方式", "去结算", "结算", "支付宝", "加入购物车", "返回", "地址", "备注", "优惠券", "删除", "+", "−", "-"):
            self.ocr.return_value = self.total + [(label, *self.control[1:])]
            for input_ in POINTER_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_, refused=None)
                    await self.check_input(input_, "pi-owner", refused=None)
        # A total alone now establishes a confirmation surface: confirm keys stop even when navigation is focused.
        for input_ in CONFIRM_INPUTS:
            await self.check_input(input_)
            await self.check_input(input_, "pi-owner", "checkpoint")
        # Navigation on an actual confirmation page also stays usable, away from the charge control.
        self.ocr.return_value = self.total + [self.control, ("+", 300, 980, 500, 1040)]
        for input_ in (("tap", (400, 1000), {}), ("press_key_code", (4,), {}), ("press_button", ("back",), {}),
                       ("swipe", (400, 1000, 400, 1200), {}), ("drag", (400, 1000, 400, 1200), {})):
            await self.check_input(input_, refused=None)
            await self.check_input(input_, "pi-owner", refused=None)

    async def test_unknown_transaction_vocabulary_refuses_all_charge_inputs(self):
        for label in ("一键下单", "下单并支付", "免密购买", "去下单", "再次购买", "买单", "结账"):
            for total in ([], self.total):
                self.ocr.return_value = total + [(label, *self.control[1:])]
                for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                    with self.subTest(label=label, total=bool(total), input=input_):
                        await self.check_input(input_)
                        await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_surface_only_controls_use_the_same_refusal_and_intent_checkpoint(self):
        for cashier in (False, True):
            self.cashier.return_value = cashier
            total = [("16.60", 80, 2100, 400, 2160)] if cashier else self.total
            for label in ("提交", "确认", "立即", "立即购买"):
                self.ocr.return_value = total + [(label, *self.control[1:])]
                for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                    with self.subTest(cashier=cashier, label=label, input=input_):
                        await self.check_input(input_)
                        await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_off_surface_product_and_purchase_navigation_stays_allowed(self):
        for label in ("提交", "确认", "立即", "立即购买", "支付方式", "付款方式", "购买须知", "购买记录", "购买说明", "支付宝"):
            self.ocr.return_value = [("商品 ¥16.6", 80, 2100, 400, 2160), (label, *self.control[1:])]
            for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_, refused=None)
                    await self.check_input(input_, "pi-owner", refused=None)

    async def test_cart_with_total_allows_checkout_navigation_but_not_confirm_keys(self):
        for label in ("去结算", "结算"):
            self.ocr.return_value = [("合计 ¥16.6", 80, 2100, 400, 2160), (label, *self.control[1:])]
            for input_ in POINTER_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_, refused=None)
                    await self.check_input(input_, "pi-owner", refused=None)
            for input_ in CONFIRM_INPUTS:
                await self.check_input(input_)
                await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_total_or_cashier_without_a_control_still_intercepts_confirm_keys(self):
        for cashier, nodes in ((False, self.total), (True, [("收银台", 80, 300, 400, 360)])):
            self.cashier.return_value = cashier
            self.ocr.return_value = nodes
            for input_ in CONFIRM_INPUTS:
                with self.subTest(cashier=cashier, input=input_):
                    await self.check_input(input_)
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_cashier_noncharge_input_keeps_exact_release_refusal(self):
        self.cashier.return_value = True
        self.ocr.return_value = [("收银台", 80, 300, 400, 360)]
        text = "已到付款页（收银台）：按规则不再点击或输入，立即结束任务并汇报商家、商品规格、金额和预计时间。"
        with self.assertRaises(server._Refused) as failure:
            await self.check_input(("tap", (400, 1000), {}), refused=None)
        self.assertEqual(str(failure.exception), text)
        await self.check_input(("tap", (400, 1000), {}), "pi-owner", "checkpoint")

    async def test_amount_bearing_merged_and_settings_text_fails_closed(self):
        # Substring matching is deliberate: a control that carries its amount, an OCR line that merged the bottom bar,
        # and payment-settings or explanatory text are all refused rather than risk a password-free charge.
        for label in ("确认付款 ¥16.60", "合计¥16.6提交订单", "支付宝付款 >", "免密支付设置", "请确认付款后查看订单",
                      "支付", " 支付 ¥16.60"):
            self.ocr.return_value = self.total + [(label, *self.control[1:])]
            for input_ in POINTER_INPUTS:
                with self.subTest(label=label, input=input_):
                    await self.check_input(input_)
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_tree_and_ocr_share_surface_total_and_control(self):
        for tree, shown in ((self.total + [self.control], [("订单确认", 80, 300, 400, 360)]),
                            ([], self.total + [self.control]), (self.total, [self.control]), ([self.control], self.total)):
            self.tree.return_value, self.ocr.return_value = native(tree), shown
            for input_ in (POINTER_INPUTS[0], CONFIRM_INPUTS[0]):
                with self.subTest(tree=tree, shown=shown, input=input_):
                    await self.check_input(input_)
                    await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_I1_cashier_confirm_and_drag_handoff_before_amount_and_verification_checks(self):
        self.cashier.return_value = True
        self.ocr.return_value = [("优惠 ¥13", 80, 1700, 500, 1760), ("16.60", 80, 2100, 400, 2160), self.control]
        for input_ in CONFIRM_INPUTS + POINTER_INPUTS[-2:]:
            with self.subTest(input=input_):
                await self.check_input(input_)
                await self.check_input(input_, "pi-owner", "checkpoint")
                self.ocr.return_value.append(("请输入支付密码", 80, 1900, 500, 1960))
                await self.check_input(input_, "pi-owner", "checkpoint")
                self.ocr.return_value.pop()
        self.ocr.return_value = [("收银台", 80, 300, 400, 360), ("16.60", 80, 2100, 400, 2160)]
        await self.check_input(CONFIRM_INPUTS[0])  # a cashier needs no readable button to refuse confirmation
        await self.check_input(CONFIRM_INPUTS[0], "pi-owner", "checkpoint")

    async def test_unreadable_total_never_allows_submit_or_confirm(self):
        self.ocr.return_value = [self.control]
        for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
            with self.subTest(input=input_):
                await self.check_input(input_)
                await self.check_input(input_, "pi-owner", "checkpoint")

    async def test_unreadable_screens_fail_closed_for_all_charge_inputs(self):
        self.tree.return_value = native(self.total + [self.control])
        for result in ([], RuntimeError("OCR unavailable")):
            self.ocr.side_effect = result if isinstance(result, Exception) else None
            self.ocr.return_value = result
            for input_ in POINTER_INPUTS + CONFIRM_INPUTS:
                with self.subTest(result=result, input=input_):
                    await self.check_input(input_, refused="读不到任何文字|读不到屏幕内容")
                    await self.check_input(input_, "pi-owner", "读不到任何文字|读不到屏幕内容")


def page(*lines: str) -> bytes:
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(CJK_FONT, 46)
    for i, line in enumerate(lines):
        d.text((80, 300 + 200 * i), line, fill="black", font=font)
    out = io.BytesIO()
    img.thumbnail((1600,1600), Image.Resampling.BILINEAR)
    img.save(out, "PNG")
    return server._ScreenImage(out.getvalue(), (W,H))


class PaidSigns(unittest.TestCase):
    """After an errand without authorisation the executor itself looks for a placed-and-paid order."""

    def signs(self, png):
        return asyncio.run(server._screen_signs(Phone(png), server.PAID))

    def test_paid_order_page_is_recognised(self):
        found = self.signs(page("商家正在备餐", "预计 17:46-18:01", "修改订单、联系商家/骑手、申请售后等更多服务"))
        self.assertTrue(any("商家正在备餐" in t for t in found), found)

    def test_unpaid_order_card_is_not_mistaken_for_paid(self):
        self.assertEqual(self.signs(order_card()), set())
        self.assertEqual(self.signs(page("总计 使用安全免密支付 | 修改", "请核对商品和地址信息，确认无误后付款。")), set())

    def test_unreadable_screen_is_unknown_not_clean(self):
        self.assertIsNone(self.signs(None))

    def test_no_ocr_text_is_unknown_not_clean(self):
        self.assertIsNone(self.signs(page()))


class RideSigns(unittest.TestCase):
    """After an errand without ride_ok the executor itself looks for a called car (and then cancels it)."""

    def signs(self, png):
        return asyncio.run(server._screen_signs(Phone(png), server.RIDE_CALLED))

    def test_a_called_car_is_recognised(self):
        self.assertTrue(self.signs(page("正在为你呼叫附近司机", "等待应答 00:12")))
        self.assertTrue(self.signs(page("司机已接单", "浙A·D12345 白色 比亚迪")))

    def test_the_price_card_is_not_a_called_car(self):
        self.assertEqual(self.signs(page("特惠快车 ¥26.3~36.6", "给司机带句话（多选）", "确认（26.3~34.3元起）")), set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
