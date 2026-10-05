// Lift the two pure scheduling helpers out of background.js without running the
// whole worker (which needs chrome.* at import time).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT, expect } = require("./harness");

const src = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
const start = src.indexOf("function parseSyncTime");
const end = src.indexOf("async function scheduleEmailSync");
const ctx = vm.createContext({ Date, JSON });
vm.runInContext(src.slice(start, end), ctx);
const { parseSyncTime, nextRunAt } = vm.runInContext("({ parseSyncTime, nextRunAt })", ctx);

const { eq, done } = expect("alarm");

eq("parses 09:00", parseSyncTime("09:00"), { hours: 9, minutes: 0 });
eq("parses 9:05 (no leading zero)", parseSyncTime("9:05"), { hours: 9, minutes: 5 });
eq("rejects half-typed", parseSyncTime("9:"), null);
eq("rejects empty", parseSyncTime(""), null);
eq("rejects 25:00", parseSyncTime("25:00"), null);
eq("rejects 09:99", parseSyncTime("09:99"), null);
eq("rejects junk", parseSyncTime("morning"), null);

// A fixed clock: Wed 5 Mar 2026 08:15 local.
const before = new Date(2026, 2, 5, 8, 15, 0, 0).getTime();
eq("today when the time is still ahead", new Date(nextRunAt("09:00", before)).getHours(), 9);
eq("today when the time is still ahead (day)", new Date(nextRunAt("09:00", before)).getDate(), 5);

// Wed 5 Mar 2026 09:00:00 — exactly on the minute has already passed.
const equal = new Date(2026, 2, 5, 9, 0, 0, 0).getTime();
eq("rolls to tomorrow when it has just passed", new Date(nextRunAt("09:00", equal)).getDate(), 6);

// Wed 5 Mar 2026 22:00 local.
const late = new Date(2026, 2, 5, 22, 0, 0, 0).getTime();
eq("late night rolls over", new Date(nextRunAt("09:00", late)).getDate(), 6);
eq("late night keeps the hour", new Date(nextRunAt("09:00", late)).getHours(), 9);

// Seconds are zeroed so the alarm does not drift a minute per day.
eq("seconds zeroed", new Date(nextRunAt("09:30", before)).getSeconds(), 0);

// Month boundary: 31 Mar 23:00 -> 1 Apr.
const monthEnd = new Date(2026, 2, 31, 23, 0, 0, 0).getTime();
eq("month rollover day", new Date(nextRunAt("09:00", monthEnd)).getDate(), 1);
eq("month rollover month", new Date(nextRunAt("09:00", monthEnd)).getMonth(), 3);

// A bad stored time must not schedule midnight.
eq("bad value falls back to 09:00", new Date(nextRunAt("garbage", before)).getHours(), 9);

// 24 distinct daily runs must not drift or repeat an hour.
let t = before; const hours = new Set();
for (let i = 0; i < 24; i++) { const n = nextRunAt("07:45", t); hours.add(new Date(n).getTime()); t = n; }
eq("24 runs, 24 distinct times", hours.size, 24);

process.exit(done() ? 1 : 0);
