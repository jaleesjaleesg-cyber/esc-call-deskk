const crypto = require('crypto');

function canonicalMessage(method, pathname, timestamp, nonce, bodyBuffer) {
  const bodyHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
  return [method.toUpperCase(), pathname, timestamp, nonce, bodyHash].join('\n');
}

function signRequest(secret, method, pathname, timestamp, nonce, bodyBuffer) {
  return crypto.createHmac('sha256', secret)
    .update(canonicalMessage(method, pathname, timestamp, nonce, bodyBuffer))
    .digest('hex');
}

class CloudResearchBridge {
  constructor({ baseUrl, secret, timeoutMs = 15000, allowInsecureHttp = false } = {}) {
    this.baseUrl = String(baseUrl || '').trim().replace(/\/$/, '');
    this.secret = String(secret || '').trim();
    this.timeoutMs = timeoutMs;
    this.allowInsecureHttp = Boolean(allowInsecureHttp);
  }

  isConfigured() {
    const permittedScheme = /^https:\/\//i.test(this.baseUrl)
      || (this.allowInsecureHttp && /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(this.baseUrl));
    return Boolean(this.baseUrl && this.secret && permittedScheme);
  }

  async request(pathWithQuery, { method = 'GET', body } = {}) {
    if (!this.isConfigured()) {
      const error = new Error('Cloud research is not configured on this server.');
      error.statusCode = 503;
      throw error;
    }

    const url = new URL(pathWithQuery, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      const error = new Error('Invalid cloud research path.');
      error.statusCode = 400;
      throw error;
    }
    const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const signedTarget = `${url.pathname}${url.search}`;
    const signature = signRequest(this.secret, method, signedTarget, timestamp, nonce, bodyBuffer);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-ESC-Timestamp': timestamp,
          'X-ESC-Nonce': nonce,
          'X-ESC-Signature': signature
        },
        ...(body === undefined ? {} : { body: bodyBuffer })
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { error: text || 'Invalid Azure response.' }; }
      if (!response.ok) {
        const error = new Error(payload.error || payload.detail || `Azure research request failed (${response.status}).`);
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const timeoutError = new Error('Azure research control timed out. No local fallback was used.');
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  requestRun(requestedBy, parameters) {
    return this.request('/v1/runs', { method: 'POST', body: { requested_by: requestedBy, parameters } });
  }

  listRuns(limit = 30) {
    return this.request(`/v1/runs?limit=${Math.max(1, Math.min(100, Number(limit) || 30))}`);
  }

  getRun(runId) {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  getArtifact(runId) {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/artifact`);
  }

  approveRun(runId, otp) {
    return this.request(`/v1/approve/${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: { otp: String(otp || '').trim() }
    });
  }

  denyRun(runId, otp) {
    return this.request(`/v1/deny/${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: { otp: String(otp || '').trim() }
    });
  }
}

module.exports = { CloudResearchBridge, canonicalMessage, signRequest };

