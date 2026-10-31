// Original deterministic child fixture. No Delta executable/account is used.
import { once } from "node:events";

const mode = process.argv[2];
const write = async (stream, data) => {
  if (!stream.write(data)) await once(stream, "drain");
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === "nonzero-empty") {
  process.stderr.write("no-json");
  process.exitCode = 9;
} else if (mode === "malformed-hang" || mode === "frame-hang") {
  process.stdout.write(
    mode === "malformed-hang" ? "{broken}\n" : "x".repeat(4096),
  );
  setInterval(() => {}, 1000);
} else if (mode === "prefix-utf8") {
  process.stdout.write(
    Buffer.concat([Buffer.from('{"text":"first"}\n'), Buffer.from([255, 10])]),
  );
} else if (mode === "prefix-frame") {
  process.stdout.write('{"text":"first"}\n' + "x".repeat(4096));
} else if (mode === "fragments") {
  const bytes = Buffer.from(
    '{"text":"🙂é"}\r\n{"text":"second"}\n{"text":"tail"}',
  );
  for (const byte of bytes) {
    await write(process.stdout, Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  }
} else if (mode === "stderr") {
  for (let i = 0; i < 64; i++)
    await write(process.stderr, Buffer.alloc(65536, "x"));
  process.stderr.write("THE-END");
  emit({ text: "drained" });
} else if (mode === "nonzero") {
  emit({ text: "valid" });
  process.stderr.write("failure-tail");
  process.exitCode = 7;
} else if (mode === "structured") {
  emit({
    error: {
      code: "reload_required",
      message: "refused",
      retryable: false,
      retry_after_ms: 123,
      extra: "preserved",
    },
  });
  process.exitCode = 3;
} else if (mode === "malformed") {
  process.stdout.write("{broken}\n");
} else if (mode === "unknown") {
  emit({ type: "unknown" });
} else if (mode === "utf8") {
  process.stdout.write(Buffer.from([0xff, 10]));
} else if (mode === "frame") {
  await write(process.stdout, Buffer.alloc(4096, "x"));
} else if (mode === "output") {
  for (let i = 0; i < 200; i++) emit({ text: "row" });
} else if (mode === "pretty") {
  process.stdout.write(JSON.stringify({ text: "🙂" }, null, 2));
} else if (mode === "environment") {
  emit({
    cwd: process.cwd(),
    arg: process.argv[3],
    path: Boolean(process.env.PATH),
    extra: process.env.DELTA_FIXTURE_EXTRA,
  });
} else if (
  mode === "hang" ||
  mode === "ignore-term" ||
  mode === "close-pipes"
) {
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  emit({ pid: process.pid });
  if (mode === "close-pipes") {
    process.stdout.end();
    process.stderr.end();
  }
  setInterval(() => {}, 1000);
} else if (mode === "one") {
  emit({ text: "one" });
} else {
  process.exitCode = 2;
}
