'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTlsSettings, certificateDecision, installCertificatePolicy } = require('../client/certificate-policy');
const config = { server: 'https://127.0.0.1:8989', trustInvalidServerCertificate: true };
const request = { hostname: '127.0.0.1', verificationResult: 'CERT_AUTHORITY_INVALID' };

test('certificate exception: disabled by default and legacy pins do not enable it', () => {
  assert.equal(validateTlsSettings({ server: 'http://localhost:8080' }), false);
  assert.equal(certificateDecision({ server: config.server }, request).code, -3);
  assert.equal(certificateDecision({ ...config, trustInvalidServerCertificate: false }, request).code, -3);
  assert.equal(certificateDecision({ server: config.server, serverCertificateSha256: 'A'.repeat(64) }, request).code, -3);
  assert.equal(certificateDecision({ ...config, trustInvalidServerCertificate: 'true' }, request).code, -3);
});

test('certificate exception: requires an explicit boolean and HTTPS endpoint', () => {
  assert.equal(validateTlsSettings(config), true);
  assert.equal(validateTlsSettings({ ...config, server: 'https://example.com:8989' }), true);
  assert.throws(() => validateTlsSettings({ ...config, server: 'http://127.0.0.1:8989' }), /HTTPS/);
  assert.throws(() => validateTlsSettings({ ...config, server: 'https://user:password@127.0.0.1' }), /用户名/);
  assert.throws(() => validateTlsSettings({ ...config, trustInvalidServerCertificate: 'false' }), /布尔/);
});

test('certificate exception: accepts certificate errors only for the configured host', () => {
  for (const error of ['CERT_AUTHORITY_INVALID', 'CERT_COMMON_NAME_INVALID', 'CERT_DATE_INVALID']) {
    assert.equal(certificateDecision(config, { ...request, verificationResult: error }).code, 0);
  }
  assert.equal(certificateDecision(config, { ...request, hostname: '127.0.0.2' }).code, -3);
  assert.equal(certificateDecision(config, { ...request, hostname: 'example.com' }).code, -3);
  assert.equal(certificateDecision(config, { ...request, verificationResult: 'OK' }).code, -3);
});

test('certificate exception: DNS/IPv6 normalization and invalid configurations preserve normal trust', () => {
  assert.equal(certificateDecision({ ...config, server: 'https://EXAMPLE.com:8989' }, { ...request, hostname: 'example.com' }).code, 0);
  assert.equal(certificateDecision({ ...config, server: 'https://[::1]:8989' }, { ...request, hostname: '::1' }).code, 0);
  for (const server of ['http://127.0.0.1:8989', 'not a URL', 'https://user:pw@127.0.0.1']) {
    assert.equal(certificateDecision({ ...config, server }, request).code, -3);
  }
});

test('certificate exception: callback logs overrides and reads updated checkbox configuration', () => {
  let handler, current = config;
  const overridden = [];
  installCertificatePolicy({ setCertificateVerifyProc(proc) { handler = proc; } }, () => current, event => overridden.push(event));
  let code;
  handler(request, value => { code = value; });
  assert.equal(code, 0);
  assert.deepEqual(overridden, [{ hostname: '127.0.0.1', error: 'CERT_AUTHORITY_INVALID' }]);
  current = { ...config, trustInvalidServerCertificate: false };
  handler(request, value => { code = value; });
  assert.equal(code, -3);
  assert.equal(overridden.length, 1);
});
