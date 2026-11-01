#!/usr/bin/env node
// Original bounded, provider-free benchmark fixture. No Delta/network/account calls.
import { once } from "node:events";
const emit = async (value) => {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`))
    await once(process.stdout, "drain");
};
const args = process.argv.slice(2);
if (args.join(" ") === "--json thread contract")
  await emit({ operation: "contract", min: 8, max: 8 });
else if (args[0] === "--json" && args[1] === "thread" && args[2] === "watch") {
  await emit({ type: "ready", thread_id: "thread", producer: null });
  const text = "x".repeat(200);
  for (let i = 0; i < 10_000; i++)
    await emit({
      type: "item",
      item: {
        id: `i${i}`,
        kind: "message",
        after_id: null,
        turn_id: null,
        author: null,
        created_at: null,
        open: false,
        content: { text },
      },
    });
  await emit({ type: "live" });
} else process.exitCode = 64;
