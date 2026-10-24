"""Compile primitives; test CLI and injected permission snapshots without GUI access."""
import json
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPTS = (Path(__file__).resolve().parents[2]
           / "integrations/hermes/personal_aios/errands/wechat/scripts")
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="macOS frameworks required")

# Every malformed input below is rejected before app, AX or clipboard access.
CASES = [
    ("activate", 0, []),
    ("ax-read", 0, []),
    ("paste", 0, []),
    ("ax-write", 3, [
        (["unknown", "搜索", "draft"], "Expected search or input"),
        (["search", "wrong-title", "draft"], "Invalid AXTextArea title"),
        (["input", "搜索", "draft"], "Invalid AXTextArea title"),
        (["input", "", "draft"], "Invalid AXTextArea title"),
    ]),
    ("click", 2, [
        (["not-a-number", "0"], "Expected finite screen coordinates"),
        (["nan", "0"], "Expected finite screen coordinates"),
        (["0", "inf"], "Expected finite screen coordinates"),
    ]),
    ("clipboard", 2, [
        (["unknown", "/unused"], "Expected operation and absolute path"),
        (["save", "relative"], "Expected operation and absolute path"),
    ]),
    ("key", 1, [(["unknown"], "Unsupported key")]),
    ("restore", 1, [
        (["0"], "Expected positive PID"),
        (["-1"], "Expected positive PID"),
        (["2147483648"], "Expected positive PID"),
    ]),
    ("screenshot", 2, [
        (["0", "/unused.png"], "Expected positive window ID and absolute PNG path"),
        (["1", "relative.png"], "Expected positive window ID and absolute PNG path"),
        (["1", "/unused.jpg"], "Expected positive window ID and absolute PNG path"),
    ]),
]


def invoke(binary, args, expected_status):
    result = subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=10)
    assert result.returncode == expected_status, result.stderr
    assert len(result.stdout.splitlines()) == 1, result.stdout
    payload = json.loads(result.stdout)
    assert payload["ok"] is (expected_status == 0)
    return payload


@pytest.fixture(scope="module")
def swift_module_cache(tmp_path_factory):
    return tmp_path_factory.mktemp("wechat-swift-module-cache")


@pytest.mark.parametrize("name,count,malformed", CASES, ids=[case[0] for case in CASES])
def test_primitive_cli_contract(tmp_path, swift_module_cache, name, count, malformed):
    binary = tmp_path / name
    sources = [SCRIPTS / "Support.swift", SCRIPTS / f"{name}.swift"]
    if name in {"ax-read", "ax-write"}:
        sources.append(SCRIPTS / "AX.swift")
    compiled = subprocess.run(
        ["/usr/bin/swiftc", "-module-cache-path", str(swift_module_cache),
         *map(str, sources), "-o", str(binary)],
        capture_output=True, text=True, timeout=120,
    )
    assert compiled.returncode == 0, compiled.stderr

    help_result = invoke(binary, ["--help"], 0)
    assert help_result["usage"].split()[0] == name
    assert "error" not in help_result

    wrong_count = ["--invalid"] if count == 0 else []
    assert "usage:" in invoke(binary, wrong_count, 1)["error"]
    for args, error in malformed:
        result = invoke(binary, args, 1)
        assert error in result["error"]
        assert "usage" not in result


def permission_node(text="", role="AXWindow", subrole="AXDialog", children=()):
    return dict(role=role, subrole=subrole, text=text, children=list(children))


def permission_window(node, bundle="com.apple.UserNotificationCenter", system=True):
    return dict(app="UserNotificationCenter", bundle=bundle, system=system, nodes=[node])


@pytest.fixture(scope="module")
def permission_probe(tmp_path_factory, swift_module_cache):
    folder = tmp_path_factory.mktemp("wechat-permission-probe")
    source = folder / "Probe.swift"
    source.write_text('''import Foundation
@main enum Probe {
    static func main() {
        run("probe <snapshot-json>", counts: [1]) { args in
            if args[0] == "read-error" {
                try requireNoPermissionDialog { throw Failure.message("synthetic AX read failed") }
            }
            let windows = try JSONDecoder().decode([PermissionWindow].self, from: Data(args[0].utf8))
            try requireNoPermissionDialog { windows }
            return ["posted": true]
        }
    }
}
''')
    binary = folder / "probe"
    compiled = subprocess.run(
        ["/usr/bin/swiftc", "-module-cache-path", str(swift_module_cache),
         str(SCRIPTS / "Support.swift"), str(source), "-o", str(binary)],
        capture_output=True, text=True, timeout=120,
    )
    assert compiled.returncode == 0, compiled.stderr
    return binary


@pytest.mark.parametrize("request_text", [
    '“依米”想要控制“访达”。允许控制将提供对“访达”中文稿和数据的访问权限。',
    '“依米”想要录制此电脑的屏幕和音频。',
    '“Yimi” would like to access the microphone.',
    '“Yimi” wants to control “Finder”.',
    'Screen & System Audio Recording: Yimi',
    '屏幕与系统音频录制：“依米”',
])
def test_permission_overlay_refuses_even_with_wechat_focus(permission_probe, request_text):
    # The visible system overlay is independent of AXFocusedApplication.
    snapshot = [permission_window(permission_node(request_text))]
    result = invoke(permission_probe, [json.dumps(snapshot)], 1)
    assert request_text in result["error"]
    assert "Waiting for owner" in result["error"]
    assert "All choices, including denial and Escape" in result["error"]
    assert "posted" not in result


@pytest.mark.parametrize("snapshot", [
    [],
    [permission_window(permission_node("确认发送文件？", children=[permission_node("允许", role="AXButton")]))],
    [permission_window(permission_node('Yimi would like to access the microphone.'), bundle="com.tencent.xinWeChat")],
    [permission_window(permission_node('Yimi would like to access the microphone.'), system=False)],
    [permission_window(permission_node('Yimi would like to access the microphone.', subrole="AXStandardWindow"))],
    [permission_window(permission_node(children=[permission_node("Allow", role="AXButton"), permission_node("Don't Allow", role="AXButton")]))],
])
def test_ordinary_windows_and_button_words_are_allowed(permission_probe, snapshot):
    assert invoke(permission_probe, [json.dumps(snapshot)], 0)["posted"] is True


def test_nested_permission_sheet_and_split_ax_labels(permission_probe):
    sheet = permission_node(role="AXSheet", subrole="", children=[
        permission_node('“依米”想要', role="AXStaticText", subrole=""),
        permission_node('控制“访达”', role="AXStaticText", subrole=""),
        permission_node("不允许", role="AXButton", subrole=""),
    ])
    window = permission_node(subrole="AXStandardWindow", children=[sheet])
    result = invoke(permission_probe, [json.dumps([permission_window(window)])], 1)
    assert "依米" in result["error"] and "访达" in result["error"]

@pytest.mark.parametrize("bundle", ["com.apple.coreservices.uiagent", "com.apple.SecurityAgent",
    "com.apple.universalaccessAuthWarn", "com.apple.screencaptureui", "com.apple.LocalAuthentication.UIAgent"])
def test_system_permission_hosts(permission_probe, bundle):
    snapshot = [permission_window(permission_node('Yimi wants to access the camera.'), bundle=bundle)]
    assert "camera" in invoke(permission_probe, [json.dumps(snapshot)], 1)["error"]


def test_permission_snapshot_read_failure_propagates(permission_probe):
    result = invoke(permission_probe, ["read-error"], 1)
    assert "synthetic AX read failed" in result["error"]
    assert "posted" not in result
