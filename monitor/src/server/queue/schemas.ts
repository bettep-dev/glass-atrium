// Zod request schemas for the session-side and owner queue routes: strict objects (unknown keys rejected), length caps, enums.

import { z } from "zod";

import { PASSPHRASE } from "./passphrase.js";

const MAX_PID = 2_147_483_647;
const MAX_PATH_LENGTH = 4096;
const MAX_LINKED_DOCS = 20;
// 9 options × (label + pros + cons) stays under the 20000-char options CHECK backstop
const OPTION_TEXT = { label: 200, pros: 800, cons: 800 } as const;

const MAX_TEXT = 20_000;
const MAX_LIST_LIMIT = 200;

const sessionId = z.uuid();
const optionCode = z.string().regex(/^R[1-9]$/);
const pid = z.int().min(1).max(MAX_PID);
const absolutePath = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "must be an absolute path");
const requiredText = (max: number) => z.string().max(max).refine((value) => value.trim() !== "", "must not be blank");

export const PERMISSION_HINTS = ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] as const;

export const registerBodySchema = z.strictObject({
  sessionId,
  pid,
  cwd: absolutePath,
  configDir: absolutePath.optional(),
  socketPath: absolutePath.optional(),
  permissionHint: z.enum(PERMISSION_HINTS).optional(),
  launchHint: z.enum(["accept_wrapper"]).optional(),
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
  title: requiredText(200),
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

export const loginBodySchema = z.strictObject({ passphrase: z.string().min(1).max(PASSPHRASE.MAX_LENGTH) });

export const emptyBodySchema = z.strictObject({});

export const answerBodySchema = z
  .strictObject({ code: optionCode.optional(), text: requiredText(MAX_TEXT).optional() })
  .refine((body) => body.code !== undefined || body.text !== undefined, "an option code or free text is required");

export const replyBodySchema = z.strictObject({ text: requiredText(MAX_TEXT) });

// Query strings arrive as text → numbers coerced, then bounded
export const ownerListQuerySchema = z.strictObject({
  profile: z.string().min(1).max(64).optional(),
  sessionId: sessionId.optional(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(100),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type DeregisterBody = z.infer<typeof deregisterBodySchema>;
export type PostItemBody = z.infer<typeof postItemBodySchema>;
export type AckBody = z.infer<typeof ackBodySchema>;
export type AnswerBody = z.infer<typeof answerBodySchema>;
export type ReplyBody = z.infer<typeof replyBodySchema>;
export type OwnerListQuery = z.infer<typeof ownerListQuerySchema>;
