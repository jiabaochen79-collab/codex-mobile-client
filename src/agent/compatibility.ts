import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import { parseExpressionAt, tokenizer, type ObjectExpression } from 'acorn';
import { RemoteError } from '../shared/protocol.js';

export type DesktopContract = { appVersion: string; protocols: Record<string, number> };
const core = { 'thread-stream-state-changed': 11, 'thread-stream-following-changed': 1, 'thread-owner-discovery': 1 };
const features = [
  { name: '发送消息', capability: 'send-messages', methods: { 'thread-follower-start-turn': 2 } },
  { name: '停止任务', capability: 'stop-generation', methods: { 'thread-follower-interrupt-turn': 4 } },
  { name: '调整方向', capability: 'steering-text', methods: { 'thread-follower-steer-turn': 1 } },
  { name: '模型设置', capability: 'model-settings', methods: { 'thread-follower-update-thread-settings': [1, 2] } },
  { name: '任务模式', capability: 'task-mode', methods: { 'thread-follower-update-thread-settings': [1, 2] } },
  { name: '任务权限', capability: 'permission-settings', methods: { 'thread-follower-update-thread-settings': [1, 2] } },
  { name: '计划确认', capability: 'plan-implementation', methods: { 'thread-follower-start-turn': 2 } },
  { name: '审批回复', capability: 'respond-approval', methods: { 'thread-follower-command-approval-decision': 1, 'thread-follower-file-approval-decision': 1, 'thread-follower-submit-user-input': 1 } }
];

export function protocolRegistries(source: string) {
  const registries: Record<string, number>[] = []; let brace = -1;
  // Tokenize instead of executing the installed application's JavaScript.
  for (const token of tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })) {
    if (token.type.label === '{') brace = token.start;
    if (brace < 0 || token.type.label !== 'string' || (token as typeof token & { value?: unknown }).value !== 'thread-stream-state-changed') continue;
    let node; try { node = parseExpressionAt(source, brace, { ecmaVersion: 'latest' }); } catch { continue; }
    if (node.type !== 'ObjectExpression') continue;
    const properties = (node as ObjectExpression).properties;
    if (properties.some(p => p.type !== 'Property' || p.computed || p.kind !== 'init' || p.value.type !== 'Literal' || !Number.isSafeInteger(p.value.value) || Number(p.value.value) < 0)) continue;
    const entries = properties.flatMap(p => p.type === 'Property' && p.value.type === 'Literal' && p.key.type === 'Literal' && typeof p.key.value === 'string' ? [[p.key.value, Number(p.value.value)] as const] : []);
    const registry = Object.fromEntries(entries);
    if (Object.keys(core).every(key => key in registry)) {
      if (entries.length !== properties.length || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Ambiguous protocol registry');
      registries.push(registry);
    }
  }
  return registries;
}

export function assessProtocols(protocols: Record<string, number>) {
  const changed = Object.entries(core).filter(([method, version]) => protocols[method] !== version);
  if (changed.length) throw new RemoteError('UNSUPPORTED', `会话通讯接口已变化（${changed[0][0]}），请更新助手。`);
  const capabilities = ['compatibility-checked', 'project-navigation', 'task-list-cursor', 'turn-details', 'activity', 'live-activity', 'multi-terminal', 'message-images', 'conditional-read', 'safety-status'];
  const limited: string[] = [];
  for (const feature of features) {
    if (Object.entries(feature.methods).every(([method, version]) => Array.isArray(version) ? version.includes(protocols[method]) : protocols[method] === version)) capabilities.push(feature.capability);
    else limited.push(feature.name);
  }
  if (capabilities.includes('send-messages')) capabilities.push('attachments', 'create-tasks');
  return { capabilities, reason: limited.length ? `以下功能的接口需适配：${limited.join('、')}。其他功能仍可使用。` : null };
}

export class DesktopCompatibility {
  private cached?: { path: string; size: number; mtime: number; contract: DesktopContract };
  inspect(executablePath: string): DesktopContract {
    const path = join(dirname(executablePath), 'resources', 'app.asar');
    try {
      const stat = statSync(path);
      if (this.cached?.path === path && this.cached.size === stat.size && this.cached.mtime === stat.mtimeMs) return this.cached.contract;
      if (this.cached && this.cached.path !== path) uncache(this.cached.path);
      uncache(path);
      const pkg = JSON.parse(extractFile(path, 'package.json').toString('utf8'));
      if (typeof pkg.version !== 'string' || !pkg.version.trim() || pkg.version.length > 100) throw new Error('Unknown version metadata');
      const candidates = listPackage(path, { isPack: false }).map(file => file.replace(/^[/\\]/, '')).filter(file => /^\.vite\/build\/[^/]+\.js$/.test(file.replaceAll('\\', '/')));
      if (candidates.length > 128) throw new Error('Too many desktop modules');
      const registries: Record<string, number>[] = []; let bytes = 0;
      for (const file of candidates) {
        const entry = statFile(path, file) as { size?: number };
        if (!entry.size || entry.size > 8 * 1024 * 1024) continue;
        bytes += entry.size; if (bytes > 32 * 1024 * 1024) throw new Error('Desktop modules exceed inspection limit');
        const text = extractFile(path, file).toString('utf8');
        if (text.includes('thread-stream-state-changed') && text.includes('thread-owner-discovery')) registries.push(...protocolRegistries(text));
      }
      if (!registries.length || registries.some(registry => JSON.stringify(Object.entries(registry).sort()) !== JSON.stringify(Object.entries(registries[0]).sort()))) throw new Error('Protocol registry missing or ambiguous');
      const contract = { appVersion: pkg.version, protocols: registries[0] };
      this.cached = { path, size: stat.size, mtime: stat.mtimeMs, contract }; return contract;
    } catch { throw new RemoteError('UNSUPPORTED', '无法确认当前客户端的通讯接口定义，请更新助手或检查 Codex 安装是否完整。'); }
  }
}
