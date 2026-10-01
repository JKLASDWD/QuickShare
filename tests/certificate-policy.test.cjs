'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const fixtures = require('./certificate-fixtures.cjs');
const { normalizeFingerprint, validateTlsSettings, certificateDecision, installCertificatePolicy } = require('../client/certificate-policy');
const certificate = new X509Certificate(fixtures.ip);
const pin = certificate.fingerprint256;
const config = { server: 'https://127.0.0.1:8989', serverCertificateSha256: pin };
const request = { hostname: '127.0.0.1', certificate: { data: fixtures.ip }, verificationResult: 'CERT_AUTHORITY_INVALID' };
const during = Date.parse(certificate.validFrom) + 1000;

test('certificate pin: requires SHA-256 and an HTTPS IP endpoint', () => {
  assert.equal(normalizeFingerprint(pin.toLowerCase()), pin.replaceAll(':', ''));
  assert.equal(normalizeFingerprint(''), '');
  assert.throws(() => normalizeFingerprint('A'.repeat(40)), /SHA-256/);
  assert.throws(() => validateTlsSettings({ ...config, server: 'http://127.0.0.1:8989' }), /https/);
  assert.throws(() => validateTlsSettings({ ...config, server: 'https://example.com' }), /IP/);
  assert.throws(() => validateTlsSettings({ ...config, server: 'https://user:password@127.0.0.1' }), /IP/);
});

test('certificate pin: accepts the exact leaf only for its IP, both HTTPS and WSS host verification', () => {
  assert.equal(certificateDecision(config, request, during).code, 0);
  assert.equal(certificateDecision({ ...config, server: 'https://127.0.0.1:8443' }, request, during).code, 0);
  assert.equal(certificateDecision(config, { ...request, hostname: '127.0.0.2' }, during).code, -3);
  assert.equal(certificateDecision({ ...config, serverCertificateSha256: '' }, request, during).code, -3);
});

test('certificate pin: mismatch is rejected even if Chromium would trust the certificate', () => {
  assert.equal(certificateDecision({ ...config, serverCertificateSha256: 'A'.repeat(64) }, { ...request, verificationResult: 'OK' }, during).code, -2);
  assert.equal(certificateDecision({ ...config, serverCertificateSha256: 'bad pin' }, request, during).code, -2);
  assert.equal(certificateDecision(config, { ...request, certificate: { data: 'malformed' } }, during).code, -2);
});

test('certificate pin: validity and revocation remain enforced', () => {
  assert.equal(certificateDecision(config, request, Date.parse(certificate.validFrom) - 1).code, -2);
  assert.equal(certificateDecision(config, request, Date.parse(certificate.validTo)).code, -2);
  assert.equal(certificateDecision(config, { ...request, verificationResult: 'CERT_REVOKED' }, during).code, -2);
});

test('certificate pin: DNS SAN containing an IP string cannot substitute for an IP SAN', () => {
  const cert = new X509Certificate(fixtures.dns);
  assert.equal(certificateDecision({ ...config, serverCertificateSha256: cert.fingerprint256 }, { ...request, certificate: { data: fixtures.dns } }, Date.parse(cert.validFrom) + 1000).code, -2);
  assert.equal(certificateDecision({ ...config, server: 'https://127.0.0.2:8989' }, { ...request, hostname: '127.0.0.2' }, during).code, -2);
});

test('certificate pin: serverAuth purpose is required', () => {
  const cert = new X509Certificate(fixtures.noEku);
  const result = certificateDecision({ ...config, serverCertificateSha256: cert.fingerprint256 }, { ...request, certificate: { data: fixtures.noEku } }, Date.parse(cert.validFrom) + 1000);
  assert.equal(result.code, -2);
  assert.match(result.reason, /serverAuth/);
});

test('certificate pin: Electron callback preserves normal trust and rejects mismatches without exposing PEM', () => {
  let handler, current = { ...config, serverCertificateSha256: 'A'.repeat(64) };
  const rejected = [];
  installCertificatePolicy({ setCertificateVerifyProc(proc) { handler = proc; } }, () => current, e => rejected.push(e));
  let code;
  handler(request, value => { code = value; });
  assert.equal(code, -2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].hostname, '127.0.0.1');
  assert.ok(!JSON.stringify(rejected).includes('BEGIN CERTIFICATE'));
  current = { ...config, serverCertificateSha256: '' };
  handler(request, value => { code = value; });
  assert.equal(code, -3);
});
