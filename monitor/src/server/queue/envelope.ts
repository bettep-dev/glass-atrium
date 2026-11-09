// Delivered text: an envelope per item carrying only ids and the fetch → ack → act order — never the answer itself,
// which the session fetches by id. Every command names the absolute CLI literal the settings allow rule names.

import type { QueueItemKind } from "../../generated/prisma/client.js";

export interface EnvelopeItem {
  id: number;
  kind: QueueItemKind;
  msgId: string;
}

const HEADER: Record<QueueItemKind, string> = { decision: "[ATRIUM-DECISION v1]", report: "[ATRIUM-REPORT v1]" };
const SUBJECT: Record<QueueItemKind, string> = {
  decision: "The owner answered your Atrium queue decision.",
  report: "The owner replied to your Atrium queue report.",
};

export function buildEnvelope(item: EnvelopeItem, cliPath: string): string {
  return [
    `${HEADER[item.kind]} item ${item.id} · msg ${item.msgId}`,
    SUBJECT[item.kind],
    "Follow these steps in order:",
    `1. Fetch it: ${cliPath} get ${item.id} — if the fetched session id is not yours, stop here.`,
    `2. Ack it: ${cliPath} ack ${item.id} ${item.msgId} — act only when the reply is "first"; on "already handled" or a rejection, do nothing.`,
    "3. Act on the answer as the next step of your task.",
  ].join("\n");
}
