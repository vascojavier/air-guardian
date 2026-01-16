// src/i18n/index.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";

import en from "./en.json";
import es from "./es.json";

const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

const deviceLang = (Localization.getLocales()?.[0]?.languageCode ?? "en");

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: deviceLang,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    // ✅ tu i18next espera v4 (o directamente omitilo)
    compatibilityJSON: "v4",
  });

export default i18n;
