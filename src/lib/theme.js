/* Appearance preference — one place that decides whether every screen renders in
   light or dark, whatever the OS says.
   ---------------------------------------------------------------------------
   The CSS side is theme.css: tokens are declared once with light-dark() and
   :root says `color-scheme: light dark`, so an unset preference follows the OS.
   Pinning a preference is just `data-theme` on <html> — the light-dark() values
   resolve against the element's used color-scheme, and the explicit
   `[data-theme="light"]` / `[data-theme="dark"]` rules set color-scheme, which
   also flips native widgets (checkboxes, selects, scrollbars) for free.

   The preference is one field of the saved settings record (chrome.storage.local
   -> "settings" -> theme), so it follows the user across the side panel, the
   popup, and all three full-page screens, and the keys screen's
   spread-the-existing-record save cannot clobber it. */

const SETTINGS_KEY = "settings";
const THEME_VALUES = ["system", "light", "dark"];
const THEME_DEFAULT = "system";

const Theme = {
  value: THEME_DEFAULT,

  // Reads the stored preference and applies it. Safe to call more than once;
  // every caller can pass a node to resolve early if it needs the attribute
  // before its own first paint.
  async init() {
    this.apply(this.value);

    try {
      const { settings } = await chrome.storage.local.get(SETTINGS_KEY);
      this.apply(settings && settings.theme);
    } catch {
      // Storage unavailable (context invalidated mid-reload) — the default
      // already applied above.
    }

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(SETTINGS_KEY in changes)) return;
        const next = changes[SETTINGS_KEY].newValue;
        this.apply(next && next.theme);
      });
    }

    return this.value;
  },

  // Accepts anything: an unknown or missing value falls back to the OS rather
  // than leaving the page on a stale theme.
  apply(value) {
    const next = THEME_VALUES.includes(value) ? value : THEME_DEFAULT;
    this.value = next;

    const root = document.documentElement;
    if (next === THEME_DEFAULT) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);

    document.querySelectorAll("[data-theme-value]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.themeValue === next));
    });

    return next;
  },

  async set(value) {
    const next = this.apply(value);
    try {
      const { settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
      await chrome.storage.local.set({ settings: { ...settings, theme: next } });
    } catch {
      // Nothing to do — the current page still switches, it just won't persist.
    }
    return next;
  },

  // One delegated listener covers every switch on the page, so a screen only has
  // to render the markup.
  bind() {
    if (this._bound) return;
    this._bound = true;

    document.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-theme-value]");
      if (btn) this.set(btn.dataset.themeValue);
    });
  },
};

// Apply as early as the document allows so a full-page view never paints in the
// wrong theme, then let storage correct it a tick later.
Theme.bind();
Theme.apply(THEME_DEFAULT);
Theme.init();