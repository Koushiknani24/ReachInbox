import React, { useEffect, useState, useRef, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  UploadCloud,
  X,
  AlertCircle,
  Menu,
  SlidersHorizontal,
} from "lucide-react";
import "./styles.css";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";

type User = {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
  operator: boolean;
  slack: { team_name: string; channel_name: string } | null;
  slack_notification: {
    state: "pending" | "sent" | "skipped" | "error";
    limit_value: number;
    notified_at: string | null;
    error: string | null;
    created_at: string;
    sender_email: string;
  } | null;
};
type Sender = {
  id: string;
  name: string;
  email: string;
  hourly_limit: number;
  hour_count: number;
  hour_start: string;
  is_default?: boolean;
};
type Email = {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduled_at: string;
  next_attempt_at: string;
  sent_at: string | null;
  sender_name: string;
  sender_email: string;
  preview_url: string | null;
  error: string | null;
  reason: string | null;
};
type Config = {
  googleReady: boolean;
  slackReady: boolean;
  minimumDelay: number;
  maxHourlyLimit: number;
  maxRecipients: number;
};
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || "Unable to complete this request.");
  return body;
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const formatDate = (v: string | null) =>
  v
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(v))
    : "—";
const localDate = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
function Logo() {
  return (
    <div className="logo">
      <img
        src="/brand/outbox-logo.svg"
        alt="Outbox"
        width="2307"
        height="333"
      />
    </div>
  );
}
function Spinner() {
  return <Loader2 className="spin" size={18} />;
}
function SenderLimit({
  sender,
  max,
  onSaved,
}: {
  sender: Sender;
  max: number;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(sender.hourly_limit),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="sender-limit">
      <label htmlFor={`limit-${sender.id}`}>Emails / hour</label>
      <div>
        <input
          id={`limit-${sender.id}`}
          type="number"
          min={1}
          max={max}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
        />
        <button
          className="icon-button"
          aria-label={`Save limit for ${sender.name}`}
          disabled={busy || value === sender.hourly_limit}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api(`/api/senders/${sender.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ hourlyLimit: value }),
              });
              onSaved();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <Check size={16} />}
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
function AddSenderForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!open)
    return (
      <button className="secondary-button" onClick={() => setOpen(true)}>
        <Plus size={16} />
        Add sender
      </button>
    );
  return (
    <form
      className="add-sender-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("/api/senders", post({ name, email, password }));
          setPassword("");
          setName("");
          setEmail("");
          setOpen(false);
          onAdded();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add an Ethereal sender</h3>
      <p className="muted">
        Enter your Ethereal account credentials. We'll verify the connection
        before saving.
      </p>
      <fieldset disabled={busy}>
        <label className="form-label" htmlFor="new-sender-name">
          Sender name
        </label>
        <input
          className="form-input"
          id="new-sender-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          placeholder="e.g. Outreach team"
        />
        <label className="form-label" htmlFor="new-sender-email">
          Ethereal email
        </label>
        <input
          className="form-input"
          id="new-sender-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="off"
          placeholder="your-account@ethereal.email"
        />
        <label className="form-label" htmlFor="new-sender-password">
          Ethereal password
        </label>
        <input
          className="form-input"
          id="new-sender-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          maxLength={256}
        />
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="sender-form-actions">
          <button className="primary-button" type="submit">
            {busy ? <Spinner /> : <Check size={16} />}{" "}
            {busy ? "Verifying sender..." : "Save sender"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setOpen(false);
              setPassword("");
              setError("");
            }}
          >
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [config, setConfig] = useState<Config>({
      googleReady: false,
      slackReady: false,
      minimumDelay: 2000,
      maxHourlyLimit: 200,
      maxRecipients: 10000,
    });
  const [view, setView] = useState<"scheduled" | "sent">("scheduled"),
    [compose, setCompose] = useState(false),
    [settings, setSettings] = useState(false),
    [selected, setSelected] = useState<Email | null>(null),
    [mobile, setMobile] = useState(false);
  const [senders, setSenders] = useState<Sender[]>([]),
    [stats, setStats] = useState({ scheduled: 0, sent: 0, failed: 0 }),
    [items, setItems] = useState<Email[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [revision, setRevision] = useState(0),
    [provisioning, setProvisioning] = useState(false);
  const [senderError, setSenderError] = useState("");
  const [removingSender, setRemovingSender] = useState<string | null>(null);
  const refresh = () => setRevision((r) => r + 1);
  useEffect(() => {
    Promise.all([
      api<Config>("/api/config").then(setConfig),
      api<User>("/api/me")
        .then(setUser)
        .catch(() => {}),
    ]).finally(() => setBoot(false));
    const p = new URLSearchParams(location.search);
    const e = p.get("error");
    if (e)
      setError(
        (
          {
            google_setup:
              "Google sign-in is being configured. Please try again shortly.",
            login_cancelled: "Sign-in was cancelled. Please try again.",
            login_failed:
              "Google sign-in could not be completed. Please try again.",
            slack_setup: "Slack connection is being configured.",
            slack_cancelled: "Slack connection was cancelled.",
            slack_non_distributed:
              "This Slack app is limited to its original workspace. Enable unlisted distribution in Slack under Settings → Manage Distribution, then try Connect Slack again.",
            slack_failed: "Slack could not connect. Please try again.",
          } as Record<string, string>
        )[e] || "Please try again.",
      );
    if (p.get("connected")) setToast("Slack connected successfully.");
    if (e || p.get("connected"))
      history.replaceState({}, "", location.pathname);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!user) return;
    const t = setInterval(refresh, 7000);
    return () => clearInterval(t);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<Sender[]>("/api/senders")
      .then((s) => {
        if (alive) {
          setSenders(s);
          setSenderError("");
        }
      })
      .catch((e) => {
        if (alive) setSenderError(e.message);
      });
    api<typeof stats>("/api/stats")
      .then((n) => {
        if (alive) setStats(n);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [user, revision]);
  useEffect(() => {
    if (!user || !settings) return;
    api<User>("/api/me").then(setUser).catch(() => {});
  }, [settings, revision]);
  useEffect(() => {
    if (!user || compose) return;
    let alive = true;
    setLoading(true);
    api<{ items: Email[]; total: number }>(
      `/api/emails?view=${view}&page=${page}&q=${encodeURIComponent(search)}`,
    )
      .then((data) => {
        if (alive) {
          setItems(data.items);
          setTotal(data.total);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [user, view, page, search, revision, compose]);
  useEffect(() => {
    if (!selected && !settings) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setSettings(false);
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [selected, settings]);
  async function provision() {
    setProvisioning(true);
    setSenderError("");
    try {
      await api("/api/senders/provision", post({}));
      refresh();
      setToast("Your sender accounts are ready.");
    } catch (e) {
      setSenderError((e as Error).message);
    } finally {
      setProvisioning(false);
    }
  }
  async function logout() {
    await api("/api/logout", post({}));
    setUser(null);
    setItems([]);
  }
  async function removeSender(id: string) {
    setRemovingSender(id);
    setSenderError("");
    try {
      await api(`/api/senders/${id}`, { method: "DELETE" });
      setSenders((current) => current.filter((s) => s.id !== id));
      refresh();
      setToast(
        "Sender removed from your account. Existing scheduled emails will still send.",
      );
    } catch (e) {
      setSenderError((e as Error).message);
    } finally {
      setRemovingSender(null);
    }
  }
  function changeView(v: "scheduled" | "sent") {
    setView(v);
    setCompose(false);
    setPage(1);
    setQuery("");
    setMobile(false);
  }
  if (boot)
    return (
      <div className="boot">
        <Logo />
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <div className="login-layout">
        <div className="login-brand">
          <Logo />
          <div className="brand-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="art-envelope">
              <Mail size={76} strokeWidth={1} />
              <span className="art-check">
                <Check size={19} />
              </span>
            </div>
            <div className="floating-card card-one">
              <span className="icon-tile">
                <Clock3 size={18} />
              </span>
              <span>
                Right on time<small>Your next email is scheduled</small>
              </span>
            </div>
            <div className="floating-card card-two">
              <span className="avatar green">A</span>
              <span>
                Message delivered
                <small>A little closer to a conversation</small>
              </span>
              <CheckCircle2 size={18} color="#168858" />
            </div>
          </div>
          <div className="login-brand-copy">
            <span className="eyebrow">
              A LITTLE PLANNING. MORE CONNECTIONS.
            </span>
            <h1>
              Good conversations
              <br />
              start with good timing.
            </h1>
            <p>
              A thoughtful space to write, schedule, and keep track of your
              outreach.
            </p>
          </div>
          <span className="brand-footer">Made for your next conversation.</span>
        </div>
        <main className="login-main">
          <div className="login-box">
            <div className="login-mobile-logo">
              <Logo />
            </div>
            <span className="login-overline">YOUR EMAIL WORKSPACE</span>
            <h2>Welcome to Outbox</h2>
            <p>
              Sign in to pick up where your next
              <br />
              conversation begins.
            </p>
            {error && (
              <div className="error-banner" role="alert">
                <AlertCircle size={18} />
                {error}
              </div>
            )}
            <a className="google-button" href="/auth/google">
              <svg
                width="20"
                height="20"
                viewBox="0 0 48 48"
                aria-hidden="true"
              >
                <path
                  fill="#4285F4"
                  d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.9-3.6 6.1-8.9 6.1-14.9Z"
                />
                <path
                  fill="#34A853"
                  d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.2A20.4 20.4 0 0 0 24 44Z"
                />
                <path
                  fill="#FBBC05"
                  d="M12.6 27.6a12.2 12.2 0 0 1 0-7.2v-5.2H5.8a20 20 0 0 0 0 17.6l6.8-5.2Z"
                />
                <path
                  fill="#EA4335"
                  d="M24 12c3 0 5.6 1 7.7 3l5.8-5.8A19.5 19.5 0 0 0 24 4 20.4 20.4 0 0 0 5.8 15.2l6.8 5.2C14.2 15.6 18.7 12 24 12Z"
                />
              </svg>
              Continue with Google
              <ArrowRight size={17} />
            </a>
            <div className="login-divider">
              <span />
            </div>
            <p className="login-note">
              <ShieldCheck size={16} /> Your workspace, securely connected.
            </p>
          </div>
          <div className="login-footer">
            Outbox Workspace <span>Plan. Send. Connect.</span>
          </div>
        </main>
      </div>
    );
  return (
    <div className="workspace">
      {mobile && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "sidebar-open" : ""}`}>
        <Logo />
        <button
          className="sidebar-close icon-button"
          aria-label="Close navigation panel"
          onClick={() => setMobile(false)}
        >
          <X size={18} />
        </button>
        <button className="user-card" onClick={() => setSettings(true)}>
          {user.avatar_url ? (
            <img
              className="avatar"
              src={user.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="avatar">{user.name[0]}</span>
          )}
          <span>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="compose-button"
          onClick={() => {
            setCompose(true);
            setMobile(false);
            setError("");
          }}
        >
          <Plus size={18} />
          Compose new email
        </button>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          <button
            className={view === "scheduled" && !compose ? "active" : ""}
            onClick={() => changeView("scheduled")}
          >
            <Clock3 size={18} />
            Scheduled<span>{stats.scheduled}</span>
          </button>
          <button
            className={view === "sent" && !compose ? "active" : ""}
            onClick={() => changeView("sent")}
          >
            <Send size={18} />
            Sent emails<span>{stats.sent + stats.failed}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="slack-card">
            <div>
              <SlackIcon />
              <strong>Keep your team in sync</strong>
            </div>
            <p>
              {user.slack
                ? `Connected to ${user.slack.channel_name}`
                : "Get a heads-up when a sender reaches its hourly limit."}
            </p>
            {user.slack ? (
              <button onClick={() => setSettings(true)}>
                <span className="connection-dot" />
                Slack connected
                <Settings2 size={14} />
              </button>
            ) : (
              <a href="/auth/slack">
                Connect Slack
                <ArrowRight size={15} />
              </a>
            )}
          </div>
          <button className="settings-button" onClick={() => setSettings(true)}>
            <Settings2 size={17} />
            Workspace settings
          </button>
          <button className="settings-button" onClick={logout}>
            <LogOut size={17} />
            Log out
          </button>
          <div className="sidebar-foot">
            <span className="connection-dot" />
            All set for your next send
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-toggle"
            onClick={() => setMobile(!mobile)}
            aria-label="Toggle navigation"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>
              {compose
                ? "Compose"
                : view === "scheduled"
                  ? "Scheduled emails"
                  : "Sent emails"}
            </span>
          </div>
          <span className="workspace-label">
            <span className="connection-dot" />
            Your workspace
          </span>
        </header>
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={18} />
            {toast}
            <button onClick={() => setToast("")} aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner workspace-error" role="alert">
            <AlertCircle size={18} />
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}
        {senderError && (
          <div className="error-banner workspace-error" role="alert">
            <AlertCircle size={18} />
            {senderError}
            <button
              className="text-button"
              onClick={provision}
              disabled={provisioning}
            >
              Retry sender setup
            </button>
          </div>
        )}
        {compose ? (
          <Compose
            senders={senders}
            config={config}
            onBack={() => setCompose(false)}
            onSuccess={(count) => {
              setCompose(false);
              changeView("scheduled");
              refresh();
              setToast(
                `${count} ${count === 1 ? "email" : "emails"} scheduled successfully.`,
              );
            }}
            onProvision={provision}
            provisioning={provisioning}
          />
        ) : (
          <>
            <section className="page-heading">
              <div>
                <div className="eyebrow">YOUR OUTREACH, ORGANIZED</div>
                <h1>
                  {view === "scheduled" ? "Scheduled emails" : "Sent emails"}
                  <span className="heading-count">
                    {view === "scheduled"
                      ? stats.scheduled
                      : stats.sent + stats.failed}
                  </span>
                </h1>
                <p>
                  {view === "scheduled"
                    ? "A little planning now. The right message, at the right time."
                    : "Every message sent. Every conversation one step closer."}
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw size={15} className={loading ? "spin" : ""} />
                Refresh
              </button>
            </section>
            <div className="mailbox">
              <div className="mailbox-toolbar">
                <div className="search-input">
                  <Search size={18} />
                  <input
                    aria-label="Search emails"
                    placeholder="Search emails, subjects, or content..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                <div className="toolbar-right">
                  <span>
                    <span
                      className={`tiny-dot ${view === "sent" ? "green-dot" : ""}`}
                    />
                    {view === "scheduled" ? "Upcoming" : "Delivery history"}
                  </span>
                  <SlidersHorizontal size={17} />
                </div>
              </div>
              <div className="table-scroll">
                <div className="mail-table">
                  <div className="table-head">
                    <span>RECIPIENT</span>
                    <span>SUBJECT</span>
                    <span>
                      {view === "scheduled" ? "SCHEDULED FOR" : "SENT AT"}{" "}
                      <ArrowDown size={12} />
                    </span>
                    <span>STATUS</span>
                    <span />
                  </div>
                  {loading && !items.length ? (
                    Array.from({ length: 5 }, (_, i) => (
                      <div className="skeleton-row" key={i}>
                        <span />
                        <span />
                        <span />
                      </div>
                    ))
                  ) : items.length ? (
                    items.map((e) => (
                      <button
                        className="mail-row"
                        key={e.id}
                        onClick={() => setSelected(e)}
                      >
                        <span className="recipient-cell">
                          <span
                            className={`recipient-avatar tint-${e.recipient.charCodeAt(0) % 4}`}
                          >
                            {e.recipient[0].toUpperCase()}
                          </span>
                          <span>
                            <strong>{e.recipient.split("@")[0]}</strong>
                            <small>{e.recipient}</small>
                          </span>
                        </span>
                        <span className="subject-cell">
                          <strong>{e.subject}</strong>
                          <small>{e.body}</small>
                        </span>
                        <span className="date-cell">
                          {formatDate(
                            view === "scheduled"
                              ? e.next_attempt_at
                              : e.sent_at,
                          )}
                          <small>
                            {view === "scheduled"
                              ? e.reason || "Local time"
                              : e.sender_name}
                          </small>
                        </span>
                        <Status status={e.status} />
                        <ChevronRight size={15} className="row-arrow" />
                      </button>
                    ))
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">
                        {search ? (
                          <Search size={29} />
                        ) : view === "scheduled" ? (
                          <Clock3 size={29} />
                        ) : (
                          <Send size={29} />
                        )}
                      </div>
                      <h2>
                        {search
                          ? "No matching emails"
                          : view === "scheduled"
                            ? "Your next conversation starts here"
                            : "Your sent emails will appear here"}
                      </h2>
                      <p>
                        {search
                          ? "Try a different email address, subject, or phrase."
                          : view === "scheduled"
                            ? "Write a message, choose your timing, and we’ll take it from there."
                            : "Once your scheduled messages are sent, you can find their delivery details here."}
                      </p>
                      {!search && view === "scheduled" && (
                        <button
                          className="primary-button"
                          onClick={() => setCompose(true)}
                        >
                          <Plus size={16} />
                          Compose new email
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <footer className="table-footer">
                <span>
                  {total
                    ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, total)} of ${total} emails`
                    : "No emails to display"}
                  {search && " · Search results"}
                </span>
                <div>
                  <button
                    className="icon-button"
                    aria-label="Previous page"
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <span>{page}</span>
                  <button
                    className="icon-button"
                    aria-label="Next page"
                    disabled={page * 20 >= total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
              </footer>
            </div>
            <div className="below-table">
              <ShieldCheck size={15} /> Your emails are safely scheduled, even
              when you’re away.
              <span>
                Times shown in{" "}
                {Intl.DateTimeFormat().resolvedOptions().timeZone}
              </span>
            </div>
            {senders.length === 0 && (
              <div className="sender-setup">
                <Mail size={20} />
                <div>
                  <strong>Set up your sending accounts</strong>
                  <p>
                    Restore the workspace's saved senders to start scheduling.
                  </p>
                </div>
                <button
                  className="secondary-button"
                  onClick={provision}
                  disabled={provisioning}
                >
                  {provisioning ? <Spinner /> : <Plus size={16} />}Set up
                  senders
                </button>
              </div>
            )}
          </>
        )}
      </main>
      {selected && (
        <Dialog onClose={() => setSelected(null)} title="Email details">
          <div className="detail-top">
            <Status status={selected.status} />
            <span>
              {formatDate(selected.sent_at || selected.next_attempt_at)}
            </span>
          </div>
          <h2 className="detail-subject">{selected.subject}</h2>
          <div className="detail-addresses">
            <p>
              <span>From</span>
              {selected.sender_name} &lt;{selected.sender_email}&gt;
            </p>
            <p>
              <span>To</span>
              {selected.recipient}
            </p>
            <p>
              <span>Scheduled</span>
              {formatDate(selected.scheduled_at)}
            </p>
          </div>
          <div className="email-body">{selected.body}</div>
          {selected.error && (
            <div className="error-banner">
              <AlertCircle size={17} />
              {selected.error}
            </div>
          )}
          {selected.reason && selected.reason.toLowerCase().includes("hourly limit") ? (
            <div className="rate-limit-notice" role="status">
              <AlertCircle size={17} />
              <div>
                <strong>Hourly limit reached</strong>
                <span>
                  This email is scheduled for {formatDate(selected.next_attempt_at)}.
                  It will be sent automatically in the next available hour.
                </span>
              </div>
            </div>
          ) : selected.reason ? (
            <p className="muted">{selected.reason}</p>
          ) : null}
          {selected.preview_url && (
            <a
              className="primary-button"
              href={selected.preview_url}
              target="_blank"
              rel="noreferrer"
            >
              View Ethereal preview
              <ExternalLink size={16} />
            </a>
          )}
        </Dialog>
      )}
      {settings && (
        <Dialog onClose={() => setSettings(false)} title="Workspace settings">
          <h3>Sending accounts</h3>
          <p className="muted sender-help">
            Your default sender is always available. You can add or remove
            additional senders; already scheduled emails will still send.
          </p>
          {senderError && (
            <div className="error-banner" role="alert">
              {senderError}
            </div>
          )}
          <div className="sender-list">
            {senders.map((s) => (
              <div key={s.id}>
                <span className="icon-tile">
                  <Mail size={18} />
                </span>
                <span>
                  <strong>
                    {s.name}
                    {s.is_default ? " · Default" : ""}
                  </strong>
                  <small>{s.email}</small>
                </span>
                <SenderLimit
                  sender={s}
                  max={config.maxHourlyLimit}
                  onSaved={() => {
                    refresh();
                    setToast("Sender limit updated.");
                  }}
                />
                {s.is_default ? (
                  <span className="permanent-sender">
                    <ShieldCheck size={14} />
                    Permanent
                  </span>
                ) : (
                  <button
                    className="text-button danger remove-sender"
                    aria-label={`Remove ${s.name}`}
                    disabled={removingSender !== null}
                    onClick={() => removeSender(s.id)}
                  >
                    {removingSender === s.id ? <Spinner /> : "Remove"}
                  </button>
                )}
              </div>
            ))}
          </div>
          <AddSenderForm
            onAdded={() => {
              refresh();
              setToast("Sender verified and added to your account.");
            }}
          />
          {
            <button
              className="secondary-button"
              onClick={provision}
              disabled={provisioning}
            >
              {provisioning ? <Spinner /> : <Plus size={16} />}Restore default
              senders
            </button>
          }
          <h3 className="settings-section">Slack notifications</h3>
          <p className="muted">
            Get notified when a sender reaches its hourly limit.
          </p>
          {user.slack ? (
            <div className="integration-connected">
              <SlackIcon />
              <div>
                <strong>{user.slack.team_name}</strong>
                <small>{user.slack.channel_name}</small>
              </div>
              <button
                className="text-button danger"
                onClick={async () => {
                  try {
                    await api("/api/integrations/slack", { method: "DELETE" });
                    setUser({ ...user, slack: null });
                    setToast("Slack disconnected.");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <a className="secondary-button" href="/auth/slack">
              <SlackIcon />
              Connect Slack
              <ArrowRight size={16} />
            </a>
          )}
          {user.slack_notification && (
            <div
              className={`slack-delivery-status ${user.slack_notification.state}`}
              role="status"
            >
              <SlackIcon />
              <div>
                <strong>
                  {user.slack_notification.state === "sent"
                    ? "Last hourly-limit alert sent"
                    : user.slack_notification.state === "pending"
                      ? "Hourly-limit alert queued"
                      : user.slack_notification.state === "error"
                        ? "Hourly-limit alert failed"
                        : "Hourly-limit alert waiting for Slack"}
                </strong>
                <small>
                  {user.slack_notification.state === "sent"
                    ? `Sent for ${user.slack_notification.sender_email} · ${formatDate(user.slack_notification.notified_at)}`
                    : user.slack_notification.state === "error"
                      ? user.slack_notification.error || "Retrying delivery"
                      : `Limit ${user.slack_notification.limit_value} · ${formatDate(user.slack_notification.created_at)}`}
                </small>
              </div>
            </div>
          )}
          {user.operator && (
            <>
              <h3 className="settings-section">Queue activity</h3>
              <a
                className="secondary-button"
                href="/admin/queues"
                target="_blank"
                rel="noreferrer"
              >
                Open live queue dashboard
                <ExternalLink size={16} />
              </a>
            </>
          )}
          <div className="settings-info">
            <ShieldCheck size={18} />
            <span>
              Test emails are captured by Ethereal. They won’t reach real
              recipient inboxes.
            </span>
          </div>
        </Dialog>
      )}
    </div>
  );
}
function Status({ status }: { status: string }) {
  const labels: Record<string, string> = {
    scheduled: "Scheduled",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
    unknown: "Needs review",
  };
  return (
    <span className={`pill ${status}`}>
      {status === "sent" ? (
        <Check size={12} />
      ) : status === "sending" ? (
        <Loader2 size={12} className="spin" />
      ) : status === "scheduled" ? (
        <Clock3 size={12} />
      ) : (
        <AlertCircle size={12} />
      )}{" "}
      {labels[status] || status}
    </span>
  );
}
function SlackIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      <path
        stroke="#36c5f0"
        strokeWidth="4"
        strokeLinecap="round"
        d="M9 3v6M3 9h1"
      />
      <path
        stroke="#2eb67d"
        strokeWidth="4"
        strokeLinecap="round"
        d="M21 9h-6M15 3v1"
      />
      <path
        stroke="#ecb22e"
        strokeWidth="4"
        strokeLinecap="round"
        d="M15 21v-6M21 15h-1"
      />
      <path
        stroke="#e01e5a"
        strokeWidth="4"
        strokeLinecap="round"
        d="M3 15h6M9 21v-1"
      />
    </svg>
  );
}
function Dialog({
  children,
  onClose,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = ref.current?.querySelectorAll<HTMLElement>(
        'button,a[href],input,select,textarea,[tabindex="0"]',
      );
      if (!nodes?.length) return;
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
function Compose({
  senders,
  config,
  onBack,
  onSuccess,
  onProvision,
  provisioning,
}: {
  senders: Sender[];
  config: Config;
  onBack: () => void;
  onSuccess: (count: number) => void;
  onProvision: () => void;
  provisioning: boolean;
}) {
  const [sender, setSender] = useState(senders[0]?.id || ""),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [recipients, setRecipients] = useState<string[]>([]),
    [manual, setManual] = useState(""),
    [fileName, setFileName] = useState(""),
    [summary, setSummary] = useState({ invalid: 0, duplicates: 0 }),
    [start, setStart] = useState(localDate(new Date(Date.now() + 300000))),
    [delay, setDelay] = useState(config.minimumDelay / 1000),
    [hour, setHour] = useState(Math.min(100, config.maxHourlyLimit)),
    [busy, setBusy] = useState(false),
    [parsing, setParsing] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!senders.some((s) => s.id === sender)) setSender(senders[0]?.id || "");
  }, [senders, sender]);
  async function parseFile(file: File) {
    setParsing(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      const data = await api<{
        recipients: string[];
        invalid: number;
        duplicates: number;
      }>("/api/leads/preview", { method: "POST", body: form });
      setRecipients(data.recipients);
      setSummary(data);
      setFileName(file.name);
      key.current = crypto.randomUUID();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setParsing(false);
    }
  }
  const manualRecipients = manual.split(/[,;\s]+/).filter(Boolean);
  const all = [...new Set([...recipients, ...manualRecipients])];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!all.length) {
      setError("Add a recipient or upload your leads.");
      return;
    }
    if (!sender) {
      setError("Set up a sending account first.");
      return;
    }
    if (!start || new Date(start).getTime() < Date.now() - 60000) {
      setError("Choose a future start time.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ count?: number }>("/api/campaigns", {
        ...post({
          senderId: sender,
          subject,
          body,
          recipients: all,
          startAt: new Date(start).toISOString(),
          delayMs: delay * 1000,
          hourlyLimit: hour,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
      });
      onSuccess(result.count || all.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="compose-page"
      onSubmit={submit}
      onChange={() => {
        key.current = crypto.randomUUID();
      }}
    >
      <div className="compose-heading">
        <div>
          <button type="button" className="back-button" onClick={onBack}>
            <ArrowLeft size={18} />
            Back to emails
          </button>
          <h1>Compose new email</h1>
          <p>A thoughtful message. Delivered on your schedule.</p>
        </div>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || parsing || !senders.length}
        >
          {busy ? <Spinner /> : <Clock3 size={17} />}Schedule email
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
      <div className="compose-grid">
        <div className="compose-editor">
          <div className="editor-field">
            <label htmlFor="sender">From</label>
            <select
              id="sender"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
              required
            >
              <option value="" disabled>
                Select a sender
              </option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} &lt;{s.email}&gt;{s.is_default ? " (Default)" : ""}
                </option>
              ))}
            </select>
          </div>
          {!senders.length && (
            <div className="provision-inline">
              <button
                type="button"
                className="text-button"
                onClick={onProvision}
                disabled={provisioning}
              >
                {provisioning
                  ? "Loading saved senders..."
                  : "Restore default senders"}
              </button>
            </div>
          )}
          <div className="editor-field">
            <label htmlFor="recipients">To</label>
            <input
              id="recipients"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Add email addresses, separated by commas"
            />
          </div>
          <div className="editor-field">
            <label htmlFor="subject">Subject</label>
            <input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Give your email a great introduction"
              required
              maxLength={250}
            />
          </div>
          <label htmlFor="body" className="sr-only">
            Email body
          </label>
          <textarea
            id="body"
            className="body-editor"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"Hi there,\n\nWrite something worth opening…"}
            required
            maxLength={100000}
          />
          <div className="editor-footer">
            <span>
              <FileText size={15} />
              Plain text email
            </span>
            <span>{body.length.toLocaleString()} characters</span>
          </div>
        </div>
        <aside className="compose-options">
          <section>
            <div className="section-title">
              <span className="icon-tile">
                <UploadCloud size={18} />
              </span>
              <div>
                <h3>Your recipients</h3>
                <p>Bring your list along.</p>
              </div>
            </div>
            <input
              type="file"
              accept=".csv,.txt,text/plain,text/csv"
              ref={input}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void parseFile(f);
              }}
            />
            <button
              type="button"
              className={`upload-zone ${fileName ? "uploaded" : ""}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) void parseFile(f);
              }}
              disabled={parsing}
            >
              {parsing ? (
                <Spinner />
              ) : fileName ? (
                <CheckCircle2 size={25} />
              ) : (
                <UploadCloud size={27} />
              )}
              <strong>{fileName || "Click to upload or drag a file"}</strong>
              <span>
                {fileName
                  ? "Click to replace your file"
                  : "CSV or TXT · Up to 2 MB"}
              </span>
            </button>
            <a
              className="template-download"
              href="/templates/recipients-template.csv"
              download="recipients-template.csv"
            >
              <Download size={15} />
              Download sample CSV
            </a>
            <p className="field-note template-note">
              Replace the example rows with your recipients, keep the email
              column, then upload your saved CSV.
            </p>
            {all.length > 0 && (
              <div className="recipient-summary">
                <CheckCircle2 size={15} />
                <strong>{all.length}</strong> recipients ready
              </div>
            )}
            {(summary.invalid > 0 || summary.duplicates > 0) && (
              <p className="import-note">
                {summary.invalid} invalid · {summary.duplicates} duplicates
                excluded
              </p>
            )}
          </section>
          <section>
            <div className="section-title">
              <span className="icon-tile">
                <Clock3 size={18} />
              </span>
              <div>
                <h3>Delivery schedule</h3>
                <p>Make every send intentional.</p>
              </div>
            </div>
            <label className="form-label" htmlFor="start">
              Start sending at
            </label>
            <input
              className="form-input"
              id="start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
            <span className="field-note">
              {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </span>
            <label className="form-label" htmlFor="delay">
              Delay between emails
            </label>
            <div className="input-unit">
              <input
                id="delay"
                type="number"
                min={config.minimumDelay / 1000}
                max={86400}
                step={1}
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
                required
              />
              <span>seconds</span>
            </div>
            <label className="form-label" htmlFor="hour">
              Hourly limit
            </label>
            <div className="input-unit">
              <input
                id="hour"
                type="number"
                min={1}
                max={config.maxHourlyLimit}
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
                required
              />
              <span>emails / hour</span>
            </div>
            <p className="field-note">
              Your sender’s hourly cap is shared across all scheduled batches.
            </p>
          </section>
          <div className="schedule-note">
            <ShieldCheck size={19} />
            <p>
              We’ll keep your schedule running, even after you close this tab.
            </p>
          </div>
        </aside>
      </div>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
