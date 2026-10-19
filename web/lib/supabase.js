"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// A single browser client for the whole app. The session lives in localStorage,
// which is what lets a refresh keep the user signed in without a server round
// trip. The null guard keeps a misconfigured deploy from throwing at import
// time with a blank screen — the page renders its own "not configured" message.
export const supabase =
  url && anonKey ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

export const isConfigured = Boolean(supabase);
