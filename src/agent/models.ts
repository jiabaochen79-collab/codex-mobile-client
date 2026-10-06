import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { z } from 'zod';
import { RemoteError, type ModelOption, type ThreadSettings } from '../shared/protocol.js';

const catalogSchema = z.object({ models: z.array(z.object({
  slug: z.string(), display_name: z.string(), visibility: z.string().optional(),
  priority: z.number().optional(),
  default_reasoning_level: z.string(), supported_reasoning_levels: z.array(z.object({ effort: z.string() })),
  input_modalities: z.array(z.string()).optional()
})) });
type Catalog = z.infer<typeof catalogSchema>;

function modelName(displayName: string) {
  return displayName.startsWith('GPT-') ? displayName.slice(4).replaceAll('-', ' ') : displayName;
}

export function catalogModels(catalog: Catalog): ModelOption[] {
  return catalog.models
    .filter(model => model.visibility === undefined || model.visibility === 'list')
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .map(model => ({ id: model.slug, name: modelName(model.display_name), efforts: model.supported_reasoning_levels.map(e => e.effort), defaultEffort: model.default_reasoning_level, images: model.input_modalities?.includes('image') ?? false }));
}

const run = promisify(execFile);
let modelRead: { executable: string; expires: number; result: Promise<ModelOption[]> } | undefined;
export async function desktopModels(codexExecutable?: string | null): Promise<ModelOption[]> {
  if (!codexExecutable || !win32.isAbsolute(codexExecutable) || win32.basename(codexExecutable).toLowerCase() !== 'codex.exe') {
    throw new RemoteError('UNSUPPORTED', '未发现电脑客户端的模型接口，请更新助手并确认 Codex 已启动。');
  }
  if (modelRead?.executable === codexExecutable && Date.now() < modelRead.expires) return modelRead.result;
  const result = (async () => {
    try {
      const { stdout } = await run(codexExecutable, ['debug', 'models'], { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const models = catalogModels(catalogSchema.parse(JSON.parse(stdout)));
      if (models.length === 0) throw new Error('Empty model catalog');
      return models;
    } catch {
      throw new RemoteError('UNSUPPORTED', '无法获取电脑当前可选模型，请在电脑端检查 Codex 后重试。');
    }
  })();
  modelRead = { executable: codexExecutable, expires: Infinity, result };
  try { const models = await result; if (modelRead?.result === result) modelRead.expires = Date.now() + 5000; return models; }
  catch (error) { if (modelRead?.result === result) modelRead = undefined; throw error; }
}
export function threadSettings(state: any): ThreadSettings {
  const settings = state.latestThreadSettings;
  const mode = settings?.collaborationMode ?? state.latestCollaborationMode;
  const model = settings?.model ?? mode?.settings?.model ?? state.latestModel ?? '';
  const effort = settings?.effort ?? mode?.settings?.reasoning_effort ?? state.latestReasoningEffort ?? null;
  const permissionState = {
    activePermissionProfile: settings?.activePermissionProfile,
    sandboxPolicy: settings?.sandboxPolicy,
    approvalPolicy: settings?.approvalPolicy,
    approvalsReviewer: settings?.approvalsReviewer
  };
  const hasPermissionState = settings && ['activePermissionProfile', 'sandboxPolicy', 'approvalPolicy', 'approvalsReviewer'].some(key => Object.prototype.hasOwnProperty.call(settings, key));
  const profile = permissionState.activePermissionProfile?.id;
  const scope = typeof profile === 'string' ? profile
    : permissionState.sandboxPolicy?.type === 'workspaceWrite' ? ':workspace'
    : permissionState.sandboxPolicy?.type === 'dangerFullAccess' ? ':danger-full-access'
    : undefined;
  const reviewer = permissionState.approvalsReviewer;
  const permission = scope === ':workspace' && permissionState.approvalPolicy === 'on-request' && reviewer === 'user' ? 'ask'
    : scope === ':workspace' && permissionState.approvalPolicy === 'on-request' && (reviewer === 'guardian_subagent' || reviewer === 'auto_review') ? 'approve'
    : scope === ':danger-full-access' && permissionState.approvalPolicy === 'never' && reviewer === 'user' ? 'full'
    : hasPermissionState ? 'custom' : undefined;
  return { model, effort, revision: createHash('sha256').update(JSON.stringify({ model, effort, mode, permissionState })).digest('hex'), ...(mode?.mode === 'plan' || mode?.mode === 'default' ? { mode: mode.mode } : {}), ...(permission ? { permission } : {}) };
}
export function collaborationMode(settings: ThreadSettings, mode: 'plan' | 'default') {
  if (!settings.model || !settings.mode) throw new RemoteError('UNSUPPORTED', '无法确认当前任务的模式或模型，请先在电脑端核对。');
  return { mode, settings: { model: settings.model, reasoning_effort: settings.effort, developer_instructions: null } };
}
export function validateModel(models: ModelOption[], model: string, effort?: string) {
  const selected = models.find(m => m.id === model);
  if (!selected || effort !== undefined && !selected.efforts.includes(effort)) throw new RemoteError('INVALID', '模型或思考深度已不可用，请刷新模型列表。');
  return selected;
}
