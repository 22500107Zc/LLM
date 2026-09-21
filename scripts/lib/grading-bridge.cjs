/**
 * Re-exports the server's grading and refusal detection to the test scripts,
 * resolved from the repository root rather than any absolute path, so the
 * scripts grade answers with exactly the logic the product uses.
 */
const { serverRequire } = require("./harness.cjs");

module.exports = {
  ...serverRequire("business/services/aiQuality"),
  ...serverRequire("business/services/knowledgeGaps"),
};
