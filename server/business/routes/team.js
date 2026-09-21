const { reqBody } = require("../../utils/http");
const { Team } = require("../models/team");
const { AuditLog } = require("../models/audit");
const { requireCapability, safeHandler } = require("../middleware");
const config = require("../config");

/**
 * Team and API-key management.
 *
 * User creation/deletion continues to go through upstream's own admin model so
 * password hashing, validation and workspace linkage stay exactly as upstream
 * maintains them; this layer adds the business role and the audit trail.
 */
function teamRoutes(router) {
  router.get(
    "/team",
    [requireCapability("team:view")],
    safeHandler(async (_request, response) => {
      const [members, owner] = await Promise.all([Team.list(), Team.owner()]);
      response.status(200).json({
        members,
        ownerId: owner?.id ?? null,
        roles: Object.values(Team.BUSINESS_ROLES).map((role) => ({
          key: role,
          description: Team.ROLE_DESCRIPTIONS[role],
        })),
        limits: {
          maxUsers: config.limits.maxUsers,
          used: members.filter((m) => !m.suspended).length,
        },
      });
    })
  );

  router.post(
    "/team/users",
    [requireCapability("team:manage")],
    safeHandler(async (request, response) => {
      const { User } = require("../../models/user");
      const {
        username,
        password,
        role = Team.BUSINESS_ROLES.MEMBER,
        title = null,
      } = reqBody(request);

      if (!username || !password)
        return response
          .status(400)
          .json({ error: "A username and password are required." });
      if (!Team.isValidRole(role))
        return response.status(400).json({ error: "Unknown role." });

      const activeUsers = await Team.activeUserCount();
      if (activeUsers >= config.limits.maxUsers)
        return response.status(400).json({
          error: `This deployment includes ${config.limits.maxUsers} named users and all of them are in use.`,
        });

      const { user, error } = await User.create({
        username,
        password,
        role: Team.upstreamRoleFor(role),
      });
      if (!user) return response.status(400).json({ error });

      await Team.setRole({
        userId: user.id,
        role,
        title,
        actor: response.locals.user,
      });

      await AuditLog.fromRequest(request, response, {
        action: "user.created",
        category: AuditLog.CATEGORIES.USERS,
        resource: "user",
        resourceId: user.id,
        // The password is never passed into the audit metadata.
        metadata: { username: user.username, role },
      });

      response.status(200).json({
        user: { id: user.id, username: user.username, businessRole: role },
      });
    })
  );

  router.post(
    "/team/users/:id/role",
    [requireCapability("team:manage")],
    safeHandler(async (request, response) => {
      const { role, title = null } = reqBody(request);
      const userId = Number(request.params.id);

      // Only an owner may create another owner.
      if (
        role === Team.BUSINESS_ROLES.OWNER &&
        response.locals.businessRole !== Team.BUSINESS_ROLES.OWNER
      )
        return response
          .status(403)
          .json({ error: "Only the owner can transfer ownership." });

      const result =
        role === Team.BUSINESS_ROLES.OWNER
          ? await Team.setOwner({ userId, actor: response.locals.user })
          : await Team.setRole({
              userId,
              role,
              title,
              actor: response.locals.user,
            });

      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/team/users/:id/suspend",
    [requireCapability("team:manage")],
    safeHandler(async (request, response) => {
      const { User } = require("../../models/user");
      const { suspended = true } = reqBody(request);
      const userId = Number(request.params.id);

      const target = await User.get({ id: userId });
      if (!target)
        return response.status(404).json({ error: "User not found." });

      const targetRole = await Team.roleFor(target);
      if (targetRole === Team.BUSINESS_ROLES.OWNER)
        return response
          .status(400)
          .json({ error: "The owner account cannot be suspended." });

      await User.update(userId, { suspended: suspended ? 1 : 0 });
      await AuditLog.fromRequest(request, response, {
        action: suspended ? "user.suspended" : "user.reinstated",
        category: AuditLog.CATEGORIES.USERS,
        resource: "user",
        resourceId: userId,
        metadata: { username: target.username },
      });
      response.status(200).json({ success: true });
    })
  );

  router.delete(
    "/team/users/:id",
    [requireCapability("team:manage")],
    safeHandler(async (request, response) => {
      const { User } = require("../../models/user");
      const prisma = require("../../utils/prisma");
      const userId = Number(request.params.id);

      const target = await User.get({ id: userId });
      if (!target)
        return response.status(404).json({ error: "User not found." });
      if (target.id === response.locals.user?.id)
        return response
          .status(400)
          .json({ error: "You cannot remove your own account." });

      const targetRole = await Team.roleFor(target);
      if (targetRole === Team.BUSINESS_ROLES.OWNER)
        return response.status(400).json({
          error: "Transfer ownership before removing the owner account.",
        });

      await prisma.platform_user_profiles
        .deleteMany({ where: { user_id: userId } })
        .catch(() => null);
      await User.delete({ id: userId });

      await AuditLog.fromRequest(request, response, {
        action: "user.removed",
        category: AuditLog.CATEGORIES.USERS,
        resource: "user",
        resourceId: userId,
        metadata: { username: target.username, role: targetRole },
      });
      response.status(200).json({ success: true });
    })
  );

  /** The caller's own role and capabilities - drives what the UI renders. */
  router.get(
    "/me",
    safeHandler(async (_request, response) => {
      response.status(200).json({
        businessRole: response.locals.businessRole,
        capabilities: response.locals.capabilities,
        username: response.locals.user?.username ?? null,
        userId: response.locals.user?.id ?? null,
      });
    })
  );

  // ------------------------------------------------------------ API keys ----
  router.get(
    "/api-keys",
    [requireCapability("apikeys:manage")],
    safeHandler(async (_request, response) => {
      const prisma = require("../../utils/prisma");
      const keys = await prisma.api_keys.findMany({ orderBy: { id: "desc" } });
      response.status(200).json({
        // The secret is shown exactly once, at creation. Afterwards only a
        // fingerprint is returned so a key cannot be recovered from the UI.
        apiKeys: keys.map((key) => ({
          id: key.id,
          name: key.name ?? null,
          fingerprint: `${String(key.secret).slice(0, 6)}…${String(key.secret).slice(-4)}`,
          createdAt: key.createdAt,
          createdBy: key.createdBy,
        })),
        notice:
          "API keys grant full programmatic access to this deployment. Treat them like passwords and revoke any key that is no longer needed.",
      });
    })
  );

  router.post(
    "/api-keys",
    [requireCapability("apikeys:manage")],
    safeHandler(async (request, response) => {
      const { ApiKey } = require("../../models/apiKeys");
      const { name = null } = reqBody(request);

      const { apiKey, error } = await ApiKey.create(
        response.locals.user?.id ?? null,
        name ? String(name).slice(0, 120) : null
      );
      if (!apiKey) return response.status(400).json({ error });

      await AuditLog.fromRequest(request, response, {
        action: "api_key.created",
        category: AuditLog.CATEGORIES.API_KEYS,
        resource: "api_key",
        resourceId: apiKey.id,
        // The secret itself is deliberately never audited.
        metadata: { name: name ?? null },
      });

      response.status(200).json({
        apiKey: {
          id: apiKey.id,
          name: apiKey.name ?? null,
          secret: apiKey.secret,
        },
        warning:
          "Copy this key now. For your security it will not be shown again.",
      });
    })
  );

  router.delete(
    "/api-keys/:id",
    [requireCapability("apikeys:manage")],
    safeHandler(async (request, response) => {
      const { ApiKey } = require("../../models/apiKeys");
      const id = Number(request.params.id);
      await ApiKey.delete({ id });
      await AuditLog.fromRequest(request, response, {
        action: "api_key.revoked",
        category: AuditLog.CATEGORIES.API_KEYS,
        resource: "api_key",
        resourceId: id,
      });
      response.status(200).json({ success: true });
    })
  );
}

module.exports = { teamRoutes };
