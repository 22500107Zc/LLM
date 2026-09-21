/**
 * The product name to stamp into files the agent generates.
 *
 * Generated documents leave the building - a customer may send a deck, a
 * report or a spreadsheet to their own clients - so they must carry this
 * deployment's own product name and never an upstream one. Returns an empty
 * string when branding is unavailable, and callers omit the footer entirely
 * rather than falling back to someone else's name.
 */
function deploymentName() {
  try {
    return require("../../../../../business/config").branding.appName || "";
  } catch {
    return "";
  }
}

module.exports = { deploymentName };
