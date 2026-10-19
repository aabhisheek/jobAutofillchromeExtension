"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";

const STATUS_COLUMNS = [
  { id: "saved", label: "Saved" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejected", label: "Rejected" }
];

export default function Home() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kinds, setKinds] = useState({});
  const [applications, setApplications] = useState([]);
  const [showRaw, setShowRaw] = useState(false);

  // ---- auth ----
  useEffect(() => {
    if (!supabase) {
      setBooting(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setBooting(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next || null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Lowercased to match the key the extension writes (it lowercases the sign-in
  // email before every row), so case differences between the two providers can
  // never split one user into two sets of rows.
  const email = ((session && session.user && session.user.email) || "").toLowerCase();

  const loadData = useCallback(async (userEmail) => {
    setLoading(true);
    setError("");
    try {
      const { data: rows, error: kindsError } = await supabase
        .from("user_data")
        .select("kind,data,updated_at")
        .eq("user_id", userEmail);
      if (kindsError) throw kindsError;

      const map = {};
      for (const row of rows || []) map[row.kind] = row.data;
      setKinds(map);

      const { data: apps, error: appsError } = await supabase
        .from("applications")
        .select("data,updated_at")
        .eq("user_id", userEmail)
        .order("updated_at", { ascending: false });
      if (appsError) throw appsError;
      setApplications((apps || []).map((r) => r.data).filter(Boolean));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (email) loadData(email);
  }, [email, loadData]);

  async function signIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setKinds({});
    setApplications([]);
  }

  const personal = (kinds.profile && kinds.profile.personal) || {};
  const resume = kinds.resume_pdf || null;

  const counts = useMemo(() => {
    const c = {};
    for (const s of STATUS_COLUMNS) c[s.id] = 0;
    for (const app of applications) if (c[app.status] != null) c[app.status] += 1;
    return c;
  }, [applications]);

  if (!isConfigured) {
    return (
      <div className="center">
        <h1 className="title">Not configured</h1>
        <p className="muted" style={{ maxWidth: 520 }}>
          Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in the
          Vercel project&apos;s environment variables, then redeploy.
        </p>
      </div>
    );
  }

  if (booting) {
    return (
      <div className="center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="center">
        <h1 className="title">Job Autofill — Cloud</h1>
        <p className="muted" style={{ maxWidth: 520 }}>
          Sign in with the same Google account the extension uses to see your synced profile, resume and
          application board.
        </p>
        <button className="primary" onClick={signIn}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1 className="title">Job Autofill — Cloud</h1>
          <p className="sub">
            {email} · {applications.length} application{applications.length === 1 ? "" : "s"} synced
          </p>
        </div>
        <div className="row">
          <button onClick={() => loadData(email)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button onClick={signOut}>Sign out</button>
        </div>
      </div>

      {error && <p className="err">Could not load data: {error}</p>}

      <div className="card">
        <h2>Pipeline</h2>
        <div className="stats">
          {STATUS_COLUMNS.map((s) => (
            <div className="stat" key={s.id}>
              <div className="n">{counts[s.id]}</div>
              <div className="l">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Profile</h2>
        <div className="grid">
          <Field k="Name" v={personal.fullName || [personal.firstName, personal.lastName].filter(Boolean).join(" ")} />
          <Field k="Email" v={personal.email} />
          <Field k="Phone" v={personal.phone} />
          <Field k="Location" v={[personal.city, personal.state, personal.country].filter(Boolean).join(", ")} />
        </div>
        {kinds.profile ? (
          <p style={{ marginTop: 14 }}>
            <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Hide" : "Show"} full profile JSON</button>
          </p>
        ) : (
          <p className="muted">No profile synced yet.</p>
        )}
        {showRaw && kinds.profile && <pre>{JSON.stringify(kinds.profile, null, 2)}</pre>}
      </div>

      <div className="card">
        <h2>Resume</h2>
        {resume && resume.base64 ? (
          <div className="row">
            <span>
              {resume.filename || "resume.pdf"}{" "}
              <span className="muted">
                ({resume.size ? `${Math.round(resume.size / 1024)} KB` : "size unknown"})
              </span>
            </span>
            <button onClick={() => downloadResume(resume)}>Download</button>
          </div>
        ) : (
          <p className="muted">No resume PDF synced yet.</p>
        )}
      </div>

      <div className="card">
        <h2>Applications</h2>
        {applications.length === 0 ? (
          <p className="muted">Nothing synced yet. Track a job in the extension and it will appear here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Company</th>
                <th>Status</th>
                <th>Source</th>
                <th>Updated</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((app) => (
                <tr key={app.id}>
                  <td>{app.title || <span className="muted">—</span>}</td>
                  <td>{app.company || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`pill ${app.status}`}>{app.status}</span>
                  </td>
                  <td className="muted">{app.source || "—"}</td>
                  <td className="muted">{formatDate(app.updatedAt)}</td>
                  <td>
                    {app.url ? (
                      <a href={app.url} target="_blank" rel="noreferrer">
                        open
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ k, v }) {
  return (
    <div className="field">
      <div className="k">{k}</div>
      <div className="v">{v || <span className="muted">—</span>}</div>
    </div>
  );
}

function formatDate(ts) {
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

// Turns the synced base64 back into a file and lets the browser save it. The
// PDF never needs a signed URL, which keeps the bucket out of the picture
// entirely — the bytes travel with the row.
function downloadResume(resume) {
  const binary = atob(resume.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: resume.mimeType || "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = resume.filename || "resume.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
