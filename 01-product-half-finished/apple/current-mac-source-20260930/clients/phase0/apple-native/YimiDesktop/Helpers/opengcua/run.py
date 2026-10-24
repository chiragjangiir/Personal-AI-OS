"""One owner_mac.exec batch. SDK handles and results never survive this process."""
import ast
import asyncio
import dataclasses
import inspect
import json
import os
from pathlib import Path
import sys
import uuid


async def run(socket, helper, output, source, filename):
    os.environ["CUA_DRIVER_EMBEDDED"] = "1"
    if not Path(socket).is_socket():
        raise ConnectionError(f"Embedded CuaDriver socket unavailable: {socket}")
    from mai_ui import Runtime, MuError

    def deliver(message):
        if message["type"] == "image":
            suffix = ".png" if message["mime_type"] == "image/png" else ".jpg"
            path = Path(output) / (uuid.uuid4().hex + suffix)
            path.write_bytes(message["data"])
            print(json.dumps({**{key: value for key, value in message.items() if key != "data"},
                              "path": str(path)}, ensure_ascii=False), flush=True)
        else:
            print(message["text"], flush=True)

    try:
        async with Runtime() as runtime:
            resource = await runtime.add_macos(name="owner-mac", app_path=helper, socket=socket)
            async with runtime.session(output=deliver) as session:
                session.auto_reconnect = False
                mac = await session.register(resource, name="mac")
                namespace = {"__name__": "__main__", "__file__": filename,
                             "mac": mac, "session": session, "output_dir": Path(output)}
                result = eval(compile(source, filename, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), namespace)
                if inspect.isawaitable(result):
                    await result
    except MuError as error:
        print(json.dumps({"code": error.code, "error": str(error), "replay": False,
                          "stop_receipt": dataclasses.asdict(error.stop_receipt) if error.stop_receipt else None,
                          "receipt": dataclasses.asdict(error.receipt) if error.receipt else None},
                         ensure_ascii=False), file=sys.stderr)
        raise


if __name__ == "__main__":
    socket, helper, output, filename = sys.argv[1:]
    source = sys.stdin.read() if filename == "-" else Path(filename).read_text(encoding="utf-8")
    asyncio.run(run(socket, helper, output, source, filename))
