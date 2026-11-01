#!/usr/bin/env node
// Original deterministic watch CLI. No Delta/account/network/local file reads.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.DELTA_WATCH_MODE ?? "normal";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
appendFileSync(
  process.env.DELTA_WATCH_LOG,
  JSON.stringify({ args, cwd: process.cwd() }) + "\n",
);
if (args.join(" ") === "--json thread contract")
  emit({ operation: "contract", min: mode === "incompatible" ? 9 : 8, max: 9 });
else if (args[0] === "--json" && args[1] === "thread" && args[2] === "watch") {
  const source = args[args.indexOf("--source") + 1];
  const external_id = args[args.indexOf("--external-id") + 1];
  emit({
    type: "ready",
    thread_id: "thread-1",
    producer: { source, external_id, next_sequence: 1, turn: null },
    fixturePid: process.pid,
  });
  if (mode === "compat") {
    emit({ type: "live", error: null });
    emit({ type: "error" });
    emit({ type: "live", error: { code: 1 } });
    emit({
      error: {
        code: "watch_reset",
        message: "normalized",
        reason: 3,
        retryable: "true",
        retry_after_ms: -1,
      },
    });
  } else if (mode === "hang") setInterval(() => {}, 1000);
  else if (mode === "malformed")
    emit({ type: "item", item: { id: "missing-fields" } });
  else if (mode === "limit") process.stdout.write("x".repeat(10000));
  else if (mode === "error")
    emit({
      error: {
        code: "watch_reset",
        reason: "watch_overflow",
        message: "fresh snapshot needed",
        retryable: true,
        retry_after_ms: 200,
        future: true,
      },
    });
  else {
    emit({ type: "future-event", opaque: ["🙂", null] });
    emit({ type: "live" });
    if (mode === "nonzero") process.exitCode = 7;
  }
} else process.exitCode = 64;
