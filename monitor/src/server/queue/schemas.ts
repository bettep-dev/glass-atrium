// Zod request schemas for the session-side and owner queue routes: strict objects (unknown keys rejected), length caps, enums.

import { z } from "zod";

const MAX_PID = 2_147_483_647;
const MAX_PATH_LENGTH = 4096;
const MAX_LINKED_DOCS = 20;
// 9 options × (label + pros + cons) stays under the 20000-char options CHECK backstop
const OPTION_TEXT = { label: 200, pros: 800, cons: 800 } as const;

const MAX_TEXT = 20_000;
// queue_items.title VARCHAR(200) → Postgres counts code points
export const ITEM_TITLE_MAX = 200;
// code points, as Zod's max and the VARCHAR(100) column both count → queue.schema.test.ts binds this schema to the column
const SESSION_NAME_MAX = 100;
const MAX_LIST_LIMIT = 200;
const MAX_MESSAGE_TARGETS = 20;
const RECENT_RESUME_LIMIT = { DEFAULT: 10, MAX: 50 } as const;

const sessionId = z.uuid();
// profile_label VARCHAR(64)
const profileLabel = z.string().min(1).max(64);
const optionCode = z.string().regex(/^R[1-9]$/);
const pid = z.int().min(1).max(MAX_PID);
const absolutePath = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "must be an absolute path");
const requiredText = (max: number) => z.string().max(max).refine((value) => value.trim() !== "", "must not be blank");
const sessionName = requiredText(SESSION_NAME_MAX).refine((value) => !/\p{Cc}/u.test(value), "must be one line with no control character");

export const PERMISSION_HINTS = ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] as const;

export const registerBodySchema = z.strictObject({
  sessionId,
  pid,
  cwd: absolutePath,
  configDir: absolutePath.optional(),
  socketPath: absolutePath.optional(),
  permissionHint: z.enum(PERMISSION_HINTS).optional(),
  launchHint: z.enum(["accept_wrapper"]).optional(),
  name: sessionName.optional(),
  derivedName: sessionName.optional(),
});

export const deregisterBodySchema = z.strictObject({
  sessionId,
  pid: pid.optional(),
  socketPath: absolutePath.optional(),
});

export const sessionBodySchema = z.strictObject({ sessionId });

export const ackBodySchema = z.strictObject({ sessionId, msgId: z.uuid() });

const optionSchema = z.strictObject({
  code: optionCode,
  label: requiredText(OPTION_TEXT.label),
  pros: z.string().max(OPTION_TEXT.pros),
  cons: z.string().max(OPTION_TEXT.cons),
});

const itemFields = {
  sessionId,
  title: requiredText(ITEM_TITLE_MAX),
  body: requiredText(MAX_TEXT),
  linkedDocIds: z
    .array(z.int().min(1).max(Number.MAX_SAFE_INTEGER))
    .max(MAX_LINKED_DOCS)
    .refine((ids) => new Set(ids).size === ids.length, "linked doc ids must be unique")
    .default([]),
  isFreeTextAllowed: z.boolean(),
};

const reportSchema = z.strictObject({ kind: z.literal("report"), ...itemFields });

const decisionSchema = z
  .strictObject({
    kind: z.literal("decision"),
    ...itemFields,
    options: z.array(optionSchema).min(2).max(9),
    recommendedCode: optionCode,
    isApprovalClass: z.boolean().default(false),
  })
  .refine((item) => new Set(item.options.map((option) => option.code)).size === item.options.length, {
    message: "option codes must be unique",
    path: ["options"],
  })
  .refine((item) => item.options.some((option) => option.code === item.recommendedCode), {
    message: "recommended code must be one of the option codes",
    path: ["recommendedCode"],
  });

export const postItemBodySchema = z.discriminatedUnion("kind", [reportSchema, decisionSchema]);

export const emptyBodySchema = z.strictObject({});

export const answerBodySchema = z
  .strictObject({ code: optionCode.optional(), text: requiredText(MAX_TEXT).optional() })
  .refine((body) => body.code !== undefined || body.text !== undefined, "an option code or free text is required");

export const replyBodySchema = z.strictObject({ text: requiredText(MAX_TEXT) });

// Query strings arrive as text → numbers coerced, then bounded
export const ownerListQuerySchema = z.strictObject({
  profile: profileLabel.optional(),
  sessionId: sessionId.optional(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(100),
});

export const ownerSessionsQuerySchema = z.strictObject({ profile: profileLabel.optional() });

export const messageBodySchema = z.strictObject({
  sessionIds: z
    .array(sessionId)
    .min(1)
    .max(MAX_MESSAGE_TARGETS)
    // Postgres uuid ignores letter case → compare lower-cased
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "session ids must be unique"),
  text: requiredText(MAX_TEXT),
});

export const recentResumesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(RECENT_RESUME_LIMIT.MAX).default(RECENT_RESUME_LIMIT.DEFAULT),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type DeregisterBody = z.infer<typeof deregisterBodySchema>;
export type PostItemBody = z.infer<typeof postItemBodySchema>;
export type AckBody = z.infer<typeof ackBodySchema>;
export type AnswerBody = z.infer<typeof answerBodySchema>;
export type ReplyBody = z.infer<typeof replyBodySchema>;
export type OwnerListQuery = z.infer<typeof ownerListQuerySchema>;
export type RecentResumesQuery = z.infer<typeof recentResumesQuerySchema>;
export type OwnerSessionsQuery = z.infer<typeof ownerSessionsQuerySchema>;
export type MessageBody = z.infer<typeof messageBodySchema>;
