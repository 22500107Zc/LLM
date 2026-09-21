import { API_BASE } from "./constants";
import { supportEmail as brandSupportEmail } from "@/business/brand";

/**
 * Check if a href matches the current pathname.
 * Matches exactly or as a parent path (e.g. /settings/model-routers matches /settings/model-routers/1).
 */
export function isPathMatch(href, pathname) {
  return pathname === href || pathname.startsWith(href + "/");
}

function applyOptions(path, options = {}) {
  let updatedPath = path;
  if (!options || Object.keys(options).length === 0) return updatedPath;

  if (options.search) {
    const searchParams = new URLSearchParams(options.search);
    updatedPath += `?${searchParams.toString()}`;
  }
  return updatedPath;
}

const paths = {
  home: () => {
    return "/";
  },
  login: (noTry = false) => {
    return `/login${noTry ? "?nt=1" : ""}`;
  },
  sso: {
    login: () => {
      return "/sso/simple";
    },
  },
  onboarding: {
    home: () => {
      return "/onboarding";
    },
    llmPreference: () => {
      return "/onboarding/llm-preference";
    },
    embeddingPreference: () => {
      return "/onboarding/embedding-preference";
    },
    vectorDatabase: () => {
      return "/onboarding/vector-database";
    },
    userSetup: () => {
      return "/onboarding/user-setup";
    },
    dataHandling: () => {
      return "/onboarding/data-handling";
    },
  },
  /**
   * Upstream community and marketing destinations are not shown to business
   * customers. These helpers are retained so upstream components that import
   * them keep working, but they resolve to the deployment's own support
   * channel instead of upstream properties.
   *
   * Required third-party licence and attribution notices are preserved in the
   * repository (LICENSE, NOTICE) - this only removes marketing surfaces.
   */
  support: () => {
    const email = brandSupportEmail();
    return email ? `mailto:${email}` : "#";
  },
  github: () => {
    return paths.support();
  },
  discord: () => {
    return paths.support();
  },
  docs: (_path = "") => {
    return paths.support();
  },
  chatModes: () => {
    return paths.support();
  },
  supportEmail: () => {
    return paths.support();
  },
  hosting: () => {
    return paths.support();
  },
  /** The commercial business portal. */
  business: {
    dashboard: () => "/dashboard",
    agents: () => "/agents",
    websiteAgents: () => "/website-agents",
    knowledge: () => "/knowledge",
    conversations: () => "/conversations",
    leads: () => "/leads",
    analytics: () => "/analytics",
    value: () => "/value",
    knowledgeGaps: () => "/knowledge-gaps",
    quality: () => "/ai-quality",
    team: () => "/team",
    integrations: () => "/integrations",
    auditLog: () => "/audit-log",
    billing: () => "/settings/billing",
  },
  workspace: {
    chat: (slug, options = {}) => {
      return applyOptions(`/workspace/${slug}`, options);
    },
    settings: {
      generalAppearance: (slug) => {
        return `/workspace/${slug}/settings/general-appearance`;
      },
      chatSettings: function (slug, options = {}) {
        return applyOptions(
          `/workspace/${slug}/settings/chat-settings`,
          options
        );
      },
      vectorDatabase: (slug) => {
        return `/workspace/${slug}/settings/vector-database`;
      },
      members: (slug) => {
        return `/workspace/${slug}/settings/members`;
      },
      agentConfig: (slug) => {
        return `/workspace/${slug}/settings/agent-config`;
      },
    },
    thread: (wsSlug, threadSlug) => {
      return `/workspace/${wsSlug}/t/${threadSlug}`;
    },
  },
  apiDocs: () => {
    return `${API_BASE}/docs`;
  },
  settings: {
    users: () => {
      return `/settings/users`;
    },
    invites: () => {
      return `/settings/invites`;
    },
    workspaces: () => {
      return `/settings/workspaces`;
    },
    chats: () => {
      return "/settings/workspace-chats";
    },
    llmPreference: () => {
      return "/settings/llm-preference";
    },
    transcriptionPreference: () => {
      return "/settings/transcription-preference";
    },
    audioPreference: () => {
      return "/settings/audio-preference";
    },
    defaultSystemPrompt: () => {
      return "/settings/default-system-prompt";
    },
    embedder: {
      modelPreference: () => "/settings/embedding-preference",
      chunkingPreference: () => "/settings/text-splitter-preference",
    },
    embeddingPreference: () => {
      return "/settings/embedding-preference";
    },
    imageGenerationPreference: () => {
      return "/settings/image-generation-preference";
    },
    vectorDatabase: () => {
      return "/settings/vector-database";
    },
    security: () => {
      return "/settings/security";
    },
    interface: () => {
      return "/settings/interface";
    },
    branding: () => {
      return "/settings/branding";
    },
    agentSkills: () => {
      return "/settings/agents";
    },
    chat: () => {
      return "/settings/chat";
    },
    apiKeys: () => {
      return "/settings/api-keys";
    },
    modelRouters: () => {
      return "/settings/model-routers";
    },
    modelRouterRules: (id) => {
      return `/settings/model-routers/${id}`;
    },
    systemPromptVariables: () => "/settings/system-prompt-variables",
    logs: () => {
      return "/settings/event-logs";
    },
    privacy: () => {
      return "/settings/privacy";
    },
    embedChatWidgets: () => {
      return `/settings/embed-chat-widgets`;
    },
    browserExtension: () => {
      return `/settings/browser-extension`;
    },
    mobile: () => {
      return `/settings/mobile-connections`;
    },
    experimental: () => {
      return `/settings/beta-features`;
    },
    mobileConnections: () => {
      return `/settings/mobile-connections`;
    },
    telegram: () => {
      return `/settings/external-connections/telegram`;
    },
    scheduledJobs: () => {
      return `/settings/scheduled-jobs`;
    },
    scheduledJobRuns: (jobId) => {
      return `/settings/scheduled-jobs/${jobId}/runs`;
    },
    scheduledJobRunDetail: (jobId, runId) => {
      return `/settings/scheduled-jobs/${jobId}/runs/${runId}`;
    },
  },
  agents: {
    builder: () => {
      return `/settings/agents/builder`;
    },
    editAgent: (uuid) => {
      return `/settings/agents/builder/${uuid}`;
    },
  },
  communityHub: {
    website: () => {
      return import.meta.env.DEV
        ? `http://localhost:5173`
        : `https://hub.anythingllm.com`;
    },
    /**
     * View more items of a given type on the community hub.
     * @param {string} type - The type of items to view more of. Should be kebab-case.
     * @returns {string} The path to view more items of the given type.
     */
    viewMoreOfType: function (type) {
      return `${this.website()}/list/${type}`;
    },
    viewItem: function (type, id) {
      return `${this.website()}/i/${type}/${id}`;
    },
    trending: () => {
      return `/settings/community-hub/trending`;
    },
    authentication: () => {
      return `/settings/community-hub/authentication`;
    },
    importItem: (importItemId) => {
      return `/settings/community-hub/import-item${importItemId ? `?id=${importItemId}` : ""}`;
    },
    profile: function (username) {
      if (username) return `${this.website()}/u/${username}`;
      return `${this.website()}/me`;
    },
    noPrivateItems: () => {
      return paths.docs("/community-hub/faq#no-private-items");
    },
  },

  /**
   * Help links shown to business users resolve to the deployment's own support
   * channel rather than the upstream project's documentation site.
   */
  documentation: {
    mobileIntroduction: () => {
      return paths.support();
    },
    contextWindows: () => {
      return paths.support();
    },
  },

  experimental: {
    liveDocumentSync: {
      manage: () => `/settings/beta-features/live-document-sync/manage`,
    },
  },
};

export default paths;
