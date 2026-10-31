#!/usr/bin/env node
// Original deterministic CLI process fixture; AGPL provenance in NOTICE.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.DELTA_DELIVERY_MODE ?? "normal";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (value) =>
  appendFileSync(process.env.DELTA_DELIVERY_LOG, JSON.stringify(value) + "\n");
if (args.join(" ") === "--json thread contract") {
  log({ args, cwd: process.cwd() });
  emit({ operation: "contract", min: mode === "incompatible" ? 9 : 8, max: 9 });
} else if (
  args[0] === "--json" &&
  args[1] === "thread" &&
  args[2] === "append"
) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  log({ args, cwd: process.cwd(), input });
  const rows = input
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const receipt = (row) => ({
    operation: "appended",
    thread_id: "thread-1",
    sequence: row.sequence,
    next_sequence: row.sequence + 1,
    turn_sequence: row.turnSequence ?? null,
    duplicate: mode === "duplicate",
    disposition:
      mode === "fenced"
        ? "fenced"
        : mode === "duplicate"
          ? "duplicate"
          : "recorded",
    version: "actor.42",
  });
  if (mode === "empty") process.exitCode = 0;
  else if (mode === "wrong-first")
    emit({ ...receipt(rows[0]), thread_id: "wrong" });
  else {
    if (mode === "reload-grace")
      process.on("SIGTERM", () =>
        writeFileSync(process.env.DELTA_DELIVERY_LOG + ".term", "SIGTERM"),
      );
    emit(receipt(rows[0]));
    if (process.env.DELTA_DELIVERY_ACK_GATE)
      while (!existsSync(process.env.DELTA_DELIVERY_ACK_GATE))
        await new Promise((resolve) => setTimeout(resolve, 5));
    if (mode === "reload-grace") {
      emit({
        error: {
          code: "reload_required",
          message: "grace fixture",
          retryable: false,
        },
      });
      setInterval(() => {}, 1000);
    } else if (mode === "malformed-reload") {
      process.stdout.write("not json\n");
      emit({ error: { code: "reload_required", message: "after malformed" } });
      process.exitCode = 3;
    } else if (mode === "reload-zero") {
      emit({ error: { code: "reload_required", message: "zero exit" } });
    } else if (mode === "crash") process.kill(process.pid, "SIGKILL");
    else if (mode === "hang") setInterval(() => {}, 1000);
    else if (mode === "malformed") process.stdout.write("{broken}\n");
    else if (mode === "unknown") emit({ type: "unknown" });
    else if (mode === "wrong") emit({ ...receipt(rows[1]), turn_sequence: 2 });
    else if (mode === "reorder") emit(receipt(rows[0]));
    else if (mode === "extra") {
      for (const row of rows.slice(1)) emit(receipt(row));
      emit({
        ...receipt(rows[0]),
        sequence: rows.at(-1).sequence + 1,
        next_sequence: rows.at(-1).sequence + 2,
      });
    } else if (mode === "limit") process.stdout.write("x".repeat(100000));
    else if (mode === "reload" || mode === "retry") {
      emit({
        error: {
          code: mode === "reload" ? "reload_required" : "offline",
          message: "fixture refusal",
          retryable: mode === "retry",
          retry_after_ms: 123,
          future: "preserved",
        },
      });
      process.exitCode = 3;
    } else if (mode === "nonzero") process.exitCode = 7;
    else if (mode !== "partial")
      for (const row of rows.slice(1)) emit(receipt(row));
  }
} else process.exitCode = 64;
