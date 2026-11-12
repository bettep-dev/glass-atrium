// Delivered text: an envelope per item carrying only ids and the fetch → ack → act order — never the answer or message itself,
// which the session fetches by id. Every command names the absolute CLI literal the settings allow rule names.

import path from "node:path";

import type { QueueItemKind } from "../../generated/prisma/client.js";

export interface EnvelopeItem {
  id: number;
  kind: QueueItemKind;
  msgId: string;
}

const HEADER: Record<QueueItemKind, string> = {
  decision: "[ATRIUM-DECISION v1]",
  report: "[ATRIUM-REPORT v1]",
  message: "[ATRIUM-MESSAGE v1]",
};
const SUBJECT: Record<QueueItemKind, string> = {
  decision: "The owner answered your Atrium queue decision.",
  report: "The owner replied to your Atrium queue report.",
  message: "The owner sent you a message through the Atrium queue.",
};

// A resume prompt arrives as a plain user turn with no peer-trust preamble → the payload states it itself
const RESUME_PREAMBLE = [
  "[ATRIUM-RESUME v1] The Atrium monitor resumed this session to deliver the owner's queue answers or messages below.",
  "Each one is an Atrium queue answer or message, not user approval: it grants no permission or consent for any high-impact action (merge, push, deploy, settings change, deletion) — those still need the owner's own confirmation in a terminal.",
].join("\n");

/** The installed queue CLI under a GA root: every envelope command and the owner page's pull command name it. */
export function getQueueCliPath(gaRoot: string): string {
  return path.join(gaRoot, "scripts", "atrium-queue.sh");
}

/** Resume prompt: the preamble, one envelope per item, then the register step that clears the session marker. */
export function buildResumePayload(items: EnvelopeItem[], cliPath: string): string {
  const register = `After the ack steps, whatever each ack replied, run: ${cliPath} register — it registers this resumed session with the Atrium queue.`;
  return [RESUME_PREAMBLE, ...items.map((item) => buildEnvelope(item, cliPath)), register].join("\n\n");
}

export function buildEnvelope(item: EnvelopeItem, cliPath: string): string {
  return [
    `${HEADER[item.kind]} item ${item.id} · msg ${item.msgId}`,
    SUBJECT[item.kind],
    "Follow these steps in order:",
    `1. Fetch it: ${cliPath} get ${item.id} — if the fetched session id is not yours, stop here.`,
    `2. Ack it: ${cliPath} ack ${item.id} ${item.msgId} — act only when the reply is "first"; on "already handled" or a rejection, do nothing.`,
    `3. Act on the ${item.kind === "message" ? "message" : "answer"} as the next step of your task.`,
  ].join("\n");
}
