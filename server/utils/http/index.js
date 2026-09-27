process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();
const JWT = require("jsonwebtoken");
const { User } = require("../../models/user");
const { jsonrepair } = require("jsonrepair");
const extract = require("extract-json-from-string");

// Bodies already parsed by rejectUnreadableBody, so reqBody need not parse
// the same string again.
const parsedBodies = new WeakMap();

function reqBody(request) {
  if (typeof request.body !== "string") return request.body;
  if (parsedBodies.has(request)) return parsedBodies.get(request);
  try {
    return JSON.parse(request.body);
  } catch (error) {
    // A body the client sent that is not JSON is the client's mistake, not a
    // server failure. Some runtimes (Vercel among them) hand the raw string
    // through untouched, so this is where it is first parsed - tag it 400 so
    // the error handler answers accordingly instead of logging a 500.
    const badRequest = new Error("The request body is not valid JSON.");
    badRequest.status = 400;
    badRequest.cause = error;
    throw badRequest;
  }
}

/**
 * The text parser hands a text/plain body through as a string, and most routes
 * parse it with reqBody inside their own try/catch - which answers any throw
 * with a bare 500. Reject a body that is not JSON once, up front, so a client's
 * garbage is a 400 on every route. The string itself is left in place for the
 * routes that forward it as-is.
 */
function rejectUnreadableBody(request, response, next) {
  if (typeof request.body !== "string" || request.body.trim() === "")
    return next();
  try {
    parsedBodies.set(request, JSON.parse(request.body));
  } catch {
    return response.status(400).json({
      error: "bad_request",
      message: "That request could not be read. Check that it is valid JSON.",
    });
  }
  return next();
}

function queryParams(request) {
  return request.query;
}

/**
 * Creates a JWT with the given info and expiry
 * @param {object} info - The info to include in the JWT
 * @param {string} expiry - The expiry time for the JWT (default: 30 days)
 * @returns {string} The JWT
 */
function makeJWT(info = {}, expiry = "30d") {
  if (!process.env.JWT_SECRET)
    throw new Error("Cannot create JWT as JWT_SECRET is unset.");
  return JWT.sign(info, process.env.JWT_SECRET, { expiresIn: expiry });
}

/**
 * Gets the user from the session
 * Note: Only valid for multi-user mode
 * as single-user mode with password is not a "user"
 * @param {import("express").Request} request - The request object
 * @param {import("express").Response} response - The response object
 * @returns {Promise<import("@prisma/client").users | null>} The user
 */
async function userFromSession(request, response = null) {
  if (!!response && !!response.locals?.user) {
    return response.locals.user;
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    return null;
  }

  const valid = decodeJWT(token);
  if (!valid || !valid.id) {
    return null;
  }

  const user = await User.get({ id: valid.id });
  return user;
}

function decodeJWT(jwtToken) {
  try {
    return JWT.verify(jwtToken, process.env.JWT_SECRET);
  } catch {}
  return { p: null, id: null, username: null };
}

function multiUserMode(response) {
  return response?.locals?.multiUserMode;
}

function parseAuthHeader(headerValue = null, apiKey = null) {
  if (headerValue === null || apiKey === null) return {};
  if (headerValue === "Authorization")
    return { Authorization: `Bearer ${apiKey}` };
  return { [headerValue]: apiKey };
}

function safeJsonParse(jsonString, fallback = null) {
  if (jsonString === null) return fallback;

  try {
    return JSON.parse(jsonString);
  } catch {}

  if (jsonString?.startsWith("[") || jsonString?.startsWith("{")) {
    try {
      const repairedJson = jsonrepair(jsonString);
      return JSON.parse(repairedJson);
    } catch {}
  }

  try {
    return extract(jsonString)?.[0] || fallback;
  } catch {}

  return fallback;
}

function isValidUrl(urlString = "") {
  try {
    const url = new URL(urlString);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return true;
  } catch {}
  return false;
}

function toValidNumber(number = null, fallback = null) {
  if (isNaN(Number(number))) return fallback;
  return Number(number);
}

/**
 * Decode HTML entities from a string.
 * The DMR response is encoded with HTML entities, so we need to decode them
 * so we can parse the JSON and report the progress percentage.
 * @param {string} str - The string to decode.
 * @returns {string} The decoded string.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

module.exports = {
  reqBody,
  rejectUnreadableBody,
  multiUserMode,
  queryParams,
  makeJWT,
  decodeJWT,
  userFromSession,
  parseAuthHeader,
  safeJsonParse,
  isValidUrl,
  toValidNumber,
  decodeHtmlEntities,
};
