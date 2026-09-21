/**
 * Attribution headers some model providers (OpenRouter, Novita, PPIO,
 * CometAPI) accept to identify the calling application.
 *
 * These carried the upstream project's domain and product name. Sending those
 * from a different product is simply inaccurate, so the deployment identifies
 * itself: its own public URL and its own product name, or nothing at all when
 * neither is configured. An absent header is correct; a wrong one is not.
 */
function providerAttributionHeaders() {
  const headers = {};

  const publicUrl = (process.env.PUBLIC_URL || "").trim();
  if (publicUrl) headers["HTTP-Referer"] = publicUrl;

  const appName = (process.env.APP_NAME || "").trim();
  if (appName) headers["X-Title"] = appName;

  return headers;
}

module.exports = { providerAttributionHeaders };
