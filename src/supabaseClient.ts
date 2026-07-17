import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// The publishable/anon key is safe to ship in the client bundle by design —
// Row Level Security on every table is what actually enforces access control.
export const supabase = createClient(url, key);
