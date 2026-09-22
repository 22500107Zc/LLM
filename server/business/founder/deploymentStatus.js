const provisioning = require("../services/provisioning");

/**
 * Reads a customer deployment's live operational status.
 *
 * HOW, AND WHY IT IS SHAPED THIS WAY
 *
 * The founder console runs on the host that provisioned these deployments.
 * Each one answers on 127.0.0.1 at the port recorded in its own env file, and
 * that same env file holds the HEALTHCHECK_TOKEN provisioning generated for
 * it. So the console makes one ordinary HTTP GET to a single fixed path.
 *
 * Nothing here executes a process, reads a customer's database, or takes a URL
 * from the caller. The host is hardcoded to loopback and the port comes from
 * the state directory, never from a request - so a founder request cannot be
 * steered at an arbitrary address.
 */

const STATUS_PATH = "/api/platform/operator-status";
const TIMEOUT_MS = 4000;

/**
 * @param {string} slug
 * @returns {Promise<{reachable: boolean, reason?: string, status?: object}>}
 */
async function readStatus(slug) {
  if (provisioning.validateSlug(slug))
    return { reachable: false, reason: "Unknown deployment." };

  const deployment = provisioning.getDeployment(slug);
  if (!deployment) return { reachable: false, reason: "Unknown deployment." };

  const port = Number(deployment.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return {
      reachable: false,
      reason: "This deployment has no valid host port recorded.",
    };

  const token = provisioning.envValue(slug, "HEALTHCHECK_TOKEN");
  if (!token)
    return {
      reachable: false,
      reason:
        "This deployment has no HEALTHCHECK_TOKEN, so its status cannot be read. Re-provision or set one, then run ./scripts/operator.sh update " +
        slug,
    };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, {
      method: "GET",
      headers: { "X-Health-Token": token, Accept: "application/json" },
      signal: controller.signal,
      redirect: "manual",
    });

    if (response.status === 401)
      return {
        reachable: true,
        reason:
          "The deployment rejected the health token. Its container may be running older configuration - run ./scripts/operator.sh update " +
          slug,
      };
    if (response.status === 404)
      return {
        reachable: true,
        reason:
          "The deployment is running a build without the operator status endpoint. Run ./scripts/operator.sh update " +
          slug,
      };
    if (!response.ok)
      return {
        reachable: true,
        reason: `The deployment answered ${response.status}.`,
      };

    return { reachable: true, status: await response.json() };
  } catch (error) {
    // Not running, still starting, or the port is closed. All the same to the
    // console: it shows "not responding" rather than an internal error.
    const aborted = error?.name === "AbortError";
    return {
      reachable: false,
      reason: aborted
        ? "The deployment did not answer within 4 seconds."
        : "The deployment is not responding on its host port.",
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readStatus, STATUS_PATH, TIMEOUT_MS };
