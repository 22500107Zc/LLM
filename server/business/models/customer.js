const prisma = require("../../utils/prisma");
const { User } = require("../../models/user");
const { Workspace } = require("../../models/workspace");

/**
 * Customers the founder created and authorized.
 *
 * WHAT A CUSTOMER IS
 *
 * A customer is a business that pays for the product, represented by one
 * ordinary `users` row plus a `business_customers` row holding the business
 * information. It is NOT a deployment, a container, a website or a tenant
 * database. There is one application and the founder decides who is in it.
 *
 * WHERE THE CREDENTIALS LIVE
 *
 * On the `users` row, through the inherited `User` model - the same store the
 * login endpoint reads. Nothing here hashes a password itself or writes to
 * `users.password` directly: a second credential path is how one of them ends
 * up weaker than the other.
 *
 * WHERE ACCESS STATE LIVES
 *
 * `users.suspended`, and nowhere else. Request validation already re-reads the
 * user from the database on every authenticated request and refuses a
 * suspended one, so disabling a customer takes effect immediately - their
 * existing session stops working, not just their next login.
 *
 * WHAT IS NOT HERE
 *
 * Stripe. Payment happens outside the application: the founder sends a hosted
 * Payment Link by email, confirms the money arrived, and then creates the
 * account. `paymentNote` is the founder's own record of that and no code reads
 * it to decide anything.
 */

const ACCESS = Object.freeze({ ACTIVE: "active", DISABLED: "disabled" });

/** Customers sign in with an email address, always lowercased. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return "A login email address is required.";
  if (email.length > 64)
    return "That email address is too long for a login (max 64 characters).";
  if (!EMAIL_PATTERN.test(email)) return "That is not a valid email address.";
  // The inherited user model owns the final say on what a username may be, so
  // ask it rather than keeping a second opinion here.
  try {
    User.validations.username(email);
  } catch (error) {
    return error.message;
  }
  return null;
}

function validateBusinessName(value) {
  const name = String(value ?? "").trim();
  if (!name) return "A business name is required.";
  if (name.length > 120) return "Business name is too long (max 120).";
  return null;
}

/** What the founder console is allowed to see about a customer. */
function present(record) {
  if (!record) return null;
  const user = record.user ?? {};
  return {
    id: record.id,
    userId: record.user_id,
    businessName: record.business_name,
    contactName: record.contact_name ?? null,
    notes: record.notes ?? null,
    paymentNote: record.payment_note ?? null,
    loginEmail: user.username ?? null,
    // Derived from the one flag the product actually enforces.
    access: user.suspended ? ACCESS.DISABLED : ACCESS.ACTIVE,
    lastLoginAt: null,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    // Deliberately absent: password, password hash, recovery codes. The hash
    // is never read out of the database by this model at all.
  };
}

const Customer = {
  ACCESS,
  validateEmail,
  validateBusinessName,
  normalizeEmail,

  /**
   * Creates a founder-authorized customer.
   *
   * The password the founder types is handed straight to the inherited user
   * model, which applies the product's complexity rules and bcrypt-hashes it.
   * The plaintext is never written anywhere.
   */
  create: async function ({
    businessName,
    email,
    password,
    contactName = null,
    notes = null,
    paymentNote = null,
  } = {}) {
    const problems = [
      validateBusinessName(businessName),
      validateEmail(email),
    ].filter(Boolean);
    if (problems.length) return { customer: null, error: problems[0] };

    const loginEmail = normalizeEmail(email);
    const existing = await User._get({ username: loginEmail });
    if (existing)
      return {
        customer: null,
        error: "An account with that login email already exists.",
      };

    // `default` role on purpose. An admin would see every other customer's
    // workspaces and be able to manage users, which is the opposite of what a
    // customer account is for.
    const { user, error } = await User.create({
      username: loginEmail,
      password: String(password ?? ""),
      role: "default",
    });
    if (!user) return { customer: null, error };

    try {
      const record = await prisma.business_customers.create({
        data: {
          user_id: user.id,
          business_name: String(businessName).trim(),
          contact_name: contactName ? String(contactName).trim() : null,
          notes: notes ? String(notes).trim() : null,
          payment_note: paymentNote ? String(paymentNote).trim() : null,
        },
        include: { user: true },
      });

      // Give them somewhere to work on their first login.
      //
      // A customer is `default` role, which cannot create a workspace - by
      // design, since workspace membership is what keeps one customer out of
      // another's data. Without this they would sign in to an empty product
      // and have no way to fix it themselves. `Workspace.new` attaches the
      // creator as a member, so this workspace is theirs and only theirs.
      //
      // A failure here is not fatal: the account is real and they can sign in.
      // The founder can add a workspace afterwards.
      try {
        await Workspace.new(String(businessName).trim(), user.id);
      } catch (error) {
        console.error(
          `[Customer] could not create the initial workspace for ${loginEmail}:`,
          error.message
        );
      }

      return { customer: present(record), error: null };
    } catch (error) {
      // The user row would otherwise be orphaned: a login with no customer
      // behind it, invisible in the console.
      await User.delete({ id: user.id }).catch(() => null);
      return {
        customer: null,
        error: `Could not record the customer: ${error.message}`,
      };
    }
  },

  list: async function () {
    try {
      const records = await prisma.business_customers.findMany({
        include: { user: true },
        orderBy: { id: "desc" },
      });
      return records.map(present);
    } catch (error) {
      console.error("[Customer] list failed:", error.message);
      return [];
    }
  },

  get: async function (id) {
    try {
      const record = await prisma.business_customers.findUnique({
        where: { id: Number(id) },
        include: { user: true },
      });
      return present(record);
    } catch {
      return null;
    }
  },

  /** The raw row plus its user. Internal - callers get `present()` output. */
  _record: async function (id) {
    try {
      return await prisma.business_customers.findUnique({
        where: { id: Number(id) },
        include: { user: true },
      });
    } catch {
      return null;
    }
  },

  /** Business information only. Credentials and access go through their own
   * methods so each one is an explicit, auditable act. */
  update: async function (
    id,
    { businessName, contactName, notes, paymentNote } = {}
  ) {
    const record = await this._record(id);
    if (!record) return { customer: null, error: "No such customer." };

    const data = {};
    if (businessName !== undefined) {
      const problem = validateBusinessName(businessName);
      if (problem) return { customer: null, error: problem };
      data.business_name = String(businessName).trim();
    }
    if (contactName !== undefined)
      data.contact_name = contactName ? String(contactName).trim() : null;
    if (notes !== undefined) data.notes = notes ? String(notes).trim() : null;
    if (paymentNote !== undefined)
      data.payment_note = paymentNote ? String(paymentNote).trim() : null;

    if (!Object.keys(data).length)
      return { customer: present(record), error: null };
    data.lastUpdatedAt = new Date();

    try {
      const updated = await prisma.business_customers.update({
        where: { id: Number(id) },
        data,
        include: { user: true },
      });
      return { customer: present(updated), error: null };
    } catch (error) {
      return { customer: null, error: error.message };
    }
  },

  /** Changes the authorized login email. The old one stops working. */
  setEmail: async function (id, email) {
    const record = await this._record(id);
    if (!record) return { customer: null, error: "No such customer." };

    const problem = validateEmail(email);
    if (problem) return { customer: null, error: problem };

    const loginEmail = normalizeEmail(email);
    if (loginEmail === record.user.username)
      return { customer: present(record), error: null };

    const taken = await User._get({ username: loginEmail });
    if (taken)
      return {
        customer: null,
        error: "An account with that login email already exists.",
      };

    const { error } = await User.update(record.user_id, {
      username: loginEmail,
    });
    if (error) return { customer: null, error };

    return { customer: await this.get(id), error: null };
  },

  /**
   * Sets a new password.
   *
   * There is no "show the current password" counterpart and there cannot be:
   * only a bcrypt hash is stored, and it does not reverse.
   */
  setPassword: async function (id, password) {
    const record = await this._record(id);
    if (!record) return { customer: null, error: "No such customer." };

    const supplied = String(password ?? "");
    if (!supplied) return { customer: null, error: "A password is required." };

    // The inherited model applies the product's complexity rules and hashes.
    const { error } = await User.update(record.user_id, { password: supplied });
    if (error) return { customer: null, error };

    return { customer: await this.get(id), error: null };
  },

  /**
   * Turns application access on or off.
   *
   * Writes `users.suspended`, which request validation checks on every
   * authenticated request - so a disabled customer's existing session stops
   * working immediately rather than lasting until their token expires.
   */
  setAccess: async function (id, access) {
    const record = await this._record(id);
    if (!record) return { customer: null, error: "No such customer." };

    const target = String(access ?? "").toLowerCase();
    if (![ACCESS.ACTIVE, ACCESS.DISABLED].includes(target))
      return { customer: null, error: `Unknown access state "${access}".` };

    const { error } = await User.update(record.user_id, {
      suspended: target === ACCESS.DISABLED ? 1 : 0,
    });
    if (error) return { customer: null, error };

    return { customer: await this.get(id), error: null };
  },

  /**
   * Permanently removes the customer and their login.
   *
   * The `business_customers` row cascades from the user, so deleting the user
   * cannot leave a customer record pointing at nothing.
   */
  remove: async function (id) {
    const record = await this._record(id);
    if (!record) return { success: false, error: "No such customer." };
    try {
      await User.delete({ id: record.user_id });
      return { success: true, removed: present(record) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
};

module.exports = { Customer, ACCESS };
