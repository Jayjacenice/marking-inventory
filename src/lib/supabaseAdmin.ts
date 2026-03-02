import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseServiceRoleKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string;

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    storageKey: 'sb-admin-auth-token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn(),
  },
});
