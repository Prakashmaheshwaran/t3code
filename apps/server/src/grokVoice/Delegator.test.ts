import { describe, expect, it } from "vite-plus/test";

import { runDelegation, toFunctionTools, type DelegatorDeps } from "./Delegator.ts";

const call = (name: string, args: Record<string, unknown>, id = name) => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

function scripted(rounds: unknown[][], results: Record<string, unknown> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const deps: { -readonly [K in keyof DelegatorDeps]: DelegatorDeps[K] } = {
    tools: [
      {
        name: "t3_thread_send",
        inputSchema: {
          type: "object",
          properties: { environmentId: {}, threadId: {}, message: {} },
          required: ["threadId", "message"],
        },
      },
      { name: "t3_thread_launch", inputSchema: { type: "object", properties: {} } },
      { name: "t3_thread_wait", inputSchema: { type: "object", properties: {} } },
      { name: "preview_open", inputSchema: { type: "object", properties: {} } },
    ],
    respond: async () => rounds.shift() ?? [say("Done.")],
    call: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      return results[name] ?? { structuredContent: { ok: true } };
    },
    approvals: {
      list: async () => [{ requestId: "r1", kind: "file_change" }],
      answer: async (threadId, requestId, decision) => {
        calls.push({ name: "answer_approval", args: { threadId, requestId, decision } });
      },
    },
  };
  return { deps, calls };
}

describe("runDelegation", () => {
  it("shows the delegator the call's notes but keeps them out of thread messages", async () => {
    const { deps, calls } = scripted([
      [call("t3_thread_send", { threadId: "t1", message: "Shorten it.", mode: "steer" })],
      [say("Sent.")],
    ]);
    const inputs: unknown[] = [];
    const respond = deps.respond;
    deps.respond = async (body) => {
      inputs.push(structuredClone(body.input));
      return respond(body);
    };
    await runDelegation(deps, {
      request: "shorten that one",
      transcript: ["User: shorten that one"],
      memory: "- Started the README thread.",
    });
    expect(JSON.stringify(inputs[0])).toContain("Started the README thread.");
    expect(String(calls[0]?.args.message)).not.toContain("README thread");
  });

  it("hands threads the delegator's own prompt, exactly as written", async () => {
    const prompt = "Fix the typo in README.md: 'recieve' should be 'receive'.";
    const { deps, calls } = scripted([
      [call("t3_thread_send", { threadId: "t1", message: prompt, mode: "steer" })],
      [say("Sent that to the docs thread.")],
    ]);
    const result = await runDelegation(deps, {
      request: "fix the typo",
      transcript: ["User: um fix the uh typo in the readme", "Voice agent: On it."],
      viewed: { threadId: "t1", title: "Docs" },
    });

    expect(calls[0]!.args.message).toBe(prompt);
    expect(result).toEqual({
      speech: "Sent that to the docs thread.",
      sent: [{ threadId: "t1", title: "Docs", instruction: "um fix the uh typo in the readme" }],
    });
  });

  it("asks for English prompts and replies in the chosen language", async () => {
    const { deps } = scripted([[say("Done.")]]);
    const seen: string[] = [];
    const respond = deps.respond;
    deps.respond = async (body) => {
      seen.push(body.instructions);
      return respond(body);
    };
    await runDelegation(deps, { request: "status", transcript: [], replyLanguage: "English" });
    await runDelegation(deps, { request: "status", transcript: [] });
    expect(seen[0]).toContain("self-contained prompt in English");
    expect(seen[0]).toContain("Spoken reply language: English.");
    expect(seen[1]).toContain("Spoken reply language: the language the user spoke");
  });

  it("records launched threads, caps waits, and asks the client to open a thread", async () => {
    const { deps, calls } = scripted(
      [
        [
          call("t3_thread_launch", {
            projectId: "p1",
            message: "Add dark mode",
            title: "Dark mode",
          }),
          call("t3_thread_wait", { threadId: "t9", timeoutMs: 600_000 }),
          call("open_thread", { threadId: "t9" }),
        ],
        [say("Started it and opened it.")],
      ],
      { t3_thread_launch: { structuredContent: { threadId: "t9", link: "t3-thread://x" } } },
    );
    const result = await runDelegation(deps, {
      request: "start dark mode",
      transcript: [],
    });

    expect(calls.map((entry) => entry.name)).toEqual(["t3_thread_launch", "t3_thread_wait"]);
    expect(calls[1]!.args.timeoutMs).toBe(90_000);
    expect(result.open).toBe("t9");
    expect(result.sent).toEqual([
      { threadId: "t9", title: "Dark mode", instruction: "start dark mode" },
    ]);
  });
  it("answers the oldest pending approval for the user and announces the run after it", async () => {
    const { deps, calls } = scripted([
      [call("answer_approval", { threadId: "t1", decision: "accept" })],
      [say("Approved.")],
    ]);
    const result = await runDelegation(deps, {
      request: "approve it",
      transcript: ["User: approve it"],
      viewed: { threadId: "t1", title: "Docs" },
    });
    expect(calls).toEqual([
      { name: "answer_approval", args: { threadId: "t1", requestId: "r1", decision: "accept" } },
    ]);
    expect(result.sent).toEqual([{ threadId: "t1", title: "Docs", instruction: "approve it" }]);
  });
});

describe("thread reads", () => {
  it("caps each read and stops a model from paging a thread forever", async () => {
    const { deps, calls } = scripted([
      [call("t3_thread_read", { threadId: "t1", limit: 40, maxCharsPerItem: 6000 }, "a")],
      [call("t3_thread_read", { threadId: "t1" }, "b")],
      [call("t3_thread_read", { threadId: "t1" }, "c")],
      [say("Done.")],
    ]);
    deps.tools = [...deps.tools, { name: "t3_thread_read", inputSchema: { type: "object" } }];
    await runDelegation(deps, { request: "check it", transcript: [] });
    expect(calls.map((entry) => entry.args)).toEqual([
      { threadId: "t1", limit: 10, maxCharsPerItem: 800, view: "messages" },
      { threadId: "t1", limit: 8, maxCharsPerItem: 600, view: "messages" },
    ]);
  });
});

describe("toFunctionTools", () => {
  it("offers only voice tools, without the linked-environment selector", () => {
    const tools = toFunctionTools(scripted([]).deps.tools);
    expect(tools.map((tool) => tool.name)).toEqual([
      "t3_thread_wait",
      "t3_thread_send",
      "t3_thread_launch",
      "pending_approvals",
      "answer_approval",
      "open_thread",
    ]);
    const send = tools.find((tool) => tool.name === "t3_thread_send")!;
    expect(send.parameters).toMatchObject({
      properties: { threadId: {}, message: {} },
      required: ["threadId", "message"],
    });
    expect(Object.keys(send.parameters.properties as object)).not.toContain("environmentId");
  });
});
