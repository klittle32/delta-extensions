import { homedir } from "node:os";
// Classification uses public `letta mods list` text and package.json#letta,
// never Letta's private registry. Stock 0.34.36 does not retain installation pins.
import { Effect, Path, Schema } from "effect";
import type { OperationFiles } from "./index.js";
export type ModInstallation =
  | { readonly kind: "local"; readonly reason: string }
  | {
      readonly kind: "pinned";
      readonly source: string;
      readonly version: string;
    }
  | {
      readonly kind: "managed";
      readonly source: string;
      readonly version: string;
      readonly enabled: boolean;
      readonly pin: "unknown" | "latest";
      readonly root: string;
      readonly modsRoot: string;
    };
const Manifest = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  letta: Schema.Struct({
    manifestVersion: Schema.Literal(1),
    mods: Schema.Array(Schema.NonEmptyString),
  }),
});
/** moduleUrl must be the adapter entry's import.meta.url, not this helper's URL. */
export const classifyModInstallation = (
  moduleUrl: string,
  listing: string,
  files: Pick<OperationFiles, "read">,
  updateSource?: string,
  managedRoot?: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = process.env.LETTA_CONFIG_DIR?.trim();
    if (config && !path.isAbsolute(config))
      return {
        kind: "local",
        reason: "LETTA_CONFIG_DIR is not an absolute path.",
      } as const;
    const modsRoot = path.resolve(
      managedRoot ??
        path.join(
          config || path.join(process.env.HOME || homedir(), ".letta"),
          "mods",
        ),
    );
    const local = (reason: string): ModInstallation => ({
      kind: "local",
      reason,
    });
    const parsedUrl = yield* Effect.try({
      try: () => new URL(moduleUrl),
      catch: () => "invalid" as const,
    }).pipe(Effect.result);
    if (parsedUrl._tag === "Failure")
      return local("The running entry has no valid file URL.");
    const url = parsedUrl.success;
    if (url.protocol !== "file:")
      return local("The running entry is not a local managed package file.");
    const entry = yield* path
      .fromFileUrl(url)
      .pipe(Effect.orElseSucceed(() => ""));
    if (!entry) return local("The running entry file URL is unsupported.");
    // Package roots are observable installed CLI layout; matching also requires
    // the public listing and an exact package manifest entry, not path shape alone.
    const normalized = path.normalize(entry);
    let directory = path.dirname(normalized);
    while (true) {
      const text = yield* files.read(path.join(directory, "package.json"));
      if (text !== undefined) {
        const decoded = yield* Schema.decodeEffect(
          Schema.fromJsonString(Manifest),
        )(text).pipe(Effect.result);
        if (decoded._tag === "Success") {
          const manifest = decoded.success;
          if (
            manifest.letta.mods.some(
              (mod) =>
                !path.isAbsolute(mod) &&
                !path.relative(directory, normalized).startsWith("..") &&
                path.resolve(directory, mod) === normalized,
            )
          ) {
            const section = listing.split(/(?:^|\n)Installed packages\r?\n/)[1];
            if (!section || /^  error\s/m.test(section))
              return local(
                "Stock Letta did not return an unambiguous installed-package listing.",
              );
            const candidates = section.split(/\r?\n/).flatMap((line) => {
              const match =
                /^  (enabled|disabled)  ((?:npm:|git:)[^\s]+)\s*(?:\s{2,}.*)?$/.exec(
                  line,
                );
              if (!match) return [];
              const spec = match[2]!;
              const at = spec.lastIndexOf("@");
              return at > spec.lastIndexOf("/") && at > 4
                ? [
                    {
                      source: spec.slice(0, at),
                      version: spec.slice(at + 1),
                      enabled: match[1] === "enabled",
                    },
                  ]
                : [];
            });
            const managed = candidates.filter((candidate) => {
              if (candidate.version !== manifest.version) return false;
              if (
                candidate.source.startsWith("npm:") &&
                !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
                  candidate.source.slice(4),
                )
              )
                return false;
              if (
                candidate.source.startsWith("git:") &&
                !/^git:https:\/\/github\.com\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(
                  candidate.source,
                )
              )
                return false;
              const suffix = candidate.source.startsWith("npm:")
                ? path.join("packages", "npm", candidate.source.slice(4))
                : candidate.source.startsWith("git:https://github.com/")
                  ? path.join(
                      "packages",
                      "git",
                      "github.com",
                      ...candidate.source.slice(23).split("/"),
                    )
                  : "";
              return (
                suffix &&
                directory === path.resolve(modsRoot, suffix) &&
                (candidate.source.startsWith("git:") ||
                  candidate.source === `npm:${manifest.name}`)
              );
            });
            if (managed.length === 1) {
              const installed = managed[0]!;
              if (updateSource?.startsWith(`${installed.source}@`))
                return {
                  kind: "pinned",
                  source: installed.source,
                  version: updateSource.slice(installed.source.length + 1),
                } satisfies ModInstallation;
              return {
                kind: "managed",
                ...managed[0]!,
                pin: updateSource === installed.source ? "latest" : "unknown",
                root: directory,
                modsRoot,
              } satisfies ModInstallation;
            }
            return local(
              "The running package entry does not match a unique public managed-package listing.",
            );
          }
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return local(
      "Loose MemFS files and source checkouts require manual source updates.",
    );
  });
