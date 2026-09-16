#!/usr/bin/env python3
"""Upload the existing HomeKit plugin through Scrypted's authenticated deploy API.

API references:
https://github.com/koush/scrypted/blob/main/sdk/src/bin/index.ts
https://github.com/koush/scrypted/blob/main/server/src/scrypted-server-main.ts
Uses Python 3 standard library only. Credentials/tokens are never saved.
"""
import argparse
import getpass
import hashlib
import http.client
import io
import json
import socket
import ssl
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlencode, urlsplit

DEFAULT_ZIP = 'plugin-hevc-webrtc-r44.zip'
DEFAULT_SHA256 = '84664a7d02adb00815eb63f7bc0ca491bd41da67857e114313c5080b29b66115'
PLUGIN = '@scrypted/homekit'
DEPLOY_PATH = '/web/component/script/deploy?' + urlencode({'npmPackage': PLUGIN})


class InstallError(Exception):
    pass


def server_address(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise InstallError('Use an HTTPS server address, for example https://192.168.1.10:10443')
    try:
        return parsed.hostname, parsed.port or 443
    except ValueError:
        raise InstallError('Invalid server port.') from None


def read_plugin(path):
    if not path.is_file():
        raise InstallError(f'ZIP not found: {path}. Keep it beside this installer, or use --zip PATH.')
    if path.stat().st_size > 100 * 1024 * 1024:
        raise InstallError('Plugin ZIP exceeds the 100 MB upload limit.')
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if path.name == DEFAULT_ZIP and digest != DEFAULT_SHA256:
        raise InstallError('The r44 ZIP checksum does not match the tested build.')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise InstallError('The ZIP contains duplicate entries.')
            for name in ('main.nodejs.js', 'build-manifest.json'):
                if archive.getinfo(name).file_size > 100 * 1024 * 1024:
                    raise InstallError('Unpacked plugin content exceeds the size limit.')
            manifest = json.loads(archive.read('build-manifest.json'))
            bundle = archive.read('main.nodejs.js')
            if hashlib.sha256(bundle).hexdigest() != manifest.get('bundleSha256'):
                raise InstallError('Plugin bundle does not match its build manifest.')
            build = manifest.get('buildId', '')
            if not isinstance(build, str) or not build.startswith('hevc-fixes-') or not all(c.isalnum() or c in '-.' for c in build):
                raise InstallError('This installer expects one of the patched HomeKit builds.')
    except (KeyError, ValueError, zipfile.BadZipFile):
        raise InstallError('Not a valid patched HomeKit plugin ZIP.') from None
    return data, build, digest


class Client:
    def __init__(self, host, port, context, fingerprint=None):
        self.host, self.port, self.context = host, port, context
        self.fingerprint = fingerprint

    def request(self, method, path, body=None, authorization=None, content_type=None):
        connection = http.client.HTTPSConnection(self.host, self.port, context=self.context, timeout=90)
        try:
            connection.connect()
            if self.fingerprint is not None:
                actual = hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest()
                if actual != self.fingerprint:
                    raise InstallError('Server certificate changed. No request was sent on this connection.')
            headers = {'Accept': 'application/json', 'User-Agent': 'Scrypted-HomeKit-Installer'}
            if content_type:
                headers['Content-Type'] = content_type
            if authorization:
                headers['Authorization'] = authorization
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            status, payload = response.status, response.read(1024 * 1024 + 1)
            if len(payload) > 1024 * 1024:
                raise InstallError('Server response exceeded the size limit.')
            if 300 <= status < 400:
                raise InstallError('Server redirected the request. Redirects are not followed; check the server address.')
            if status in (401, 403):
                raise InstallError('Scrypted rejected authentication. Use a Scrypted administrator account.')
            if not 200 <= status < 300:
                if b'npm package not found' in payload:
                    raise InstallError('HomeKit is not installed on this server. This script only updates an existing installation.')
                raise InstallError(f'Scrypted returned HTTP {status}. Check the server console.')
            return payload
        finally:
            connection.close()


def connect_client(host, port, ask=input):
    context = ssl.create_default_context()
    connection = http.client.HTTPSConnection(host, port, context=context, timeout=10)
    try:
        connection.connect()
        return Client(host, port, context)
    except ssl.SSLCertVerificationError:
        pass
    finally:
        connection.close()

    # Inspect the certificate without sending HTTP requests or credentials. Only
    # explicit user trust enables requests, pinned to these exact certificate bytes.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    connection = http.client.HTTPSConnection(host, port, context=context, timeout=10)
    try:
        connection.connect()
        fingerprint = hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest()
    finally:
        connection.close()
    print(f'\nThe certificate for {host}:{port} is not trusted by Python.')
    print('Scrypted normally uses a self-signed certificate. Verify this is your server.')
    print('Certificate SHA-256: ' + ':'.join(fingerprint[i:i+2] for i in range(0, 64, 2)))
    if ask('Type TRUST to accept this certificate for this upload only, or Enter to cancel: ').strip() != 'TRUST':
        raise InstallError('Cancelled before sending credentials.')
    return Client(host, port, context, fingerprint)


def login(client, username, password):
    payload = json.dumps({'username': username, 'password': password, 'maxAge': 300000}).encode()
    result = json.loads(client.request('POST', '/login', payload, content_type='application/json'))
    authorization = result.get('authorization')
    if result.get('error') or not isinstance(authorization, str) or not authorization.startswith('Bearer '):
        raise InstallError('Login failed. Check your Scrypted username and password.')
    return authorization


def upload(client, data, authorization):
    try:
        response = client.request('POST', DEPLOY_PATH, data, authorization, 'application/zip')
    except (socket.timeout, ConnectionError, http.client.HTTPException):
        raise InstallError('Connection ended during deployment. The upload may have been accepted; check HomeKit startup logs before retrying.') from None
    if response.strip() != b'ok':
        raise InstallError('Unexpected deployment response. Check the HomeKit console before retrying.')


def main():
    parser = argparse.ArgumentParser(description='Upload a patched ZIP to the existing Scrypted HomeKit plugin.')
    parser.add_argument('--server', default='https://192.168.1.10:10443')
    parser.add_argument('--zip', type=Path, default=Path(__file__).resolve().with_name(DEFAULT_ZIP))
    args = parser.parse_args()
    host, port = server_address(args.server)
    data, build, digest = read_plugin(args.zip.expanduser())
    print(f'Scrypted HomeKit installer\nServer: {host}:{port}\nPlugin: {PLUGIN}\nBuild: {build}\nZIP SHA-256: {digest}')
    print('Uploading will reload HomeKit and briefly interrupt its camera streams. Existing plugin settings are retained.')
    client = connect_client(host, port)
    state = json.loads(client.request('GET', '/login'))
    if state.get('hasLogin') is False:
        raise InstallError('This server has no configured account. No account was created and no upload was attempted.')
    if not sys.stdin.isatty():
        raise InstallError('Run this script in Terminal so the password can be entered privately.')
    username = input('Scrypted username: ').strip()
    password = getpass.getpass('Scrypted password (hidden): ')
    if not username or not password:
        raise InstallError('Username and password are required.')
    authorization = login(client, username, password)
    del password
    print('Signed in. Uploading plugin and waiting for the server reload...')
    upload(client, data, authorization)
    del authorization
    print(f'\nScrypted accepted {build} and completed its deploy/reload call.')
    print(f'Check the HomeKit console for the {build} startup marker.')
    print('Live camera operation has not been verified by this installer.')


if __name__ == '__main__':
    code = 0
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled.'); code = 1
    except InstallError as error:
        print(f'\n{error}'); code = 1
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(f'\nCould not complete the request ({type(error).__name__}). Check the server address and network connection.'); code = 1
    if sys.stdin.isatty():
        try:
            input('\nPress Enter to close...')
        except (KeyboardInterrupt, EOFError):
            pass
    sys.exit(code)
