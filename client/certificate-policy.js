'use strict';

function serverHost(config) {
  const url = new URL(config.server);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('信任不匹配证书时，服务器地址必须使用 HTTPS，且不能包含用户名或密码');
  }
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function validateTlsSettings(config) {
  const enabled = config.trustInvalidServerCertificate ?? false;
  if (typeof enabled !== 'boolean') throw new Error('信任不匹配证书选项必须为布尔值');
  if (enabled) serverHost(config);
  return enabled;
}

// The verification hook exposes a host, not a port; the exception covers that host's ports.
function certificateDecision(config, request) {
  if (config.trustInvalidServerCertificate !== true) return { code: -3 };
  try {
    if (request.hostname.replace(/^\[|\]$/g, '').toLowerCase() === serverHost(config)) {
      return { code: request.verificationResult === 'OK' ? -3 : 0 };
    }
  } catch { /* Invalid settings never enable a global exception. */ }
  return { code: -3 };
}

function installCertificatePolicy(ses, getConfig, onOverride = () => {}) {
  ses.setCertificateVerifyProc((request, callback) => {
    const result = certificateDecision(getConfig(), request);
    if (result.code === 0) onOverride({ hostname: request.hostname, error: request.verificationResult });
    callback(result.code);
  });
}

module.exports = { validateTlsSettings, certificateDecision, installCertificatePolicy };
