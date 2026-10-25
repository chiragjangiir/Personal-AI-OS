"""The dedicated phone capability MCP process."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from capability.packages.phone.server.host import executor, mcp

if __name__ == "__main__":
    executor._recover_interrupted()
    mcp.run(transport="stdio")
