"""Pinned TLS and bounded, fail-fast admission at the public builder bridge."""
import importlib.util
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
from urllib.error import URLError

import pytest

ROOT = Path(__file__).parents[2] / 'integrations/hermes/personal_aios'
# The builder runs as a script beside its sibling modules; load it the same way.
sys.path.insert(0, str(ROOT))


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    def certificate(name, ip):
        cert, key = tmp_path / (name + '.crt'), tmp_path / (name + '.key')
        config = tmp_path / (name + '.cnf')
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\n'
                          '[dn]\n[ext]\nsubjectAltName=IP:' + ip + '\n')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-days', '1', '-subj', '/CN=fixture', '-config', str(config),
            '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
        return cert, key
    cert, key = certificate('builder', '127.0.0.1')
    other, _ = certificate('other', '127.0.0.1')
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    builder, client = module('workshop_builder'), module('workshop')
    monkeypatch.setattr(builder, 'build_tool', lambda body: {'built': body})
    monkeypatch.setattr(builder, 'build_capability', lambda body: {'capability': body})
    monkeypatch.setattr(builder, 'test_tool', lambda body: {'tested': body})
    monkeypatch.setattr(builder, 'hub_request', lambda body: {'hub': body})
    server = builder.builder_server(('127.0.0.1', 0), 'fixture-bearer', tls, read_timeout=.3)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    token = tmp_path / 'bearer'
    token.write_text('fixture-bearer')
    config = {'builder_url': f'https://127.0.0.1:{server.server_port}',
              'builder_token_file': str(token), 'builder_ca_file': str(cert)}
    try:
        yield builder, client, config, other, server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_pinned_certificate_and_https_required(bridge):
    _, client, config, other, _ = bridge
    assert client.builder_request('/build', {'fixture': 1}, config) == {'built': {'fixture': 1}}
    assert client.builder_request('/capability-build', {'fixture': 1}, config) == {'capability': {'fixture': 1}}
    assert client.builder_request('/hub', {'action': 'search', 'value': 'fixture'}, config) == {
        'hub': {'action': 'search', 'value': 'fixture'}}
    with pytest.raises(URLError, match='CERTIFICATE_VERIFY_FAILED'):
        client.builder_request('/build', {}, {**config, 'builder_ca_file': str(other)})
    with pytest.raises(URLError, match='CERTIFICATE_VERIFY_FAILED'):
        client.builder_request('/build', {}, {**config, 'builder_url': config['builder_url'].replace('127.0.0.1', 'localhost')})
    with pytest.raises(ValueError, match='pinned HTTPS'):
        client.builder_request('/build', {}, {**config, 'builder_url': 'http://127.0.0.1'})


def test_build_and_test_refuse_busy_without_queuing(bridge, monkeypatch):
    builder, client, config, _, _ = bridge
    entered, finish = threading.Event(), threading.Event()
    results = []
    def build(body):
        entered.set()
        assert finish.wait(5)
        return {'complete': True}
    monkeypatch.setattr(builder, 'build_tool', build)
    thread = threading.Thread(target=lambda: results.append(client.builder_request('/build', {}, config)))
    thread.start()
    try:
        assert entered.wait(2)
        for path in ('/build', '/capability-build', '/test', '/hub'):
            with pytest.raises(RuntimeError, match='the builder is busy'):
                client.builder_request(path, {}, config)
    finally:
        finish.set()
        thread.join(timeout=3)
    assert results == [{'complete': True}]
    assert client.builder_request('/test', {}, config) == {'tested': {}}


@pytest.mark.parametrize('partial', [b'POST /build HTTP/1.1\r\n',
    b'POST /build HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-bearer\r\nContent-Length: 20\r\n\r\n{'])
def test_incomplete_headers_and_body_expire_without_blocking_accept(bridge, partial):
    _, client, config, _, server = bridge
    context = ssl.create_default_context(cafile=config['builder_ca_file'])
    raw = socket.create_connection(('127.0.0.1', server.server_port), timeout=2)
    with context.wrap_socket(raw, server_hostname='127.0.0.1') as connection:
        connection.sendall(partial)
        response = connection.recv(4096)
        assert not response or b'408' in response
    assert client.builder_request('/test', {}, config) == {'tested': {}}


def test_incomplete_tls_handshake_does_not_block_accept(bridge):
    _, client, config, _, server = bridge
    with socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as connection:
        assert client.builder_request('/test', {}, config) == {'tested': {}}
        assert connection.recv(4096) == b''


def test_redirect_cannot_forward_bearer_to_cleartext(bridge, monkeypatch):
    _, client, config, _, server = bridge
    def redirect(handler):
        handler.send_response(302)
        handler.send_header('Location', 'http://127.0.0.1:1/cleartext')
        handler.end_headers()
    monkeypatch.setattr(server.RequestHandlerClass, 'do_POST', redirect)
    with pytest.raises(ValueError, match='redirects'):
        client.builder_request('/build', {}, config)


def test_native_hub_refusal_survives_http_bridge(bridge, monkeypatch):
    builder, client, config, _, _ = bridge
    def refused(body):
        raise builder.BuilderRefusal('Hub did not install a scanned package: native scan refused it')
    monkeypatch.setattr(builder, 'hub_request', refused)
    with pytest.raises(RuntimeError, match='native scan refused it'):
        client.builder_request('/hub', {'action': 'install', 'value': 'fixture'}, config)


def test_reasoned_and_approved_packages_are_not_stopped_by_a_second_transport_budget(bridge):
    _, client, config, _, _ = bridge
    package = {'fixture': '\\u0000' * 220000}
    assert client.builder_request('/build', package, config) == {'built': package}
    assert client.builder_request('/test', package, config) == {'tested': package}
