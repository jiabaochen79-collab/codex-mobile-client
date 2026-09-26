import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktop } from '../src/agent/desktop.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn()
}));

const cli = 'C:/Codex/bin/codex.exe';
const app = 'C:/WindowsApps/Codex/app/ChatGPT.exe';
const catalog = JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] });
const directories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function adapter() {
  const home = mkdtempSync(join(tmpdir(), 'model-discovery-'));
  directories.push(home);
  writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'obsolete', display_name: 'Obsolete', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] }] }));
  const desktop = new CodexDesktop('unused', home);
  vi.spyOn(desktop, 'status').mockResolvedValue({ available: true, version: 'fixture', reason: null });
  Reflect.set(desktop, 'discovery', { processId: 123, version: 'fixture', toolsPipe: 'fixture', executablePath: app, cliExecutablePath: cli });
  return desktop;
}

it('queries the CLI belonging to the discovered desktop, not the desktop executable or stale cache', async () => {
  const desktop = adapter();
  vi.mocked(execFileSync).mockReturnValue(catalog);
  try {
    const result = await desktop.execute({ method: 'models', params: {} }, 'models');
    expect(result).toEqual({ models: [{ id: 'gpt-6-astra', name: '6 Astra', efforts: ['medium'], defaultEffort: 'medium', images: false }] });
    expect(execFileSync).toHaveBeenCalledWith(cli, ['debug', 'models'], expect.any(Object));
  } finally { desktop.close(); }
});

it('reports model discovery failure instead of presenting stale cache entries', async () => {
  const desktop = adapter();
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('CLI unavailable'); });
  try {
    await expect(desktop.execute({ method: 'models', params: {} }, 'models')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  } finally { desktop.close(); }
});
