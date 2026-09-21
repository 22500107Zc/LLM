const { reqBody } = require("../../utils/http");
const { AuditLog } = require("../models/audit");
const { requireCapability, safeHandler } = require("../middleware");
const config = require("../config");

/**
 * Knowledge management.
 *
 * Ingestion, parsing, embedding and vectorization all remain upstream's - this
 * layer presents them as a business-legible "company knowledge" view with
 * processing state, failures and per-agent assignment.
 */
function knowledgeRoutes(router) {
  router.get(
    "/knowledge",
    [requireCapability("knowledge:view")],
    safeHandler(async (request, response) => {
      const prisma = require("../../utils/prisma");
      const { agentUuid = null } = request.query;

      let workspaceFilter = {};
      if (agentUuid) {
        const agent = await prisma.agent_profiles.findUnique({
          where: { uuid: String(agentUuid) },
        });
        if (!agent) return response.status(404).json({ error: "Agent not found." });
        workspaceFilter = { workspaceId: agent.workspace_id };
      }

      const [documents, agents, syncQueues] = await Promise.all([
        prisma.workspace_documents.findMany({
          where: workspaceFilter,
          orderBy: { id: "desc" },
          take: 1_000,
        }),
        prisma.agent_profiles.findMany({
          select: { id: true, uuid: true, name: true, workspace_id: true },
        }),
        prisma.document_sync_queues.findMany({
          include: { runs: { orderBy: { id: "desc" }, take: 1 } },
        }),
      ]);

      const agentByWorkspace = new Map(agents.map((a) => [a.workspace_id, a]));
      const syncByDoc = new Map(syncQueues.map((q) => [q.workspaceDocId, q]));

      const items = documents.map((doc) => {
        let metadata = {};
        try {
          metadata = JSON.parse(doc.metadata || "{}");
        } catch {
          metadata = {};
        }
        const sync = syncByDoc.get(doc.id);
        const lastRun = sync?.runs?.[0] ?? null;

        return {
          id: doc.id,
          docId: doc.docId,
          filename: doc.filename,
          title: metadata.title ?? doc.filename,
          source: metadata.url ?? metadata.source ?? "Uploaded file",
          wordCount: metadata.wordCount ?? null,
          tokenCount: metadata.token_count_estimate ?? null,
          published: metadata.published ?? null,
          // A document row only exists once embedding succeeded, so presence
          // here means "processed"; a failure shows on its sync run instead.
          status: lastRun?.status === "failed" ? "failed" : "processed",
          lastRunStatus: lastRun?.status ?? null,
          watched: Boolean(sync),
          nextSyncAt: sync?.nextSyncAt ?? null,
          lastSyncedAt: sync?.lastSyncedAt ?? null,
          workspaceId: doc.workspaceId,
          agent: agentByWorkspace.get(doc.workspaceId)
            ? {
                uuid: agentByWorkspace.get(doc.workspaceId).uuid,
                name: agentByWorkspace.get(doc.workspaceId).name,
              }
            : null,
          createdAt: doc.createdAt,
          lastUpdatedAt: doc.lastUpdatedAt,
        };
      });

      response.status(200).json({
        documents: items,
        total: items.length,
        failed: items.filter((d) => d.status === "failed").length,
        limits: { storageLimitGb: config.limits.storageLimitGb },
      });
    })
  );

  /** Documents that exist in storage but are not attached to any agent yet. */
  router.get(
    "/knowledge/available",
    [requireCapability("knowledge:view")],
    safeHandler(async (_request, response) => {
      const { viewLocalFiles } = require("../../utils/files");
      const files = await viewLocalFiles();
      response.status(200).json({ localFiles: files });
    })
  );

  /**
   * Attaches or detaches documents for an agent. Delegates to the upstream
   * workspace document model so embedding and vector sync behave identically.
   */
  router.post(
    "/knowledge/assign",
    [requireCapability("knowledge:manage")],
    safeHandler(async (request, response) => {
      const prisma = require("../../utils/prisma");
      const { Document } = require("../../models/documents");
      const { agentUuid, adds = [], deletes = [] } = reqBody(request);

      const agent = await prisma.agent_profiles.findUnique({
        where: { uuid: String(agentUuid) },
      });
      if (!agent) return response.status(404).json({ error: "Agent not found." });

      const { Workspace } = require("../../models/workspace");
      const workspace = await Workspace.get({ id: agent.workspace_id });
      if (!workspace)
        return response.status(404).json({ error: "The agent's workspace is missing." });

      const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
        workspace,
        Array.isArray(adds) ? adds : [],
        response.locals.user?.id ?? null
      );

      if (Array.isArray(deletes) && deletes.length)
        await Document.removeDocuments(
          workspace,
          deletes,
          response.locals.user?.id ?? null
        );

      if (adds.length)
        await AuditLog.fromRequest(request, response, {
          action: "document.uploaded",
          category: AuditLog.CATEGORIES.KNOWLEDGE,
          resource: "agent",
          resourceId: agent.uuid,
          metadata: {
            agent: agent.name,
            added: adds.length,
            failed: failedToEmbed.length,
          },
        });

      if (deletes.length)
        await AuditLog.fromRequest(request, response, {
          action: "document.removed",
          category: AuditLog.CATEGORIES.KNOWLEDGE,
          resource: "agent",
          resourceId: agent.uuid,
          metadata: { agent: agent.name, removed: deletes.length },
        });

      response.status(200).json({
        success: true,
        failedToEmbed,
        // Upstream error strings can contain provider detail, so they are
        // summarized rather than passed through verbatim.
        errors: errors.length
          ? ["Some documents could not be processed. Check the server logs."]
          : [],
      });
    })
  );

  /** Re-runs ingestion for a document that failed or has gone stale. */
  router.post(
    "/knowledge/:docId/reingest",
    [requireCapability("knowledge:manage")],
    safeHandler(async (request, response) => {
      const prisma = require("../../utils/prisma");
      const { Document } = require("../../models/documents");
      const { Workspace } = require("../../models/workspace");

      const doc = await prisma.workspace_documents.findFirst({
        where: { docId: String(request.params.docId) },
      });
      if (!doc) return response.status(404).json({ error: "Document not found." });

      const workspace = await Workspace.get({ id: doc.workspaceId });
      if (!workspace)
        return response.status(404).json({ error: "The document's workspace is missing." });

      // Remove then re-add so the vector store is rebuilt from the source file.
      await Document.removeDocuments(workspace, [doc.docpath], response.locals.user?.id);
      const { failedToEmbed = [] } = await Document.addDocuments(
        workspace,
        [doc.docpath],
        response.locals.user?.id ?? null
      );

      await AuditLog.fromRequest(request, response, {
        action: "document.reingested",
        category: AuditLog.CATEGORIES.KNOWLEDGE,
        resource: "document",
        resourceId: doc.docId,
        metadata: { filename: doc.filename, succeeded: failedToEmbed.length === 0 },
      });

      response.status(200).json({
        success: failedToEmbed.length === 0,
        error: failedToEmbed.length ? "The document could not be re-processed." : null,
      });
    })
  );
}

module.exports = { knowledgeRoutes };
