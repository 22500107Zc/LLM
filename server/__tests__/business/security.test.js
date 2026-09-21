/**
 * Security properties the commercial platform must hold.
 * Each test here corresponds to a way a paying customer could be harmed.
 */

describe("outbound webhook SSRF protection", () => {
  const { isBlockedAddress, assertSafeDestination } = require("../../business/services/outboundWebhook");

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback range"],
    ["10.0.0.5", "RFC1918 /8"],
    ["172.16.0.1", "RFC1918 /12"],
    ["172.31.255.254", "RFC1918 /12 upper"],
    ["192.168.1.1", "RFC1918 /16"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.1.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["203.0.113.10"], ["2606:4700:4700::1111"]])(
    "allows public address %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    }
  );

  it("rejects a non-http protocol", async () => {
    const result = await assertSafeDestination("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects a literal metadata IP destination", async () => {
    const result = await assertSafeDestination("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/restricted network/i);
  });

  it("rejects localhost by name", async () => {
    const result = await assertSafeDestination("http://localhost:8080/hook");
    expect(result.ok).toBe(false);
  });

  it("rejects a .internal hostname", async () => {
    const result = await assertSafeDestination("https://vault.internal/secret");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed URL", async () => {
    const result = await assertSafeDestination("not a url");
    expect(result.ok).toBe(false);
  });
});

describe("audit log redaction", () => {
  const { AuditLog } = require("../../business/models/audit");

  it.each([
    "password",
    "passwd",
    "api_key",
    "apiKey",
    "API-KEY",
    "secret",
    "clientSecret",
    "authorization",
    "token",
    "refresh_token",
    "bearer",
    "credential",
    "privateKey",
    "cardNumber",
    "cvv",
    "cvc",
    "ssn",
    "signature",
  ])("redacts a field named %s", (key) => {
    const output = AuditLog._sanitize({ [key]: "super-secret-value" });
    expect(output[key]).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain("super-secret-value");
  });

  it("redacts secrets nested inside objects and arrays", () => {
    const output = AuditLog._sanitize({
      outer: { inner: { stripeSecretKey: "sk_live_realkey" } },
      list: [{ password: "hunter2" }],
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("sk_live_realkey");
    expect(serialized).not.toContain("hunter2");
  });

  it.each([
    "username",
    "company",
    "companyName",
    "first_name",
    "last_name",
    "email",
    "phone",
    "job_title",
    "reason",
    "author",
    "status",
    "notes",
    "provider",
    "filename",
  ])("keeps the ordinary business field %s intact", (key) => {
    // Regression guard: short patterns like "pan" and "auth" must not match as
    // substrings, or real business data would be destroyed in the audit trail.
    const output = AuditLog._sanitize({ [key]: "Acme" });
    expect(output[key]).toBe("Acme");
  });

  it("truncates long values so document contents cannot leak", () => {
    const output = AuditLog._sanitize({ note: "x".repeat(5000) });
    expect(output.note.length).toBeLessThan(600);
    expect(output.note).toMatch(/truncated/);
  });

  it("does not recurse without bound", () => {
    let deep = { value: "leaf" };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => AuditLog._sanitize(deep)).not.toThrow();
  });
});

describe("CSV export injection defence", () => {
  const { Lead } = require("../../business/models/lead");

  it.each(["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(A1)"])(
    "neutralises the formula payload %s",
    (payload) => {
      const csv = Lead.toCSV([
        { uuid: "u", createdAt: new Date(), status: "new", first_name: payload },
      ]);
      expect(csv).toContain(`"'${payload}"`);
    }
  );

  it("escapes embedded quotes correctly", () => {
    const csv = Lead.toCSV([
      { uuid: "u", createdAt: new Date(), status: "new", reason: 'He said "hi"' },
    ]);
    expect(csv).toContain('"He said ""hi"""');
  });
});

describe("production authentication enforcement", () => {
  const {
    isBootstrapPath,
  } = require("../../business/middleware/requireAuthenticatedMode");

  it.each([
    "/business/dashboard",
    "/business/billing/summary",
    "/workspaces",
    "/admin/users",
    "/system/settings",
    "/document/upload",
  ])("does not treat %s as a bootstrap path", (path) => {
    expect(isBootstrapPath(path)).toBe(false);
  });

  it.each([
    "/ping",
    "/setup-complete",
    "/system/enable-multi-user",
    "/platform/branding",
    "/platform/health/probe",
    "/embed/abc/stream-chat",
    "/invite/some-code",
  ])("keeps %s reachable for bootstrap", (path) => {
    expect(isBootstrapPath(path)).toBe(true);
  });
});

describe("authenticated-mode guard cache", () => {
  /**
   * Regression: a cached "multi-user mode is off" kept blocking every request
   * after an operator finished setup, so a freshly provisioned deployment
   * looked broken for the first seconds of its life. Only a positive result
   * may be cached.
   */
  const request = { path: "/workspaces", method: "GET" };

  function response() {
    return {
      code: null,
      status(value) {
        this.code = value;
        return this;
      },
      json() {
        return this;
      },
      sendStatus(value) {
        this.code = value;
        return this;
      },
    };
  }

  let previousEnv;
  let previousToken;

  beforeEach(() => {
    previousEnv = process.env.NODE_ENV;
    previousToken = process.env.AUTH_TOKEN;
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_TOKEN;
    jest.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
    if (previousToken !== undefined) process.env.AUTH_TOKEN = previousToken;
    else delete process.env.AUTH_TOKEN;
    jest.resetModules();
  });

  it("opens as soon as multi-user mode is enabled, with no stale-negative delay", async () => {
    let mode = false;
    jest.doMock("../../models/systemSettings", () => ({
      SystemSettings: { isMultiUserMode: async () => mode },
    }));
    const {
      requireAuthenticatedMode,
    } = require("../../business/middleware/requireAuthenticatedMode");

    const blocked = response();
    let passedWhileOff = false;
    await requireAuthenticatedMode(request, blocked, () => {
      passedWhileOff = true;
    });
    expect(passedWhileOff).toBe(false);
    expect(blocked.code).toBe(401);

    // No wait: the very next request after setup must be allowed through.
    mode = true;
    const allowed = response();
    let passedAfterSetup = false;
    await requireAuthenticatedMode(request, allowed, () => {
      passedAfterSetup = true;
    });
    expect(passedAfterSetup).toBe(true);
  });

  it("caches the positive result so the lookup is not repeated per request", async () => {
    let reads = 0;
    jest.doMock("../../models/systemSettings", () => ({
      SystemSettings: {
        isMultiUserMode: async () => {
          reads += 1;
          return true;
        },
      },
    }));
    const {
      requireAuthenticatedMode,
    } = require("../../business/middleware/requireAuthenticatedMode");

    for (let i = 0; i < 5; i += 1)
      await requireAuthenticatedMode(request, response(), () => {});

    expect(reads).toBe(1);
  });
});

describe("boot posture checks", () => {
  const { evaluatePosture, isWeakSecret } = require("../../business/boot");

  it.each(["", "secret", "changeme", "password", "short", "my-random-string-for-seeding"])(
    "rejects the weak secret %p",
    (value) => {
      expect(isWeakSecret(value)).toBe(true);
    }
  );

  it("accepts a strong random secret", () => {
    expect(isWeakSecret(require("crypto").randomBytes(32).toString("hex"))).toBe(false);
  });

  it("refuses a production boot with weak auth secrets", () => {
    const { errors } = evaluatePosture({
      NODE_ENV: "production",
      JWT_SECRET: "secret",
      SIG_KEY: "salt",
      SIG_SALT: "salt",
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.join(" ")).toMatch(/JWT_SECRET/);
  });

  it("passes a correctly configured production deployment", () => {
    const strong = () => require("crypto").randomBytes(32).toString("hex");
    const { errors } = evaluatePosture({
      NODE_ENV: "production",
      JWT_SECRET: strong(),
      SIG_KEY: strong(),
      SIG_SALT: strong(),
    });
    expect(errors).toHaveLength(0);
  });
});

describe("business role mapping", () => {
  const { Team, BUSINESS_ROLES } = require("../../business/models/team");

  it("maps each business role onto an upstream role", () => {
    expect(Team.upstreamRoleFor(BUSINESS_ROLES.OWNER)).toBe("admin");
    expect(Team.upstreamRoleFor(BUSINESS_ROLES.ADMINISTRATOR)).toBe("admin");
    expect(Team.upstreamRoleFor(BUSINESS_ROLES.MANAGER)).toBe("manager");
    expect(Team.upstreamRoleFor(BUSINESS_ROLES.MEMBER)).toBe("default");
    expect(Team.upstreamRoleFor(BUSINESS_ROLES.VIEWER)).toBe("default");
  });

  it("reserves billing management for the owner alone", () => {
    expect(Team.can(BUSINESS_ROLES.OWNER, "billing:manage")).toBe(true);
    for (const role of [
      BUSINESS_ROLES.ADMINISTRATOR,
      BUSINESS_ROLES.MANAGER,
      BUSINESS_ROLES.MEMBER,
      BUSINESS_ROLES.VIEWER,
    ])
      expect(Team.can(role, "billing:manage")).toBe(false);
  });

  it("does not let a viewer change anything", () => {
    for (const capability of [
      "agents:manage",
      "knowledge:manage",
      "team:manage",
      "integrations:manage",
      "apikeys:manage",
      "quality:manage",
      "embeds:manage",
    ])
      expect(Team.can(BUSINESS_ROLES.VIEWER, capability)).toBe(false);
  });

  it("does not let a member read the audit log or other people's leads", () => {
    expect(Team.can(BUSINESS_ROLES.MEMBER, "audit:view")).toBe(false);
    expect(Team.can(BUSINESS_ROLES.MEMBER, "leads:view")).toBe(false);
    expect(Team.can(BUSINESS_ROLES.MEMBER, "team:view")).toBe(false);
  });

  it("rejects an unknown capability rather than defaulting to allow", () => {
    expect(Team.can(BUSINESS_ROLES.OWNER, "totally:madeup")).toBe(false);
  });

  it("orders roles by privilege", () => {
    expect(Team.atLeast(BUSINESS_ROLES.OWNER, BUSINESS_ROLES.MANAGER)).toBe(true);
    expect(Team.atLeast(BUSINESS_ROLES.MEMBER, BUSINESS_ROLES.ADMINISTRATOR)).toBe(false);
  });
});

describe("public rate limiting", () => {
  const { createRateLimiter } = require("../../business/middleware");

  function run(limiter, count, ip = "1.2.3.4") {
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < count; i += 1) {
      const response = {
        setHeader() {},
        status() {
          return this;
        },
        json() {
          blocked += 1;
          return this;
        },
      };
      limiter({ ip }, response, () => {
        allowed += 1;
      });
    }
    return { allowed, blocked };
  }

  it("allows up to the limit then blocks", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
    expect(run(limiter, 8)).toEqual({ allowed: 5, blocked: 3 });
  });

  it("tracks callers independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    run(limiter, 2, "1.1.1.1");
    expect(run(limiter, 2, "2.2.2.2").allowed).toBe(2);
  });
});
