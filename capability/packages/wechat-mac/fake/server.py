"""No device access; reuse the real package with an offline owner_mac transport."""
import importlib


def register(host):
    server = importlib.import_module('capability.packages.wechat-mac.server.server')
    def transport(args):
        return {'returncode':0,'output':'{"content_exposed":true,"chat_titles":["fixture"],"messages":[]}'
                if args.get('read_recent') else '{"posted":true}'}
    server.register(host, transport=transport)
