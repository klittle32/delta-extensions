// Original provider-free fixture. No Delta calls or protected local files.
import { once } from "node:events";
const mode = process.argv[2];
const write = async (stream, bytes) => {
  if (!stream.write(bytes)) await once(stream, "drain");
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (mode === "blocked") {
  emit({ pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode.startsWith("early")) {
  process.stdin.destroy();
  if (mode !== "early-structured") emit({ text: "prefix" });
  if (mode === "early-structured" || mode === "early-structured-prefix") {
    emit({
      error: { code: "reload_required", message: "refused", retryable: false },
    });
    process.exitCode = 3;
  } else if (mode === "early-nonzero") process.exitCode = 7;
} else {
  if (mode === "duplex") {
    await write(
      process.stdout,
      '{"padding":"' + "x".repeat(2 * 1024 * 1024) + '",',
    );
    await write(process.stderr, "d".repeat(2 * 1024 * 1024));
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("hex");
  if (mode === "duplex")
    process.stdout.write('"text":' + JSON.stringify(text) + "}\n");
  else emit({ text });
}
