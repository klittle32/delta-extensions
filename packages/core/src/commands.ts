// Adapted command grammar; see NOTICE for pinned source and license.
export const commandNames = [
  "delta",
  "delta-share",
  "delta-join",
  "delta-setup",
  "delta-update",
  "delta-plugin-update",
  "delta-org",
] as const;
export const usage =
  "/delta [share [<email>…] | join <shared-link-or-thread> | setup | update | plugin-update [check | notifications on|off] | org list|current|switch <ID>|invite <email>…|manage]";
export type Command =
  | { kind: "menu" | "team-menu" | "setup" | "update" }
  | { kind: "share"; emails: string[] }
  | { kind: "join"; locator: string | null }
  | { kind: "plugin-update"; action: "update" | "check" }
  | { kind: "plugin-update"; action: "notifications"; enabled: boolean }
  | { kind: "org"; action: "list" | "current" | "manage" }
  | { kind: "org"; action: "switch"; id: string }
  | { kind: "org"; action: "invite"; emails: string[] }
  | { kind: "usage"; usage: string };
const emailsIn = (text: string) => [
  ...new Set(
    text.split(/[\s,;]+/).filter((word) => /^[^@\s]+@[^@\s]+$/.test(word)),
  ),
];
/** Parses an ID and raw arguments; UI, consent and execution belong to the adapter. */
export function parseCommand(name: string, args: string): Command {
  const invalid = (): Command => ({ kind: "usage", usage });
  if (!commandNames.some((known) => known === name)) return invalid();
  // Dedicated bare commands have menu entry points that /delta subcommands lack.
  if (!args.trim()) {
    if (name === "delta-org") return { kind: "team-menu" };
    if (name === "delta-join") return { kind: "join", locator: null };
  }
  const text = (name === "delta" ? args : `${name.slice(6)} ${args}`).trim();
  if (!text) return { kind: "menu" };
  const [action, ...words] = text.split(/\s+/);
  const tail = words.join(" ");
  switch (action) {
    case "setup":
    case "update":
      return words.length ? invalid() : { kind: action };
    case "share": {
      const emails = emailsIn(tail);
      return !tail || emails.length ? { kind: "share", emails } : invalid();
    }
    case "join":
      return words.length === 1 && words[0]
        ? { kind: "join", locator: words[0] }
        : invalid();
    case "plugin-update":
      if (!tail || tail === "check")
        return { kind: "plugin-update", action: tail ? "check" : "update" };
      if (tail === "notifications on" || tail === "notifications off")
        return {
          kind: "plugin-update",
          action: "notifications",
          enabled: tail.endsWith("on"),
        };
      return invalid();
    case "org": {
      const [sub, id, ...extra] = words;
      if ((sub === "list" || sub === "current" || sub === "manage") && !id)
        return { kind: "org", action: sub };
      if (sub === "switch" && id && !extra.length)
        return { kind: "org", action: "switch", id };
      if (sub === "invite") {
        const emails = emailsIn(words.slice(1).join(" "));
        if (emails.length) return { kind: "org", action: "invite", emails };
      }
      return invalid();
    }
    default:
      return invalid();
  }
}
