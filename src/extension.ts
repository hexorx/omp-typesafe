import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import type { Questions } from "@typesafe-ai/sdk";
import { DEFAULT_BACKEND, defaultModelId } from "./backends.js";
import { createTypeSafe, DEFAULT_MAX_REQUESTS } from "./client.js";
import type { Evaluation, TypeSafe } from "./client.js";
import { authState, clearAuthState, describeAuth } from "./auth.js";
import { clearStoredApiKey, credentialsPath, keySituation, keySourceLabel } from "./credentials.js";
import { TypeSafeIntegrationError, safeError } from "./errors.js";
import { loginWithPrompt } from "./login.js";
import { DEFAULT_MAX_INPUT_BYTES, prepareEvaluationRequest } from "./schema.js";

const disclosure = "Submitted state and questions will be sent to api.typesafe.ai and may incur charges. Do not include secrets. The extension does not collect files or conversation history. Results are model judgments, not proof or authorization.";
const sample = {
  state: { message: "I was charged twice for my subscription. Please help today." },
  questions: {
    category: { type: "choice", instructions: "Which team should handle this message?", criteria: { billing: "Charges and payments", technical: "Software failures", other: "None of these" } },
    urgent: { type: "noul", instructions: "Does the sender request help today?" },
    frustration: { type: "score", instructions: "How frustrated does the sender sound?", criteria: ["Neutral request", "Frustrated but civil", "Angry or threatening"] },
  },
};

/** Session opt-in. `OMP_TYPESAFE_ENABLED=1` is the omp name; `PI_TYPESAFE_ENABLED=1` still counts. */
function enabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMP_TYPESAFE_ENABLED === "1" || env.PI_TYPESAFE_ENABLED === "1";
}

function format(result: Evaluation<Questions>, expanded = false): string {
  const lines = [`TypeSafe · ${JSON.stringify(result.model)} · ${result.elapsedMs} ms`];
  for (const [id, answer] of Object.entries(result.answers)) {
    const label = JSON.stringify(id);
    if (answer.type === "noul") lines.push(`${label}: P(yes) = ${answer.noul.toFixed(3)}`);
    else if (answer.type === "choice") lines.push(`${label}: ${JSON.stringify(answer.choice)} · confidence ${answer.confidence.toFixed(3)}`);
    else lines.push(`${label}: ${answer.score.toFixed(3)} · confidence ${answer.confidence.toFixed(3)}`);
    if (expanded && answer.type !== "noul") lines.push(`  ${JSON.stringify(answer.probabilities)}`);
  }
  lines.push(`${result.usage.input_tokens} input / ${result.usage.output_tokens} output tokens`);
  lines.push("Confidence is distribution concentration, not proof of correctness.");
  return lines.join("\n");
}

/** omp registration; importing the root library does not load this module. */
export default function typesafeExtension(pi: ExtensionAPI): void {
  let enabled = enabledFromEnv();
  let client: TypeSafe | undefined;
  // One callout per distinct degradation per session: a long run must not bury the reason in repeated notices.
  let calledOut: string | undefined;
  const getClient = () => client ??= createTypeSafe();
  // Status never goes through sendMessage: a custom message is model context. The UI shows it when there is one;
  // otherwise the omp log and a session entry (appendEntry is not sent to the model) are the record.
  const remember = (data: { text: string; level: "info" | "warning" | "error" }) => {
    try { pi.appendEntry("typesafe-status", data); } catch { /* no session runtime yet */ }
  };
  const callOut = (ctx: ExtensionContext | undefined, key: string, text: string) => {
    if (calledOut === key) return;
    calledOut = key;
    try {
      if (ctx?.hasUI) ctx.ui.notify(text, "warning");
      else {
        pi.logger.warn(text);
        remember({ text, level: "warning" });
      }
    } catch {
      // Reporting must never replace the failure it describes, and a headless run may have no message channel.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    enabled = enabledFromEnv();
    client = undefined;
    calledOut = undefined;
    // An enabled extension with no usable key used to look exactly like a working one. Say it at startup; an
    // unverified-but-present key stays quiet, because the first request is what proves it.
    const auth = describeAuth(authState());
    if (enabled && auth.level === "error") callOut(ctx, `start:${auth.level}`, `TypeSafe is enabled but judgments are skipped. ${auth.text}`);
  });

  const promptGuidelines = [
    // The payload shape is what models get wrong on the first call; the same sample the playground edits is the cheapest way to show it.
    // Every session pays for this line on every tool listing, so the sample stays short.
    `Request shape, all three question kinds in one call: ${JSON.stringify(sample)}`,
    "Use typesafe_evaluate only for requested semantic judgments, not calculations or exact lookups; send only the relevant permitted data.",
    "Batch independent typesafe_evaluate questions over the same state; use code or explicit permission rules for actions, never confidence as authorization.",
    "When typesafe_evaluate judges several items, give each item a named state field and ask one question per item per dimension, naming the field in the instructions; one question over many items returns an unusable blend.",
    "Report typesafe_evaluate answers as the model's judgments with their probabilities; do not replace them with your own guesses, and say when an answer is uncertain.",
  ];
  const z = pi.zod;
  // Questions stay loose so near-miss aliases reach execute(), which normalizes them.
  // omp has no prepareArguments hook, and a strict schema would reject those aliases first.
  const tool = {
    name: "typesafe_evaluate",
    label: "TypeSafe",
    description: `Evaluate supplied state with independent Choice, Score, and Noul questions in one TypeSafe request. Each question judges the whole state, so when several items are involved, put each item in a named state field (e.g. \`reports.r1\`) and ask one question per item per dimension (e.g. \`r1_owner\`, \`r2_owner\`), naming the field in the instructions; never aggregate several items into one question. ${disclosure} Requires operator opt-in via /typesafe enable or OMP_TYPESAFE_ENABLED=1. Limit: 32 questions, ${DEFAULT_MAX_INPUT_BYTES / 1024} KiB JSON, ${DEFAULT_MAX_REQUESTS} attempts per session; no retries.\n${promptGuidelines.map(line => `- ${line}`).join("\n")}`,
    promptGuidelines,
    loadMode: "essential" as const,
    parameters: z.object({
      state: z.unknown().describe("What to judge: text, or an object whose fields the questions name."),
      questions: z.record(z.string(), z.unknown()).describe("Questions keyed by a short id, as an object map, not an array."),
      model: z.string().optional().describe("Jev model id, e.g. jev-latest. Omit for the default."),
    }).strict(),
    async execute(_id: string, params: { state: unknown; questions: Record<string, unknown>; model?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<Evaluation<Questions>>> {
      if (!enabled) throw new TypeSafeIntegrationError("configuration", "TypeSafe is disabled. Ask the operator to run /typesafe enable; do not enable it by editing configuration or environment files.");
      // The tool admits through the same rule as the library; evaluate() re-runs it idempotently.
      const request = prepareEvaluationRequest(params);
      try {
        const result = await getClient().evaluate(request, signal ? { signal } : {});
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const safe = safeError(error);
        // Authentication degradation is louder than a single failed call: it means every later judgment is skipped.
        const rejected = safe.code === "http" && (safe.status === 401 || safe.status === 403);
        if (rejected || safe.code === "configuration") {
          callOut(ctx, `run:${safe.code}:${safe.status ?? ""}`, `TypeSafe is not authenticated (${safe.message}) Judgments will fail until the key is fixed.`);
        }
        throw safe;
      }
    },
    renderCall(args: { questions?: Record<string, unknown> }) {
      return new Text(`TypeSafe · ${Object.keys(args.questions ?? {}).length} questions · external request`, 0, 0);
    },
    renderResult(result: AgentToolResult<Evaluation<Questions>>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }) {
      if (isPartial) return new Text("TypeSafe · waiting for response", 0, 0);
      if (!result.details?.answers) return new Text(result.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("\n"), 0, 0);
      return new Text(format(result.details, expanded), 0, 0);
    },
  };
  // promptGuidelines is not part of omp's ToolDefinition; the same lines are in the description.
  pi.registerTool(tool as ToolDefinition);

  const actions = ["login", "logout", "setup", "status", "enable", "disable", "test", "playground"];
  pi.registerCommand("typesafe", {
    description: "TypeSafe login, consent, usage, sample test, and JSON playground",
    getArgumentCompletions(prefix) {
      const matches = actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      const action = args.trim() || "status";
      const report = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) {
          ctx.ui.notify(text, level);
          return;
        }
        const log = level === "error" ? pi.logger.error : level === "warning" ? pi.logger.warn : pi.logger.info;
        log(text);
        remember({ text, level });
      };
      try {
        if (action === "status") {
          const spend = client?.getSpend();
          const auth = describeAuth(authState());
          const session = spend
            ? `Session ${spend.session.requestsStarted}/${DEFAULT_MAX_REQUESTS} attempts, ${spend.session.requestsSucceeded} successful, ${spend.session.requestsFailed} failed, ${spend.session.inputTokens} input tokens (~$${spend.session.estimatedUsd.toFixed(4)}).`
            : `Session 0/${DEFAULT_MAX_REQUESTS} attempts; no client yet in this session.`;
          const today = spend
            ? `Today ${spend.today.requestsStarted} requests (${spend.today.requestsSucceeded} ok, ${spend.today.requestsFailed} failed), ${spend.today.inputTokens} input tokens, ~$${spend.today.estimatedUsd.toFixed(4)}.`
            : "";
          const blocked = spend?.blocked ? ` Cap reached: ${spend.blocked.cap} ${spend.blocked.used}/${spend.blocked.limit} on ${spend.blocked.day}; no request will be submitted until the local day rolls over.` : "";
          report(`TypeSafe: ${enabled ? "enabled" : "disabled"}. ${auth.text} ${session} ${today}${blocked} Model: ${defaultModelId(DEFAULT_BACKEND)}. Session limits reset on session start/reload; daily counters persist and caps come from client options or OMP_TYPESAFE_MAX_* environment variables. ${disclosure}`, auth.level === "error" && enabled ? "warning" : "info");
          return;
        }
        if (action === "logout") {
          const removed = clearStoredApiKey();
          clearAuthState();
          client = undefined;
          enabled = false;
          report(removed ? `Removed the stored key at ${credentialsPath()}. TypeSafe is disabled.` : "No stored key to remove." + (process.env.TYPESAFE_API_KEY?.trim() ? " TYPESAFE_API_KEY is still set in the environment." : ""));
          return;
        }
        if (action === "disable") {
          enabled = false;
          report("TypeSafe disabled for future agent calls. In-flight requests are not cancelled.");
          return;
        }
        if (!actions.includes(action)) {
          report(`Usage: /typesafe ${actions.join(" | ")}`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          report("This command needs an interactive omp session. For headless tool use, explicitly set OMP_TYPESAFE_ENABLED=1 and TYPESAFE_API_KEY before launching omp.", "warning");
          return;
        }
        const situation = keySituation();
        if (action === "login" || (action === "setup" && situation.kind === "missing")) {
          if (process.env.TYPESAFE_API_KEY?.trim()) {
            report("TYPESAFE_API_KEY is set in the environment and takes precedence over a stored key. Unset it before using /typesafe login.", "warning");
            return;
          }
          const login = await loginWithPrompt(ctx);
          if (login === undefined) { report("Login cancelled; nothing was saved."); return; }
          client = undefined;
          report(`Key verified (${login.models} model${login.models === 1 ? "" : "s"} available) and saved to ${login.path} with owner-only permissions. Run /typesafe enable to allow agent tool calls.`);
          return;
        }
        if (action === "setup") {
          const current = situation.kind === "environment" || situation.kind === "stored" ? `configured via ${keySourceLabel(situation)}`
            : situation.kind === "unusable" ? `unusable — ${situation.reason}`
            : "missing";
          report(`Key ${current}. Run /typesafe test for one sample request or /typesafe enable to allow agent tool calls.`);
          return;
        }
        if (action === "enable") {
          if (situation.kind === "missing") { report("Run /typesafe login first: no API key is configured.", "warning"); return; }
          if (situation.kind === "unusable") { report(`The stored key cannot be used. ${situation.reason}`, "warning"); return; }
          if (await ctx.ui.confirm("Enable TypeSafe for this session?", disclosure)) {
            enabled = true;
            report(`TypeSafe enabled. Up to ${DEFAULT_MAX_REQUESTS} attempts in this session; /typesafe disable stops future agent calls.`);
          }
          return;
        }
        let request = sample;
        if (action === "playground") {
          const text = await ctx.ui.editor("TypeSafe request JSON · edit state and questions", JSON.stringify(sample, null, 2));
          if (text === undefined) return;
          try { request = JSON.parse(text); } catch { report("Invalid JSON. Keep quoted strings on one line; nothing was sent.", "error"); return; }
        }
        const validated = prepareEvaluationRequest(request);
        if (!await ctx.ui.confirm("Send this TypeSafe request?", disclosure)) return;
        const result = await getClient().evaluate(validated);
        // Shown in the terminal only. appendEntry persists the result without putting it in model context.
        // omp does not render custom entries, so the formatted text is also notified.
        report(format(result, true));
        try { pi.appendEntry("typesafe-result", result); } catch { /* no session runtime yet */ }
      } catch (error) {
        report(safeError(error).message, "error");
      }
    },
  });
}
