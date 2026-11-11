import { getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

async function ensureStore(client, storeName) {
  const safeName = String(storeName || '').trim().slice(0, 80) || 'Meu comércio';
  const { data: storeId, error: createError } = await client.rpc('create_my_store', {
    p_name: safeName
  });
  if (createError) throw createError;
  if (!storeId) throw new Error('A conta foi autenticada, mas não foi possível localizar o estabelecimento. Confira se a migração SQL foi aplicada.');

  const { data: store, error: storeError } = await client
    .from('stores')
    .select('id, name, created_at')
    .eq('id', storeId)
    .single();
  if (storeError) throw storeError;
  return store;
}

export async function getCloudAccount() {
  if (!isSupabaseConfigured()) return { configured: false, session: null, store: null };
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const session = data.session || null;
  if (!session) return { configured: true, session: null, store: null };
  const store = await ensureStore(client, session.user.user_metadata?.store_name);
  return { configured: true, session, store };
}

export async function signInWithPassword(email, password) {
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  const store = await ensureStore(client, data.user?.user_metadata?.store_name);
  return { user: data.user, session: data.session, store };
}

export async function signUpWithPassword({ email, password, storeName }) {
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { store_name: String(storeName || '').trim().slice(0, 80) || 'Meu comércio' },
      emailRedirectTo: new URL('./', window.location.href).href
    }
  });
  if (error) throw error;
  if (!data.session) {
    return { user: data.user, session: null, store: null, requiresEmailConfirmation: true };
  }
  const store = await ensureStore(client, data.user?.user_metadata?.store_name);
  return { user: data.user, session: data.session, store, requiresEmailConfirmation: false };
}

export async function signOutFromCloud() {
  const client = await getSupabaseClient();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
