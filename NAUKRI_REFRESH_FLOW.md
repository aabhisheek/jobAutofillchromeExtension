# Naukri Profile Refresh — Data Flow & Call Graph

High-level walkthrough of the daily Naukri profile "touch": what config drives it,
where the values come from, which functions read them, what each function does,
and who calls whom.

## 1. What it does (one paragraph)

Every day at `naukriRefreshTime` the background worker opens the saved Naukri
profile URL in a hidden tab, injects a one-time edit (functionally a trailing dot
toggle on the Resume headline, with bio/summary as fallback), clicks Save, waits
until "Profile last updated" actually moves, then closes the tab. The dashboard
has a button that triggers the exact same run immediately, force-ed.

## 2. Where the config values come from

Four-layer precedence, resolved by `mergeSettings()` in `src/lib/schema.js:413`.

| Layer | Source | Notes |
|---|---|---|
| 1. Defaults | `DEFAULT_SETTINGS` in `src/lib/schema.js:193` (`schema.js` lines 369–373) | Compiled-in fallback; always present |
| 2. Bundled | `src/data/settings.json` | Optional base, read via `fetch(chrome.runtime.getURL(...))` |
| 3. Overrides | `chrome.storage.local` → key `settings` | Field-by-field user changes from the dashboard/options |
| 4. Merge | `mergeSettings(bundled, override)` | `{ ...DEFAULT_SETTINGS, ...bundled }` then each stored override wins unless it is an empty string (non-clearable keys) |

Both `loadSettings()` (`src/background.js:36`) and `loadPanelSettings()`
(`src/dashboard/dashboard.js:380`) end in the same `mergeSettings` call, so the
background worker and the dashboard always see the same effective settings.

### The variables and their initial values

| Variable | Initial value | Meaning |
|---|---|---|
| `naukriRefreshEnabled` | `true` | Master switch. Off ⇒ alarm cleared, nothing runs |
| `naukriRefreshTime` | `"08:00"` | HH:MM, local timezone — when the alarm fires daily |
| `naukriRefreshUrl` | `"https://www.naukri.com/mnjuser/profile"` | Tab the worker opens for the run |
| `naukriRefreshEditPattern` | `"dots"` | `"dots"` \| `"append"` \| `"custom"` (see `nextText`) |
| `naukriRefreshCustomText` | `" ."` | Suffix used only when pattern is `"custom"` |

Derived/stored helper constants (background):

| Constant | Value |
|---|---|
| `NAUKRI_REFRESH_ALARM` | `"naukri-profile-refresh"` |
| `NAUKRI_REFRESH_FIELDS` | the five keys above (used for change detection) |
| `DAY_MINUTES` | `1440` (alarm period) |

## 3. Background-side call graph (src/background.js)

```
module load
   └─ reconcileNaukriRefreshAlarm()
         ├─ loadSettings()                  # values from schema.js/settings.json/storage
         ├─ (disabled)  chrome.alarms.clear(NAUKRI_REFRESH_ALARM)
         └─ (enabled)   scheduleNaukriRefresh(settings)
                              └─ nextRunAt(settings.naukriRefreshTime || "08:00")
                              └─ chrome.alarms.create(NAUKRI_REFRESH_ALARM, {when, periodInMinutes: 1440})

chrome.alarms.onAlarm("naukri-profile-refresh")
   └─ runNaukriRefresh()                     # (NOT forced; disabled ⇒ no-op)
         └─ loadSettings()
         └─ triggerNaukriProfileRefresh(settings, {})

chrome.runtime.onMessage: {type:"naukri:run"}          # dashboard "Update Naukri" / "Refresh now"
   └─ runNaukriRefresh({ force: true })                # same path, forced
         └─ triggerNaukriProfileRefresh(settings, { force: true })

chrome.runtime.onMessage: {type:"naukri:reschedule"}   # after panel save
   └─ reconcileNaukriRefreshAlarm()

chrome.storage.onChanged
   └─ if any NAUKRI_REFRESH_FIELDS changed ⇒ reconcileNaukriRefreshAlarm()
```

### Function summaries (background)

| Function | Lines | What it does |
|---|---|---|
| `loadSettings()` | 36 | Reads `chrome.storage.local.settings`, fetches bundled `settings.json`, returns `mergeSettings(...)` |
| `nextRunAt(time, from)` | 365 | Next clock time matching `HH:MM` from `Date.now()` (or `from`) |
| `scheduleNaukriRefresh(settings)` | 450 | Creates/re-creates the daily alarm via `chrome.alarms.create`; returns the next run time |
| `runNaukriRefresh(options)` | 461 | Dedupes concurrent runs through `naukriRefreshInFlight`, then `loadSettings()` → `triggerNaukriProfileRefresh(settings, options)` |
| `triggerNaukriProfileRefresh(settings, {force})` | 492 | Guard `if (!enabled && !force) return {ok:false, reason:"disabled"}`; `chrome.tabs.create({url, active:false})`; `sendNaukriRefresh(...)`; then `chrome.tabs.remove` in `finally`; returns `{ ...contentResult, url }` |
| `sendNaukriRefresh(tabId, message, attempts=30)` | 479 | Retries `chrome.tabs.sendMessage` every 1 s until the content script answers (document_idle/redirect races) |
| `reconcileNaukriRefreshAlarm()` | 520 | Re-reads settings; clears alarm if disabled, else re-schedules |

### The message background → content script

Sent from `triggerNaukriProfileRefresh` (`src/background.js:504`):

```js
{
  type: "naukri:refresh",
  editPattern: settings.naukriRefreshEditPattern || "dots",
  customText:  settings.naukriRefreshCustomText || " .",
  profileUrl:  url
}
```

## 4. Content-script call graph (src/content/naukri-profile.js)

Registered in `manifest.json` (`content_scripts`, matches `*://*.naukri.com/*`,
`*://*.naukri.in/*`, `*://login.naukri.com/*`, `run_at: document_idle`).

```
chrome.runtime.onMessage({type:"naukri:refresh"})
   └─ refreshProfile(editPattern, customText)         # entry point
         └─ refreshHeadline(editPattern, customText)  # primary path
         └─ if it returns null → bio/summary fallback flow (inside refreshProfile)
```

### `refreshHeadline` — the normal path
```
refreshHeadline(editPattern, customText)
   ├─ waitFor(findHeadlineEditButton, 8000)      → click the "Edit resume headline" control
   ├─ waitFor(findHeadlineField, 8000)           → editor for the headline (textarea/input/contenteditable)
   ├─ before = readLastUpdated()                 # "Profile last updated - X" line
   ├─ next  = nextText(readText(field), editPattern, customText)
   ├─ writeText(field, next);  wait(400)
   ├─ save  = waitFor(() => findSaveButtonNear(field), 5000)
   ├─ save.click()
   ├─ date moved?  waitFor(isFreshUpdate(before, read), 12000)  → saved:true   # proof #1
   ├─ else drawer closed?  waitFor(!isVisible(field), 6000)
   │     └─ closed + no date line            → saved:true          # old fast path
   │     └─ closed + date line but stale     → "did not stick" fail
   └─ else document.hidden?                  → saved:true + note   # frozen bg tab
         └─ visible tab, drawer open, stale  → "editor stayed open" fail
```

### `refreshProfile` — bio/summary fallback
```
refreshProfile
   ├─ result = refreshHeadline(...);  return result if non-null
   ├─ field  = waitFor(findBioField, 8000)          # longest visible textarea/contenteditable
   ├─ if none → findEditButton() → click → waitFor(findBioField, 8000)   # read-only view
   ├─ next   = nextText(readText(field), editPattern, customText)
   ├─ writeText(field, next);  wait(400)
   ├─ save   = waitFor(findSaveButton, 5000) → click
   ├─ date moved?  waitFor(isFreshUpdate(before, read), 12000)  → saved:true
   └─ else hidden tab? → saved:true + note          # visible + stale → "did not stick" fail
```

### Helper functions (content script)

| Function | Lines | What it does |
|---|---|---|
| `wait(ms)` | 24 | Promise sleep |
| `isVisible(el)` | 31 | `getClientRects().length > 0` and not `disabled`/`readOnly`/`display:none`/`visibility:hidden`/`opacity:0` |
| `waitFor(predicate, timeout, pollMs)` | 45 | Polls `predicate` every `pollMs` up to `timeout`; returns first truthy or `null` |
| `readText(el)` | 101 | `value` for input/textarea, else `textContent` |
| `findLastUpdated()` / `readLastUpdated()` | 107 / 116 | Locates and reads the "Profile last updated" line (`.mod-date-val` …) |
| `isFreshUpdate(before, after)` | 125 | Changed from `before`, or "today"/"now"/"just now"; "yesterday"/"ago" ⇒ not fresh |
| `setNativeValue(el, value)` | 138 | Writes through the prototype's native value setter (React-visible) |
| `isEditableField(el)` | 148 | True for input/textarea or `contenteditable="true"` |
| `findBioField()` | 155 | Sweeps `BIO_SELECTORS`, else the visible textarea/CE box with most characters |
| `findHeadlineEditButton()` | 177 | Sweeps `HEADLINE_EDIT_SELECTORS` for the edit control |
| `findHeadlineField()` | 188 | Sweeps `HEADLINE_FIELD_SELECTORS`, must be both visible and editable |
| `findButtonByText(pattern)` | 197 | First visible `button/a/input[type=submit]/[role=button]` whose text matches |
| `findEditButton()` | 209 | `findButtonByText(/^(edit|edit profile|update profile|edit now)$/i)` |
| `findSaveButton()` | 213 | Strict-then-loose Save/Update search (global) |
| `findSaveButtonNear(field)` | 224 | Save search scoped to the field's own `form/[role=dialog]/.lightbox/.drawer-content/.profileEditDrawer`, so it can't hit another drawer's decoy button; falls back to `findSaveButton()` |
| `findButtonIn(root, pattern)` | 237 | Same as `findButtonByText` but inside one root |
| `nextText(current, editPattern, customText)` | 247 | Computes the replacement text: trims trailing whitespace, then `"custom"` → `+ customText`, `"append"` → `+ " "`, default `"dots"` → remove trailing `.` if present else append `.` (always a real change) |
| `writeText(el, text)` | 263 | Focus, then native setter + dispatch `input`/`change`; routes CE boxes to `writeRichText` |
| `writeRichText(el, text)` | 284 | Focus, select-all via Range/Selection, `document.execCommand("insertText")`; `textContent` fallback; dispatch `input`/`change` |

### Result object shape (content script → background)

```js
{ ok: boolean, edited: boolean, saved: boolean, reason: string, note?: string }
```

`note` is set only on a success that could not be fully verified because the tab
ran in the background (see section 7). The dashboard appends it to the status line.

`ok:false` examples: not logged in, editor didn't open, Save not found,
"the editor stayed open — the change did not save", save clicked but
"Profile last updated" didn't move. Background wraps with `url`.

## 5. Dashboard-side call graph (src/dashboard/dashboard.js)

```
initNaukriPanel()                        # on dashboard load (line 1182)
   ├─ loadPanelSettings()                # → mergeSettings(bundled, storage["settings"])
   ├─ set #naukri-enabled.checked = settings.naukriRefreshEnabled !== false
   ├─ set #naukri-time.value      = settings.naukriRefreshTime || "08:00"
   ├─ #naukri-save click  → savePanelSettings({enabled, time}) → sendMessage("naukri:reschedule") → status
   └─ #naukri-run  click  → runNaukriNow()
#update-naukri (page header) click → runNaukriNow()
```

| Function | Lines | What it does |
|---|---|---|
| `naukriStatus(text, kind)` | 907 | Writes the panel's `<span id="naukri-status-msg">` with an ok/err/busy class |
| `runNaukriNow()` | 918 | Opens/scrolls the panel, sets busy, sends `{type:"naukri:run"}`, then renders the outcome (`result.ok` / `result.reason` / `result.edited` / `result.saved`) |
| `initNaukriPanel()` | 946 | Seeds the toggle/time from settings; wires Save (→ `naukri:reschedule`) and Refresh (→ `runNaukriNow`) |
| `loadPanelSettings()` | 380 | Same three-layer settings read the background uses, returns merged settings |
| `savePanelSettings(patch)` | 397 | Merge patch into `chrome.storage.local.settings` field-by-field (never clobbers API keys) |

Message the dashboard sends to the background: `{ type: "naukri:run" }`
and `{ type: "naukri:reschedule" }`.

## 6. End-to-end value flow (one line each)

```
naukriRefreshTime   → nextRunAt()                        → alarm `when`
naukriRefreshUrl    → triggerNaukriProfileRefresh()      → chrome.tabs.create({url, active:false})
naukriRefreshUrl    → sendNaukriRefresh() message        → content script (profileUrl, informational)
naukriRefreshEditPattern → triggerNaukriProfileRefresh() → message.editPattern         → nextText()
naukriRefreshCustomText → triggerNaukriProfileRefresh()  → message.customText          → nextText()
nextText() → writeText()/writeRichText()                 → Save click → isFreshUpdate(before, after) → ok:true
```

## 7. Where success is decided

After a Save click, the content script asks, in order:

1. **Did "Profile last updated" move?** (polled up to 12 s) — if yes, `saved:true`.
   This is the primary proof because it reflects the server-side commit and still
   works on a hidden background tab.
2. **Did the editor drawer close?** (up to 6 s, only reached if the date did not
   move). If closed and the page shows a last-updated line that did not move →
   `did not stick` failure. If closed and there is no such line → `saved:true`
   (old fast path for layouts without the date).
3. **Is the tab hidden (`document.hidden`)?** — if the drawer is still open *and*
   the tab is a hidden background tab, the frozen render is the cause, not a
   failed save: report `saved:true` with a `note` ("the editor still looked open
   only because the tab ran in the background") instead of a false alarm. Only a
   *visible* tab that keeps both the drawer open and the date stale is a genuine
   failure → "The Save button was clicked but the editor stayed open — the change
   did not save."

The bio/summary fallback gates on the same date-line proof (steps 1 and 3; it has
no drawer to watch).