// Cloudflare Pages Function — handles every request under /api/*
// Bound resources (set in wrangler.toml / Pages dashboard):
//   env.DB   -> D1 database ("gbyd-db")
//
// Data model note: `progress`, `badges`, `bonusBadges`, `unlockedAvatars`,
// and `friends` are stored as JSON text columns, exactly mirroring the
// shape the front-end used to keep in localStorage. This keeps the API a
// thin, honest layer over the same "one blob per user" model the app
// already used, while adding real auth + real per-user access control.

const OWNER_USERNAME = "elnathan";
const SESSION_DAYS = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}

// ---- crypto helpers -------------------------------------------------
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr.buffer;
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

// ---- row <-> public-user shape ---------------------------------------
function rowToUser(row) {
  return {
    username: row.username,
    isAdmin: !!row.is_admin,
    kicked: !!row.kicked,
    avatar: row.avatar,
    points: row.points,
    unlockedAvatars: JSON.parse(row.unlocked_avatars || "[]"),
    friends: JSON.parse(row.friends || "[]"),
    progress: JSON.parse(row.progress || "{}"),
    badges: JSON.parse(row.badges || "[]"),
    bonusBadges: JSON.parse(row.bonus_badges || "[]"),
    hadPerfectRound: !!row.had_perfect_round,
    forceLogoutAt: row.force_logout_at || 0,
    joinedAt: row.joined_at,
  };
}

// ---- auth --------------------------------------------------------------
async function requireAuth(request, env) {
  const authz = request.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!token) return null;
  const session = await env.DB.prepare(
    "SELECT username, expires_at FROM sessions WHERE token = ?"
  ).bind(token).first();
  if (!session || session.expires_at < Date.now()) return null;
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(session.username).first();
  if (!row) return null;
  return { token, row };
}

async function createSession(env, username) {
  const token = randomHex(24);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, username, now, now + SESSION_DAYS * 24 * 60 * 60 * 1000).run();
  return token;
}

function newUserDefaults(username) {
  const isOwner = username.toLowerCase() === OWNER_USERNAME;
  return {
    is_admin: isOwner ? 1 : 0,
    unlocked_avatars: JSON.stringify(isOwner ? ["🎓", "🛡️", "⚙️"] : ["🎓"]),
  };
}

// ---- route handlers ------------------------------------------------

async function handleSignup(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (username.length < 3) return err("Username needs to be at least 3 characters.");
  if (password.length < 4) return err("Password needs to be at least 4 characters.");

  const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
  if (existing) return err("That username is already taken.");

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const defaults = newUserDefaults(username);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, salt, is_admin, unlocked_avatars, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(username, hash, salt, defaults.is_admin, defaults.unlocked_avatars, now).run();

  const token = await createSession(env, username);
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  return json({ token, user: rowToUser(row) });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = (body.username || "").trim();
  const password = body.password || "";

  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!row) return err("Incorrect username or password.", 401);
  const hash = await hashPassword(password, row.salt);
  if (hash !== row.password_hash) return err("Incorrect username or password.", 401);
  if (row.kicked) return err("This account has been suspended by an administrator.", 403);

  const token = await createSession(env, username);
  return json({ token, user: rowToUser(row) });
}

async function handleLogout(request, env, auth) {
  if (auth) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(auth.token).run();
  return json({ ok: true });
}

// Full-state fetch: every user's public record, used to populate the
// front-end's in-memory `users` object (leaderboard, friends, admin panel).
async function handleGetState(request, env, auth) {
  if (!auth) return err("Not logged in.", 401);
  const { results } = await env.DB.prepare("SELECT * FROM users").all();
  const users = {};
  for (const row of results) users[row.username] = rowToUser(row);
  return json({ users, me: auth.row.username });
}

// Whole-state save. Mirrors the old localStorage saveUsers(users) call,
// but with real per-user access control instead of trusting the client:
//  - a user may always update their own record (except admin/kick/force-logout flags)
//  - an admin may update any existing user, including those flags, and
//    may delete a user by omitting them from the payload
//  - a non-admin's attempted edits to OTHER users are silently ignored
async function handleSaveState(request, env, auth) {
  if (!auth) return err("Not logged in.", 401);
  const body = await request.json().catch(() => ({}));
  const incoming = body.users || {};
  const isAdmin = !!auth.row.is_admin;
  const me = auth.row.username;

  const { results: existingRows } = await env.DB.prepare("SELECT username FROM users").all();
  const existingNames = new Set(existingRows.map((r) => r.username));

  const statements = [];

  for (const name of existingNames) {
    const incomingUser = incoming[name];
    const canEdit = incomingUser && (name === me || isAdmin);
    if (!canEdit) continue;

    const editingPrivileged = isAdmin; // only admins may change these fields
    const current = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(name).first();

    const avatar = incomingUser.avatar ?? current.avatar;
    const points = Number.isFinite(incomingUser.points) ? incomingUser.points : current.points;
    const unlockedAvatars = JSON.stringify(incomingUser.unlockedAvatars ?? JSON.parse(current.unlocked_avatars));
    const friends = JSON.stringify(incomingUser.friends ?? JSON.parse(current.friends));
    const progress = JSON.stringify(incomingUser.progress ?? JSON.parse(current.progress));
    const badges = JSON.stringify(incomingUser.badges ?? JSON.parse(current.badges));
    const bonusBadges = JSON.stringify(incomingUser.bonusBadges ?? JSON.parse(current.bonus_badges));
    const hadPerfectRound = incomingUser.hadPerfectRound ? 1 : (current.had_perfect_round ? 1 : 0);

    const isAdminFlag = editingPrivileged && typeof incomingUser.isAdmin === "boolean"
      ? (incomingUser.isAdmin ? 1 : 0)
      : current.is_admin;
    const kicked = editingPrivileged && typeof incomingUser.kicked === "boolean"
      ? (incomingUser.kicked ? 1 : 0)
      : current.kicked;
    const forceLogoutAt = editingPrivileged && Number.isFinite(incomingUser.forceLogoutAt)
      ? incomingUser.forceLogoutAt
      : current.force_logout_at;

    // Never let the owner account lose admin by accident.
    const finalIsAdmin = name.toLowerCase() === OWNER_USERNAME ? 1 : isAdminFlag;

    statements.push(
      env.DB.prepare(
        `UPDATE users SET avatar=?, points=?, unlocked_avatars=?, friends=?, progress=?, badges=?, bonus_badges=?,
         had_perfect_round=?, is_admin=?, kicked=?, force_logout_at=? WHERE username=?`
      ).bind(avatar, points, unlockedAvatars, friends, progress, badges, bonusBadges,
             hadPerfectRound, finalIsAdmin, kicked, forceLogoutAt, name)
    );

    // If an admin suspended/force-logged-out someone, kill their sessions.
    if (editingPrivileged && (kicked && !current.kicked)) {
      statements.push(env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(name));
    }
  }

  for (const stmt of statements) await stmt.run();

  const { results } = await env.DB.prepare("SELECT * FROM users").all();
  const users = {};
  for (const row of results) users[row.username] = rowToUser(row);
  return json({ users });
}

// Explicit delete endpoint (admin only) — safer than inferring deletion
// from an omitted key in a whole-state payload.
async function handleDeleteUser(request, env, auth, username) {
  if (!auth || !auth.row.is_admin) return err("Admin only.", 403);
  if (username === auth.row.username) return err("You can't delete the account you're logged into.", 400);
  if (username.toLowerCase() === OWNER_USERNAME) return err("Can't delete the owner account.", 400);
  await env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
  await env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(username).run();
  return json({ ok: true });
}

// ---- feedback ------------------------------------------------------
async function handleFeedbackList(request, env, auth) {
  if (!auth) return err("Not logged in.", 401);
  if (auth.row.is_admin) {
    const { results } = await env.DB.prepare("SELECT * FROM feedback ORDER BY timestamp DESC").all();
    return json({ feedback: results });
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM feedback WHERE username = ? ORDER BY timestamp DESC"
  ).bind(auth.row.username).all();
  return json({ feedback: results });
}
async function handleFeedbackSubmit(request, env, auth) {
  if (!auth) return err("Not logged in.", 401);
  const body = await request.json().catch(() => ({}));
  const message = (body.message || "").trim();
  if (!message) return err("Please write a message before sending.");
  const category = body.category || "other";
  const ts = Date.now();
  await env.DB.prepare(
    "INSERT INTO feedback (username, avatar, category, message, timestamp, completed) VALUES (?, ?, ?, ?, ?, 0)"
  ).bind(auth.row.username, auth.row.avatar, category, message, ts).run();
  return json({ ok: true });
}
async function handleFeedbackUpdate(request, env, auth, id) {
  if (!auth || !auth.row.is_admin) return err("Admin only.", 403);
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare("UPDATE feedback SET completed = ? WHERE id = ?")
    .bind(body.completed ? 1 : 0, id).run();
  return json({ ok: true });
}
async function handleFeedbackClear(request, env, auth) {
  if (!auth || !auth.row.is_admin) return err("Admin only.", 403);
  await env.DB.prepare("DELETE FROM feedback").run();
  return json({ ok: true });
}

// ---- messages --------------------------------------------------------
function convoKey(a, b) { return [a, b].sort().join("::"); }

async function handleMessagesGet(request, env, auth, friend) {
  if (!auth) return err("Not logged in.", 401);
  const key = convoKey(auth.row.username, friend);
  const { results } = await env.DB.prepare(
    "SELECT from_user as `from`, text, ts FROM messages WHERE convo_key = ? ORDER BY ts ASC"
  ).bind(key).all();
  return json({ messages: results });
}
async function handleMessagesSend(request, env, auth, friend) {
  if (!auth) return err("Not logged in.", 401);
  const body = await request.json().catch(() => ({}));
  const text = (body.text || "").trim();
  if (!text) return err("Empty message.");
  const key = convoKey(auth.row.username, friend);
  const ts = Date.now();
  await env.DB.prepare(
    "INSERT INTO messages (convo_key, from_user, text, ts) VALUES (?, ?, ?, ?)"
  ).bind(key, auth.row.username, text, ts).run();
  return json({ ok: true });
}

// ---- router ----------------------------------------------------------
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join("/");
  const method = request.method;

  try {
    if (path === "signup" && method === "POST") return await handleSignup(request, env);
    if (path === "login" && method === "POST") return await handleLogin(request, env);

    const auth = await requireAuth(request, env);

    if (path === "logout" && method === "POST") return await handleLogout(request, env, auth);
    if (path === "state" && method === "GET") return await handleGetState(request, env, auth);
    if (path === "state" && method === "POST") return await handleSaveState(request, env, auth);

    if (path.startsWith("users/") && method === "DELETE") {
      return await handleDeleteUser(request, env, auth, decodeURIComponent(path.slice("users/".length)));
    }

    if (path === "feedback" && method === "GET") return await handleFeedbackList(request, env, auth);
    if (path === "feedback" && method === "POST") return await handleFeedbackSubmit(request, env, auth);
    if (path === "feedback" && method === "DELETE") return await handleFeedbackClear(request, env, auth);
    if (path.startsWith("feedback/") && method === "PATCH") {
      return await handleFeedbackUpdate(request, env, auth, Number(path.slice("feedback/".length)));
    }

    if (path.startsWith("messages/") && method === "GET") {
      return await handleMessagesGet(request, env, auth, decodeURIComponent(path.slice("messages/".length)));
    }
    if (path.startsWith("messages/") && method === "POST") {
      return await handleMessagesSend(request, env, auth, decodeURIComponent(path.slice("messages/".length)));
    }

    return err("Not found.", 404);
  } catch (e) {
    return err("Server error: " + e.message, 500);
  }
}
