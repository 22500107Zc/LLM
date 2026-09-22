/**
 * What a customer is allowed to be told when something breaks.
 *
 * A paying business using this product is not an operator of it. They did not
 * choose the model provider, they do not know what a vector store is, and a
 * message like "No OpenAI API key was set" tells them nothing they can act on
 * while telling them something about our infrastructure they should not have
 * to think about.
 *
 * So: the real error goes to the server log, where it is actually useful, and
 * the customer gets a sentence in their own language that says what happened
 * and what to do. Nothing here invents an answer to their question - a failure
 * is reported as a failure.
 */

/**
 * Patterns that identify a class of failure, and the sentence for it.
 *
 * Ordered - the first match wins. `test` sees the lowercased message.
 */
const TRANSLATIONS = [
  {
    test: (m) =>
      /api key|apikey|no .* key was set|unauthorized|401|invalid_api_key|authentication/.test(
        m
      ),
    say: "The AI assistant is not available right now. This is on our side, not yours - support has been notified.",
  },
  {
    test: (m) => /rate limit|429|quota|insufficient_quota|billing/.test(m),
    say: "The AI assistant is busy right now. Please try that again in a moment.",
  },
  {
    test: (m) =>
      /timeout|timed out|etimedout|econnreset|socket hang up/.test(m),
    say: "That request took too long to come back. Please try again.",
  },
  {
    test: (m) =>
      /cannot find module|econnrefused|enotfound|getaddrinfo/.test(m),
    say: "The AI assistant is not available right now. This is on our side, not yours - support has been notified.",
  },
  {
    test: (m) => /context length|maximum context|too many tokens/.test(m),
    say: "That message is too long for the assistant to read in one go. Try sending a shorter version.",
  },
];

const FALLBACK =
  "Something went wrong answering that. Please try again - if it keeps happening, contact support.";

/**
 * Translate an error into something a customer should see.
 *
 * @param {Error|string} error the real failure
 * @param {string} [context] where it happened, for the server log only
 * @returns {string} a sentence safe to show a customer
 */
function customerFacingMessage(error, context = "chat") {
  const raw = String(error?.message ?? error ?? "");
  console.error(`[customer-facing] ${context}:`, raw);

  const message = raw.toLowerCase();
  const match = TRANSLATIONS.find((translation) => translation.test(message));
  return match ? match.say : FALLBACK;
}

module.exports = { customerFacingMessage, FALLBACK };
