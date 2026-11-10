export const ADMIN_KEY_STORAGE = "airguardian.adminKey";
export const DEFAULT_ADMIN_KEY = "123";

export function resolveAdminKey(stored: string | null) {
  const key = stored?.trim();
  const legacy = key?.toLowerCase();
  return !key || legacy === "pista" || legacy === "aeroclub123" ? DEFAULT_ADMIN_KEY : key;
}
