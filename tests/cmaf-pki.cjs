// A stand-in for the certificate authority Apple's provisioning represents: it issues the
// publishing point's server certificate and signs the CSR the plugin generates, so the upload
// tests exercise the real mutual-TLS identity rather than a disabled check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function openssl(...args) {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function available() {
  try { openssl('version'); return true; } catch { return false; }
}

/** Creates a CA and a server certificate for localhost, and returns a signer for client CSRs. */
function authority() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hksv-pki-'));
  const at = name => path.join(dir, name);
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', at('ca.key'), '-out', at('ca.pem'), '-days', '1', '-subj', '/CN=HKSV Test CA');
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', at('server.key'), '-out', at('server.csr'), '-subj', '/CN=localhost');
  openssl('x509', '-req', '-in', at('server.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'),
    '-CAcreateserial', '-days', '1', '-out', at('server.pem'),
    '-extfile', writeExt(at('server.ext')));
  const caPem = fs.readFileSync(at('ca.pem'));
  return {
    dir,
    caPem,
    caDer: pemToDer(caPem),
    serverKey: fs.readFileSync(at('server.key')),
    serverCert: fs.readFileSync(at('server.pem')),
    /** Signs a DER CSR the way the controller's CSR/certificate exchange (§4.25/§4.26) would. */
    signCsr(csrDer) {
      fs.writeFileSync(at('client.csr.der'), csrDer);
      openssl('req', '-inform', 'DER', '-in', at('client.csr.der'), '-out', at('client.csr'));
      openssl('x509', '-req', '-in', at('client.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'),
        '-CAcreateserial', '-days', '1', '-out', at('client.pem'));
      return pemToDer(fs.readFileSync(at('client.pem')));
    },
    close() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function writeExt(file) {
  fs.writeFileSync(file, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  return file;
}

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}

module.exports = { authority, available, pemToDer };
