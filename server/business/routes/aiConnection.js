const { reqBody, userFromSession } = require("../../utils/http");
const { safeHandler } = require("../middleware");
const { adapters, connection } = require("../ai");

/**
 * The customer's own AI connection.
 *
 * Every business using this product brings the AI service they chose and pays
 * for their own usage. There is no platform-wide model credential, and no
 * customer can see or use another's.
 *
 * Deliberately NOT behind a business capability: connecting your own AI
 * service is something any signed-in customer does for their own account, not
 * an administrative act. The router this mounts on already requires a valid
 * session, and the owner is taken from that session - never from the request
 * body, which is how one customer would end up reading another's key.
 */
function aiConnectionRoutes(router) {
  /** The services a customer may connect, and what each one needs. */
  router.get(
    "/ai-connection/options",
    safeHandler(async (_request, response) => {
      response.status(200).json({ options: adapters.describe() });
    })
  );

  /** What this customer has configured. Never includes the credential. */
  router.get(
    "/ai-connection",
    safeHandler(async (request, response) => {
      const user = await userFromSession(request, response);
      response.status(200).json({
        connection: await connection.forCustomer(user?.id),
      });
    })
  );

  /**
   * Saves or replaces it.
   *
   * Omitting `apiKey` keeps the stored credential, so changing a model does
   * not require the browser to hold the key again. Sending an empty string
   * removes it.
   */
  router.post(
    "/ai-connection",
    safeHandler(async (request, response) => {
      const user = await userFromSession(request, response);
      if (!user?.id)
        return response.status(401).json({ error: "Not signed in." });

      const body = reqBody(request);
      const { connection: saved, error } = await connection.save(user.id, {
        provider: body.provider,
        baseUrl: body.baseUrl,
        model: body.model,
        embeddingModel: body.embeddingModel,
        ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
      });

      if (error) return response.status(400).json({ error });
      return response.status(200).json({ connection: saved });
    })
  );

  /** Removes it. The customer keeps their account, their workspace and their
   * conversation history - they simply cannot chat until they connect again. */
  router.delete(
    "/ai-connection",
    safeHandler(async (request, response) => {
      const user = await userFromSession(request, response);
      if (!user?.id)
        return response.status(401).json({ error: "Not signed in." });

      const { error } = await connection.remove(user.id);
      if (error) return response.status(400).json({ error });
      return response.status(200).json({ connection: null });
    })
  );

  /** One real call to the customer's own service, so they can see it works. */
  router.post(
    "/ai-connection/test",
    safeHandler(async (request, response) => {
      const user = await userFromSession(request, response);
      if (!user?.id)
        return response.status(401).json({ error: "Not signed in." });

      try {
        const connector = await connection.connectorFor(user);
        if (!connector)
          return response
            .status(200)
            .json({ ok: false, reason: "No AI service is connected yet." });

        const answer = await connector.getChatCompletion(
          [{ role: "user", content: "Reply with exactly: connected." }],
          { temperature: 0 }
        );
        const text = String(
          answer?.textResponse ?? answer?.content ?? answer ?? ""
        ).trim();

        return response
          .status(200)
          .json({ ok: text.length > 0, sample: text.slice(0, 120) });
      } catch (error) {
        console.error(
          `[ai-connection] test failed for user ${user.id}:`,
          error.message
        );
        // Their own service, their own credential - they need the real reason.
        return response
          .status(200)
          .json({
            ok: false,
            reason: String(error.message ?? error).slice(0, 300),
          });
      }
    })
  );
}

module.exports = { aiConnectionRoutes };
