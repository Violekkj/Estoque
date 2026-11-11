// Configure com a URL do projeto e a chave PUBLICÁVEL do Supabase.
// Nunca coloque a chave service_role/secret neste arquivo ou no navegador.
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'SUA_CHAVE_PUBLICAVEL_DO_SUPABASE';

export function isSupabaseConfigured() {
  const urlReady = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
    && !SUPABASE_URL.includes('SEU-PROJETO');
  const keyReady = typeof SUPABASE_PUBLISHABLE_KEY === 'string'
    && SUPABASE_PUBLISHABLE_KEY.length > 20
    && !SUPABASE_PUBLISHABLE_KEY.includes('SUA_CHAVE');
  return urlReady && keyReady;
}
