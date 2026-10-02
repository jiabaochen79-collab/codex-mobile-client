import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses the package version for installer file and product metadata', () => {
  const setup = readFileSync('installer/windows.iss', 'utf8');
  expect(setup).toContain('VersionInfoVersion={#AppVersion}.0');
  expect(setup).toContain('VersionInfoTextVersion={#AppVersion}');
  expect(setup).toContain('VersionInfoProductVersion={#AppVersion}.0');
  expect(setup).toContain('VersionInfoProductTextVersion={#AppVersion}');
});

it('closes only the remote helper before continuing an upgrade', () => {
  const setup = readFileSync('installer/windows.iss', 'utf8');
  expect(setup).not.toContain('AppMutex=');
  expect(setup).toContain('Local\\CodexMobileCompanion.Exit');
  expect(setup).toContain('taskkill.exe');
  expect(setup).toContain('/PID ');
  expect(setup).toContain('/T /F');
  expect(setup).toContain('ChatGPT 远程助手');
  expect(setup).toContain('远程伴侣');
  expect(setup).not.toContain('Codex.exe');
  expect(setup.indexOf('function OpenMutex')).toBeLessThan(setup.indexOf('function InitializeSetup'));
  const native = readFileSync('native/RemoteCompanion.cs', 'utf8');
  expect(native).toContain('Local\\\\CodexMobileCompanion.Exit');
  expect(native).toContain('ExitForInstall');
});
