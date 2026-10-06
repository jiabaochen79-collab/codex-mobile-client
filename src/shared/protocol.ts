import { z } from 'zod';
import { MAX_FILE_SIZE } from './upload-limits.js';
export { MAX_UPLOAD_CHUNK, MAX_FILE_SIZE, MAX_ATTACHMENT_TOTAL } from './upload-limits.js';

export const VERSION = '0.2.0';
export const MAX_FRAME = 2 * 1024 * 1024;
export const uid = z.string().uuid();
export const codeSchema = z.string().min(8).max(64).refine(value => value.trim().length > 0);
export const passwordSettingsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('automatic') }).strict(),
  z.object({ mode: z.literal('custom'), password: codeSchema }).strict()
]);
export type PasswordSettings = z.infer<typeof passwordSettingsSchema>;
export const idSchema = z.string().regex(/^[1-9][0-9]{8}$/);
const epochSchema = z.string().min(1).max(200);
const modelSchema = z.string().min(1).max(200);
const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const taskModeSchema = z.enum(['plan', 'default']);
export const permissionModeSchema = z.enum(['ask', 'approve', 'full']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const commandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('list'), params: z.object({ cursor: z.union([z.literal('new'), uid]).optional(), offset: z.number().int().min(0).max(10000).default(0), projectId: z.string().min(1).max(200).nullable().optional(), query: z.string().trim().max(200).optional() }).strict() }).strict(),
  z.object({ method: z.literal('read'), params: z.object({ id: uid, limit: z.number().int().min(20).max(500).default(100), before: z.string().min(1).max(200).optional(), activate: z.boolean().optional(), ifRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict() }).strict(),
  z.object({ method: z.literal('safety.status'), params: z.object({ id: uid }).strict() }).strict(),
  z.object({ method: z.literal('image.read'), params: z.object({ id: uid, imageId: z.string().regex(/^[a-f0-9]{64}$/), variant: z.enum(['thumbnail', 'full']) }).strict() }).strict(),
  z.object({ method: z.literal('send'), params: z.object({ id: uid, text: z.string().trim().max(32000), epoch: epochSchema, attachmentIds: z.array(uid).max(5).optional(), mode: z.enum(['queue','steer']).optional(), turnId: epochSchema.optional() }).strict().refine(p => (!!p.text || !!p.attachmentIds?.length) && (p.mode !== 'steer' || !!p.turnId)) }).strict(),
  z.object({ method: z.literal('queue.list'), params: z.object({ id: uid }).strict() }).strict(),
  z.object({ method: z.literal('command.status'), params: z.object({ id: uid, requestId: uid }).strict() }).strict(),
  z.object({ method: z.literal('queue.remove'), params: z.object({ id: uid, queuedId: uid }).strict() }).strict(),
  z.object({ method: z.literal('queue.resume'), params: z.object({ id: uid, queuedId: uid, epoch: epochSchema }).strict() }).strict(),
  z.object({ method: z.literal('stop'), params: z.object({ id: uid, turnId: z.string().min(1).max(200), epoch: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ method: z.literal('respond'), params: z.object({ id: uid, requestId: z.union([z.string().max(200), z.number()]), decision: z.enum(['accept', 'decline']).optional(), answers: z.record(z.string(), z.array(z.string().max(4000))).optional(), epoch: z.string().min(1).max(200) }).strict().refine(params => params.decision === undefined || params.answers === undefined) }).strict(),
  z.object({ method: z.literal('projects'), params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('create'), params: z.object({ projectId: z.string().min(1).max(200), text: z.string().trim().min(1).max(32000), model: modelSchema.optional(), effort: effortSchema.optional() }).strict() }).strict(),
  z.object({ method: z.literal('models'), params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('settings.update'), params: z.object({ id: uid, epoch: epochSchema, revision: epochSchema, model: modelSchema, effort: effortSchema }).strict() }).strict(),
  z.object({ method: z.literal('mode.update'), params: z.object({ id: uid, epoch: epochSchema, revision: epochSchema, mode: taskModeSchema }).strict() }).strict(),
  z.object({ method: z.literal('permissions.update'), params: z.object({ id: uid, epoch: epochSchema, revision: epochSchema, permission: permissionModeSchema }).strict() }).strict(),
  z.object({ method: z.literal('plan.respond'), params: z.object({ id: uid, epoch: epochSchema, requestId: z.string().min(1).max(200), revision: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['implement', 'revise']), feedback: z.string().trim().min(1).max(4000).optional() }).strict().refine(p => p.action === 'revise' ? !!p.feedback : p.feedback === undefined) }).strict(),
  z.object({ method: z.literal('activity'), params: z.object({ ids: z.array(uid).max(150) }).strict() }).strict(),
 z.object({ method: z.literal('seen'), params: z.object({ id: uid, completionId: z.string().max(200), turnId: z.string().min(1).max(200).optional() }).strict() }).strict(),
  z.object({ method: z.literal('control.claim'), params: z.object({ epoch: uid.nullable() }).strict() }).strict(),
  z.object({ method: z.literal('upload.begin'), params: z.object({ id: uid, name: z.string().min(1).max(180), size: z.number().int().min(1).max(MAX_FILE_SIZE), sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string().max(100) }).strict() }).strict(),
  z.object({ method: z.literal('upload.status'), params: z.object({ attachmentId: uid }).strict() }).strict(),
  z.object({ method: z.literal('upload.complete'), params: z.object({ attachmentId: uid }).strict() }).strict(),
  z.object({ method: z.literal('upload.remove'), params: z.object({ attachmentId: uid }).strict() }).strict()
]);
export type Command = z.infer<typeof commandSchema>;
export function supportsDesktopCommand(capabilities: string[] | undefined, command: Command) {
  if (command.method === 'plan.respond') return capabilities?.includes('plan-implementation') === true;
  if (command.method === 'mode.update') return capabilities?.includes('task-mode') === true;
  if (command.method === 'permissions.update') return capabilities?.includes('permission-settings') === true;
  const feature = command.method === 'send' ? command.params.mode === 'steer' ? 'steering-text' : 'send-messages'
    : command.method === 'create' ? 'create-tasks' : command.method === 'stop' ? 'stop-generation'
    : command.method === 'respond' ? 'respond-approval' : command.method === 'settings.update' ? 'model-settings'
    : command.method === 'queue.resume' ? 'send-messages' : ['upload.begin', 'upload.complete'].includes(command.method) ? 'attachments' : undefined;
  return !feature || !capabilities?.includes('compatibility-checked') || capabilities.includes(feature);
}
export const commandFrame = z.object({ type: z.literal('command'), id: uid, command: commandSchema, controlEpoch: uid.optional() }).strict();
export const readMethods = new Set<Command['method']>(['list', 'read', 'image.read', 'safety.status', 'projects', 'models', 'activity', 'seen', 'upload.status', 'queue.list', 'command.status']);
export const isSafetyCommand = (command: Command) => command.method === 'stop' || command.method === 'safety.status' || command.method === 'command.status' || command.method === 'upload.remove' || command.method === 'queue.remove' || command.method === 'respond' && command.params.decision === 'decline' && command.params.answers === undefined;
export type ControlLease = { sessionId: string; clientId: string; epoch: string; expires: number };
export type ControlState = { role: 'controller' | 'viewer'; epoch: string | null; expires: number | null; terminals: { id: string; label: string; controlling: boolean }[] };
export type ModelOption = { id: string; name: string; efforts: string[]; defaultEffort: string; images: boolean };
export type ThreadSettings = { model: string; effort: string | null; revision: string; mode?: 'plan' | 'default'; permission?: PermissionMode | 'custom' };
export type Activity = { id: string; running: boolean; unread: boolean; completionId: string };
export type Attachment = { id: string; name: string; size: number; mediaType: string; offset: number; ready: boolean };
export type LocalAttachment = Attachment & { path: string };
export type ClientStatus = { available: boolean; version: string | null; reason: string | null; capabilities?: string[] };
export type Project = { id: string; name: string; path: string; count?: number };
export type Conversation = { id: string; title: string; cwd: string; updatedAt: number; projectId?: string | null; running?: boolean; unread?: boolean; completionId?: string };
export type MessageImage = { id: string; alt: string };
export const MAX_IMAGE_BYTES = 1024 * 1024;
export type Message = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; images?: MessageImage[]; status?: string; turnId?: string; turnStatus?: string; turnReason?: string; phase?: 'commentary' | 'final' | 'reasoning' };
export type Interaction = { id: string | number; kind: 'command' | 'file' | 'input' | 'plan' | 'unsupported'; title: string; detail: string; plan?: { turnId: string; revision: string }; questions?: { id: string; question: string; options: { label: string; description?: string }[] }[] };
export type QueuedMessage = { id: string; text: string; attachments: { id: string; name: string }[]; state: 'pending' | 'paused' | 'sending' | 'uncertain'; reason: string | null; created: number };
export type Snapshot = { id: string; title: string; epoch: string; turnId: string | null; busy: boolean; messages: Message[]; requests: Interaction[]; hasMore: boolean; historyCursor?: string; settings?: ThreadSettings; completionId?: string; revision?: string; lastTurnStatus?: string; lastTurnId?: string | null; lastTurnReason?: string; nativeQueuedCount?: number | null; queued?: QueuedMessage[] };
export interface DesktopAdapter {
  updateBlockers?(): Promise<string[]>;
  notificationSources?(taskIds?: string[]): Promise<{ id: string; path: string }[]>;
  status(): Promise<ClientStatus>;
  execute(command: Command, commandId: string, authorize?: () => void, attachments?: LocalAttachment[]): Promise<unknown>;
  setSubscriptions?(ids: string[]): void;
  close(): void;
  onChange?: (id: string) => void;
}
export class RemoteError extends Error {
  constructor(public code: string, message: string, public retryAfterSeconds?: number) { super(message); }
}
export function publicError(error: unknown) {
  return error instanceof RemoteError ? { code: error.code, message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } : { code: 'INTERNAL', message: '操作未完成，请重新连接后核对状态。' };
}
