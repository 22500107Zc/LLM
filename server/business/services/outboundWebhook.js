const dns = require("dns").promises;
const net = require("net");
const config = require("../config");

/**
 * SSRF protection for customer-configured outbound webhooks.
 *
 * Customers can point an integration at any URL they like, which makes the
 * server a confused deputy unless we refuse to talk to internal addresses.
 * We resolve the hostname ourselves and reject any answer that lands inside a
 * private, loopback, link-local or cloud-metadata range - including the
 * classic `169.254.169.254` IMDS endpoint.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** @returns {boolean} true when the IPv4/IPv6 literal is not safe to contact. */
function isBlockedAddress(address) {
  if (!address) return true;

  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o)))
      return true;
    const [a, b] = octets;
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fe80")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local
    if (normalized.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) - re-check against the IPv4 rules.
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  return true;
}

/**
 * Validates a webhook destination and resolves it to safe IP addresses.
 * @param {string} rawUrl
 * @returns {Promise<{ok: boolean, reason?: string, url?: URL, addresses?: string[]}>}
 */
async function assertSafeDestination(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "Destination is not a valid URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol))
    return { ok: false, reason: "Only http(s) destinations are permitted." };

  if (
    config.deployment.environment === "production" &&
    url.protocol === "http:"
  )
    return { ok: false, reason: "Webhook destinations must use HTTPS." };

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return { ok: false, reason: "Destination has no hostname." };

  if (config.security.allowPrivateNetworkWebhooks)
    return { ok: true, url, addresses: [] };

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".internal"))
    return { ok: false, reason: "Destination host is not permitted." };

  // A literal IP needs no DNS round trip.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname))
      return {
        ok: false,
        reason: "Destination resolves to a restricted network.",
      };
    return { ok: true, url, addresses: [hostname] };
  }

  let records = [];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "Destination hostname could not be resolved." };
  }

  if (!records.length)
    return { ok: false, reason: "Destination hostname could not be resolved." };

  for (const record of records) {
    if (isBlockedAddress(record.address))
      return {
        ok: false,
        reason: "Destination resolves to a restricted network.",
      };
  }

  return { ok: true, url, addresses: records.map((r) => r.address) };
}

/**
 * Performs a guarded outbound POST. Redirects are never followed, because a
 * redirect would bypass the pre-flight address check.
 * @param {string} rawUrl
 * @param {object} payload
 * @param {{headers?: object, timeoutMs?: number, method?: string}} options
 */
async function postJSON(rawUrl, payload, options = {}) {
  const check = await assertSafeDestination(rawUrl);
  if (!check.ok) return { ok: false, status: null, error: check.reason };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(check.url.toString(), {
      method: options.method ?? "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `${config.branding.appName}/${config.deployment.version}`,
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(payload ?? {}),
    });

    if (response.status >= 300 && response.status < 400)
      return {
        ok: false,
        status: response.status,
        error: "Destination attempted a redirect, which is not allowed.",
      };

    let body = "";
    try {
      const text = await response.text();
      body = text.slice(0, MAX_RESPONSE_BYTES);
    } catch {
      body = "";
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok
        ? null
        : `Destination responded with ${response.status}.`,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      status: null,
      error: aborted ? "Destination timed out." : "Destination request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  assertSafeDestination,
  postJSON,
  isBlockedAddress,
};
