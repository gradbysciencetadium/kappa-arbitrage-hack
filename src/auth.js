// Server-side authentication via Supabase Auth (email + password).
// Users are created PRE-CONFIRMED through the admin API, so no email/SMTP setup is
// needed — signup immediately returns a usable session. If Supabase isn't configured,
// auth reports itself disabled and the app still runs anonymously.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let admin = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require("@supabase/supabase-js");
    admin = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("Auth: Supabase Auth enabled (email + password).");
  } catch (e) {
    console.warn("Auth: Supabase client failed to init:", e.message);
  }
} else {
  console.log("Auth: disabled (set SUPABASE_URL + SUPABASE_KEY to enable accounts).");
}

const enabled = () => !!admin;

// A throwaway client for password sign-in, so its session never pollutes the admin client.
function freshClient() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const cleanEmail = (email) => String(email || "").trim().toLowerCase();

async function signup(email, password) {
  if (!admin) throw new Error("Accounts are not available (database not configured).");
  email = cleanEmail(email);
  if (!/.+@.+\..+/.test(email)) throw new Error("Enter a valid email address.");
  if (!password || String(password).length < 8) throw new Error("Password must be at least 8 characters.");

  // Create a pre-confirmed user — no email confirmation step needed.
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error && !/already (been )?(registered|exists)|already registered|email.*exists/i.test(error.message)) {
    throw new Error(error.message);
  }
  // Whether newly created or already existing, sign in to return a session.
  return login(email, password);
}

async function login(email, password) {
  if (!admin) throw new Error("Accounts are not available (database not configured).");
  email = cleanEmail(email);
  const client = freshClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (/invalid login|invalid credentials/i.test(error.message)) {
      throw new Error("Email or password is incorrect.");
    }
    throw new Error(error.message);
  }
  return {
    token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email },
  };
}

// Verify a bearer access token and return the user, or null if invalid/absent.
async function verifyToken(token) {
  if (!token || !admin) return null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}

module.exports = { enabled, signup, login, verifyToken };
