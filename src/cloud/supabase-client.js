import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isSupabaseConfigured } from '../config/supabase-config.js';

let clientPromise = null;
let scriptPromise = null;

function loadSupabaseLibrary() {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    return Promise.resolve(window.supabase);
  }
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        resolve(window.supabase);
      } else {
        reject(new Error('A biblioteca do Supabase carregou, mas não disponibilizou o cliente.'));
      }
    };
    script.onerror = () => reject(new Error('Não foi possível carregar o serviço de autenticação. Verifique sua conexão.'));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

export async function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    throw new Error('O Supabase ainda não foi configurado. Preencha src/config/supabase-config.js com a URL e a chave publicável do projeto.');
  }
  if (!clientPromise) {
    clientPromise = loadSupabaseLibrary().then((library) => library.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          flowType: 'pkce'
        }
      }
    )).catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

export { isSupabaseConfigured };
