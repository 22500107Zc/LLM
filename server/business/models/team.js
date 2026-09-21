const prisma = require("../../utils/prisma");
const { AuditLog } = require("./audit");

/**
 * The simplified business role model.
 *
 * Upstream AnythingLLM has three roles (admin / manager / default). Rather than
 * rewriting that permission system, the five business-facing roles are layered
 * on top: each maps down onto an upstream role that continues to govern all
 * upstream routes, while the business API additionally enforces the finer
 * distinctions (owner vs administrator, member vs viewer).
 */

const BUSINESS_ROLES = Object.freeze({
  OWNER: "owner",
  ADMINISTRATOR: "administrator",
  MANAGER: "manager",
  MEMBER: "member",
  VIEWER: "viewer",
});

/** business role -> upstream role that backs it. */
const UPSTREAM_ROLE = Object.freeze({
  [BUSINESS_ROLES.OWNER]: "admin",
  [BUSINESS_ROLES.ADMINISTRATOR]: "admin",
  [BUSINESS_ROLES.MANAGER]: "manager",
  [BUSINESS_ROLES.MEMBER]: "default",
  [BUSINESS_ROLES.VIEWER]: "default",
});

/** Ordered most- to least-privileged; used for "at least" comparisons. */
const ROLE_RANK = Object.freeze({
  [BUSINESS_ROLES.OWNER]: 50,
  [BUSINESS_ROLES.ADMINISTRATOR]: 40,
  [BUSINESS_ROLES.MANAGER]: 30,
  [BUSINESS_ROLES.MEMBER]: 20,
  [BUSINESS_ROLES.VIEWER]: 10,
});

const ROLE_DESCRIPTIONS = Object.freeze({
  [BUSINESS_ROLES.OWNER]:
    "Full access including billing, team and every platform setting.",
  [BUSINESS_ROLES.ADMINISTRATOR]:
    "Agents, knowledge, conversations, users, integrations and analytics.",
  [BUSINESS_ROLES.MANAGER]:
    "Operational content: agents, conversations, analytics and limited settings.",
  [BUSINESS_ROLES.MEMBER]: "Can use the AI capabilities assigned to them.",
  [BUSINESS_ROLES.VIEWER]: "Read-only access to what has been shared with them.",
});

/**
 * Capability matrix. The business API checks these rather than scattering role
 * name comparisons through the route handlers.
 */
const CAPABILITIES = Object.freeze({
  "billing:view": [BUSINESS_ROLES.OWNER],
  "billing:manage": [BUSINESS_ROLES.OWNER],
  "team:view": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "team:manage": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "apikeys:manage": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "integrations:view": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "integrations:manage": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "audit:view": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "settings:manage": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "health:view": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "agents:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.MEMBER,
    BUSINESS_ROLES.VIEWER,
  ],
  "agents:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "knowledge:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.MEMBER,
    BUSINESS_ROLES.VIEWER,
  ],
  "knowledge:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "conversations:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.VIEWER,
  ],
  "conversations:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "leads:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.VIEWER,
  ],
  "leads:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "analytics:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.VIEWER,
  ],
  "quality:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
    BUSINESS_ROLES.VIEWER,
  ],
  "quality:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "automations:view": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
  "automations:manage": [BUSINESS_ROLES.OWNER, BUSINESS_ROLES.ADMINISTRATOR],
  "embeds:manage": [
    BUSINESS_ROLES.OWNER,
    BUSINESS_ROLES.ADMINISTRATOR,
    BUSINESS_ROLES.MANAGER,
  ],
});

const Team = {
  BUSINESS_ROLES,
  UPSTREAM_ROLE,
  ROLE_RANK,
  ROLE_DESCRIPTIONS,
  CAPABILITIES,

  isValidRole(role) {
    return Object.values(BUSINESS_ROLES).includes(String(role));
  },

  upstreamRoleFor(businessRole) {
    return UPSTREAM_ROLE[String(businessRole)] ?? "default";
  },

  /**
   * Derives a business role for a user that has no explicit profile yet, from
   * their upstream role. Guarantees every user resolves to something sane.
   */
  inferFromUpstream(upstreamRole) {
    switch (String(upstreamRole)) {
      case "admin":
        return BUSINESS_ROLES.ADMINISTRATOR;
      case "manager":
        return BUSINESS_ROLES.MANAGER;
      default:
        return BUSINESS_ROLES.MEMBER;
    }
  },

  /**
   * Resolves a user's effective business role.
   * @param {{id: number, role: string}|null} user
   * @returns {Promise<string|null>}
   */
  roleFor: async function (user) {
    if (!user?.id) return null;
    try {
      const profile = await prisma.platform_user_profiles.findUnique({
        where: { user_id: Number(user.id) },
      });
      if (profile?.business_role && this.isValidRole(profile.business_role)) {
        // An upstream demotion always wins - a user downgraded to `default` in
        // the upstream admin screens must not keep administrator powers here.
        const backing = this.upstreamRoleFor(profile.business_role);
        if (backing === "admin" && user.role !== "admin")
          return this.inferFromUpstream(user.role);
        if (backing === "manager" && !["admin", "manager"].includes(user.role))
          return this.inferFromUpstream(user.role);
        return profile.business_role;
      }
      return this.inferFromUpstream(user.role);
    } catch (error) {
      console.error("[Team] role lookup failed:", error.message);
      return this.inferFromUpstream(user.role);
    }
  },

  /** @returns {boolean} whether a business role holds a capability. */
  can(businessRole, capability) {
    const allowed = CAPABILITIES[capability];
    if (!allowed) return false;
    return allowed.includes(String(businessRole));
  },

  /** Every capability a role holds - sent to the frontend to drive the UI. */
  capabilitiesFor(businessRole) {
    return Object.entries(CAPABILITIES)
      .filter(([, roles]) => roles.includes(String(businessRole)))
      .map(([capability]) => capability);
  },

  /** True when the role is at least as privileged as `minimum`. */
  atLeast(businessRole, minimum) {
    return (ROLE_RANK[businessRole] ?? 0) >= (ROLE_RANK[minimum] ?? 99);
  },

  /** The single owner of this deployment, if one has been designated. */
  owner: async function () {
    try {
      const profile = await prisma.platform_user_profiles.findFirst({
        where: { business_role: BUSINESS_ROLES.OWNER },
        orderBy: { id: "asc" },
      });
      if (!profile) return null;
      const { User } = require("../../models/user");
      return await User.get({ id: profile.user_id });
    } catch (error) {
      console.error("[Team] owner lookup failed:", error.message);
      return null;
    }
  },

  /**
   * Assigns a business role. Also aligns the upstream role so upstream routes
   * stay consistent with what the business UI promises.
   * @param {{userId: number, role: string, actor?: object|null, title?: string}} params
   */
  setRole: async function ({ userId, role, actor = null, title = null }) {
    if (!this.isValidRole(role))
      return { success: false, error: "Unknown role." };

    const { User } = require("../../models/user");
    const user = await User.get({ id: Number(userId) });
    if (!user) return { success: false, error: "User not found." };

    const previous = await this.roleFor(user);

    try {
      await prisma.platform_user_profiles.upsert({
        where: { user_id: Number(userId) },
        update: {
          business_role: role,
          ...(title !== null ? { title: String(title).slice(0, 120) } : {}),
          lastUpdatedAt: new Date(),
        },
        create: {
          user_id: Number(userId),
          business_role: role,
          title: title ? String(title).slice(0, 120) : null,
        },
      });

      // Keep the upstream role in lockstep so upstream permission checks agree.
      const upstream = this.upstreamRoleFor(role);
      if (user.role !== upstream) await User.update(Number(userId), { role: upstream });

      await AuditLog.log({
        action: "team.role_changed",
        category: AuditLog.CATEGORIES.USERS,
        actor,
        resource: "user",
        resourceId: userId,
        metadata: { username: user.username, from: previous, to: role, upstream },
      });

      return { success: true, role };
    } catch (error) {
      console.error("[Team] setRole failed:", error.message);
      return { success: false, error: "Unable to update the role." };
    }
  },

  /** Designates the deployment owner, demoting any previous owner to admin. */
  setOwner: async function ({ userId, actor = null }) {
    try {
      const existing = await prisma.platform_user_profiles.findMany({
        where: { business_role: BUSINESS_ROLES.OWNER },
      });
      for (const profile of existing) {
        if (profile.user_id === Number(userId)) continue;
        await this.setRole({
          userId: profile.user_id,
          role: BUSINESS_ROLES.ADMINISTRATOR,
          actor,
        });
      }
      return await this.setRole({
        userId,
        role: BUSINESS_ROLES.OWNER,
        actor,
      });
    } catch (error) {
      console.error("[Team] setOwner failed:", error.message);
      return { success: false, error: "Unable to designate the owner." };
    }
  },

  /** All users with their business roles, for the Team page. */
  list: async function () {
    const { User } = require("../../models/user");
    const users = await User.where({}, null, { id: "asc" });
    const profiles = await prisma.platform_user_profiles.findMany();
    const byUser = new Map(profiles.map((p) => [p.user_id, p]));

    return Promise.all(
      users.map(async (user) => {
        const profile = byUser.get(user.id);
        const role =
          profile?.business_role && this.isValidRole(profile.business_role)
            ? await this.roleFor(user)
            : this.inferFromUpstream(user.role);
        return {
          id: user.id,
          username: user.username,
          title: profile?.title ?? null,
          businessRole: role,
          upstreamRole: user.role,
          suspended: Boolean(user.suspended),
          createdAt: user.createdAt,
          lastUpdatedAt: user.lastUpdatedAt,
        };
      })
    );
  },

  /** Count of active (non-suspended) named users, for the seat limit. */
  activeUserCount: async function () {
    try {
      return await prisma.users.count({ where: { suspended: 0 } });
    } catch (error) {
      console.error("[Team] user count failed:", error.message);
      return 0;
    }
  },
};

module.exports = { Team, BUSINESS_ROLES };
