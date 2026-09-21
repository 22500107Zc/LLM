/**
 * Centralized brand configuration for the customer-facing application.
 *
 * Values come from the server's /api/platform/branding endpoint (which reads
 * the deployment's environment variables) with build-time Vite variables as a
 * fallback so the login screen renders correctly before the first fetch.
 *
 * Nothing customer-specific is hardcoded anywhere else in the frontend.
 */

const FALLBACK = Object.freeze({
  branding: {
    appName: import.meta.env.VITE_APP_NAME || "Business AI Platform",
    companyName: import.meta.env.VITE_COMPANY_NAME || "Business AI Platform",
    legalCompanyName: import.meta.env.VITE_LEGAL_COMPANY_NAME || "",
    appLogo: import.meta.env.VITE_APP_LOGO || "",
    appIcon: import.meta.env.VITE_APP_ICON || "",
    primaryDomain: import.meta.env.VITE_PRIMARY_DOMAIN || "",
    supportEmail: import.meta.env.VITE_SUPPORT_EMAIL || "",
    primaryColor: import.meta.env.VITE_PRIMARY_COLOR || "#2563eb",
    tagline: "Your company's private AI operations platform",
    poweredByNotice: "",
  },
  customer: { name: "", domain: "", logo: "" },
  plan: {
    name: "Managed Business AI Platform",
    displayPrice: "$3,888.88",
    displayPriceWithInterval: "$3,888.88/month",
    interval: "month",
    currency: "usd",
  },
  limits: { maxUsers: 50, maxPublicAgents: 3, storageLimitGb: 25 },
  version: "",
});

let cache = null;
let inflight = null;
const listeners = new Set();

/** Synchronous access for render paths. Returns the fallback until loaded. */
export function brand() {
  return cache ?? FALLBACK;
}

/** Fetches (once) and caches the deployment's brand configuration. */
export async function loadBrand() {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = fetch("/api/platform/branding")
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      cache = data
        ? {
            ...FALLBACK,
            ...data,
            branding: { ...FALLBACK.branding, ...(data.branding ?? {}) },
            customer: { ...FALLBACK.customer, ...(data.customer ?? {}) },
            plan: { ...FALLBACK.plan, ...(data.plan ?? {}) },
            limits: { ...FALLBACK.limits, ...(data.limits ?? {}) },
          }
        : FALLBACK;
      listeners.forEach((listener) => listener(cache));
      return cache;
    })
    .catch(() => {
      // A branding fetch failure must never block the application.
      cache = FALLBACK;
      return cache;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function onBrandChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The name shown in page titles, headings and the browser tab. */
export function appName() {
  return brand().branding.appName;
}

/** The business this deployment belongs to, falling back to the brand name. */
export function companyName() {
  const { customer, branding } = brand();
  return customer.name || branding.companyName || branding.appName;
}

export function supportEmail() {
  return brand().branding.supportEmail;
}

/** A mailto: link to the deployment's support address, or null when unset. */
export function supportMailto() {
  const email = supportEmail();
  return email ? `mailto:${email}` : null;
}

export function primaryColor() {
  return brand().branding.primaryColor;
}

export function planPrice() {
  return brand().plan.displayPriceWithInterval;
}

export default {
  brand,
  loadBrand,
  onBrandChange,
  appName,
  companyName,
  supportEmail,
  supportMailto,
  primaryColor,
  planPrice,
};
