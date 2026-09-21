const fs = require("fs");
const path = require("path");
const prisma = require("../../utils/prisma");
const config = require("../config");

/**
 * Infrastructure health.
 *
 * Two audiences, two shapes:
 *   - `probe()`   is the uptime endpoint: a tiny, credential-free answer.
 *   - `report()`  is the admin panel: detailed, still credential-free.
 *
 * No provider key, connection string or filesystem internal is ever included
 * in either payload.
 */

const STATUS = Object.freeze({
  OK: "ok",
  DEGRADED: "degraded",
  DOWN: "down",
  UNKNOWN: "unknown",
});

function storageRoot() {
  return process.env.STORAGE_DIR ?? path.resolve(__dirname, "../../storage");
}

/** Recursively measures a directory, capped so a huge tree cannot stall boot. */
function directorySize(target, budget = { files: 200_000 }) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    if (budget.files <= 0) break;
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.files-- <= 0) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += fs.statSync(full).size;
      } catch {
        /* a file disappearing mid-walk is not an error */
      }
    }
  }
  return total;
}

async function databaseStatus() {
  const started = Date.now();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return { status: STATUS.OK, latencyMs: Date.now() - started };
  } catch (error) {
    console.error("[Health] database check failed:", error.message);
    return { status: STATUS.DOWN, latencyMs: Date.now() - started };
  }
}

async function vectorStatus() {
  try {
    const { getVectorDbClass } = require("../../utils/helpers");
    const VectorDb = getVectorDbClass();
    const heartbeat = await VectorDb.heartbeat();
    return {
      status: STATUS.OK,
      provider: process.env.VECTOR_DB ?? "lancedb",
      heartbeat: heartbeat?.heartbeat ?? null,
    };
  } catch {
    return {
      status: STATUS.DEGRADED,
      provider: process.env.VECTOR_DB ?? "lancedb",
      // The message can name a host, so it is summarized rather than echoed.
      detail: "The vector store did not respond to a heartbeat.",
    };
  }
}

async function collectorStatus() {
  try {
    const { CollectorApi } = require("../../utils/collectorApi");
    const online = await new CollectorApi().online();
    return {
      status: online ? STATUS.OK : STATUS.DOWN,
      detail: online ? null : "The document processor is not reachable.",
    };
  } catch {
    return {
      status: STATUS.UNKNOWN,
      detail: "Document processor status unavailable.",
    };
  }
}

async function llmProviderStatus() {
  const provider = process.env.LLM_PROVIDER ?? null;
  if (!provider)
    return {
      status: STATUS.UNKNOWN,
      provider: null,
      detail: "No AI provider has been connected yet.",
    };

  try {
    const { getLLMProvider } = require("../../utils/helpers");
    const llm = getLLMProvider({});
    // A cheap capability check - never a billable completion.
    const reachable = typeof llm?.isValidChatCompletionModel === "function";
    return {
      status: reachable ? STATUS.OK : STATUS.DEGRADED,
      provider,
      model: llm?.model ?? process.env.OPEN_MODEL_PREF ?? null,
      // Deliberately reports configuration health, not a live billable call.
      detail: reachable ? null : "Provider client could not be constructed.",
    };
  } catch {
    return {
      status: STATUS.DEGRADED,
      provider,
      detail: "The AI provider is configured but could not be initialized.",
    };
  }
}

const Health = {
  STATUS,

  /**
   * Minimal liveness/readiness answer for external uptime monitoring.
   * Contains no credentials and no internal topology.
   */
  probe: async function () {
    const database = await databaseStatus();
    const healthy = database.status === STATUS.OK;
    return {
      status: healthy ? STATUS.OK : STATUS.DOWN,
      version: config.deployment.version,
      timestamp: new Date().toISOString(),
    };
  },

  /** Full operational picture for Owner/Administrator and Super Admin. */
  report: async function () {
    const [database, vector, collector, llm] = await Promise.all([
      databaseStatus(),
      vectorStatus(),
      collectorStatus(),
      llmProviderStatus(),
    ]);

    const root = storageRoot();
    let storage = { status: STATUS.UNKNOWN };
    try {
      const documentsBytes = directorySize(path.join(root, "documents"));
      const vectorBytes = directorySize(path.join(root, "lancedb"));
      const modelsBytes = directorySize(path.join(root, "models"));
      let databaseBytes = 0;
      try {
        databaseBytes = fs.statSync(path.join(root, "anythingllm.db")).size;
      } catch {
        /* a non-SQLite deployment has no local database file */
      }

      const usedBytes = documentsBytes + vectorBytes + databaseBytes;
      const limitBytes = config.limits.storageLimitGb * 1024 ** 3;
      const percentUsed = limitBytes
        ? Math.round((usedBytes / limitBytes) * 1000) / 10
        : 0;

      storage = {
        status:
          percentUsed >= 95
            ? STATUS.DEGRADED
            : percentUsed >= 100
              ? STATUS.DOWN
              : STATUS.OK,
        usedBytes,
        limitBytes,
        percentUsed,
        breakdown: { documentsBytes, vectorBytes, databaseBytes, modelsBytes },
      };
    } catch (error) {
      console.error("[Health] storage check failed:", error.message);
      storage = { status: STATUS.UNKNOWN };
    }

    const [failedIngestion, failedAutomations, totalDocuments, pendingSync] =
      await Promise.all([
        // Upstream records ingestion outcomes on sync executions; a document
        // that failed to embed shows up here rather than on the file row.
        prisma.document_sync_executions
          .count({
            where: {
              status: { in: ["failed", "unknown"] },
              createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
            },
          })
          .catch(() => 0),
        prisma.scheduled_job_runs.count({
          where: {
            status: { in: ["failed", "timed_out"] },
            startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
          },
        }),
        prisma.workspace_documents.count(),
        prisma.document_sync_queues.count().catch(() => 0),
      ]);

    const { PlatformSettings } = require("../models/platformSettings");
    const lastBackupAt = await PlatformSettings.get(
      PlatformSettings.KEYS.LAST_BACKUP_AT
    );

    const components = { database, vector, collector, llm, storage };
    const worst = Object.values(components).some(
      (c) => c.status === STATUS.DOWN
    )
      ? STATUS.DOWN
      : Object.values(components).some((c) => c.status === STATUS.DEGRADED)
        ? STATUS.DEGRADED
        : STATUS.OK;

    return {
      status: worst,
      timestamp: new Date().toISOString(),
      application: {
        status: STATUS.OK,
        version: config.deployment.version,
        buildRef: config.deployment.buildRef || null,
        environment: config.deployment.environment,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
      components,
      processing: {
        totalDocuments,
        failedIngestion,
        pendingSync,
      },
      automations: {
        recentFailures: failedAutomations,
      },
      backups: {
        lastBackupAt: lastBackupAt ?? null,
        // Surfaced so an operator notices a deployment that has never backed up.
        configured: Boolean(config.deployment.backupDir),
      },
    };
  },
};

module.exports = { Health, STATUS };
