"""Ask the existing host release runner to qualify staging before a core workspace opens."""
import json
import time


def prepare(spool, request_id, timeout=3600):
    from utils import atomic_json_write
    if __package__:
        from .workshop_sandbox import BuilderRefusal
    else:
        from workshop_sandbox import BuilderRefusal
    atomic_json_write(spool / (request_id + '.prepare'), {'request_id': request_id})
    receipt = spool / (request_id + '.prepared')
    deadline = time.monotonic() + timeout
    while not receipt.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError('CORE_PARITY_TIMEOUT: ' + request_id)
        time.sleep(1)
    value = json.loads(receipt.read_text())
    if 'failure' in value:
        raise BuilderRefusal('CORE_PARITY_FAILED: ' + request_id + ': ' + value['failure'])
    if value['request_id'] != request_id or value['parity']['equal'] is not True:
        raise BuilderRefusal('CORE_PARITY_NOT_EQUAL: ' + request_id)
    return value
