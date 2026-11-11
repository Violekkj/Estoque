// Configuração pública do Supabase.
// Nunca coloque service_role ou secret neste arquivo.

export const SUPABASE_URL = "https://qpbhntswhhfmppzgopti.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_Jm8zA5oyrMftJutYY-jZMw_eEQ7krwW";

export function isSupabaseConfigured() {
  const urlReady =
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
    !SUPABASE_URL.includes("SEU-PROJETO");

  const keyReady =
    typeof SUPABASE_PUBLISHABLE_KEY === "string" &&
    SUPABASE_PUBLISHABLE_KEY.length > 20 &&
    !SUPABASE_PUBLISHABLE_KEY.includes("SUA_CHAVE");

  return urlReady && keyReady;
}
