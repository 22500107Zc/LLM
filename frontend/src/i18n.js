import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { defaultNS, resources } from "./locales/resources";
import { appName, onBrandChange } from "./business/brand";

i18next
  // https://github.com/i18next/i18next-browser-languageDetector/blob/9efebe6ca0271c3797bc09b84babf1ba2d9b4dbb/src/index.js#L11
  .use(initReactI18next) // Initialize i18n for React
  .use(LanguageDetector)
  .init({
    fallbackLng: "en",
    debug: import.meta.env.DEV,
    defaultNS,
    resources,
    lowerCaseLng: true,
    interpolation: {
      escapeValue: false,
      // Every string that used to hardcode the upstream product name now says
      // {{appName}}. This supplies it once, so a deployment shows the
      // business's own product name everywhere without each call site having
      // to pass it.
      defaultVariables: { appName: appName() },
    },
  });

// The real name arrives with the deployment's branding, after i18n is set up.
onBrandChange(() => {
  i18next.options.interpolation.defaultVariables.appName = appName();
  i18next.emit("languageChanged", i18next.language);
});

export default i18next;
