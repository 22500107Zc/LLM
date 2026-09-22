/**
 * The provider adapters a customer can point their account at.
 *
 * This deliberately does NOT reimplement any integration. AnythingLLM already
 * has a class per provider that knows that provider's authentication,
 * endpoints, request shape, streaming protocol and response format. This
 * registry says which of those are offered, what a customer has to supply for
 * each, and how to hand one a customer's own credential instead of the
 * server's.
 *
 * HOW A CUSTOMER'S CREDENTIAL REACHES THE PROVIDER CLASS
 *
 * Those classes read `process.env` in their constructors. Writing a
 * customer's key into the process environment for the length of a request
 * would be a real isolation bug - two customers chatting at the same moment
 * could cross credentials.
 *
 * So `build()` sets the variables, constructs, and restores them inside ONE
 * synchronous block. Every provider constructor is synchronous, and a
 * synchronous block cannot be interleaved with another request on Node's
 * single thread, so no other request can observe the substituted values. By
 * the time the block ends the credential lives only on the returned instance,
 * which belongs to this request alone. `assert-synchronous-build.test.js`
 * fails if a constructor ever stops being synchronous.
 *
 * Adding a provider is one entry here. Nothing else changes.
 */

const { NativeEmbedder } = require("../../utils/EmbeddingEngines/native");

/**
 * @typedef {Object} Adapter
 * @property {string} label what a customer sees
 * @property {string[]} requires fields the customer must supply
 * @property {string[]} optional fields they may supply
 * @property {string} [help] one line of guidance for the form
 * @property {(input: Object) => Object} env the variables the class reads
 * @property {string} [defaultModel]
 */

/** @type {Record<string, Adapter>} */
const ADAPTERS = {
  "openai-compatible": {
    label: "OpenAI-compatible endpoint",
    requires: ["baseUrl", "model"],
    optional: ["apiKey"],
    help: "Any service that exposes an OpenAI-compatible HTTP API — self-hosted, a gateway, or a hosted provider.",
    env: ({ apiKey, baseUrl, model }) => ({
      LLM_PROVIDER: "generic-openai",
      GENERIC_OPEN_AI_BASE_PATH: baseUrl,
      GENERIC_OPEN_AI_API_KEY: apiKey ?? "",
      GENERIC_OPEN_AI_MODEL_PREF: model,
      GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT:
        process.env.GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT || "128000",
    }),
  },

  openai: {
    label: "OpenAI",
    requires: ["apiKey"],
    optional: ["model"],
    defaultModel: "gpt-4.1-mini",
    env: ({ apiKey, model }) => ({
      LLM_PROVIDER: "openai",
      OPEN_AI_KEY: apiKey,
      OPEN_MODEL_PREF: model,
    }),
  },

  anthropic: {
    label: "Anthropic",
    requires: ["apiKey"],
    optional: ["model"],
    defaultModel: "claude-sonnet-4-6",
    env: ({ apiKey, model }) => ({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL_PREF: model,
    }),
  },

  gemini: {
    label: "Google Gemini",
    requires: ["apiKey"],
    optional: ["model"],
    defaultModel: "gemini-2.0-flash-lite",
    env: ({ apiKey, model }) => ({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: apiKey,
      GEMINI_LLM_MODEL_PREF: model,
    }),
  },

  groq: {
    label: "Groq",
    requires: ["apiKey"],
    optional: ["model"],
    defaultModel: "llama-3.1-8b-instant",
    env: ({ apiKey, model }) => ({
      LLM_PROVIDER: "groq",
      GROQ_API_KEY: apiKey,
      GROQ_MODEL_PREF: model,
    }),
  },

  openrouter: {
    label: "OpenRouter",
    requires: ["apiKey"],
    optional: ["model"],
    defaultModel: "openrouter/auto",
    env: ({ apiKey, model }) => ({
      LLM_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: apiKey,
      OPENROUTER_MODEL_PREF: model,
    }),
  },
};

const types = () => Object.keys(ADAPTERS);
const get = (type) => ADAPTERS[String(type ?? "")] ?? null;

/**
 * What the customer's settings form should show. No credential ever appears
 * here - these are field names, not values.
 */
function describe() {
  return types().map((type) => ({
    type,
    label: ADAPTERS[type].label,
    requires: ADAPTERS[type].requires,
    optional: ADAPTERS[type].optional,
    help: ADAPTERS[type].help ?? null,
    defaultModel: ADAPTERS[type].defaultModel ?? null,
  }));
}

/**
 * Builds the provider class for one customer's connection.
 *
 * Read the note at the top of this file before changing anything here.
 *
 * @param {{provider: string, apiKey?: string, baseUrl?: string, model?: string}} connection
 * @returns {Object} a connector bound to this customer's credential
 */
function build(connection) {
  const adapter = get(connection?.provider);
  if (!adapter)
    throw new Error(`Unknown AI connection type: ${connection?.provider}`);

  const values = adapter.env({
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    model: connection.model || adapter.defaultModel,
  });

  // --- synchronous from here ---------------------------------------------
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === "")
        delete process.env[key];
      else process.env[key] = String(value);
    }

    const { getLLMProvider } = require("../../utils/helpers");
    const connector = getLLMProvider({
      provider: values.LLM_PROVIDER,
      model: values.GENERIC_OPEN_AI_MODEL_PREF ?? connection.model ?? null,
    });

    // The customer did not choose an embedder and may have no embedding
    // service at all. Retrieval degrades; conversation does not.
    if (!connector.embedder) connector.embedder = new NativeEmbedder();
    return connector;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // --- synchronous to here -----------------------------------------------
}

/**
 * Checks a customer's input before it is stored.
 * @returns {string|null} what is wrong, in words they can act on
 */
function validate(input) {
  const adapter = get(input?.provider);
  if (!adapter) return "Choose an AI service.";

  for (const field of adapter.requires) {
    if (field === "apiKey") continue; // handled by the caller: it may be kept
    if (!String(input?.[field] ?? "").trim())
      return `${field === "baseUrl" ? "A base URL" : "A model name"} is required for ${adapter.label}.`;
  }

  const baseUrl = String(input?.baseUrl ?? "").trim();
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return "The base URL is not a valid address.";
    }
    if (!["http:", "https:"].includes(parsed.protocol))
      return "The base URL must start with http:// or https://.";
  }

  return null;
}

module.exports = { ADAPTERS, types, get, describe, build, validate };
