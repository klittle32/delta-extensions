import { win32 } from "node:path";
import { Duration, Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const OPEN_TIMEOUT = Duration.seconds(5);

/**
 * Literal argv for the desktop's URL handler; never a shell. macOS and Windows
 * use their fixed system helpers by absolute path, so a planted `open` or
 * `rundll32` earlier on PATH (or in the working directory) is never run.
 * Windows requires a drive-absolute SystemRoot; anything else answers
 * `undefined` and the caller falls back to showing the link.
 */
export const openerArgv = (
  platform: NodeJS.Platform,
  url: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly [string, ...string[]] | undefined => {
  if (platform === "darwin") return ["/usr/bin/open", url];
  if (platform === "win32") {
    const root = env.SystemRoot;
    if (!root || !/^[a-z]:[\\/]/i.test(root) || /[\r\n\0"]/.test(root))
      return undefined;
    return [
      win32.join(root, "System32", "rundll32.exe"),
      "url.dll,FileProtocolHandler",
      url,
    ];
  }
  // freedesktop has no fixed install path for xdg-open; it is resolved from PATH.
  return ["xdg-open", url];
};

/** Answers whether the handler accepted the link; any failure or timeout is `false`. */
export const nativeOpener =
  (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    platform: NodeJS.Platform = process.platform,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) =>
  (url: string): Effect.Effect<boolean> => {
    const argv = openerArgv(platform, url, env);
    if (!argv) return Effect.succeed(false);
    const [command, ...args] = argv;
    return Effect.scoped(
      Effect.flatMap(
        spawner.spawn(
          ChildProcess.make(command, args, {
            shell: false,
            extendEnv: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            killSignal: "SIGTERM",
          }),
        ),
        (handle) => handle.exitCode,
      ),
    ).pipe(
      Effect.map((code) => code === 0),
      Effect.timeoutOrElse({
        duration: OPEN_TIMEOUT,
        orElse: () => Effect.succeed(false),
      }),
      Effect.orElseSucceed(() => false),
    );
  };
