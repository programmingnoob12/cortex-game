// Service-role Supabase client — bypasses Row-Level Security, so it must only
// ever be constructed server-side. The service role key is never sent to the
// browser and is not prefixed VITE_, which would inline it into the bundle.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
}

export const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
