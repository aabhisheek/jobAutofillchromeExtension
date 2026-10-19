// The scheduler's shared history/status lib: pure helpers (ring buffer,
// relative-time wording) plus the storage records the worker writes and both
// UIs read. Runs the real src/lib/scheduler-state.js against the harness's
// chrome.storage.local mock, the same way verify-alarm.js runs the real
// scheduling math out of background.js.
const { makeChrome, makeContext, load, take, expect } = require("./harness");

const chromeMock = makeChrome();
const ctx = makeContext({ chrome: chromeMock });
load(ctx, "src/lib/scheduler-state.js");

const S = take(ctx, "SchedulerState");
const store = chromeMock.storage.local.store;

const { eq, ok, done } = expect("scheduler-state");

console.log("--- pushHistory (ring buffer) ---");
eq("empty list yields one entry", S.pushHistory([], { at: 1 }), [{ at: 1 }]);
eq("null list is tolerated", S.pushHistory(null, { at: 1 }), [{ at: 1 }]);
eq("newest first", S.pushHistory([{ at: 1 }], { at: 2 }).map((e) => e.at), [2, 1]);
eq("caps at the given size", S.pushHistory([1, 2, 3], 4, 3).length, 3);
eq("cap keeps the newest, drops the oldest", S.pushHistory([1, 2, 3], 4, 3), [4, 1, 2]);
eq("default cap is 20", S.pushHistory(Array.from({ length: 25 }, (_, i) => i), "x").length, 20);
eq("does not mutate its input", (() => { const list = [1, 2]; S.pushHistory(list, 3); return list.length; })(), 2);

console.log("--- formatWhen (fine-grained relative) ---");
const now = new Date(2026, 2, 5, 12, 0, 0).getTime();
const min = 60000;
eq("future/near-past reads just now", S.formatWhen(now - 30 * 1000, now), "just now");
eq("minutes", S.formatWhen(now - 25 * min, now), "25m ago");
eq("hours", S.formatWhen(now - 3 * 60 * min, now), "3h ago");
eq("one day is 'yesterday'", S.formatWhen(now - 26 * 60 * min, now), "yesterday");
eq("days", S.formatWhen(now - 3 * 24 * 60 * min, now), "3d ago");
eq("unparseable is blank", S.formatWhen("not a date", now), "");
eq("null is blank", S.formatWhen(null, now), "");

console.log("--- formatNextRun ---");
eq("no schedule is blank", S.formatNextRun(null, now), "");
eq("due now when in the past", S.formatNextRun(now - min, now), "due now");
eq("minutes", S.formatNextRun(now + 30 * min, now), "in 30m");
eq("hours", S.formatNextRun(now + 2 * 60 * min, now), "in 2h");
eq("a day out is 'tomorrow'", S.formatNextRun(now + 30 * 60 * min, now), "tomorrow");

console.log("--- formatStamp (exact clock time) ---");
eq("mirrors the mail panel's own toLocaleString", S.formatStamp(now), new Date(now).toLocaleString());
eq("accepts an ISO string", S.formatStamp(new Date(now).toISOString()), new Date(now).toLocaleString());
eq("unparseable is blank", S.formatStamp("not a date"), "");
eq("null is blank", S.formatStamp(null), "");

console.log("--- describeNaukriRun ---");
ok("a saved run reads ok", /ok · profile saved/.test(S.describeNaukriRun({ at: now, ok: true, saved: true })));
ok("edited-but-not-saved is distinct", /edited but not saved/.test(S.describeNaukriRun({ at: now, ok: true, edited: true })));
ok("a failure shows its reason", /failed · tab never answered/.test(S.describeNaukriRun({ at: now, ok: false, reason: "tab never answered" })));
eq("no entry is blank", S.describeNaukriRun(null), "");

console.log("--- describeEmailRun ---");
ok("a normal run counts additions", /ok · 2 new, 1 moved/.test(S.describeEmailRun({ at: now, ok: true, added: 2, updated: 1 })));
ok("a stop is not a failure", /stopped early/.test(S.describeEmailRun({ at: now, ok: true, aborted: true, note: "Stopped before reading." })));
ok("a failure shows its note", /failed · Gmail is not connected/.test(S.describeEmailRun({ at: now, ok: false, note: "Gmail is not connected." })));

(async () => {
  console.log("--- recordNaukriRun writes state + history ---");
  await S.recordNaukriRun({ at: 100, ok: true, saved: true, trigger: "alarm" });
  await S.recordNaukriRun({ at: 200, ok: false, reason: "boom", trigger: "manual" });
  const state = await S.readNaukriState();
  eq("latest state is the newest run", state.at, 200);
  eq("failure recorded", state.ok, false);
  eq("trigger preserved", state.trigger, "manual");
  const history = await S.readNaukriHistory();
  eq("history newest first", history.map((e) => e.at), [200, 100]);
  eq("history keeps only known fields", Object.keys(history[0]).sort(), ["at", "edited", "note", "ok", "reason", "saved", "trigger"]);

  console.log("--- appendEmailHistory trims the full report ---");
  await S.appendEmailHistory({
    at: 500, ok: true, scanned: 9, added: 3, updated: 1, skipped: 2, failed: 0,
    deferred: 0, aiEnriched: 4, full: true,
    notes: ["the window holds at least 1000 messages", "second note"]
  });
  const mailHistory = await S.readEmailHistory();
  eq("one entry appended", mailHistory.length, 1);
  eq("trimmed to the summary fields", mailHistory[0].added, 3);
  eq("only the first note kept", mailHistory[0].note, "the window holds at least 1000 messages");
  eq("no raw notes array persisted", mailHistory[0].notes, undefined);

  console.log("--- readEmailLastRun prefers history, falls back to latest state ---");
  const lastFromHistory = await S.readEmailLastRun();
  eq("newest history entry wins", lastFromHistory.at, 500);
  delete store.emailSyncHistory;
  store.emailSyncState = { at: 900, ok: true, scanned: 1, added: 1, updated: 0, notes: [] };
  const fallback = await S.readEmailLastRun();
  eq("falls back to emailSyncState", fallback.at, 900);
  eq("fallback is trimmed to the one-line shape", fallback.added, 1);

  console.log("--- setNextRun / readSchedulerStatus ---");
  await S.setNextRun("naukriRefresh", 12345);
  await S.setNextRun("emailSync", null);
  const status = await S.readSchedulerStatus();
  eq("naukri next stored", status.naukriRefresh.nextAt, 12345);
  eq("a null clears the next run", status.emailSync.nextAt, null);

  process.exitCode = done() ? 1 : 0;
})();
