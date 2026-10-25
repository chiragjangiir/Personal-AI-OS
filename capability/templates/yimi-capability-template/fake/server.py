"""Same MCP tools and receipts, with synthetic inputs only."""
import runpy
import sys
from pathlib import Path
server = Path(__file__).resolve().parents[1] / 'server'
sys.path.insert(0, str(server))
runpy.run_path(str(server / 'server.py'), run_name='__main__')
