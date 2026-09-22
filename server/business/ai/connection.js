/**
 * A customer's own connection to the AI service they chose.
 *
 * The product does not own a model credential. Every business that uses it
 * supplies their own, uses their own account, and receives their own bill.
 * This is where that lives.
 *
 * The identity of the customer is always the authenticated user the caller
 * resolved server-side. Nothing here takes a customer id from a request body,
 * because that is how one customer ends up reading another's key.
 */

const prisma = require("../../utils/prisma");
const adapters = require("./adapters");
const secrets = require("./secrets");

/**
 * What a connection looks like to the customer who owns it.
 *
 * The credential is represented by whether it exists and, if it is long
 * enough to be worth recognising, its last four characters. The sealed value
 * never leaves the server.
 */
function present(record) {
  if (!record) return null;
  const adapter = adapters.get(record.provider);
  return {
    provider: record.provider,
    providerLabel: adapter?.label ?? record.provider,
    baseUrl: record.base_url,
    model: record.model,
    embeddingModel: record.embedding_model,
    credential: record.credential ? "configured" : null,
    configured: Boolean(record.provider && record.model),
    lastUpdatedAt: record.lastUpdatedAt,
  };
}

/** @returns {Promise<Object|null>} the raw row, credential still sealed */
async function _record(userId) {
  if (!userId) return null;
  try {
    return await prisma.business_ai_connections.findUnique({
      where: { user_id: Number(userId) },
    });
  } catch (error) {
    console.error("[AIConnection] could not read:", error.message);
    return null;
  }
}

/** What this customer has configured, safe to send to their browser. */
async function forCustomer(userId) {
  return present(await _record(userId));
}

/**
 * Saves or replaces this customer's connection.
 *
 * Leaving the credential out keeps the stored one, which is what makes
 * "change the model but not the key" work without the browser ever holding
 * the key. Sending an empty string clears it.
 *
 * @param {number} userId the AUTHENTICATED user, never a request parameter
 */
async function save(userId, input = {}) {
  if (!userId) return { connection: null, error: "Not signed in." };

  const provider = String(input.provider ?? "").trim();
  const adapter = adapters.get(provider);
  if (!adapter) return { connection: null, error: "Choose an AI service." };

  const model =
    String(input.model ?? "").trim() || adapter.defaultModel || null;
  const baseUrl = String(input.baseUrl ?? "").trim() || null;

  const problem = adapters.validate({ provider, model, baseUrl });
  if (problem) return { connection: null, error: problem };

  const existing = await _record(userId);

  // `undefined` means "leave it alone"; "" means "remove it".
  let credential = existing?.credential ?? null;
  if (input.apiKey !== undefined) {
    const supplied = String(input.apiKey ?? "").trim();
    if (!supplied) credential = null;
    else {
      if (!secrets.available())
        return {
          connection: null,
          error:
            "This deployment cannot store credentials securely yet. Contact support.",
        };
      credential = secrets.seal(supplied);
    }
  }

  if (adapter.requires.includes("apiKey") && !credential)
    return {
      connection: null,
      error: `${adapter.label} needs an API key.`,
    };

  const data = {
    provider,
    base_url: baseUrl,
    model,
    embedding_model: String(input.embeddingModel ?? "").trim() || null,
    credential,
    lastUpdatedAt: new Date(),
  };

  try {
    const record = await prisma.business_ai_connections.upsert({
      where: { user_id: Number(userId) },
      update: data,
      create: { ...data, user_id: Number(userId) },
    });
    return { connection: present(record), error: null };
  } catch (error) {
    console.error("[AIConnection] could not save:", error.message);
    return {
      connection: null,
      error: "Could not save that. Please try again.",
    };
  }
}

/** Removes this customer's connection. Their account is untouched. */
async function remove(userId) {
  if (!userId) return { error: "Not signed in." };
  try {
    await prisma.business_ai_connections.deleteMany({
      where: { user_id: Number(userId) },
    });
    return { error: null };
  } catch (error) {
    console.error("[AIConnection] could not remove:", error.message);
    return { error: "Could not remove that. Please try again." };
  }
}

/**
 * Builds the provider connector for an authenticated customer.
 *
 * Returns null when they have not configured one - that is an ordinary,
 * expected state for a customer who has just been created, not a failure.
 *
 * @param {Object|null} user the authenticated user
 * @returns {Promise<Object|null>}
 */
async function connectorFor(user) {
  const record = await _record(user?.id);
  if (!record || !record.provider) return null;

  let apiKey = null;
  if (record.credential) {
    try {
      apiKey = secrets.open(record.credential);
    } catch (error) {
      console.error(
        `[AIConnection] the stored credential for user ${user?.id} could not be opened:`,
        error.message
      );
      throw new Error(
        "Your saved AI credential could not be read. Enter it again in AI Connection settings."
      );
    }
  }

  return adapters.build({
    provider: record.provider,
    apiKey,
    baseUrl: record.base_url,
    model: record.model,
  });
}

/** Whether this customer has something to chat with. */
async function isConfigured(user) {
  const record = await _record(user?.id);
  return Boolean(record?.provider);
}

module.exports = {
  present,
  _record,
  forCustomer,
  save,
  remove,
  connectorFor,
  isConfigured,
};
