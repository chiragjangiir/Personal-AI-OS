import sys

import pytest


@pytest.fixture(autouse=True)
def native_request_context():
    """In-process native turns bind per-request usage attribution in the caller's context; keep it inside the test."""
    yield
    usage = sys.modules.get('agent.model_usage')
    if usage is not None:
        usage.usage_context.set(('', ''))
        usage.provider_context.set(None)
