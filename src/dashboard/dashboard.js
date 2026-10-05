// Dashboard page: stat tiles, the five-column board, and the add/edit/delete
// actions behind every card.
//
// Renders from scratch on each change rather than diffing the DOM. The list is
// small (tens of rows), and a full redraw is what keeps the column counts and
// the tiles from ever disagreeing with the cards.

const insightsEl = document.getElementById("insights");
const boardEl = document.getElementById("board");
const emptyEl = document.getElementById("empty");
const noticeEl = document.getElementById("notice");
const addPanel = document.getElementById("add-panel");
const addForm = document.getElementById("add-form");
const addStatusSelect = document.getElementById("add-status");
const addStatusMsg = document.getElementById("add-status-msg");

let items = [];

// The panel is always in the DOM (the dashboard is the only place that can run
// Gmail's consent window, since chrome.identity.launchWebAuthFlow needs a live
// document), so its elements are looked up lazily by the functions that use
// them. That also keeps the board's own wiring above this one readable.
const mail = {};

function byId(id) {
  return document.getElementById(id);
}

function showNotice(text, kind = "info") {
  noticeEl.textContent = text;
  noticeEl.className = `banner ${kind}`;
  noticeEl.classList.remove("hidden");
}

function clearNotice() {
  noticeEl.classList.add("hidden");
  noticeEl.textContent = "";
}

function tile(value, label) {
  return `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
}

function renderInsights(list) {
  const insights = Tracker.computeInsights(list);
  insightsEl.innerHTML = [
    tile(String(insights.week), "Applied this week"),
    tile(String(insights.month), "Applied (30d)"),
    tile(Tracker.formatPercent(insights.responseRate), "Response rate"),
    tile(Tracker.formatPercent(insights.offerRate), "Offer rate"),
    tile(String(insights.interviews), "Interviews"),
    tile(String(insights.total), "Total tracked")
  ].join("");
}

function statusOptions(selected) {
  return Tracker.STATUSES.map(
    (status) => `<option value="${status}"${status === selected ? " selected" : ""}>${status}</option>`
  ).join("");
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

// A card is three facts and three controls. Anything longer (notes, the full
// URL) lives behind the card's own row on the dashboard rather than being
// truncated here — the board is for triage, not for reading.
function renderCard(item) {
  const role = escapeHtml(item.title || "Untitled role");
  const company = escapeHtml(item.company || "Unknown company");
  const source = item.source ? `<span class="source">${escapeHtml(item.source)}</span>` : "";
  // Marks a card that came from Gmail rather than a button press. Worth its own
  // glyph: an imported row's title is a machine's best guess, and the user
  // should be able to spot those to correct first.
  const fromEmail = item.sourceEmailId
    ? '<span class="mail-mark" title="Imported from Gmail">✉</span>'
    : "";
  const age = Tracker.relativeTime(item.updatedAt || item.appliedAt || item.savedAt);
  const open = item.url
    ? `<a class="icon-link" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer" title="Open job posting">↗</a>`
    : "";

  return `
    <div class="app-card" data-id="${escapeHtml(item.id)}">
      <div class="role">${role}${fromEmail}</div>
      <div class="company">${company}</div>
      <div class="meta">${source}<span>${escapeHtml(age)}</span></div>
      <div class="actions">
        <select class="status-select" title="Move to another stage">${statusOptions(item.status)}</select>
        ${open}
        <button class="icon-link danger" data-action="delete" title="Delete">✕</button>
      </div>
    </div>`;
}

function renderBoard(list) {
  boardEl.innerHTML = Tracker.COLUMNS.map((column) => {
    const columnItems = list.filter((item) => item.status === column.id);
    const cards = columnItems.length
      ? columnItems.map(renderCard).join("")
      : '<p class="column-empty">Nothing here</p>';

    return `
      <div class="column">
        <div class="column-head">
          <span class="dot ${column.id}"></span>${column.label}
          <span class="count">${columnItems.length}</span>
        </div>
        <div class="cards">${cards}</div>
      </div>`;
  }).join("");

  emptyEl.classList.toggle("hidden", list.length > 0);
  boardEl.classList.toggle("hidden", list.length === 0);
}

async function refresh() {
  items = await Tracker.listByRecency();
  renderInsights(items);
  renderBoard(items);
}

// Delegated so a card re-rendered by any other action keeps working — there are
// no per-card listeners to rebind, and no listener left pointing at a row that
// has since moved to a different column.
boardEl.addEventListener("change", async (event) => {
  const select = event.target.closest(".status-select");
  if (!select) return;

  const id = select.closest(".app-card").dataset.id;
  try {
    await Tracker.setStatus(id, select.value);
    await refresh();
  } catch (err) {
    showNotice(`Could not move that application: ${err.message}`, "err");
    await refresh();
  }
});

boardEl.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="delete"]');
  if (!button) return;

  const id = button.closest(".app-card").dataset.id;
  await Tracker.remove(id);
  await refresh();
  showNotice("Application deleted.", "ok");
});

for (const status of Tracker.STATUSES) {
  const option = document.createElement("option");
  option.value = status;
  option.textContent = status;
  addStatusSelect.appendChild(option);
}
addStatusSelect.value = "saved";

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  addStatusMsg.textContent = "";

  const draft = {
    title: document.getElementById("add-title").value.trim(),
    company: document.getElementById("add-company").value.trim(),
    url: document.getElementById("add-url").value.trim(),
    status: addStatusSelect.value,
    notes: document.getElementById("add-notes").value.trim()
  };

  if (!draft.title && !draft.url) {
    addStatusMsg.className = "status-msg err";
    addStatusMsg.textContent = "Give it a job title or a URL so it can be found again.";
    return;
  }

  if (draft.url && !/^https?:\/\//i.test(draft.url)) {
    addStatusMsg.className = "status-msg err";
    addStatusMsg.textContent = "The URL needs to start with http:// or https://";
    return;
  }

  await Tracker.save(draft);
  addForm.reset();
  addStatusSelect.value = "saved";
  addPanel.open = false;
  await refresh();
  showNotice("Added to your dashboard.", "ok");
});

document.getElementById("add-cancel").addEventListener("click", () => {
  addForm.reset();
  addStatusSelect.value = "saved";
  addPanel.open = false;
});

document.getElementById("refresh").addEventListener("click", async () => {
  await refresh();
  showNotice("Refreshed.", "ok");
});

document.getElementById("export-csv").addEventListener("click", () => {
  if (!items.length) {
    showNotice("Nothing to export yet.", "warn");
    return;
  }
  const blob = new Blob([Tracker.toCsv(items)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "applications.csv";
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!items.length) return;
  if (!confirm(`Delete all ${items.length} tracked applications? This cannot be undone.`)) return;
  await Tracker.clear();
  await refresh();
  showNotice("All applications cleared.", "ok");
});

// Another page (the side panel's Track Job button) can add a row while this tab
// is open, so keep the board live instead of showing a stale snapshot.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.applications) refresh();
  // The background worker writes its own summary, and a sync started from the
  // alarm lands here with no UI open at all.
  if (changes.emailSyncState && !mail.syncing) renderLastRun();
});

// ---- Gmail import panel -------------------------------------------------
//
// Everything here runs in the page rather than the service worker for one
// reason: chrome.identity.launchWebAuthFlow opens a real consent window, and a
// service worker Chrome is free to suspend mid-flow is the wrong place for that.
// The daily run itself lives in background.js, behind an alarm.

// Reads the merged settings the same way every other page does, so a value
// placed in the bundled src/data/settings.json shows up here without being
// retyped.
async function loadPanelSettings() {
  const { settings: override } = await chrome.storage.local.get("settings");

  let bundled = {};
  try {
    const res = await fetch(chrome.runtime.getURL("src/data/settings.json"));
    if (res.ok) bundled = await res.json();
  } catch {
    // mergeSettings still supplies DEFAULT_SETTINGS and the stored overrides.
  }

  return mergeSettings(bundled, override);
}

// Written field by field rather than replacing the record: `settings` also holds
// the provider keys, the analytics token and the theme, and clobbering it from
// a mail panel would be a spectacular way to lose an API key.
async function savePanelSettings(patch) {
  const { settings: existing = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...existing, ...patch } });
  return { ...existing, ...patch };
}

function mailStatus(text, kind = "") {
  const el = byId("mail-status-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

function setupStatus(text, kind = "") {
  const el = byId("mail-setup-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

function renderLastRun() {
  const el = byId("mail-last-run");
  if (!el) return;

  return MailImport.readSyncState().then((state) => {
    if (!state || !state.at) {
      el.textContent = "Never synced yet.";
      return;
    }

    const when = new Date(state.at).toLocaleString();
    if (!state.ok) {
      el.textContent = `Last attempt ${when} — ${state.notes[0] || "it did not finish."}`;
      return;
    }

    const bits = [`Last synced ${when}`];
    if (state.added) bits.push(`${state.added} new`);
    if (state.updated) bits.push(`${state.updated} moved stage`);
    if (state.skipped) bits.push(`${state.skipped} already imported`);
    if (state.failed) bits.push(`${state.failed} unreadable`);
    bits.push(`${state.scanned} matching emails`);
    if (state.aiEnriched) bits.push(`${state.aiEnriched} read by AI`);
    if (state.aiSkipped) bits.push(`${state.aiSkipped} read locally (over the AI limit)`);
    if (state.aiFailed) bits.push(`${state.aiFailed} AI call(s) failed, read locally`);

    el.textContent = `${bits.join(" · ")}.`;
  });
}

function renderConnection(connection) {
  const stateEl = byId("mail-conn-state");
  const connectBtn = byId("mail-connect");
  const disconnectBtn = byId("mail-disconnect");
  const noteEl = byId("mail-conn-note");
  const setupEl = byId("mail-setup");

  // The Google Cloud steps only matter until there is something to paste.
  if (setupEl) setupEl.classList.toggle("hidden", !!mail.clientId);

  if (!stateEl) return;

  if (connection.connected) {
    stateEl.textContent = connection.email ? `Connected · ${connection.email}` : "Connected";
    stateEl.className = "pill on";
    if (connectBtn) connectBtn.classList.add("hidden");
    if (disconnectBtn) disconnectBtn.classList.remove("hidden");
    if (noteEl) noteEl.textContent = "Read-only access to Gmail. Revoke it from your Google account at any time.";
    return;
  }

  stateEl.textContent = "Not connected";
  stateEl.className = "pill";
  if (connectBtn) {
    connectBtn.classList.remove("hidden");
    // Nothing to connect until there is a client id, and the button saying
    // "Connect Gmail" before the user can possibly do so is a dead end.
    connectBtn.disabled = !mail.clientId;
  }
  if (disconnectBtn) disconnectBtn.classList.add("hidden");
  if (noteEl) noteEl.textContent = mail.clientId
    ? "Grants read-only access so confirmation emails can be read. You can revoke it from your Google account at any time."
    : "Save a Google OAuth client id above first.";
}

async function refreshConnection() {
  renderConnection(await Gmail.getConnection(mail.settings));
}

async function initMailPanel() {
  const panel = byId("mail-panel");
  if (!panel) return;

  mail.settings = await loadPanelSettings();
  mail.clientId = String(mail.settings.gmailClientId || "").trim();

  const clientIdInput = byId("mail-client-id");
  if (clientIdInput) clientIdInput.value = mail.clientId;

  const enabled = byId("mail-enabled");
  const time = byId("mail-time");
  const lookback = byId("mail-lookback");
  const query = byId("mail-query");
  const useAi = byId("mail-use-ai");

  if (enabled) enabled.checked = !!mail.settings.emailSyncEnabled;
  if (time) time.value = mail.settings.emailSyncTime || "09:00";
  if (query) query.value = mail.settings.emailSyncQuery || "";
  if (useAi) useAi.checked = mail.settings.emailUseAi !== false;

  const days = String(mail.settings.emailLookbackDays || 30);
  // Fall back to the closest option rather than leaving the select blank: a
  // stored value of 45 is a real state and silently showing "30 days" would
  // hide it.
  if (lookback) {
    if ([...lookback.options].some((option) => option.value === days)) lookback.value = days;
    else lookback.selectedIndex = 1;
  }

  const aiConfigured = configuredProviders(mail.settings).length > 0;
  if (useAi && !aiConfigured) {
    useAi.checked = false;
    useAi.disabled = true;
    const note = useAi.closest("label");
    if (note) note.title = "Add an API key on the API Keys page to turn this on.";
  }

  await refreshConnection();
  renderLastRun();

  byId("mail-save-client").addEventListener("click", async () => {
    const value = (byId("mail-client-id").value || "").trim();
    if (value && !/\.apps\.googleusercontent\.com$/.test(value)) {
      setupStatus("That does not look like a Google client id — it should end in apps.googleusercontent.com.", "err");
      return;
    }
    await savePanelSettings({ gmailClientId: value });
    mail.clientId = value;
    mail.settings = await loadPanelSettings();
    setupStatus(value ? "Saved. Now connect your Gmail." : "Cleared.", "ok");
    await refreshConnection();
  });

  byId("mail-connect").addEventListener("click", async () => {
    mailStatus("Waiting for Google's consent screen…", "busy");
    try {
      // The settings are re-read rather than reused: saving the client id is a
      // separate click, and a stale copy here is the difference between a
      // working connection and a Google error about an unknown client.
      const connection = await Gmail.connect({ settings: await loadPanelSettings() });
      renderConnection(connection);
      mailStatus(
        connection.email
          ? `Connected as ${connection.email}. Press Sync now to bring in past applications.`
          : "Connected. Press Sync now to bring in past applications.",
        "ok"
      );
      renderLastRun();
    } catch (err) {
      renderConnection({ connected: false });
      mailStatus(err.message, "err");
    }
  });

  byId("mail-disconnect").addEventListener("click", async () => {
    await Gmail.disconnect();
    renderConnection({ connected: false });
    mailStatus("Disconnected. Nothing is read from Gmail until you connect again.", "ok");
  });

  byId("mail-save").addEventListener("click", async () => {
    const patch = {
      emailSyncEnabled: !!(enabled && enabled.checked),
      emailSyncTime: (time && time.value) || "09:00",
      emailLookbackDays: Number((lookback && lookback.value) || 30),
      emailSyncQuery: (query && query.value.trim()) || MailImport.DEFAULT_QUERY,
      emailUseAi: !!(useAi && useAi.checked)
    };

    await savePanelSettings(patch);
    mail.settings = await loadPanelSettings();

    // The alarm lives in the worker, which is asleep by now; this is the nudge
    // that makes the saved time take effect without waiting for a restart.
    const res = await chrome.runtime
      .sendMessage({ type: "mail:reschedule" })
      .catch(() => null);

    const when = res && res.when ? new Date(res.when).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
    mailStatus(
      patch.emailSyncEnabled
        ? `Saved. Checking your mail every day at ${(time && time.value) || "09:00"} — next run ${when}.`
        : "Saved. The daily check is off; Sync now still works.",
      "ok"
    );
  });

  byId("mail-sync-now").addEventListener("click", async () => {
    const button = byId("mail-sync-now");
    if (mail.syncing) return;

    mail.syncing = true;
    button.disabled = true;

    try {
      mailStatus("Reading your mail…", "busy");
      // Run here, not in the worker, so progress can be reported as it happens.
      // force: true because this button is meant to work whether or not the
      // daily schedule is switched on.
      const report = await MailImport.runSync({
        settings: await loadPanelSettings(),
        force: true,
        onProgress: ({ phase, done, total }) => {
          if (!total) return;
          mailStatus(phase === "fetch" ? `Reading emails… ${done}/${total}` : `Reading applications… ${done}/${total}`, "busy");
        }
      });

      if (!report.ok) {
        mailStatus(report.notes[0] || "The sync did not finish.", "err");
      } else if (!report.scanned) {
        mailStatus("No matching emails found. Try a broader Gmail search above.", "warn");
      } else {
        const parts = [];
        if (report.added) parts.push(`${report.added} added`);
        if (report.updated) parts.push(`${report.updated} moved stage`);
        if (report.skipped) parts.push(`${report.skipped} already imported`);
        if (report.failed) parts.push(`${report.failed} unreadable`);
        mailStatus(parts.length ? `${parts.join(", ")}.` : "Nothing new to import.", "ok");
      }

      renderLastRun();
      await refresh();
    } catch (err) {
      mailStatus(err.message, "err");
    } finally {
      mail.syncing = false;
      button.disabled = false;
    }
  });

  byId("mail-reset").addEventListener("click", async () => {
    if (!confirm("Forget which emails have already been imported? The next sync will read them again — existing cards are updated rather than duplicated, but titles and companies may be re-guessed.")) return;

    await MailImport.ledger.clear();
    mailStatus("Cleared. Press Sync now to read your mail again.", "ok");
  });
}

refresh();
initMailPanel().catch((err) => mailStatus(err.message, "err"));