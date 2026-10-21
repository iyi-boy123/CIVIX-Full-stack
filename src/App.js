/* eslint-disable jsx-a11y/anchor-is-valid */
import React, { useState, useEffect, useCallback, useMemo } from "react";

/* ======================================================================
   CIVIX — React port of the CIVIX_App_Mockup.html prototype
   Single-file component: all screens, styles and interactions live here,
   mirroring the structure of the original static mockup.

   Data now comes from the CIVIX API (server.js) via fetch() instead of
   hardcoded rows. Start the server first:  npm start  (port 4000)
====================================================================== */

const API_BASE = "http://localhost:4000/api";

const PRIORITY_CLASS = {
  Critical: "pri-critical",
  High: "pri-high",
  Medium: "pri-medium",
  Low: "pri-low",
};

const STATUS_BADGE = {
  Pending: "b-pending",
  "In progress": "b-progress",
  Resolved: "b-resolved",
  Reopened: "b-reopened",
};

const FILTERS = ["All", "Pending", "In progress", "Resolved"];

// A new report counts as a possible duplicate if an open report in the same
// category was filed within this distance of the reporter's location.
const DUPLICATE_RADIUS_M = 250;

/* ---------------------------------------------------------------- */
/* API + data helpers                                                */
/* ---------------------------------------------------------------- */
async function api(path, options = {}) {
  const { body, headers: extraHeaders, ...rest } = options;
  let res;

  try {
    res = await fetch(API_BASE + path, {
      ...rest,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(extraHeaders || {}),
      },
      body,
    });
  } catch {
    throw new Error(
      "Can't reach the CIVIX server. Is it running at " + API_BASE + "?"
    );
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // The response may have no JSON body.
  }

  if (!res.ok) {
    throw new Error(
      (json && json.error) || `Request failed (${res.status}).`
    );
  }

  return json;
}

// The API returns at most 500 rows per request, so page through until done.
async function fetchAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api(`${path}?limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

function loadSavedUser() {
  try {
    return JSON.parse(localStorage.getItem("civix_user")) || null;
  } catch {
    return null;
  }
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

const newestFirst = (a, b) => new Date(b.created_at) - new Date(a.created_at);

const EMPTY_MODEL = {
  issues: [],
  adminIssues: [],
  categories: [],
  departments: [],
  officers: [],
  upvoteCounts: {},
  kpis: null,
  stats: null,
};

// Turns the raw API rows into everything the screens display.
function buildModel(data) {
  if (!data) return EMPTY_MODEL;
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  const cats = byId(data.categories);
  const pris = byId(data.priorities);
  const sts = byId(data.statuses);
  const depts = byId(data.departments);

  const issues = data.issues.map((i) => {
    const c = cats[i.category_id];
    const p = pris[i.priority_id];
    const s = sts[i.status_id];
    const d = depts[i.department_id];
    return {
      ...i,
      code: i.public_code,
      cat: c ? c.label : "Other",
      icon: c ? c.icon : "📍",
      categorySlug: c ? c.slug : "other",
      loc: i.location_label,
      desc: i.description,
      pri: p ? p.label : "Medium",
      priRank: p ? p.sort_order : 99,
      status: s ? s.label : "Pending",
      dept: d ? d.name : "Unassigned",
      deptShort: d ? d.short_name : "Unassigned",
      reported: timeAgo(i.created_at),
    };
  });

  // "Sorted by priority, then time reported" (newest first within a priority)
  const adminIssues = [...issues].sort(
    (a, b) => a.priRank - b.priRank || newestFirst(a, b)
  );

  const upvoteCounts = {};
  data.upvotes.forEach((u) => {
    upvoteCounts[u.issue_id] = (upvoteCounts[u.issue_id] || 0) + 1;
  });

  const DAY = 86400000;
  const now = Date.now();
  const isOpen = (i) => i.status !== "Resolved";
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const resolvedDays = issues
    .filter((i) => i.resolved_at)
    .map((i) => (new Date(i.resolved_at) - new Date(i.created_at)) / DAY);

  const kpis = {
    urgentOpen: issues.filter((i) => isOpen(i) && (i.pri === "Critical" || i.pri === "High")).length,
    open: issues.filter(isOpen).length,
    resolvedThisWeek: issues.filter(
      (i) => i.status === "Resolved" && i.resolved_at && now - new Date(i.resolved_at) <= 7 * DAY
    ).length,
    avgResolutionDays: avg(resolvedDays),
  };

  // Response time = report -> the first status change on that issue.
  const createdAt = {};
  issues.forEach((i) => {
    createdAt[i.id] = new Date(i.created_at).getTime();
  });
  const firstChange = {};
  data.history.forEach((h) => {
    if (h.from_status_id == null) return;
    const t = new Date(h.changed_at).getTime();
    if (firstChange[h.issue_id] === undefined || t < firstChange[h.issue_id]) {
      firstChange[h.issue_id] = t;
    }
  });
  const responseDays = Object.entries(firstChange)
    .filter(([id]) => createdAt[id] !== undefined)
    .map(([id, t]) => (t - createdAt[id]) / DAY)
    .filter((d) => d >= 0);

  const year = new Date().getFullYear();
  const stats = {
    totalThisYear: issues.filter((i) => new Date(i.created_at).getFullYear() === year).length,
    resolvedWithinTwoWeeksPct: issues.length
      ? Math.round((100 * resolvedDays.filter((d) => d <= 14).length) / issues.length)
      : null,
    avgResponseDays: avg(responseDays),
  };

  return {
    issues,
    adminIssues,
    categories: data.categories,
    departments: data.departments,
    officers: data.officers,
    upvoteCounts,
    kpis,
    stats,
  };
}

// Small loading / error strip shown on screens that depend on API data.
function Notice({ status, what, style }) {
  if (status.error) {
    return (
      <div className="api-notice error" style={style}>
        Couldn't load {what}: {status.error}{" "}
        <button className="link-btn" onClick={status.retry}>
          Try again
        </button>
      </div>
    );
  }
  if (status.loading) {
    return (
      <div className="api-notice" style={style}>
        Loading {what}…
      </div>
    );
  }
  return null;
}

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [authMode, setAuthMode] = useState("signin"); // "signin" | "create"
  const [selectedIssueId, setSelectedIssueId] = useState(null);
  const [activeFilter, setActiveFilter] = useState("All");
  const [activeCategory, setActiveCategory] = useState(null); // null = first category
  const [currentUser, setCurrentUser] = useState(loadSavedUser);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [issues, categories, priorities, statuses, departments, officers, upvotes, history] =
        await Promise.all([
          fetchAll("/issues"),
          fetchAll("/categories"),
          fetchAll("/priorities"),
          fetchAll("/statuses"),
          fetchAll("/departments"),
          fetchAll("/officers"),
          fetchAll("/issue_upvotes"),
          fetchAll("/issue_status_history"),
        ]);
      setData({ issues, categories, priorities, statuses, departments, officers, upvotes, history });
      setLoadError("");
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  // Fetch on first load, and refresh whenever the person switches screens.
  useEffect(() => {
    if (screen !== "login") loadData();
  }, [screen, loadData]);

  const model = useMemo(() => buildModel(data), [data]);
  const status = { loading: data === null && !loadError, error: loadError, retry: loadData };

  const goTo = (name) => (e) => {
    if (e) e.preventDefault();
    setScreen(name);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  
const handleAuthed = (result) => {
  const user = result.user;
  const token = result.token;

  setCurrentUser(user);

  try {
    localStorage.setItem("civix_user", JSON.stringify(user));
    localStorage.setItem("civix_token", token);
  } catch {
    /* Storage unavailable — session-only fallback */
  }

  goTo("user")();
};


  return (
    <>
      {/* Google Fonts — same faces as the mockup */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <style>{STYLES}</style>

      {/* ============ PROTOTYPE SWITCHER ============ */}
      <nav className="proto-bar">
        <span className="proto-label">CIVIX MOCKUP —</span>
        <button
          className={"proto-tab" + (screen === "landing" ? " active" : "")}
          onClick={goTo("landing")}
        >
          Landing
        </button>
        <button
          className={"proto-tab" + (screen === "login" ? " active" : "")}
          onClick={goTo("login")}
        >
          Sign in
        </button>
        <button
          className={"proto-tab" + (screen === "user" ? " active" : "")}
          onClick={goTo("user")}
        >
          User app
        </button>
        <button
          className={"proto-tab" + (screen === "admin" ? " active" : "")}
          onClick={goTo("admin")}
        >
          Admin console
        </button>
        <button
          className={"proto-tab" + (screen === "report" ? " active" : "")}
          onClick={goTo("report")}
        >
          Report an issue
        </button>
      </nav>

      {/* Every screen stays mounted; only the "active" class decides which one
          is visible — exactly how the mockup's showScreen() works. */}
      <Landing active={screen === "landing"} goTo={goTo} stats={model.stats} />
      <Login
        active={screen === "login"}
        authMode={authMode}
        setAuthMode={setAuthMode}
        onAuthed={handleAuthed}
      />
      <Admin
        active={screen === "admin"}
        model={model}
        status={status}
        currentUser={currentUser}
        selectedIssueId={selectedIssueId}
        setSelectedIssueId={setSelectedIssueId}
        activeFilter={activeFilter}
        setActiveFilter={setActiveFilter}
      />
      <UserDashboard
        active={screen === "user"}
        goTo={goTo}
        model={model}
        status={status}
        currentUser={currentUser}
      />
      
<ReportIssue
  active={screen === "report"}
  goTo={goTo}
  model={model}
  status={status}
  activeCategory={activeCategory}
  setActiveCategory={setActiveCategory}
  currentUser={currentUser}
  refresh={loadData}
/>


/* ============================================================ */
/* LANDING PAGE                                                  */
/* ============================================================ */
function Landing({ active, goTo, stats }) {
  return (
    <section className={"screen" + (active ? " active" : "")} id="landing">
      <div className="l-nav">
        <div className="wordmark">
          <span className="dot"></span>CIVIX
        </div>
        <div className="l-nav-links">
          <a href="#">How it works</a>
          <a href="#">For communities</a>
          <a href="#">For local government</a>
        </div>
        <div className="l-nav-actions">
          <a className="btn btn-outline btn-sm nav-link" onClick={goTo("login")}>
            Sign in
          </a>
          <a className="btn btn-dark btn-sm nav-link" onClick={goTo("report")}>
            Report an issue
          </a>
        </div>
      </div>

      <div className="hero">
        <div>
          <span className="eyebrow">Community reporting, made routable</span>
          <h1 style={{ marginTop: 14 }}>
            Every pothole, outage, and leak — reported, routed, resolved.
          </h1>
          <p className="lead">
            CIVIX turns what your neighborhood already knows into a queue
            your local government can actually work through. Snap a photo,
            drop a pin, and watch it move from reported to resolved.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary nav-link" onClick={goTo("report")}>
              Report an issue
            </a>
            <a className="btn btn-outline nav-link" onClick={goTo("user")}>
              See the app
            </a>
          </div>
        </div>
        <div className="hero-visual">
          <div className="mini-phone">
            <div className="mini-phone-notch"></div>
            <div className="mini-phone-body">
              <p className="small" style={{ fontWeight: 700, color: "var(--ink)" }}>
                Report an issue
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 6,
                  marginTop: 12,
                }}
              >
                <div
                  style={{
                    background: "#FBF1DF",
                    border: "1.5px solid var(--signal)",
                    borderRadius: 6,
                    padding: "10px 4px",
                    textAlign: "center",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--signal-dark)",
                  }}
                >
                  🕳️<br />Pothole
                </div>
                <div
                  style={{
                    background: "var(--white)",
                    border: "1.5px solid var(--line)",
                    borderRadius: 6,
                    padding: "10px 4px",
                    textAlign: "center",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--muted)",
                  }}
                >
                  💡<br />Electric
                </div>
                <div
                  style={{
                    background: "var(--white)",
                    border: "1.5px solid var(--line)",
                    borderRadius: 6,
                    padding: "10px 4px",
                    textAlign: "center",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--muted)",
                  }}
                >
                  💧<br />Water
                </div>
              </div>
              <div
                style={{
                  marginTop: 14,
                  background: "var(--white)",
                  border: "1.5px solid var(--line)",
                  borderRadius: 6,
                  height: 56,
                  padding: 8,
                  fontSize: 10,
                  color: "var(--muted-lt)",
                }}
              >
                Deep pothole near the Elm St. bus stop, been growing for two
                weeks...
              </div>
              <div
                style={{
                  marginTop: 10,
                  border: "1.5px dashed var(--line)",
                  borderRadius: 6,
                  padding: 10,
                  textAlign: "center",
                  fontSize: 10,
                  color: "var(--moss-dark)",
                  fontWeight: 600,
                }}
              >
                📍 Use current location
              </div>
              <div
                style={{
                  marginTop: 12,
                  background: "#FBF1DF",
                  borderRadius: 6,
                  padding: 8,
                  fontSize: 9.5,
                  color: "#8A5A12",
                }}
              >
                <strong style={{ display: "block", fontSize: 10 }}>
                  3 nearby reports
                </strong>
                Similar issue already flagged 40m away.
              </div>
              <div
                style={{
                  marginTop: 14,
                  background: "var(--ink)",
                  color: "white",
                  textAlign: "center",
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Submit report
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="num">
            {stats && stats.totalThisYear != null
              ? stats.totalThisYear.toLocaleString()
              : "—"}
          </div>
          <div className="lbl">Issues reported this year</div>
        </div>
        <div className="stat">
          <div className="num">
            {stats && stats.resolvedWithinTwoWeeksPct != null
              ? `${stats.resolvedWithinTwoWeeksPct}%`
              : "—"}
          </div>
          <div className="lbl">Resolved within two weeks of being reported</div>
        </div>
        <div className="stat">
          <div className="num">
            {stats && stats.avgResponseDays != null
              ? `${stats.avgResponseDays.toFixed(1)} days`
              : "—"}
          </div>
          <div className="lbl">Average time from report to a department response</div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>From noticing to resolved, in three steps</h2>
          <p>
            CIVIX was built around the biggest barrier residents told us
            about: not knowing who to contact, or whether reporting does
            anything at all.
          </p>
        </div>
        <div className="steps">
          <div className="step">
            <div className="n">01</div>
            <h3>Spot it</h3>
            <p>
              See a pothole, a dead streetlight, a leak? Open CIVIX and pick
              a category — no account digging, no phone tree.
            </p>
          </div>
          <div className="step">
            <div className="n">02</div>
            <h3>Report it</h3>
            <p>
              Drop a pin, add a photo, and CIVIX automatically routes it to
              the right department — Roads, Power, Water, or Sanitation.
            </p>
          </div>
          <div className="step">
            <div className="n">03</div>
            <h3>Track it</h3>
            <p>
              Follow the status from pending to in progress to resolved, and
              get notified the moment it changes.
            </p>
          </div>
        </div>
      </div>

      <div className="quote-block">
        <div className="quote-mark">&ldquo;</div>
        <div>
          <blockquote>
            I reported a downed line on my street and actually heard back
            two days later. That's never happened with a phone call.
          </blockquote>
          <cite>Resident, Maple Heights — reported via CIVIX</cite>
        </div>
      </div>

      <div className="cta-band">
        <h2>
          Your neighborhood already knows what's broken. Let's make it easy
          to say so.
        </h2>
        <a className="btn btn-primary nav-link" onClick={goTo("report")}>
          Report your first issue
        </a>
      </div>

      <footer>
        <div className="wordmark" style={{ fontSize: 16 }}>
          <span className="dot"></span>CIVIX
        </div>
        <div className="footer-links">
          <a href="#">Privacy</a>
          <a href="#">For local government</a>
          <a href="#">Contact</a>
        </div>
        <div>A community reporting mockup</div>
      </footer>
    </section>
  );
}

/* ============================================================ */
/* LOGIN / AUTHENTICATION                                        */
/* ============================================================ */
function Login({ active, authMode, setAuthMode, onAuthed }) {
  const isCreate = authMode === "create";
  const [identifier, setIdentifier] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const switchMode = (mode) => {
    setAuthMode(mode);
    setError("");
  };

  const submit = async () => {
    if (busy) return;
    setError("");
    const id = identifier.trim();
    if (!id || !password) {
      setError("Enter your email or phone number and your password.");
      return;
    }
    if (isCreate) {
      if (!fullName.trim()) {
        setError("Enter your full name.");
        return;
      }
      if (!id.includes("@")) {
        setError("Please use an email address to create an account.");
        return;
      }
    }

    setBusy(true);
    try {
      const result = isCreate
        ? await api("/register", {
            method: "POST",
            body: JSON.stringify({ full_name: fullName.trim(), email: id, password }),
          })
        : await api("/login", {
            method: "POST",
            body: JSON.stringify({ identifier: id, password }),
          });
      setPassword("");
      onAuthed(result.user, result.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <section className={"screen" + (active ? " active" : "")} id="login">
      <div className="phone-stage">
        <div className="phone">
          <div className="phone-scroll">
            <div className="login-head">
              <div className="wordmark">
                <span className="dot"></span>CIVIX
              </div>
              <p>Report it once. Track it to done.</p>
            </div>

            <div className="segmented">
              <button
                className={!isCreate ? "active" : ""}
                onClick={() => switchMode("signin")}
              >
                Sign in
              </button>
              <button
                className={isCreate ? "active" : ""}
                onClick={() => switchMode("create")}
              >
                Create account
              </button>
            </div>

            <div className="field-group">
              <div className="field">
                <label>Email or phone number</label>
                <input
                  type="text"
                  placeholder="you@example.com"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  onKeyDown={onEnter}
                />
              </div>
              <div
                className="field"
                id="name-field"
                style={{ display: isCreate ? "block" : "none" }}
              >
                <label>Full name</label>
                <input
                  type="text"
                  placeholder="Amara Johnson"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  onKeyDown={onEnter}
                />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={onEnter}
                />
              </div>
              <a
                className="field-link"
                id="forgot-link"
                style={{ display: isCreate ? "none" : "block" }}
              >
                Forgot password?
              </a>
              {error && <div className="form-error">{error}</div>}
              <button
                className="btn btn-primary btn-block"
                id="auth-submit"
                onClick={submit}
                disabled={busy}
                style={busy ? { opacity: 0.7 } : undefined}
              >
                {busy
                  ? "Please wait…"
                  : isCreate
                  ? "Create account"
                  : "Sign in"}
              </button>
            </div>

            <div className="trust-line">
              <span className="trust-dot"></span>
              Used by residents across 12 partner municipalities
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/* ADMIN DASHBOARD                                                */
/* ============================================================ */
function Admin({
  active,
  model,
  status,
  currentUser,
  selectedIssueId,
  setSelectedIssueId,
  activeFilter,
  setActiveFilter,
}) {
  const filtered = model.adminIssues.filter(
    (i) => activeFilter === "All" || i.status === activeFilter
  );
  const selectedIssue =
    filtered.find((i) => i.id === selectedIssueId) || filtered[0] || null;

  const k = model.kpis;
  const kpi = (v) => (k && v != null ? v : "—");

  const officer =
    currentUser && model.officers.find((o) => o.user_id === currentUser.id);
  const profileName = currentUser ? currentUser.full_name : "Guest";
  const profileRole = currentUser ? (officer ? officer.role : "Resident") : "Not signed in";

  return (
    <section className={"screen" + (active ? " active" : "")} id="admin">
      <div className="admin-shell">
        <aside className="admin-side">
          <div className="wordmark">
            <span className="dot"></span>CIVIX
          </div>
          <div className="side-section-label">Workspace</div>
          <div className="side-nav">
            <a href="#" className="active">
              <span className="side-icon"></span>Issue queue
            </a>
            <a href="#">
              <span className="side-icon"></span>Map view
            </a>
            <a href="#">
              <span className="side-icon"></span>Departments
            </a>
            <a href="#">
              <span className="side-icon"></span>Analytics
            </a>
            <a href="#">
              <span className="side-icon"></span>Settings
            </a>
          </div>
          <div className="side-section-label">Departments</div>
          <div>
            {model.departments.map((d) => (
              <span key={d.id} className="dept-chip">
                {d.chip_label}
              </span>
            ))}
          </div>
        </aside>

        <div className="admin-main">
          <div className="admin-top">
            <div className="admin-search">🔍 Search by issue ID, street, or reporter</div>
            <div className="admin-profile">
              <div className="avatar">
                {currentUser ? initials(currentUser.full_name) : "?"}
              </div>
              {profileName} · {profileRole}
            </div>
          </div>

          <div className="admin-body">
            <Notice status={status} what="issues" style={{ marginBottom: 20 }} />

            <div className="admin-heading">
              <div>
                <h2>Issue queue</h2>
                <p>Sorted by priority, then time reported</p>
              </div>
              <button className="btn btn-dark btn-sm">Assign selected</button>
            </div>

            <div className="kpi-row">
              <div className="kpi warn">
                <div className="num">{kpi(k && k.urgentOpen)}</div>
                <div className="lbl">Critical / high priority open</div>
              </div>
              <div className="kpi">
                <div className="num">{kpi(k && k.open)}</div>
                <div className="lbl">Total open issues</div>
              </div>
              <div className="kpi ok">
                <div className="num">{kpi(k && k.resolvedThisWeek)}</div>
                <div className="lbl">Resolved this week</div>
              </div>
              <div className="kpi accent">
                <div className="num">
                  {k && k.avgResolutionDays != null
                    ? `${k.avgResolutionDays.toFixed(1)}d`
                    : "—"}
                </div>
                <div className="lbl">Average resolution time</div>
              </div>
            </div>

            <div className="admin-layout">
              <div className="table-card">
                <div className="table-toolbar">
                  <div className="filter-tabs">
                    {FILTERS.map((f) => (
                      <button
                        key={f}
                        className={activeFilter === f ? "active" : ""}
                        onClick={() => setActiveFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <span className="small muted">{filtered.length} results</span>
                </div>
                <table id="issues-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Category</th>
                      <th>Location</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th>Department</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted">
                          {status.loading ? "Loading issues…" : "No issues to show."}
                        </td>
                      </tr>
                    )}
                    {filtered.map((issue) => (
                      <tr
                        key={issue.id}
                        className={selectedIssue && selectedIssue.id === issue.id ? "selected" : ""}
                        onClick={() => setSelectedIssueId(issue.id)}
                      >
                        <td>{issue.code}</td>
                        <td>{issue.cat}</td>
                        <td>{issue.loc}</td>
                        <td>
                          <span className={"pri " + (PRIORITY_CLASS[issue.pri] || "pri-medium")}>
                            {issue.pri}
                          </span>
                        </td>
                        <td>
                          <span className={"badge " + (STATUS_BADGE[issue.status] || "b-pending")}>
                            <span className="badge-dot"></span>
                            {issue.status}
                          </span>
                        </td>
                        <td>{issue.deptShort}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="detail-panel" id="detail-panel">
                {selectedIssue ? (
                  <>
                    <div className="did">{selectedIssue.code}</div>
                    <h3>
                      {selectedIssue.cat} — {selectedIssue.loc}
                    </h3>
                    <p className="small muted" style={{ marginTop: 8, lineHeight: 1.5 }} id="dp-desc">
                      {selectedIssue.desc}
                    </p>
                    <div className="meta-row">
                      <span>Priority</span>
                      <span
                        id="dp-pri"
                        className={"pri " + (PRIORITY_CLASS[selectedIssue.pri] || "pri-medium")}
                      >
                        {selectedIssue.pri}
                      </span>
                    </div>
                    <div className="meta-row">
                      <span>Status</span>
                      <span id="dp-status">{selectedIssue.status}</span>
                    </div>
                    <div className="meta-row">
                      <span>Department</span>
                      <span id="dp-dept">{selectedIssue.dept}</span>
                    </div>
                    <div className="meta-row">
                      <span>Reported</span>
                      <span id="dp-time">{selectedIssue.reported}</span>
                    </div>
                    <div className="detail-actions">
                      <button className="btn btn-dark btn-sm" style={{ flex: 1 }}>
                        Assign officer
                      </button>
                      <button className="btn btn-outline btn-sm" style={{ flex: 1 }}>
                        Mark resolved
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="small muted">
                    {status.loading ? "Loading…" : "Select an issue to see its details."}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/* USER DASHBOARD                                                 */
/* ============================================================ */
function UserDashboard({ active, goTo, model, status, currentUser }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = currentUser ? currentUser.full_name.split(" ")[0] : "there";

  const myIssues = currentUser
    ? model.issues.filter((i) => i.reporter_id === currentUser.id).sort(newestFirst)
    : [];

  // Distances on "Nearby" are measured from the signed-in person's latest report.
  const originIssue = myIssues.find((i) => i.latitude != null && i.longitude != null);
  const origin = originIssue ? { lat: originIssue.latitude, lng: originIssue.longitude } : null;

  const nearby = model.issues
    .filter((i) => i.status !== "Resolved" && (!currentUser || i.reporter_id !== currentUser.id))
    .map((i) => ({
      issue: i,
      votes: model.upvoteCounts[i.id] || 0,
      dist:
        origin && i.latitude != null && i.longitude != null
          ? distanceMeters(origin, { lat: i.latitude, lng: i.longitude })
          : null,
    }))
    .sort((a, b) => b.votes - a.votes || newestFirst(a.issue, b.issue))
    .slice(0, 3);

  return (
    <section className={"screen" + (active ? " active" : "")} id="user">
      <div className="phone-stage">
        <div className="phone">
          <div className="phone-scroll">
            <div className="u-header">
              <div>
                <div className="u-greeting">{greeting}</div>
                <div className="u-name">{firstName}</div>
              </div>
              <div className="bell">🔔</div>
            </div>

            <div className="report-cta nav-link" onClick={goTo("report")}>
              <div>
                <div className="t">Report a new issue</div>
                <div className="s">Takes under a minute</div>
              </div>
              <div style={{ fontSize: 22 }}>＋</div>
            </div>

            <div className="u-section-title">
              <h3>Your reports</h3>
              <a href="#">See all</a>
            </div>
            <Notice status={status} what="reports" />
            {!currentUser && (
              <div className="nearby-card nav-link" onClick={goTo("login")}>
                <span>Sign in to see the reports you've submitted.</span>
              </div>
            )}
            {currentUser && !status.loading && !status.error && myIssues.length === 0 && (
              <div className="nearby-card">
                <span>You haven't reported anything yet.</span>
              </div>
            )}
            {myIssues.slice(0, 5).map((issue) => (
              <div className="issue-card" key={issue.id}>
                <div className="issue-ico">{issue.icon}</div>
                <div className="issue-info">
                  <h4>
                    {issue.cat} — {issue.loc}
                  </h4>
                  <p>Submitted {issue.reported}</p>
                  <div className="issue-meta">
                    <span className={"badge " + (STATUS_BADGE[issue.status] || "b-pending")}>
                      <span className="badge-dot"></span>
                      {issue.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}

            <div className="u-section-title">
              <h3>Nearby community reports</h3>
              <a href="#">Map</a>
            </div>
            {nearby.map(({ issue, votes, dist }) => (
              <div className="nearby-card" key={issue.id}>
                <span>
                  {issue.icon} {issue.cat} — {issue.loc}
                  {dist != null ? ` (${formatDistance(dist)} away)` : ""}
                </span>
                <span className="upvote">
                  <span className="arrow">▲</span>
                  {votes}
                </span>
              </div>
            ))}
            {nearby.length === 0 && !status.loading && !status.error && (
              <div className="nearby-card">
                <span>No open community reports right now.</span>
              </div>
            )}

            <div style={{ height: 12 }}></div>
          </div>

          <div className="tab-bar">
            <div className="tab-item active">
              <div className="ico"></div>Home
            </div>
            <div className="tab-item">
              <div className="ico"></div>My reports
            </div>
            <div className="tab-item">
              <div className="ico"></div>Map
            </div>
            <div className="tab-item">
              <div className="ico"></div>Profile
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/* REPORT A NEW ISSUE                                             */
/* ============================================================ */
function ReportIssue({
  active,
  goTo,
  model,
  status,
  activeCategory,
  setActiveCategory,
  currentUser,
  refresh,
}) {
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState(null); // { lat, lng } once the browser shares it
  const [locMessage, setLocMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
const [submitError, setSubmitError] = useState("");
const [submitSuccess, setSubmitSuccess] = useState("");

  const slug = activeCategory || (model.categories[0] && model.categories[0].slug);

  const fetchLocation = () => {
    if (!navigator.geolocation) {
      setLocMessage("Location isn't available in this browser.");
      return;
    }
    setLocMessage("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocMessage("");
      },
      () => setLocMessage("Couldn't get your location. Check your browser's permission."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };
const handleSubmit = async () => {
  if (submitting) return;

  setSubmitError("");
  setSubmitSuccess("");

  if (!currentUser) {
    setSubmitError("Please sign in before submitting a report.");
    return;
  }

  const token = localStorage.getItem("civix_user_token");

  if (!token) {
    setSubmitError("Please sign in again before submitting a report.");
    return;
  }

  if (!description.trim()) {
    setSubmitError("Please describe the issue before submitting.");
    return;
  }

  if (!slug || !model.categories.some((c) => c.slug === slug)) {
    setSubmitError("Please choose a valid issue category.");
    return;
  }

  setSubmitting(true);

  try {
    const result = await api("/issues/report", {
      method: "POST",
      headers: {
        "x-user-token": token,
      },
      body: JSON.stringify({
        category_slug: slug,
        description: description.trim(),
        latitude: location ? location.lat : null,
        longitude: location ? location.lng : null,
      }),
    });

    setDescription("");
    setLocation(null);
    setLocMessage("");

    setSubmitSuccess(
      `Report submitted successfully! Your reference number is ${result.public_code}.`
    );

    await refresh();
  } catch (err) {
    setSubmitError(err.message);
  } finally {
    setSubmitting(false);
  }
};

  // Duplicate detection: open reports in the same category close to the reporter.
  const similar = location
    ? model.issues
        .filter(
          (i) =>
            i.categorySlug === slug &&
            i.status !== "Resolved" &&
            i.latitude != null &&
            i.longitude != null
        )
        .map((i) => ({
          issue: i,
          dist: distanceMeters(location, { lat: i.latitude, lng: i.longitude }),
        }))
        .filter((x) => x.dist <= DUPLICATE_RADIUS_M)
        .sort((a, b) => a.dist - b.dist)
    : [];

  return (
    <section className={"screen" + (active ? " active" : "")} id="report">
      <div className="phone-stage">
        <div className="phone">
          <div className="phone-scroll">
            <div className="r-header">
              <div className="back-btn nav-link" onClick={goTo("user")}>
                ←
              </div>
              <h2>Report an issue</h2>
            </div>

            <Notice status={status} what="categories" />
            <div className="cat-grid">
              {model.categories.map((c) => (
                <button
                  key={c.id}
                  className={"cat-btn" + (slug === c.slug ? " active" : "")}
                  onClick={() => setActiveCategory(c.slug)}
                >
                  <span className="ic">{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>

            <div className="form-block">
              <label>Description</label>
              <textarea
                placeholder="What's going on, and how bad is it?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />

              <label style={{ marginTop: 16 }}>Location</label>
              <button className="loc-btn" onClick={fetchLocation}>
                {location
                  ? `📍 Location set — ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
                  : `📍 ${locMessage || "Use current location"}`}
              </button>

              <div
                id="dup-alert"
                className={"dup-alert" + (similar.length > 0 ? " show" : "")}
              >
                {similar.length > 0 && (
                  <>
                    <strong>
                      {similar.length} similar report{similar.length === 1 ? "" : "s"} nearby
                    </strong>
                    This looks like an issue already flagged {Math.round(similar[0].dist)}m from
                    here. Consider upvoting it instead so it's prioritized faster.
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-outline btn-sm">
                        View & upvote existing report
                      </button>
                    </div>
                  </>
                )}
              </div>

              <label style={{ marginTop: 16 }}>Photo</label>
              <div className="upload-box">
                📷 Tap to add a photo (optional but helps triage)
              </div>

              {submitError && (
  <div className="form-error" role="alert">
    {submitError}
  </div>
)}

{submitSuccess && (
  <div className="api-notice" role="status" style={{ marginTop: 12 }}>
    {submitSuccess}
  </div>
)}

<button
  type="button"
  className="btn btn-primary btn-block"
  style={{ marginTop: 22 }}
  onClick={handleSubmit}
  disabled={submitting}
>
  {submitting ? "Submitting report…" : "Submit report"}
</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================ */
/* STYLES — identical rules to the original mockup.html          */
/* ============================================================ */
const STYLES = `
  :root{
    --ink:#182A3A;
    --ink-2:#22384C;
    --paper:#F4F0E6;
    --paper-2:#EAE3D2;
    --signal:#E7A33B;
    --signal-dark:#B87A1F;
    --moss:#3F7A5B;
    --moss-dark:#2E5C44;
    --brick:#C1502E;
    --line:#D9D1BE;
    --line-dark:#3A5068;
    --white:#FFFFFF;
    --muted:#5E6A72;
    --muted-lt:#8B96A8;
    --radius-sm:4px;
    --radius-md:10px;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    background:var(--paper);
    color:var(--ink);
    font-family:'Inter',sans-serif;
    -webkit-font-smoothing:antialiased;
    padding-top:52px;
  }
  h1,h2,h3,.display{
    font-family:'Fraunces',serif;
    font-weight:600;
    letter-spacing:-0.01em;
    margin:0;
  }
  p{margin:0;}
  a{color:inherit;text-decoration:none;}
  button{font-family:inherit;cursor:pointer;}
  ::selection{background:var(--signal);color:var(--ink);}

  /* ============ PROTOTYPE SWITCHER (not part of product UI) ============ */
  .proto-bar{
    position:fixed;top:0;left:0;right:0;height:52px;
    background:var(--ink);
    display:flex;align-items:center;gap:6px;
    padding:0 16px;
    z-index:999;
    overflow-x:auto;
    border-bottom:2px solid var(--signal);
  }
  .proto-label{
    color:var(--muted-lt);
    font-size:12px;
    letter-spacing:0.02em;
    margin-right:10px;
    white-space:nowrap;
    font-weight:500;
  }
  .proto-tab{
    background:transparent;
    border:1px solid transparent;
    color:#C9D2DC;
    padding:7px 13px;
    border-radius:20px;
    font-size:13px;
    font-weight:500;
    white-space:nowrap;
    transition:background .15s, color .15s;
  }
  .proto-tab:hover{background:rgba(255,255,255,0.08);}
  .proto-tab.active{background:var(--signal);color:var(--ink);font-weight:600;}

  .screen{display:none;}
  .screen.active{display:block;}

  /* ============ SHARED: PHONE FRAME ============ */
  .phone-stage{
    min-height:calc(100vh - 52px);
    display:flex;align-items:center;justify-content:center;
    background:
      radial-gradient(circle at 20% 20%, #2A415A 0%, transparent 45%),
      var(--ink);
    padding:48px 20px;
  }
  .phone{
    width:375px;
    max-width:100%;
    height:780px;
    background:var(--paper);
    border-radius:38px;
    border:10px solid #0E1822;
    box-shadow:0 30px 60px -20px rgba(0,0,0,0.6);
    position:relative;
    overflow:hidden;
    display:flex;
    flex-direction:column;
  }
  .phone::before{
    content:"";
    position:absolute;top:0;left:50%;transform:translateX(-50%);
    width:120px;height:22px;
    background:#0E1822;
    border-bottom-left-radius:14px;
    border-bottom-right-radius:14px;
    z-index:5;
  }
  .phone-scroll{
    flex:1;overflow-y:auto;
    padding-top:26px;
  }
  .phone-scroll::-webkit-scrollbar{width:0;}

  /* ============ TYPE HELPERS ============ */
  .eyebrow{
    font-size:12.5px;
    color:var(--moss-dark);
    font-weight:600;
  }
  .muted{color:var(--muted);}
  .small{font-size:13px;}

  /* ============ LANDING PAGE ============ */
  #landing .l-nav{
    display:flex;align-items:center;justify-content:space-between;
    padding:22px 56px;
    border-bottom:1px solid var(--line);
  }
  .wordmark{
    font-family:'Fraunces',serif;
    font-weight:700;
    font-size:22px;
    color:var(--ink);
    display:flex;align-items:center;gap:8px;
  }
  .wordmark .dot{width:9px;height:9px;background:var(--signal);border-radius:50%;display:inline-block;}
  .l-nav-links{display:flex;gap:34px;align-items:center;font-size:14.5px;font-weight:500;color:var(--muted);}
  .l-nav-actions{display:flex;gap:12px;align-items:center;}

  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    padding:11px 22px;
    border-radius:var(--radius-sm);
    font-size:14.5px;font-weight:600;
    border:1.5px solid transparent;
    transition:transform .12s ease, background .15s ease;
  }
  .btn:active{transform:scale(0.98);}
  .btn-primary{background:var(--signal);color:var(--ink);}
  .btn-primary:hover{background:var(--signal-dark);}
  .btn-dark{background:var(--ink);color:var(--white);}
  .btn-dark:hover{background:var(--ink-2);}
  .btn-outline{border-color:var(--ink);color:var(--ink);background:transparent;}
  .btn-outline:hover{background:var(--ink);color:var(--white);}
  .btn-outline-light{border-color:rgba(255,255,255,0.4);color:var(--white);background:transparent;}
  .btn-outline-light:hover{background:rgba(255,255,255,0.12);}
  .btn-block{width:100%;}
  .btn-sm{padding:8px 14px;font-size:13px;}

  .hero{
    display:grid;grid-template-columns:1.05fr 0.95fr;
    gap:40px;
    padding:64px 56px 40px;
    align-items:center;
  }
  .hero h1{font-size:48px;line-height:1.08;color:var(--ink);}
  .hero .lead{font-size:17px;color:var(--muted);margin-top:20px;max-width:460px;line-height:1.55;}
  .hero-actions{display:flex;gap:14px;margin-top:32px;}
  .hero-visual{display:flex;justify-content:center;}

  .mini-phone{
    width:250px;height:510px;
    background:var(--white);
    border:8px solid var(--ink);
    border-radius:28px;
    position:relative;
    overflow:hidden;
    box-shadow:14px 18px 0 var(--paper-2), 14px 18px 0 1px var(--line);
  }
  .mini-phone-notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:80px;height:16px;background:var(--ink);border-bottom-left-radius:10px;border-bottom-right-radius:10px;z-index:2;}
  .mini-phone-body{padding:24px 16px 16px;height:100%;overflow:hidden;}

  .stat-row{
    display:grid;grid-template-columns:repeat(3,1fr);
    border-top:1px solid var(--line);border-bottom:1px solid var(--line);
    margin:36px 56px 0;
  }
  .stat{
    padding:26px 20px;
    border-right:1px solid var(--line);
  }
  .stat:last-child{border-right:none;}
  .stat .num{font-family:'Fraunces',serif;font-size:34px;font-weight:600;color:var(--ink);}
  .stat .lbl{font-size:13.5px;color:var(--muted);margin-top:4px;}

  .section{padding:72px 56px;}
  .section-head{max-width:560px;margin-bottom:40px;}
  .section-head h2{font-size:30px;color:var(--ink);}
  .section-head p{margin-top:12px;color:var(--muted);font-size:15.5px;line-height:1.6;}

  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;}
  .step .n{font-family:'Fraunces',serif;font-size:44px;font-weight:600;color:var(--signal-dark);}
  .step h3{font-size:18px;margin-top:10px;color:var(--ink);}
  .step p{margin-top:8px;color:var(--muted);font-size:14.5px;line-height:1.6;}

  .quote-block{
    background:var(--ink);
    color:var(--white);
    padding:56px;
    margin:0 56px;
    border-radius:var(--radius-md);
    display:grid;grid-template-columns:auto 1fr;gap:28px;align-items:center;
  }
  .quote-mark{font-family:'Fraunces',serif;font-size:64px;color:var(--signal);line-height:1;}
  .quote-block blockquote{font-family:'Fraunces',serif;font-size:22px;font-weight:500;line-height:1.5;}
  .quote-block cite{display:block;margin-top:14px;font-style:normal;font-size:13.5px;color:#B9C2CD;}

  .cta-band{
    background:var(--paper-2);
    margin:56px;
    border-radius:var(--radius-md);
    padding:48px 56px;
    display:flex;align-items:center;justify-content:space-between;
    gap:24px;
    border:1px solid var(--line);
  }
  .cta-band h2{font-size:26px;color:var(--ink);max-width:420px;}

  footer{
    border-top:1px solid var(--line);
    padding:36px 56px;
    display:flex;justify-content:space-between;align-items:center;
    color:var(--muted);
    font-size:13.5px;
  }
  .footer-links{display:flex;gap:24px;}

  /* ============ LOGIN ============ */
  .login-head{padding:0 26px;text-align:center;margin-top:6px;}
  .login-head .wordmark{justify-content:center;font-size:20px;margin-bottom:6px;}
  .login-head p{color:var(--muted);font-size:13.5px;margin-top:6px;}

  .segmented{
    display:flex;
    margin:26px 26px 0;
    background:var(--paper-2);
    border-radius:24px;
    padding:4px;
  }
  .segmented button{
    flex:1;border:none;background:transparent;
    padding:9px 0;border-radius:20px;
    font-size:13.5px;font-weight:600;color:var(--muted);
  }
  .segmented button.active{background:var(--ink);color:var(--white);}

  .field-group{padding:22px 26px 0;}
  .field{margin-bottom:16px;}
  .field label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:6px;}
  .field input{
    width:100%;padding:12px 14px;
    border:1.5px solid var(--line);
    border-radius:var(--radius-sm);
    font-size:14.5px;font-family:inherit;
    background:var(--white);
    color:var(--ink);
  }
  .field input:focus{outline:2px solid var(--signal);outline-offset:1px;border-color:var(--signal);}
  .field-link{font-size:12.5px;color:var(--moss-dark);font-weight:600;text-align:right;display:block;margin-top:-8px;margin-bottom:18px;}

  .trust-line{
    display:flex;align-items:center;gap:8px;
    margin:28px 26px 0;
    padding:12px 14px;
    background:var(--paper-2);
    border-radius:var(--radius-sm);
    font-size:12px;color:var(--muted);
  }
  .trust-dot{width:7px;height:7px;border-radius:50%;background:var(--moss);flex-shrink:0;}

  /* ============ ADMIN DASHBOARD ============ */
  .admin-shell{display:flex;min-height:calc(100vh - 52px);}
  .admin-side{
    width:230px;flex-shrink:0;
    background:var(--ink);
    color:#C9D2DC;
    padding:26px 18px;
  }
  .admin-side .wordmark{color:var(--white);font-size:19px;margin-bottom:30px;}
  .side-section-label{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted-lt);margin:20px 0 8px 10px;}
  .side-nav a{
    display:flex;align-items:center;gap:10px;
    padding:9px 10px;border-radius:6px;
    font-size:14px;font-weight:500;
    color:#C9D2DC;margin-bottom:2px;
  }
  .side-nav a.active{background:rgba(231,163,59,0.16);color:var(--signal);}
  .side-nav a:hover:not(.active){background:rgba(255,255,255,0.06);}
  .side-icon{width:7px;height:7px;border-radius:2px;background:currentColor;flex-shrink:0;opacity:.8;}
  .dept-chip{
    display:inline-flex;align-items:center;gap:6px;
    font-size:12.5px;padding:6px 10px;
    border:1px solid rgba(255,255,255,0.15);
    border-radius:16px;margin:3px 4px 0 0;color:#C9D2DC;
  }

  .admin-main{flex:1;min-width:0;background:var(--paper);}
  .admin-top{
    display:flex;align-items:center;justify-content:space-between;
    padding:18px 30px;border-bottom:1px solid var(--line);
    background:var(--white);
  }
  .admin-search{
    display:flex;align-items:center;gap:8px;
    background:var(--paper-2);
    border-radius:20px;padding:9px 16px;
    width:320px;font-size:13.5px;color:var(--muted);
  }
  .admin-profile{display:flex;align-items:center;gap:10px;font-size:13.5px;font-weight:600;}
  .avatar{width:32px;height:32px;border-radius:50%;background:var(--signal);color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;}

  .admin-body{padding:28px 30px;}
  .admin-heading{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:22px;}
  .admin-heading h2{font-size:24px;}
  .admin-heading p{color:var(--muted);font-size:13.5px;margin-top:4px;}

  .kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:26px;}
  .kpi{
    background:var(--white);border:1px solid var(--line);
    border-top:3px solid var(--ink);
    border-radius:var(--radius-sm);
    padding:16px 18px;
  }
  .kpi.warn{border-top-color:var(--brick);}
  .kpi.ok{border-top-color:var(--moss);}
  .kpi.accent{border-top-color:var(--signal);}
  .kpi .num{font-family:'Fraunces',serif;font-size:28px;font-weight:600;}
  .kpi .lbl{font-size:12.5px;color:var(--muted);margin-top:2px;}

  .table-card{background:var(--white);border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;}
  .table-toolbar{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);}
  .filter-tabs{display:flex;gap:4px;}
  .filter-tabs button{
    background:transparent;border:1px solid transparent;
    padding:7px 13px;border-radius:16px;font-size:13px;font-weight:500;color:var(--muted);
  }
  .filter-tabs button.active{background:var(--ink);color:var(--white);}

  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  thead th{
    text-align:left;padding:11px 18px;
    font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;
    color:var(--muted);border-bottom:1px solid var(--line);
  }
  tbody td{padding:13px 18px;border-bottom:1px solid var(--line);vertical-align:middle;}
  tbody tr{cursor:pointer;transition:background .12s;}
  tbody tr:hover{background:var(--paper-2);}
  tbody tr.selected{background:#FBF1DF;}
  tbody tr:last-child td{border-bottom:none;}

  .badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:4px 10px;border-radius:12px;}
  .badge-dot{width:6px;height:6px;border-radius:50%;}
  .b-pending{background:#F5EAD4;color:#8A5A12;}
  .b-pending .badge-dot{background:#C6821F;}
  .b-progress{background:#DDE6EF;color:#22506E;}
  .b-progress .badge-dot{background:#2F6C97;}
  .b-resolved{background:#DEEBE3;color:#2E5C44;}
  .b-resolved .badge-dot{background:var(--moss);}
  .b-reopened{background:#F3DAD1;color:#8C3A22;}
  .b-reopened .badge-dot{background:var(--brick);}

  .pri{font-size:12px;font-weight:700;}
  .pri-critical{color:var(--brick);}
  .pri-high{color:var(--signal-dark);}
  .pri-medium{color:#5E6A72;}
  .pri-low{color:var(--muted-lt);}

  .admin-layout{display:grid;grid-template-columns:1fr 300px;gap:20px;align-items:start;}
  .detail-panel{background:var(--white);border:1px solid var(--line);border-radius:var(--radius-sm);padding:20px;position:sticky;top:80px;}
  .detail-panel .did{font-size:12px;color:var(--muted-lt);font-weight:600;}
  .detail-panel h3{font-size:17px;margin-top:6px;}
  .detail-panel .meta-row{display:flex;justify-content:space-between;font-size:13px;padding:9px 0;border-bottom:1px dashed var(--line);}
  .detail-panel .meta-row span:first-child{color:var(--muted);}
  .detail-actions{display:flex;gap:8px;margin-top:16px;}

  /* ============ USER DASHBOARD (phone) ============ */
  .u-header{display:flex;justify-content:space-between;align-items:center;padding:0 20px;}
  .u-greeting{font-size:12.5px;color:var(--muted);}
  .u-name{font-family:'Fraunces',serif;font-size:20px;font-weight:600;margin-top:2px;}
  .bell{width:36px;height:36px;border-radius:50%;background:var(--white);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;position:relative;}
  .bell::after{content:"";position:absolute;top:8px;right:9px;width:6px;height:6px;background:var(--brick);border-radius:50%;}

  .report-cta{
    margin:18px 20px 0;
    background:var(--ink);color:var(--white);
    border-radius:var(--radius-md);
    padding:18px 20px;
    display:flex;justify-content:space-between;align-items:center;
  }
  .report-cta .t{font-family:'Fraunces',serif;font-size:16.5px;font-weight:600;}
  .report-cta .s{font-size:12px;color:#B9C2CD;margin-top:3px;}

  .u-section-title{display:flex;justify-content:space-between;align-items:center;margin:26px 20px 10px;}
  .u-section-title h3{font-size:14.5px;}
  .u-section-title a{font-size:12.5px;color:var(--moss-dark);font-weight:600;}

  .issue-card{
    margin:0 20px 10px;
    background:var(--white);border:1px solid var(--line);
    border-radius:var(--radius-sm);
    padding:13px 14px;
    display:flex;gap:12px;align-items:flex-start;
  }
  .issue-ico{width:34px;height:34px;border-radius:8px;background:var(--paper-2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:15px;}
  .issue-info h4{font-size:13.5px;font-weight:600;margin:0 0 3px;}
  .issue-info p{font-size:12px;color:var(--muted);}
  .issue-meta{margin-top:6px;display:flex;gap:8px;align-items:center;}

  .nearby-card{
    margin:0 20px 10px;
    background:transparent;border:1px dashed var(--line);
    border-radius:var(--radius-sm);
    padding:12px 14px;
    display:flex;justify-content:space-between;align-items:center;
    font-size:12.5px;
  }
  .upvote{display:flex;flex-direction:column;align-items:center;font-size:11px;color:var(--muted);font-weight:600;}
  .upvote .arrow{color:var(--moss);font-size:14px;}

  .tab-bar{
    display:flex;border-top:1px solid var(--line);
    background:var(--white);
    padding:10px 0 14px;
  }
  .tab-item{flex:1;text-align:center;font-size:11px;color:var(--muted-lt);font-weight:600;}
  .tab-item .ico{width:18px;height:18px;margin:0 auto 4px;border-radius:5px;background:var(--paper-2);}
  .tab-item.active{color:var(--ink);}
  .tab-item.active .ico{background:var(--signal);}

  /* ============ REPORT ISSUE (phone) ============ */
  .r-header{display:flex;align-items:center;gap:12px;padding:0 20px 14px;}
  .back-btn{width:32px;height:32px;border-radius:50%;background:var(--white);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:15px;}
  .r-header h2{font-size:17px;}

  .cat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:0 20px;}
  .cat-btn{
    background:var(--white);border:1.5px solid var(--line);
    border-radius:var(--radius-sm);
    padding:14px 6px;text-align:center;
    font-size:12px;font-weight:600;color:var(--muted);
  }
  .cat-btn .ic{font-size:20px;display:block;margin-bottom:6px;}
  .cat-btn.active{border-color:var(--signal);background:#FBF1DF;color:var(--signal-dark);}

  .form-block{padding:20px;}
  .form-block label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:6px;}
  textarea{
    width:100%;border:1.5px solid var(--line);border-radius:var(--radius-sm);
    padding:12px 14px;font-family:inherit;font-size:14px;resize:none;height:78px;
    background:var(--white);color:var(--ink);
  }
  textarea:focus{outline:2px solid var(--signal);outline-offset:1px;border-color:var(--signal);}
  .loc-btn{
    display:flex;align-items:center;gap:8px;
    border:1.5px dashed var(--line);border-radius:var(--radius-sm);
    padding:12px 14px;font-size:13.5px;color:var(--moss-dark);font-weight:600;
    margin-top:8px;background:transparent;width:100%;
  }
  .upload-box{
    border:1.5px dashed var(--line);border-radius:var(--radius-sm);
    padding:22px 14px;text-align:center;margin-top:8px;color:var(--muted-lt);font-size:12.5px;
  }
  .dup-alert{
    display:none;
    margin-top:16px;
    background:#FBF1DF;border:1px solid #EBD3A0;
    border-radius:var(--radius-sm);
    padding:12px 14px;
    font-size:12.5px;color:#8A5A12;
  }
  .dup-alert.show{display:block;}
  .dup-alert strong{display:block;font-size:13px;margin-bottom:3px;}

  /* ============ RESPONSIVE ============ */
  @media (max-width:900px){
    .hero{grid-template-columns:1fr;padding:40px 24px;}
    .l-nav{padding:18px 24px;}
    .l-nav-links{display:none;}
    .stat-row{grid-template-columns:1fr;margin:36px 24px 0;}
    .stat{border-right:none;border-bottom:1px solid var(--line);}
    .section{padding:48px 24px;}
    .steps{grid-template-columns:1fr;}
    .quote-block{grid-template-columns:1fr;margin:0 24px;padding:32px;}
    .cta-band{margin:24px;flex-direction:column;align-items:flex-start;padding:32px 28px;}
    footer{flex-direction:column;gap:14px;padding:28px 24px;}
    .admin-shell{flex-direction:column;}
    .admin-side{width:100%;}
    .kpi-row{grid-template-columns:repeat(2,1fr);}
    .admin-layout{grid-template-columns:1fr;}
    .admin-search{width:180px;}
  }
  /* ============ API STATES (added when data moved to the server) ============ */
  .api-notice{
    padding:12px 14px;
    border:1px dashed var(--line);
    border-radius:var(--radius-sm);
    font-size:12.5px;color:var(--muted);
    background:var(--white);
  }
  .phone .api-notice{margin:0 20px 10px;}
  .api-notice.error{border:1px solid #EBB5A4;background:#F3DAD1;color:#8C3A22;}
  .link-btn{
    background:none;border:none;padding:0;
    font-size:inherit;font-weight:600;color:inherit;
    text-decoration:underline;
  }
  .form-error{
    margin-bottom:14px;padding:10px 12px;
    background:#F3DAD1;border:1px solid #EBB5A4;
    border-radius:var(--radius-sm);
    font-size:12.5px;color:#8C3A22;
  }
  .btn:disabled{cursor:default;}
`;
