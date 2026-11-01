import { type Effect, Schema } from "effect";

export interface Session {
  readonly agentId: string;
  readonly conversationId: string;
  readonly cwd: string;
  readonly interactive: boolean;
  readonly memoryDirectory?: string | null;
  readonly title?: string | null;
  readonly signal: AbortSignal;
  readonly getHistory: (options?: {
    limit?: number;
    order?: "asc" | "desc";
    includeErrors?: boolean;
  }) => Promise<readonly unknown[]>;
  readonly notify: (message: string) => void;
}

export interface Question {
  readonly title: string;
  readonly message: string;
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly allowText?: boolean;
  readonly initialText?: string;
}

export class InteractionError extends Schema.TaggedError<InteractionError>()(
  "InteractionError",
  {
    kind: Schema.Literals([
      "unavailable",
      "io",
      "invalid-question",
      "invalid-response",
      "closed",
    ]),
    message: Schema.String,
  },
) {}

export interface Interaction {
  readonly ask: (
    session: Session,
    question: Question,
  ) => Effect.Effect<string | undefined, InteractionError>;
}
