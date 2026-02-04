import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

// Base types
export const Base64Schema = z.string();
export type Base64 = z.infer<typeof Base64Schema>;

// Schema definitions
export const ChallengeMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('challenge'),
  nonce: Base64Schema,
  serverTimeMs: z.number(),
});
export type ChallengeMsg = z.infer<typeof ChallengeMsgSchema>;

export const AuthMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('auth'),
  agentName: z.string().min(1),
  publicKey: Base64Schema,
  signature: Base64Schema,
  nonce: Base64Schema,
});
export type AuthMsg = z.infer<typeof AuthMsgSchema>;

export const AuthedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('authed'),
  agentId: z.string(),
  credits: z.number(),
});
export type AuthedMsg = z.infer<typeof AuthedMsgSchema>;

export const ErrorMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('error'),
  message: z.string(),
});
export type ErrorMsg = z.infer<typeof ErrorMsgSchema>;

export const JobSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  budget: z.number().positive(),
  requesterId: z.string(),
  createdAtMs: z.number(),
  status: z.enum(['open', 'awarded', 'in_review', 'completed', 'cancelled', 'failed']),
  workerId: z.string().optional(),
  kind: z.string().default('simple'),
  payload: z.record(z.unknown()).default({}),
});
export type Job = z.infer<typeof JobSchema>;

export const BidSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  bidderId: z.string(),
  price: z.number().positive(),
  etaSeconds: z.number().positive(),
  createdAtMs: z.number(),
  pitch: z.string().optional(),
  bidderRep: z
    .object({
      completed: z.number().nonnegative(),
      failed: z.number().nonnegative(),
      score: z.number().min(0).max(1),
    })
    .optional(),
});
export type Bid = z.infer<typeof BidSchema>;

export const PostJobMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('post_job'),
  title: z.string().min(1),
  description: z.string().optional(),
  budget: z.number().positive(),
  kind: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
export type PostJobMsg = z.infer<typeof PostJobMsgSchema>;

export const JobPostedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_posted'),
  job: JobSchema,
});
export type JobPostedMsg = z.infer<typeof JobPostedMsgSchema>;

export const BidMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('bid'),
  jobId: z.string(),
  price: z.number().positive(),
  etaSeconds: z.number().positive(),
  pitch: z.string().optional(),
});
export type BidMsg = z.infer<typeof BidMsgSchema>;

export const BidPostedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('bid_posted'),
  bid: BidSchema,
});
export type BidPostedMsg = z.infer<typeof BidPostedMsgSchema>;

export const AwardMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('award'),
  jobId: z.string(),
  workerId: z.string(),
  notes: z.string().optional(),
});
export type AwardMsg = z.infer<typeof AwardMsgSchema>;

export const JobAwardedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_awarded'),
  jobId: z.string(),
  workerId: z.string(),
  budgetLocked: z.number(),
});
export type JobAwardedMsg = z.infer<typeof JobAwardedMsgSchema>;

export const SubmitMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('submit'),
  jobId: z.string(),
  result: z.string(),
});
export type SubmitMsg = z.infer<typeof SubmitMsgSchema>;

export const ReviewMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('review'),
  jobId: z.string(),
  decision: z.enum(['accept', 'reject', 'changes']),
  notes: z.string().optional(),
});
export type ReviewMsg = z.infer<typeof ReviewMsgSchema>;

export const JobSubmittedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_submitted'),
  jobId: z.string(),
  workerId: z.string(),
  bytes: z.number().nonnegative(),
  preview: z.string().optional(),
});
export type JobSubmittedMsg = z.infer<typeof JobSubmittedMsgSchema>;

export const JobReviewedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_reviewed'),
  jobId: z.string(),
  decision: z.enum(['accept', 'reject', 'changes']),
  notes: z.string().optional(),
});
export type JobReviewedMsg = z.infer<typeof JobReviewedMsgSchema>;

export const JobCompletedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_completed'),
  jobId: z.string(),
  workerId: z.string(),
  paid: z.number(),
});
export type JobCompletedMsg = z.infer<typeof JobCompletedMsgSchema>;

export const LedgerUpdateMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('ledger_update'),
  credits: z.number(),
  locked: z.number().optional(),
});
export type LedgerUpdateMsg = z.infer<typeof LedgerUpdateMsgSchema>;

export const JobFailedMsgSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('job_failed'),
  jobId: z.string(),
  workerId: z.string(),
  reason: z.string(),
});
export type JobFailedMsg = z.infer<typeof JobFailedMsgSchema>;

// Discriminated Unions
export const ServerToAgentMsgSchema = z.discriminatedUnion('type', [
  ChallengeMsgSchema,
  AuthedMsgSchema,
  ErrorMsgSchema,
  JobPostedMsgSchema,
  BidPostedMsgSchema,
  JobAwardedMsgSchema,
  JobSubmittedMsgSchema,
  JobReviewedMsgSchema,
  JobCompletedMsgSchema,
  JobFailedMsgSchema,
  LedgerUpdateMsgSchema,
]);
export type ServerToAgentMsg = z.infer<typeof ServerToAgentMsgSchema>;

export const AgentToServerMsgSchema = z.discriminatedUnion('type', [
  AuthMsgSchema,
  PostJobMsgSchema,
  BidMsgSchema,
  AwardMsgSchema,
  SubmitMsgSchema,
  ReviewMsgSchema,
]);
export type AgentToServerMsg = z.infer<typeof AgentToServerMsgSchema>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseAgentMessage(text: string): AgentToServerMsg | null {
  try {
    const json = JSON.parse(text);
    return AgentToServerMsgSchema.parse(json);
  } catch {
    return null;
  }
}

export function safeParseAgentMessage(text: string) {
  try {
    const json = JSON.parse(text);
    return AgentToServerMsgSchema.safeParse(json);
  } catch {
    return { success: false as const, error: new Error('Invalid JSON') };
  }
}
