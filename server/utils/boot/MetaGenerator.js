/**
 * @typedef MetaTagDefinition
 * @property {('link'|'meta')} tag - the type of meta tag element
 * @property {{string:string}|null} props - the inner key/values of a meta tag
 * @property {string|null} content - Text content to be injected between tags. If null self-closing.
 */

/**
 * This class serves the default index.html page that is not present when built in production.
 * and therefore this class should not be called when in development mode since it is unused.
 * All this class does is basically emulate SSR for the meta-tag generation of the root index page.
 * Since we are an SPA, we can just render the primary page and the known entrypoints for the index.{js,css}
 * we can always start at the right place and dynamically load in lazy-loaded as we typically normally would
 * and we dont have any of the overhead that would normally come with having the rewrite the whole app in next or something.
 * Lastly, this class is singleton, so once instantiate the same reference is shared for as long as the server is alive.
 * the main function is `.generate()` which will return the index HTML. These settings are stored in the #customConfig
 * static property and will not be reloaded until the page is loaded AND #customConfig is explicitly null. So anytime a setting
 * for meta-props is updated you should get this singleton class and call `.clearConfig` so the next page load will show the new props.
 */
class MetaGenerator {
  name = "MetaGenerator";

  /** @type {MetaGenerator|null} */
  static _instance = null;

  /** @type {MetaTagDefinition[]|null} */
  #customConfig = null;

  /**
   * Commercial platform branding, resolved from the deployment's environment.
   * Falls back to the upstream defaults when the module is unavailable so this
   * class keeps working if the business layer is ever removed.
   */
  #brand() {
    try {
      return require("../../business/config").branding;
    } catch {
      return {
        appName: "AnythingLLM",
        tagline: "",
        primaryDomain: "",
        appIcon: "",
      };
    }
  }

  /** The page title and social description shown to a business's users. */
  #title() {
    const { appName, tagline } = this.#brand();
    return tagline ? `${appName} | ${tagline}` : appName;
  }

  #icon() {
    return this.#brand().appIcon || "/favicon.png";
  }

  get #defaultManifest() {
    const { appName } = this.#brand();
    return {
      name: appName,
      short_name: appName,
      display: "standalone",
      orientation: "portrait",
      start_url: "/",
      icons: [
        {
          src: this.#icon(),
          sizes: "any",
        },
      ],
    };
  }

  constructor() {
    if (MetaGenerator._instance) return MetaGenerator._instance;
    MetaGenerator._instance = this;
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[${this.name}]\x1b[0m ${text}`, ...args);
  }

  #defaultMeta() {
    // Every customer-facing tag is derived from the deployment's own brand.
    // No upstream product name, domain or promotional image is served.
    const title = this.#title();
    const icon = this.#icon();
    const domain = this.#brand().primaryDomain;
    const url = domain
      ? domain.startsWith("http")
        ? domain
        : `https://${domain}`
      : null;

    return [
      {
        tag: "link",
        props: { type: "image/svg+xml", href: icon },
        content: null,
      },
      { tag: "title", props: null, content: title },
      { tag: "meta", props: { name: "title", content: title } },
      { tag: "meta", props: { name: "description", content: title } },

      // A private business deployment should never be indexed or previewed
      // by search engines and social crawlers.
      { tag: "meta", props: { name: "robots", content: "noindex, nofollow" } },

      // <!-- Open Graph -->
      { tag: "meta", props: { property: "og:type", content: "website" } },
      ...(url
        ? [{ tag: "meta", props: { property: "og:url", content: url } }]
        : []),
      { tag: "meta", props: { property: "og:title", content: title } },
      { tag: "meta", props: { property: "og:description", content: title } },

      // <!-- Twitter -->
      { tag: "meta", props: { property: "twitter:card", content: "summary" } },
      ...(url
        ? [{ tag: "meta", props: { property: "twitter:url", content: url } }]
        : []),
      { tag: "meta", props: { property: "twitter:title", content: title } },
      {
        tag: "meta",
        props: { property: "twitter:description", content: title },
      },

      { tag: "link", props: { rel: "icon", href: icon } },
      { tag: "link", props: { rel: "apple-touch-icon", href: icon } },

      // PWA specific tags
      {
        tag: "meta",
        props: { name: "mobile-web-app-capable", content: "yes" },
      },
      {
        tag: "meta",
        props: { name: "apple-mobile-web-app-capable", content: "yes" },
      },
      {
        tag: "meta",
        props: {
          name: "apple-mobile-web-app-status-bar-style",
          content: "black-translucent",
        },
      },
      { tag: "link", props: { rel: "manifest", href: "/manifest.json" } },
    ];
  }

  /**
   * HTML-escapes a value for safe insertion into attribute values or text content.
   * Meta values (e.g. meta_page_title/meta_page_favicon) are operator-controlled but
   * must never be able to break out of the attribute or element context they land in.
   * @param {any} value
   * @returns {string}
   */
  #escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Assembles Meta tags as one large string
   * @param {MetaTagDefinition[]} tagArray
   * @returns {string}
   */
  #assembleMeta() {
    const output = [];
    for (const tag of this.#customConfig) {
      let htmlString;
      htmlString = `<${tag.tag} `;

      if (tag.props !== null) {
        for (const [key, value] of Object.entries(tag.props))
          htmlString += `${this.#escapeHtml(key)}="${this.#escapeHtml(value)}" `;
      }

      if (tag.content) {
        htmlString += `>${this.#escapeHtml(tag.content)}</${tag.tag}>`;
      } else {
        htmlString += `>`;
      }
      output.push(htmlString);
    }
    return output.join("\n");
  }

  #validUrl(faviconUrl = null) {
    if (faviconUrl === null) return "/favicon.png";
    try {
      const url = new URL(faviconUrl);
      return url.toString();
    } catch {
      return "/favicon.png";
    }
  }

  async #fetchConfg() {
    this.#log(`fetching custom meta tag settings...`);
    const { SystemSettings } = require("../../models/systemSettings");
    const customTitle = await SystemSettings.getValueOrFallback(
      { label: "meta_page_title" },
      null
    );
    const faviconURL = await SystemSettings.getValueOrFallback(
      { label: "meta_page_favicon" },
      null
    );

    // If nothing defined - assume defaults.
    if (customTitle === null && faviconURL === null) {
      this.#customConfig = this.#defaultMeta();
    } else {
      // When custom settings exist, include all default meta tags but override specific ones
      this.#customConfig = this.#defaultMeta().map((tag) => {
        // Override favicon link
        if (tag.tag === "link" && tag.props?.rel === "icon") {
          return {
            tag: "link",
            props: { rel: "icon", href: this.#validUrl(faviconURL) },
          };
        }
        // Override page title
        if (tag.tag === "title") {
          return {
            tag: "title",
            props: null,
            content: customTitle ?? this.#title(),
          };
        }
        // Override meta title
        if (tag.tag === "meta" && tag.props?.name === "title") {
          return {
            tag: "meta",
            props: {
              name: "title",
              content: customTitle ?? this.#title(),
            },
          };
        }
        // Override og:title
        if (tag.tag === "meta" && tag.props?.property === "og:title") {
          return {
            tag: "meta",
            props: {
              property: "og:title",
              content: customTitle ?? this.#title(),
            },
          };
        }
        // Override twitter:title
        if (tag.tag === "meta" && tag.props?.property === "twitter:title") {
          return {
            tag: "meta",
            props: {
              property: "twitter:title",
              content: customTitle ?? this.#title(),
            },
          };
        }
        // Override apple-touch-icon if custom favicon is set
        if (
          tag.tag === "link" &&
          tag.props?.rel === "apple-touch-icon" &&
          faviconURL
        ) {
          return {
            tag: "link",
            props: {
              rel: "apple-touch-icon",
              href: this.#validUrl(faviconURL),
            },
          };
        }
        // Return original tag for everything else (including PWA tags)
        return tag;
      });
    }

    return this.#customConfig;
  }

  /**
   * Clears the current config so it can be refetched on the server for next render.
   */
  clearConfig() {
    this.#customConfig = null;
  }

  /**
   *
   * @param {import('express').Response} response
   * @param {number} code
   */
  async generate(response, code = 200) {
    if (this.#customConfig === null) await this.#fetchConfg();
    response.status(code).send(`
       <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            ${this.#assembleMeta()}
            <script type="module" crossorigin src="/index.js"></script>
            <link rel="stylesheet" href="/index.css">
          </head>
          <body>
            <div id="root" class="h-screen"></div>
          </body>
        </html>`);
  }

  /**
   * Generates the manifest.json file for the PWA application on the fly.
   * @param {import('express').Response} response
   * @param {number} code
   */
  async generateManifest(response) {
    try {
      const { SystemSettings } = require("../../models/systemSettings");
      const manifestName = await SystemSettings.getValueOrFallback(
        { label: "meta_page_title" },
        this.#brand().appName
      );
      const faviconURL = await SystemSettings.getValueOrFallback(
        { label: "meta_page_favicon" },
        null
      );

      let iconUrl = "/favicon.png";
      if (faviconURL) {
        try {
          new URL(faviconURL);
          iconUrl = faviconURL;
        } catch {
          iconUrl = "/favicon.png";
        }
      }

      const manifest = {
        name: manifestName,
        short_name: manifestName,
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          {
            src: iconUrl,
            sizes: "any",
          },
        ],
      };

      response.type("application/json").status(200).send(manifest).end();
    } catch (error) {
      this.#log(`error generating manifest: ${error.message}`, error);
      response
        .type("application/json")
        .status(200)
        .send(this.#defaultManifest)
        .end();
    }
  }
}

module.exports.MetaGenerator = MetaGenerator;
