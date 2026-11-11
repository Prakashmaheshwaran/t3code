// @effect-diagnostics globalDate:off - a voice call's own clock, kept plain like the calls using it.

// What a voice call remembers, whichever voice runs it: everything said, short running notes of
// the older part, and the notes of the user's recent calls. Realtime sessions forget the start
// of a long call; this memory is what a fresh session and each delegation start from.

// Conversation not yet in the notes beyond this folds into them, keeping the newest lines as said.
const FOLD_AT_CHARS = 6_000;
export const KEEP_LINES = 12;
const NOTES_MAX_CHARS = 4_000;
const LINE_MAX_CHARS = 800;
// After a failed fold, the next waits this long rather than retrying on every line.
const FOLD_RETRY_MS = 60_000;
const SEED_MAX_BYTES = 24_000;
// Codex refuses more than 128 initial items.
const SEED_MAX_ITEMS = 120;

const NOTES_INSTRUCTIONS = `You keep the running notes of a voice call between a user and T3 Code's voice assistant, which hands their requests to coding threads. Update the notes with the new part of the conversation.
Keep what a later request could refer back to: what the user asked for, what was done and in which thread (by title), decisions, open questions, pending work, and preferences the user stated (such as the language to answer in).
Drop greetings, filler, and anything later superseded. Plain text, one short line per point, at most 250 words. Write the notes in English. Reply with the notes only.`;

export type Speaker = "User" | "Voice agent" | "T3 Code" | "Update";
export interface Line {
  readonly at: number;
  readonly who: Speaker;
  readonly text: string;
}
export const render = (line: Line) => `${line.who}: ${line.text}`;
/** What the voice agent and the user said, as opposed to T3 Code's own records. */
export const spoken = (line: Line) => line.who === "User" || line.who === "Voice agent";

export interface CallMemory {
  readonly lines: ReadonlyArray<Line>;
  readonly notes: string;
  readonly foldedUpTo: number;
  readonly earlier: string;
}

/** Turns the notes so far and a new stretch of conversation into updated notes. */
export type Summarize = (request: { instructions: string; input: string }) => Promise<string>;

/** A call's memory, with notes folded in the background one fold at a time. */
export class CallLog implements CallMemory {
  readonly lines: Line[] = [];
  /** A summary of `lines` before `foldedUpTo`. */
  notes = "";
  foldedUpTo = 0;
  /** Notes from the user's recent earlier calls. */
  earlier = "";
  private folding: Promise<void> | undefined;
  private foldFailedAt = 0;

  add(who: Speaker, text: string) {
    const trimmed = text.trim();
    if (trimmed) this.lines.push({ at: Date.now(), who, text: trimmed.slice(0, LINE_MAX_CHARS) });
  }

  /** Summarizes the lines before `upTo` into the notes, after any fold already running. */
  fold(upTo: number, summarize: Summarize) {
    const run = (this.folding ?? Promise.resolve())
      .then(async () => {
        const part = this.lines.slice(this.foldedUpTo, upTo);
        if (part.length === 0) return;
        const notes = (
          await summarize({
            instructions: NOTES_INSTRUCTIONS,
            input: `Notes so far:\n${this.notes || "(none)"}\n\nNew conversation:\n${part.map(render).join("\n")}`,
          })
        ).trim();
        if (!notes) throw new Error("No notes came back.");
        this.notes = notes.slice(0, NOTES_MAX_CHARS);
        this.foldedUpTo = Math.max(this.foldedUpTo, upTo);
      })
      .catch(() => {
        this.foldFailedAt = Date.now();
      })
      .finally(() => {
        if (this.folding === run) this.folding = undefined;
      });
    this.folding = run;
    return run;
  }

  /** Folds once the unsummarized conversation grows long; never in the way of the call. */
  foldIfLong(summarize: Summarize) {
    if (this.folding || Date.now() - this.foldFailedAt < FOLD_RETRY_MS) return;
    const upTo = nextFold(this);
    if (upTo !== null) void this.fold(upTo, summarize);
  }
}

/** Where to fold the notes up to now, or null while the unsummarized part is still short. */
export function nextFold(memory: Pick<CallMemory, "lines" | "foldedUpTo">) {
  const upTo = memory.lines.length - KEEP_LINES;
  if (upTo <= memory.foldedUpTo) return null;
  let chars = 0;
  for (const line of memory.lines.slice(memory.foldedUpTo, upTo)) chars += line.text.length + 14;
  return chars >= FOLD_AT_CHARS ? upTo : null;
}

/**
 * What a delegation may need from before its own transcript delta: recent calls, this call's
 * notes, and the lines since the notes, verbatim.
 */
export function delegationMemory(memory: CallMemory, deltaStart: number) {
  const since = memory.lines
    .slice(memory.foldedUpTo, deltaStart)
    .slice(-30)
    .map(render)
    .join("\n")
    .slice(-4_000);
  const parts = [
    memory.earlier && `Recent earlier calls (may be out of date):\n${memory.earlier}`,
    memory.notes && `This call so far:\n${memory.notes}`,
    since && `Then, word for word:\n${since}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * What the voice is always told. With a reply language it answers in that language whatever the
 * user speaks; without one it answers in the language it's spoken to.
 */
export function standingInstructions(replyLanguage: string | undefined) {
  return replyLanguage
    ? [
        `Always speak to the user in ${replyLanguage}, whatever language they speak, unless they ask you to switch. Understand them in any language.`,
      ]
    : [];
}

export interface SeedItem {
  readonly role: "developer" | "user" | "assistant";
  readonly text: string;
}

/** History a realtime session starts with, so it knows the call it joins. */
export function seedItems(
  memory: CallMemory,
  resumed: boolean,
  standing: ReadonlyArray<string> = [],
): SeedItem[] {
  const context = [
    ...standing,
    resumed &&
      "This call continues from an earlier realtime session, which was refreshed to keep the call going. Carry on naturally and don't mention the refresh unless asked.",
    memory.earlier &&
      `Notes from the user's recent earlier calls, which may be out of date:\n${memory.earlier}`,
    memory.notes && `Notes on this call so far:\n${memory.notes}`,
  ].filter(Boolean);
  const items: SeedItem[] = [];
  const header = context.join("\n\n");
  if (header) items.push({ role: "developer", text: header });
  if (!resumed) return items;
  // Codex refuses more than 128 items, or about 8k tokens, which it estimates from bytes.
  let budget = SEED_MAX_BYTES - Buffer.byteLength(header);
  const recent: SeedItem[] = [];
  for (const line of memory.lines.slice(memory.foldedUpTo).toReversed()) {
    budget -= Buffer.byteLength(line.text) + 16;
    if (budget < 0 || items.length + recent.length >= SEED_MAX_ITEMS) break;
    recent.unshift(
      line.who === "User"
        ? { role: "user", text: line.text }
        : line.who === "Voice agent"
          ? { role: "assistant", text: line.text }
          : { role: "developer", text: render(line) },
    );
  }
  return [...items, ...recent];
}
