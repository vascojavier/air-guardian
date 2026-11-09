import * as Localization from "expo-localization";

export const languageOptions = {
  en: { label: "English", voice: "en-US" },
  es: { label: "Español", voice: "es-ES" },
  de: { label: "Deutsch", voice: "de-DE" },
  nl: { label: "Nederlands", voice: "nl-NL" },
  fr: { label: "Français", voice: "fr-FR" },
  pt: { label: "Português", voice: "pt-PT" },
  it: { label: "Italiano", voice: "it-IT" },
} as const;

export type SupportedLanguage = keyof typeof languageOptions;
export type AppLanguage = "system" | SupportedLanguage;

function isSupported(code: string): code is SupportedLanguage {
  return Object.prototype.hasOwnProperty.call(languageOptions, code);
}

export function resolveLanguage(preference: unknown): SupportedLanguage {
  if (typeof preference === "string" && isSupported(preference)) return preference;

  for (const locale of Localization.getLocales()) {
    const code = locale.languageCode?.toLowerCase();
    if (code && isSupported(code)) return code;
  }
  return "en";
}

export function readLanguagePreference(value: unknown): AppLanguage | undefined {
  if (typeof value !== "string") return undefined;
  return value === "system" || isSupported(value) ? value : undefined;
}

export function resolveVoiceLanguage(language: SupportedLanguage): string {
  const matchingLocale = Localization.getLocales().find(
    locale => locale.languageCode?.toLowerCase() === language
  );
  return matchingLocale?.languageTag || languageOptions[language].voice;
}
