import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Localization from "expo-localization";
import i18n from "./index";

export type AppLanguage = "system" | "en" | "es";

const STORAGE_KEY = "airguardian.language";

/**
 * Obtiene el idioma efectivo según el sistema,
 * limitado a los idiomas soportados por la app.
 */
function getSystemLanguage(): "en" | "es" {
  const raw = Localization.getLocales()?.[0]?.languageCode ?? "en";
  return raw.toLowerCase().startsWith("es") ? "es" : "en";
}

/**
 * Cambia el idioma de la app y lo persiste.
 */
export async function setAppLanguage(lang: AppLanguage) {
  await AsyncStorage.setItem(STORAGE_KEY, lang);

  if (lang === "system") {
    const deviceLang = getSystemLanguage();
    await i18n.changeLanguage(deviceLang);
  } else {
    await i18n.changeLanguage(lang);
  }
}

/**
 * Carga el idioma guardado al iniciar la app.
 * Se llama UNA sola vez al arrancar.
 */
export async function loadAppLanguageOnStart() {
  const saved = (await AsyncStorage.getItem(STORAGE_KEY)) as AppLanguage | null;
  if (!saved) return;

  if (saved === "system") {
    const deviceLang = getSystemLanguage();
    await i18n.changeLanguage(deviceLang);
  } else {
    await i18n.changeLanguage(saved);
  }
}
