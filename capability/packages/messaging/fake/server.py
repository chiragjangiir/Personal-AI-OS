"""Offline native-transport fixtures; the package and idempotency code are unchanged."""
import os
from capability.packages.messaging.server.server import register as real_register

RESULTS = {'succeeded': {'success': True, 'message_id': 'fixture-message'},
           'partial': {'success': False, 'partial_success': True, 'media_dropped': ['fixture-file']},
           'unknown': {'error': 'transport disconnected'},
           'cancelled': {'success': True, 'skipped': True}}


def register(host):
    def sender(args):
        if args.get('action') == 'list':
            return {'targets': 'email:fixture@example.com'}
        if os.environ.get('YIMI_MESSAGE_FIXTURE') == 'timeout':
            raise TimeoutError('fixture')
        return RESULTS[os.environ.get('YIMI_MESSAGE_FIXTURE', 'succeeded')]
    real_register(host, sender)
