// Configuração pública do Supabase.
// A chave publishable pode ser usada no frontend; nunca coloque service_role/secret aqui.
export const SUPABASE_URL = 'https://qpbhntswhhfmppzgopti.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Jm8zA5oyrMftJutYY-jZMw_eEQ7krwW';

export function isSupabaseConfigured() {
  const urlReady = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL);
  const keyReady = typeof SUPABASE_PUBLISHABLE_KEY === 'string' &&
    SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_') &&
    SUPABASE_PUBLISHABLE_KEY.length > 20;
  return urlReady && keyReady;
}
