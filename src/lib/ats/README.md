# ATS adapters

`page-scripts.js` is the shared page engine: it scans ordinary controls,
matches reviewed profile values, and carries out native input/select/radio
interactions. It accepts a plain `pageConfig` so injected scripts remain
self-contained.

Each adapter exports an object with:

- `id` and `name` for identification;
- `matches(url)` to select it for an active tab; and
- `pageConfig` for only the selectors or behavior rules unique to that ATS.

Add a new platform by creating an adapter file, adding it before the generic
adapter in `registry.js`, and loading it before `registry.js` in
`popup/popup.html`. Put platform-specific selector data in the adapter; add
new reusable interaction algorithms to the shared engine only when they can
be expressed through configuration.

`matches(url)` is also called with the origin of every `<iframe>` on the page,
not just the tab's URL, because the form is often not in the page you are
looking at: an employer serves its own careers page and hosts the application
in a cross-origin frame on the ATS. The frame's own URL picks the adapter, so a
Greenhouse form embedded in someone else's page is matched as Greenhouse — see
the FRAMES section in `popup/popup.js`.
