/**
 * Authenticated encryption for customer-supplied credentials.
 *
 * A customer's model-provider key is their property and their bill. It is
 * written to our database, so it is written encrypted, and with a mode that
 * detects tampering rather than one that merely hides the bytes: AES-256-GCM,
 * whose auth tag makes a modified ciphertext fail to decrypt instead of
 * silently producing different plaintext.
 *
 * The key never leaves the server and is never derived from anything a
 * customer controls.
 */

const crypto = require("crypto");

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

/**
 * The master key, from the environment only.
 *
 * `AI_CREDENTIAL_KEY` is the variable to set. When it is absent the key is
 * derived from JWT_SECRET, which every deployment already has and already
 * treats as a secret - so a deployment cannot accidentally end up storing
 * customer credentials in the clear. HKDF with a fixed info string keeps that
 * derived key unrelated to the one signing sessions.
 */
function masterKey() {
  const explicit = String(process.env.AI_CREDENTIAL_KEY ?? "").trim();
  if (explicit.length >= 32)
    return crypto.createHash("sha256").update(explicit).digest();

  const fallback = String(process.env.JWT_SECRET ?? "").trim();
  if (!fallback)
    throw new Error(
      "No key is available to encrypt customer credentials. Set AI_CREDENTIAL_KEY."
    );

  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(fallback, "utf8"),
      Buffer.from("business-ai-connection", "utf8"),
      Buffer.from("customer credential encryption", "utf8"),
      32
    )
  );
}

/** Whether this deployment can store a customer credential at all. */
function available() {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} plaintext the customer's credential
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`, all base64url
 */
function seal(plaintext) {
  const value = String(plaintext ?? "");
  if (!value) throw new Error("Nothing to encrypt.");

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

/**
 * @param {string} sealed a value produced by `seal`
 * @returns {string} the credential
 * @throws if the value was tampered with, truncated, or sealed with another key
 */
function open(sealed) {
  const parts = String(sealed ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION)
    throw new Error("The stored credential is not in a form this can read.");

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const body = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error("The stored credential is malformed.");

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    "utf8"
  );
}

/**
 * What a credential looks like once it is stored: enough to recognise, never
 * enough to use. Short credentials are not partially revealed.
 */
function hint(plaintext) {
  const value = String(plaintext ?? "");
  if (value.length < 12) return "configured";
  return `configured (…${value.slice(-4)})`;
}

module.exports = { seal, open, hint, available, VERSION };
