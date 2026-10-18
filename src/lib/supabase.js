// Supabase client for signed-in features (Portfolio). Public pages keep using plain
// REST calls; this client adds sessions, so it's only loaded where needed.
import { createClient } from '@supabase/supabase-js';

const URL_ = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const supabase = URL_ && KEY
  ? createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null;
