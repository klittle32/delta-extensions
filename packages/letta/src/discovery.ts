// Discovery locations adapted from pinned delta-claude; AGPL-3.0-only.
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { Effect } from "effect";
import { runText } from "./process.js";

const executable = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    },
    catch: () => false,
  }).pipe(
    Effect.match({ onFailure: () => false, onSuccess: (isFile) => isFile }),
  );
/** Windows drive-relative/root-relative paths must never reach process lookup. */
export const windowsHelpers = (systemRoot: string | undefined) =>
  Effect.suspend(() => {
    if (
      !systemRoot ||
      !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(systemRoot) ||
      /[\r\n\0]/.test(systemRoot)
    )
      return Effect.fail(
        "Cannot locate Delta CLI: SystemRoot must be an absolute Windows path.",
      );
    return Effect.succeed({
      where: win32.join(systemRoot, "System32", "where.exe"),
      reg: win32.join(systemRoot, "System32", "reg.exe"),
    });
  });
export const discover = (cwd: string) =>
  Effect.gen(function* () {
    if (process.platform === "win32") {
      const helpers = yield* windowsHelpers(process.env.SystemRoot);
      const found = yield* runText({
        executable: helpers.where,
        args: ["$PATH:delta.exe"],
        cwd,
        timeoutMs: 30_000,
      });
      if (found.exitCode === 0) {
        const first = found.stdout.trim().split(/\r?\n/)[0];
        if (first && isAbsolute(first) && !/[\r\n\0]/.test(first)) return first;
      }
      if (found.exitCode !== 1)
        return yield* Effect.fail("Cannot locate Delta CLI using where.exe.");
      for (const hive of ["HKCU", "HKLM"]) {
        const result = yield* runText({
          executable: helpers.reg,
          args: [
            "query",
            `${hive}\\Software\\Zed Industries\\Delta`,
            "/v",
            "InstallFolder",
            "/reg:64",
          ],
          cwd,
          timeoutMs: 30_000,
        });
        const folder =
          result.exitCode === 0
            ? result.stdout.match(
                /^\s*InstallFolder\s+REG_SZ\s+(.+?)\s*$/m,
              )?.[1]
            : undefined;
        if (folder && isAbsolute(folder)) {
          const candidate = join(folder, "bin", "delta.exe");
          if (yield* executable(candidate)) return candidate;
        }
      }
    } else {
      const home = process.env.HOME;
      const paths = (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) =>
          join(
            isAbsolute(directory) ? directory : join(cwd, directory),
            "delta",
          ),
        );
      if (home && process.platform === "linux")
        paths.push(join(home, ".local/delta.app/bin/delta"));
      if (process.platform === "darwin") {
        if (home)
          paths.push(join(home, "Applications/Delta.app/Contents/MacOS/delta"));
        paths.push("/Applications/Delta.app/Contents/MacOS/delta");
      }
      for (const candidate of paths)
        if (yield* executable(candidate)) return candidate;
    }
    return yield* Effect.fail(
      "Delta CLI is missing. Install Delta manually from https://delta.dev and put delta on PATH.",
    );
  });
