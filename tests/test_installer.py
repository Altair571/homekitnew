import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import ssl
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('installer', os.environ.get('HK_INSTALLER_PATH', str(ROOT / 'Install Scrypted Plugin.command')))
spec = importlib.util.spec_from_loader(loader.name, loader)
app = importlib.util.module_from_spec(spec)
loader.exec_module(app)


class FakeConnection:
    requests = []
    status = 200
    data = b'ok'
    certificate = b'test certificate'
    reject_trusted = False

    def __init__(self, host, port, context, timeout):
        self.context = context
        self.sock = self

    def connect(self):
        if self.reject_trusted and self.context.verify_mode == ssl.CERT_REQUIRED:
            raise ssl.SSLCertVerificationError('test self-signed certificate')

    def getpeercert(self, binary_form=False):
        return self.certificate

    def request(self, method, path, body, headers):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return self

    def read(self, limit):
        return self.data

    def close(self):
        pass


class InstallerTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.requests = []
        FakeConnection.status = 200
        FakeConnection.data = b'ok'
        FakeConnection.reject_trusted = False

    def test_exact_release_archive(self):
        data, build, digest = app.read_plugin(ROOT / app.DEFAULT_ZIP)
        self.assertEqual(build, os.environ.get('HK_INSTALLER_BUILD', 'hevc-fixes-2026-09-16-r41'))
        self.assertEqual(digest, app.DEFAULT_SHA256)
        self.assertGreater(len(data), 2_000_000)

    def test_reject_non_https_or_credential_url(self):
        for url in ('http://192.168.1.10:10443', 'https://user:password@host', 'https://host/path', 'https://host?token=secret'):
            with self.assertRaises(app.InstallError):
                app.server_address(url)
        self.assertEqual(app.server_address('https://192.168.1.10:10443'), ('192.168.1.10', 10443))

    @patch.object(app.http.client, 'HTTPSConnection', FakeConnection)
    def test_refusing_certificate_sends_no_http_request(self):
        FakeConnection.reject_trusted = True
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(app.InstallError):
            app.connect_client('host', 10443, ask=lambda _: '')
        self.assertEqual(FakeConnection.requests, [])

    @patch.object(app.http.client, 'HTTPSConnection', FakeConnection)
    def test_trust_is_pinned_and_certificate_change_blocks_credentials(self):
        FakeConnection.reject_trusted = True
        with contextlib.redirect_stdout(io.StringIO()):
            client = app.connect_client('host', 10443, ask=lambda _: 'TRUST')
        self.assertEqual(client.fingerprint, hashlib.sha256(FakeConnection.certificate).hexdigest())
        client.request('GET', '/login')
        self.assertEqual(len(FakeConnection.requests), 1)
        client.fingerprint = 'wrong fingerprint'
        with self.assertRaises(app.InstallError):
            client.request('POST', '/login', b'secret', 'Bearer secret')
        self.assertEqual(len(FakeConnection.requests), 1)

    @patch.object(app.http.client, 'HTTPSConnection', FakeConnection)
    def test_redirects_and_auth_errors_do_not_retry_or_expose_body(self):
        client = app.Client('host', 10443, ssl.create_default_context())
        for status in (302, 401, 403, 500):
            FakeConnection.status = status
            FakeConnection.data = b'private response body'
            with self.assertRaises(app.InstallError) as captured:
                client.request('POST', '/login', b'password')
            self.assertNotIn('private response body', str(captured.exception))
        self.assertEqual(len(FakeConnection.requests), 4)

    @patch.object(app.http.client, 'HTTPSConnection', FakeConnection)
    def test_login_short_lived_token_then_exact_zip_deploy_without_setup(self):
        client = app.Client('host', 10443, ssl.create_default_context())
        FakeConnection.data = json.dumps({'authorization': 'Bearer test-session'}).encode()
        password = 'test "pass" with \\ backslash'
        authorization = app.login(client, 'test-user', password)
        request = FakeConnection.requests[0]
        self.assertEqual(request[1], '/login')
        self.assertEqual(json.loads(request[2]), {'username': 'test-user', 'password': password, 'maxAge': 300000})
        self.assertNotIn('Authorization', request[3])
        FakeConnection.data = b'ok'
        payload = b'exact ZIP bytes'
        app.upload(client, payload, authorization)
        request = FakeConnection.requests[1]
        self.assertEqual(request[:3], ('POST', '/web/component/script/deploy?npmPackage=%40scrypted%2Fhomekit', payload))
        self.assertEqual(request[3]['Content-Type'], 'application/zip')
        self.assertEqual(request[3]['Authorization'], 'Bearer test-session')
        self.assertEqual(len(FakeConnection.requests), 2)

    @patch.object(app.http.client, 'HTTPSConnection', FakeConnection)
    def test_http_200_login_error_is_not_success(self):
        FakeConnection.data = b'{"error":"Incorrect password."}'
        with self.assertRaises(app.InstallError):
            app.login(app.Client('host', 10443, ssl.create_default_context()), 'user', 'password')
        self.assertEqual(len(FakeConnection.requests), 1)

    def test_uncertain_upload_is_not_retried(self):
        class Interrupted:
            calls = 0
            def request(self, *args):
                self.calls += 1
                raise socket.timeout()
        client = Interrupted()
        with self.assertRaisesRegex(app.InstallError, 'may have been accepted'):
            app.upload(client, b'zip', 'Bearer test')
        self.assertEqual(client.calls, 1)


if __name__ == '__main__':
    unittest.main()
