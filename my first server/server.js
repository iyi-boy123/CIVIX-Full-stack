/* ======================================================================
   CIVIX API server (Node.js + Express + mysql2)
   Matches schema.sql (database: civix).

   Public:   POST /api/register, POST /api/login
             GET  /api/<table>  and  GET /api/<table>/<id>   (every table except users)
   Admin:    POST /api/admin/login  -> returns a bearer token
             POST / PUT / DELETE on every table, plus GET on users
             (send header:  x-admin-token: <token>   — "Authorization: Bearer <token>" also works)
====================================================================== */

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { escapeId } = require("mysql2");
const bcrypt = require("bcryptjs");

const {
  PORT = "4000",
  DB_HOST = "localhost",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_NAME = "civix",
  ADMIN_PASSWORD,
  ADMIN_TOKEN_TTL_HOURS = "8",
  CORS_ORIGIN = "http://localhost:3000,http://localhost:5173",
} = process.env;

if (!ADMIN_PASSWORD) {
  console.error(
    "ADMIN_PASSWORD is not set. Copy .env.example to .env and set a strong value."
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- DB */
const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true, // latitude/longitude come back as numbers, not strings
});

/* ----------------------------------------------------------- helpers */
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

// Only plain values may reach the database. mysql2's query() expands objects
// and arrays into SQL fragments, so nested JSON must never be passed through.
const isScalar = (v) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

function pickFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }
  const data = {};
  const unknown = [];
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) {
      unknown.push(key);
    } else if (!isScalar(value)) {
      throw httpError(400, `Field "${key}" must be a string, number, boolean or null.`);
    } else {
      data[key] = value;
    }
  }
  if (unknown.length) {
    throw httpError(
      400,
      `Unknown or read-only field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`
    );
  }
  return data;
}

// Simple in-memory limiter for login endpoints: `max` failures per window, per IP.
function createLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of hits) if (e.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();
  return {
    blocked(req) {
      const e = hits.get(req.ip);
      return !!e && e.resetAt > Date.now() && e.count >= max;
    },
    fail(req) {
      const now = Date.now();
      const e = hits.get(req.ip);
      if (!e || e.resetAt <= now) hits.set(req.ip, { count: 1, resetAt: now + windowMs });
      else e.count += 1;
    },
    clear(req) {
      hits.delete(req.ip);
    },
  };
}
const userLoginLimiter = createLimiter(10, 15 * 60 * 1000);
const adminLoginLimiter = createLimiter(5, 15 * 60 * 1000);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw httpError(400, "Password must be at least 8 characters.");
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw httpError(400, "Password must be at most 72 bytes (bcrypt limit).");
  }
}

const DUMMY_HASH = bcrypt.hashSync("civix-dummy-password", 10);

async function safeCompare(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false; // malformed hash (e.g. the placeholder hashes in the sample data)
  }
}

/* ------------------------------------------------------ admin tokens */
const ttlHours = Number(ADMIN_TOKEN_TTL_HOURS);
const TOKEN_TTL_MS = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 8) * 3600 * 1000;
const adminTokens = new Map(); // token -> expiry time (ms). Cleared when the server restarts.
const userTokens = new Map();

function createUserToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  userTokens.set(token, {
    userId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

function requireUser(req, res, next) {
  const token = req.get("x-user-token");
  const session = token && userTokens.get(token);

  if (!session || session.expiresAt <= Date.now()) {
    if (token) userTokens.delete(token);
    return res.status(401).json({
      error: "Please sign in again before submitting a report.",
    });
  }

  req.userId = session.userId;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (exp <= now) adminTokens.delete(t);
}, 10 * 60 * 1000).unref();

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const adminPasswordMatches = (input) =>
  crypto.timingSafeEqual(sha256(input), sha256(ADMIN_PASSWORD));

// The token comes from the "x-admin-token" header (or "Authorization: Bearer <token>").
function getAdminToken(req) {
  const direct = req.get("x-admin-token");
  if (direct) return direct.trim();
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  return match ? match[1] : null;
}

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  const expiresAt = token && adminTokens.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ error: "Valid admin token required." });
  }
  next();
}

/* --------------------------------------------------------------- app */
const app = express();
app.disable("x-powered-by");

const allowedOrigins = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  })
);
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", ah(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

/* ------------------------------------------------- user register/login */
const publicUser = (u) => ({
  id: u.id,
  full_name: u.full_name,
  email: u.email,
  phone: u.phone,
  created_at: u.created_at,
});

app.post("/api/register", ah(async (req, res) => {
  const body = req.body || {};
  const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone =
    typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;

  if (!full_name || full_name.length > 150) {
    throw httpError(400, "full_name is required (max 150 characters).");
  }
  if (!EMAIL_RE.test(email) || email.length > 255) {
    throw httpError(400, "A valid email is required.");
  }
  if (phone && (phone.length < 5 || phone.length > 30)) {
    throw httpError(400, "phone must be 5 to 30 characters.");
  }
  checkPassword(body.password);

  const password_hash = await bcrypt.hash(body.password, 10);
  let result;
  try {
    [result] = await pool.query(
      "INSERT INTO users (full_name, email, password_hash, phone) VALUES (?, ?, ?, ?)",
      [full_name, email, password_hash, phone]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      throw httpError(409, "An account with that email or phone already exists.");
    }
    throw err;
  }
  const [rows] = await pool.query(
  "SELECT * FROM users WHERE id = ?",
  [result.insertId]
);

const user = publicUser(rows[0]);
const token = createUserToken(user.id);

res.status(201).json({ user, token });
}));

app.post("/api/login", ah(async (req, res) => {
  if (userLoginLimiter.blocked(req)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again later." });
  }
  const body = req.body || {};
  // The mockup's field is "Email or phone number", so accept any of these names.
  const identifier = [body.identifier, body.email, body.phone].find(
    (v) => typeof v === "string" && v.trim()
  );
  if (!identifier || typeof body.password !== "string") {
    throw httpError(400, "Email (or phone) and password are required.");
  }

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE email = ? OR phone = ? LIMIT 1",
    [identifier.trim().toLowerCase(), identifier.trim()]
  );
  const user = rows[0];
  // Always run one bcrypt comparison so response time doesn't reveal whether the account exists.
  const ok = await safeCompare(body.password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !ok) {
    userLoginLimiter.fail(req);
    return res.status(401).json({ error: "Invalid email/phone or password." });
  }
  userLoginLimiter.clear(req);

const safeUser = publicUser(user);
const token = createUserToken(safeUser.id);

res.json({ user: safeUser, token });
}));
/* ------------------------------------------------------------- admin */
app.post("/api/admin/login", ah(async (req, res) => {
  if (adminLoginLimiter.blocked(req)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again later." });
  }
  const password = req.body && req.body.password;
  if (typeof password !== "string" || !adminPasswordMatches(password)) {
    adminLoginLimiter.fail(req);
    return res.status(401).json({ error: "Invalid admin password." });
  }
  adminLoginLimiter.clear(req);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  adminTokens.set(token, expiresAt);
  res.json({ token, expires_at: new Date(expiresAt).toISOString() });
}));

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  adminTokens.delete(getAdminToken(req));
  res.json({ ok: true });
});

/* ---------------------------------------------------- table definitions
   columns  : what GET returns, and what ?filters may use
   create   : fields accepted on POST        required : must be present on POST
   update   : fields accepted on PUT
   publicRead: GET open to everyone (users is admin-only: it holds personal data)
------------------------------------------------------------------- */
const TABLES = {
  users: {
    pk: ["id"], auto: true, publicRead: false,
    columns: ["id", "full_name", "email", "phone", "created_at"],
    create: ["full_name", "email", "phone", "password"],
    update: ["full_name", "email", "phone", "password"],
    required: ["full_name", "email", "password"],
    async prepare(data) {
      if (typeof data.email === "string") data.email = data.email.trim().toLowerCase();
      if ("password" in data) {
        checkPassword(data.password);
        data.password_hash = await bcrypt.hash(data.password, 10);
        delete data.password;
      }
    },
  },
  departments: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "name", "short_name", "chip_label"],
    create: ["name", "short_name", "chip_label"],
    update: ["name", "short_name", "chip_label"],
    required: ["name", "short_name", "chip_label"],
  },
  categories: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "slug", "label", "icon", "department_id"],
    create: ["slug", "label", "icon", "department_id"],
    update: ["slug", "label", "icon", "department_id"],
    required: ["slug", "label", "icon"],
  },
  priorities: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "label", "sort_order"],
    create: ["label", "sort_order"],
    update: ["label", "sort_order"],
    required: ["label", "sort_order"],
    orderBy: "`sort_order`",
  },
  statuses: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "label", "sort_order"],
    create: ["label", "sort_order"],
    update: ["label", "sort_order"],
    required: ["label", "sort_order"],
    orderBy: "`sort_order`",
  },
  officers: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "user_id", "role", "department_id"],
    create: ["user_id", "role", "department_id"],
    update: ["user_id", "role", "department_id"],
    required: ["user_id", "role"],
  },
  issues: {
    pk: ["id"], auto: true, publicRead: true,
    columns: [
      "id", "public_code", "reporter_id", "category_id", "description", "location_label",
      "latitude", "longitude", "priority_id", "status_id", "department_id",
      "assigned_officer_id", "created_at", "updated_at", "resolved_at",
    ],
    create: [
      "public_code", "reporter_id", "category_id", "description", "location_label",
      "latitude", "longitude", "priority_id", "status_id", "department_id",
      "assigned_officer_id", "resolved_at",
    ],
    update: [
      "public_code", "reporter_id", "category_id", "description", "location_label",
      "latitude", "longitude", "priority_id", "status_id", "department_id",
      "assigned_officer_id", "resolved_at",
    ],
    required: [
      "reporter_id", "category_id", "description", "location_label", "priority_id", "status_id",
    ],
    orderBy: "`created_at` DESC, `id` DESC",
    touch: "updated_at",
    async prepare(data, isCreate) {
      if (!isCreate) return;
      // Auto-number new issues: CX-1043 comes after the highest existing code.
      if (!data.public_code) {
        const [r] = await pool.query(
          "SELECT COALESCE(MAX(CAST(SUBSTRING(public_code, 4) AS UNSIGNED)), 1000) + 1 AS n FROM issues"
        );
        data.public_code = `CX-${r[0].n}`;
      }
      // Auto-route to the category's department unless one was given.
      if (data.department_id === undefined && data.category_id != null) {
        const [r] = await pool.query("SELECT department_id FROM categories WHERE id = ?", [
          data.category_id,
        ]);
        if (r[0] && r[0].department_id != null) data.department_id = r[0].department_id;
      }
    },
  },
  issue_photos: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "issue_id", "photo_url", "uploaded_at"],
    create: ["issue_id", "photo_url"],
    update: ["issue_id", "photo_url"],
    required: ["issue_id", "photo_url"],
  },
  issue_upvotes: {
    pk: ["issue_id", "user_id"], auto: false, publicRead: true,
    columns: ["issue_id", "user_id", "created_at"],
    create: ["issue_id", "user_id"],
    update: ["created_at"],
    required: ["issue_id", "user_id"],
  },
  notifications: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "user_id", "issue_id", "message", "is_read", "created_at"],
    create: ["user_id", "issue_id", "message", "is_read"],
    update: ["user_id", "issue_id", "message", "is_read"],
    required: ["user_id", "message"],
    orderBy: "`created_at` DESC, `id` DESC",
  },
  issue_status_history: {
    pk: ["id"], auto: true, publicRead: true,
    columns: ["id", "issue_id", "from_status_id", "to_status_id", "changed_by", "note", "changed_at"],
    create: ["issue_id", "from_status_id", "to_status_id", "changed_by", "note"],
    update: ["issue_id", "from_status_id", "to_status_id", "changed_by", "note"],
    required: ["issue_id", "to_status_id"],
    orderBy: "`changed_at`, `id`",
  },
};

function registerCrud(table, cfg) {
  const T = escapeId(table);
  const selectCols = cfg.columns.map(escapeId).join(", ");
  const orderBy = cfg.orderBy || cfg.pk.map(escapeId).join(", ");
  const base = `/api/${table}`;
  const idPath = cfg.pk.map((k) => `/:${k}`).join("");
  const readGuard = cfg.publicRead ? [] : [requireAdmin];

  // WHERE clause for one row, built from URL parameters (must be whole numbers).
  const pkWhere = (params) => {
    const vals = [];
    for (const k of cfg.pk) {
      if (!/^\d+$/.test(params[k] || "")) throw httpError(400, `"${k}" must be a whole number.`);
      vals.push(params[k]);
    }
    return { sql: cfg.pk.map((k) => `${escapeId(k)} = ?`).join(" AND "), vals };
  };

  const fetchOne = async (sql, vals) => {
    const [rows] = await pool.query(`SELECT ${selectCols} FROM ${T} WHERE ${sql}`, vals);
    return rows[0];
  };

  // GET /api/<table>?col=value&limit=100&offset=0
  app.get(base, ...readGuard, ah(async (req, res) => {
    const { limit, offset, ...filters } = req.query;
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(filters)) {
      if (!cfg.columns.includes(k)) throw httpError(400, `Cannot filter by unknown column "${k}".`);
      if (typeof v !== "string") throw httpError(400, `Filter "${k}" must be a single value.`);
      where.push(`${escapeId(k)} = ?`);
      params.push(v);
    }
    const lim = Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 500);
    const off = Math.max(parseInt(String(offset), 10) || 0, 0);
    const [rows] = await pool.query(
      `SELECT ${selectCols} FROM ${T}${where.length ? " WHERE " + where.join(" AND ") : ""}` +
        ` ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`,
      params
    );
    res.json(rows);
  }));

  // GET /api/<table>/:id
  app.get(base + idPath, ...readGuard, ah(async (req, res) => {
    const w = pkWhere(req.params);
    const row = await fetchOne(w.sql, w.vals);
    if (!row) throw httpError(404, "Not found.");
    res.json(row);
  }));

  // POST /api/<table>   (admin)
  app.post(base, requireAdmin, ah(async (req, res) => {
    const data = pickFields(req.body, cfg.create);
    for (const k of cfg.required) {
      if (data[k] === undefined || data[k] === null || data[k] === "") {
        throw httpError(400, `Missing required field: ${k}`);
      }
    }
    if (cfg.prepare) await cfg.prepare(data, true);

    const keys = Object.keys(data);
    const [result] = await pool.query(
      `INSERT INTO ${T} (${keys.map(escapeId).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((k) => data[k])
    );
    const vals = cfg.auto ? [result.insertId] : cfg.pk.map((k) => data[k]);
    const row = await fetchOne(cfg.pk.map((k) => `${escapeId(k)} = ?`).join(" AND "), vals);
    res.status(201).json(row);
  }));

  // PUT /api/<table>/:id   (admin) - only the fields you send are changed
  app.put(base + idPath, requireAdmin, ah(async (req, res) => {
    const w = pkWhere(req.params);
    const data = pickFields(req.body, cfg.update);
    if (cfg.prepare) await cfg.prepare(data, false);

    const keys = Object.keys(data);
    if (!keys.length) throw httpError(400, "No updatable fields were provided.");
    const sets = keys.map((k) => `${escapeId(k)} = ?`);
    if (cfg.touch) sets.push(`${escapeId(cfg.touch)} = NOW()`);

    await pool.query(`UPDATE ${T} SET ${sets.join(", ")} WHERE ${w.sql}`, [
      ...keys.map((k) => data[k]),
      ...w.vals,
    ]);
    const row = await fetchOne(w.sql, w.vals);
    if (!row) throw httpError(404, "Not found.");
    res.json(row);
  }));

  // DELETE /api/<table>/:id   (admin)
  app.delete(base + idPath, requireAdmin, ah(async (req, res) => {
    const w = pkWhere(req.params);
    const [result] = await pool.query(`DELETE FROM ${T} WHERE ${w.sql}`, w.vals);
    if (!result.affectedRows) throw httpError(404, "Not found.");
    res.json({ deleted: true });
  }));
}
// Residents can submit their own reports; they cannot choose another reporter.
app.post("/api/issues/report", requireUser, ah(async (req, res) => {
  const body = req.body || {};
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const categorySlug =
    typeof body.category_slug === "string" ? body.category_slug.trim() : "";

  if (!description || description.length > 5000) {
    throw httpError(400, "Enter a description of up to 5000 characters.");
  }

  if (!categorySlug) {
    throw httpError(400, "Choose an issue category.");
  }

  const validCoordinate = (v, min, max) =>
    v === null || v === undefined ||
    (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);

  if (
    !validCoordinate(body.latitude, -90, 90) ||
    !validCoordinate(body.longitude, -180, 180)
  ) {
    throw httpError(400, "The location coordinates are invalid.");
  }

  const [categories] = await pool.query(
    "SELECT id, department_id FROM categories WHERE slug = ? LIMIT 1",
    [categorySlug]
  );

  if (!categories.length) {
    throw httpError(400, "That category does not exist. Refresh and try again.");
  }

  const [priorities] = await pool.query(
    "SELECT id FROM priorities WHERE label = 'Medium' LIMIT 1"
  );
  const [statuses] = await pool.query(
    "SELECT id FROM statuses WHERE label = 'Pending' LIMIT 1"
  );

  if (!priorities.length || !statuses.length) {
    throw httpError(500, "CIVIX is missing its default priority or status.");
  }

  const latitude = body.latitude ?? null;
  const longitude = body.longitude ?? null;
  const locationLabel =
    latitude !== null && longitude !== null
      ? `Lat ${latitude.toFixed(5)}, Lng ${longitude.toFixed(5)}`
      : "Location not provided";

  const [codes] = await pool.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(public_code, 4) AS UNSIGNED)), 1000) + 1 AS n FROM issues"
  );
  const publicCode = `CX-${codes[0].n}`;

  const [result] = await pool.query(
    `INSERT INTO issues
      (public_code, reporter_id, category_id, description, location_label,
       latitude, longitude, priority_id, status_id, department_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      publicCode,
      req.userId,
      categories[0].id,
      description,
      locationLabel,
      latitude,
      longitude,
      priorities[0].id,
      statuses[0].id,
      categories[0].department_id ?? null,
    ]
  );

  const [rows] = await pool.query(
    "SELECT * FROM issues WHERE id = ?",
    [result.insertId]
  );

  res.status(201).json(rows[0]);
}));
for (const [table, cfg] of Object.entries(TABLES)) registerCrud(table, cfg);

app.get("/api", (req, res) => {
  res.json({
    tables: Object.keys(TABLES),
    note: "GET is public except /api/users. POST/PUT/DELETE need an admin token.",
  });
});

/* ------------------------------------------------------ error handling */
const DB_ERRORS = {
  ER_DUP_ENTRY: [409, "That value already exists (duplicate)."],
  ER_NO_REFERENCED_ROW_2: [400, "A referenced record does not exist (check the *_id fields)."],
  ER_ROW_IS_REFERENCED_2: [409, "Other records still depend on this one, so it can't be deleted."],
  ER_BAD_NULL_ERROR: [400, "A required field is missing."],
  ER_NO_DEFAULT_FOR_FIELD: [400, "A required field is missing."],
  ER_DATA_TOO_LONG: [400, "A value is too long for its field."],
  ER_TRUNCATED_WRONG_VALUE: [400, "A value has the wrong format."],
  ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: [400, "A value has the wrong format."],
  WARN_DATA_TRUNCATED: [400, "A value has the wrong format."],
};

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  if (DB_ERRORS[err.code]) {
    const [status, error] = DB_ERRORS[err.code];
    return res.status(status).json({ error });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

/* --------------------------------------------------------------- start */
(async () => {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.error(`Could not connect to MySQL (${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}): ${err.message}`);
    console.error("Check that MySQL is running, the civix database exists (run schema.sql), and your .env values.");
    process.exit(1);
  }
  app.listen(Number(PORT), () => {
    console.log(`CIVIX API listening on http://localhost:${PORT}`);
  });
})();
