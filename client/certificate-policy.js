'use strict';
const { X509Certificate } = require('node:crypto');
const { isIP } = require('node:net');

function normalizeFingerprint(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const hex = text.replace(/[:\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error('证书指纹应为 SHA-256 的 64 位十六进制值，可带冒号');
  return hex;
}

function pinnedHost(config) {
  const url = new URL(config.server);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || !isIP(host) || url.username || url.password) {
    throw new Error('使用证书指纹时，服务器地址必须是 https://IP:端口');
  }
  return host;
}

function validateTlsSettings(config) {
  const fingerprint = normalizeFingerprint(config.serverCertificateSha256);
  if (fingerprint) pinnedHost(config);
  return fingerprint;
}

// Electron: -3 preserves Chromium verification; -2 rejects; 0 accepts only the pinned leaf.
function certificateDecision(config, request, now = Date.now()) {
  if (!config.serverCertificateSha256) return { code: -3 };
  let host;
  try { host = pinnedHost(config); } catch { return { code: -3 }; }
  if (request.hostname.replace(/^\[|\]$/g, '') !== host) return { code: -3 };
  try {
    const pin = normalizeFingerprint(config.serverCertificateSha256);
    if (!pin) return { code: -3 };
    const cert = new X509Certificate(request.certificate.data);
    if (normalizeFingerprint(cert.fingerprint256) !== pin) throw new Error('服务器证书指纹不匹配');
    if (!cert.checkIP(host)) throw new Error('证书 SAN 不包含服务器 IP');
    const start = Date.parse(cert.validFrom), end = Date.parse(cert.validTo);
    if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) {
      throw new Error('服务器证书未生效或已过期，请检查证书和系统时间');
    }
    if (!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1')) throw new Error('证书缺少 serverAuth 用途');
    if (request.verificationResult === 'CERT_REVOKED') throw new Error('服务器证书已撤销');
    return { code: 0 };
  } catch (err) {
    return { code: -2, reason: err.message };
  }
}

function installCertificatePolicy(ses, getConfig, onReject = () => {}) {
  ses.setCertificateVerifyProc((request, callback) => {
    const result = certificateDecision(getConfig(), request);
    if (result.code === -2) onReject({ hostname: request.hostname, reason: result.reason });
    callback(result.code);
  });
}

module.exports = { normalizeFingerprint, validateTlsSettings, certificateDecision, installCertificatePolicy };
