// src/i18n/index.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveLanguage } from "./language";

import en from "./en.json";
import es from "./es.json";
import de from "./de.json";
import nl from "./nl.json";
import fr from "./fr.json";
import pt from "./pt.json";
import it from "./it.json";

const resources = {
  en: { translation: en },
  es: { translation: es },
  de: { translation: de },
  nl: { translation: nl },
  fr: { translation: fr },
  pt: { translation: pt },
  it: { translation: it },
} as const;

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: resolveLanguage("system"),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    // ✅ tu i18next espera v4 (o directamente omitilo)
    compatibilityJSON: "v4",
  });

export default i18n;
