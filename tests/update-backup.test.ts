import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFailedProgram, createProgramBackup, pruneProgramBackups, restoreProgramBackup, verifyProgramBackup } from '../src/agent/update-backup.js';

const disk = vi.hoisted(() => ({ low: false, programLow: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, statfsSync: (path: string) => disk.low || disk.programLow && path.endsWith('install-volume') ? { bavail: 1, bsize: 1 } : fs.statfsSync(path) };
});

describe('local program rollback backup', () => {
  let dir: string, root: string, data: string, nonce: string;
  beforeEach(() => {
    disk.low = false; disk.programLow = false; dir = mkdtempSync(join(process.cwd(), '.runtime/update-backup-'));
    root = join(dir, 'program'); data = join(dir, 'data'); nonce = randomUUID();
    mkdirSync(join(root, 'dist'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'codex-mobile', version: '0.4.22' }));
    writeFileSync(join(root, 'RemoteCompanion.exe'), 'original helper'); writeFileSync(join(root, 'node.exe'), 'original node');
    writeFileSync(join(root, 'dist/agent.mjs'), 'original agent'); writeFileSync(join(root, 'relay.json'), 'original relay');
    writeFileSync(join(data, 'agent.sqlite'), 'device and subscription state, never restored');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('restores exact installed files, removes new-only program files and preserves current user data', async () => {
    await createProgramBackup(root, data, nonce, '0.4.22');
    writeFileSync(join(root, 'RemoteCompanion.exe'), 'candidate'); writeFileSync(join(root, 'new-only.dll'), 'new module');
    writeFileSync(join(data, 'agent.sqlite'), 'newest device and subscription state');
    const result = await restoreProgramBackup(root, data, nonce);
    expect(result.version).toBe('0.4.22'); expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('original helper');
    expect(existsSync(join(root, 'new-only.dll'))).toBe(false);
    expect(readFileSync(join(data, 'agent.sqlite'), 'utf8')).toBe('newest device and subscription state');
    expect(readFileSync(join(result.displaced, 'RemoteCompanion.exe'), 'utf8')).toBe('candidate');
    await cleanupFailedProgram(root, data, nonce);
    expect(existsSync(result.displaced)).toBe(false);
    expect(existsSync(join(data, 'updates/program-backups', nonce))).toBe(true);
  });
  it('rejects corrupted backup files before changing the installed program', async () => {
    const backup = await createProgramBackup(root, data, nonce, '0.4.22');
    writeFileSync(join(backup, 'program/RemoteCompanion.exe'), 'corrupt');
    await expect(restoreProgramBackup(root, data, nonce)).rejects.toThrow('Backup verification failed');
    expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('original helper');
  });
  it('restores when a failed installer has removed the program directory', async () => {
    await createProgramBackup(root, data, nonce, '0.4.22');
    rmSync(root, { recursive: true });
    await restoreProgramBackup(root, data, nonce);
    expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('original helper');
    expect(readFileSync(join(data, 'agent.sqlite'), 'utf8')).toBe('device and subscription state, never restored');
  });
  it.each(['../outside.txt', '/outside.txt', 'C:/outside.txt', 'dist/../../outside.txt'])('rejects a manifest path escaping the program: %s', async path => {
    const backup = await createProgramBackup(root, data, nonce, '0.4.22');
    const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')); manifest.files[0].path = path;
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(manifest));
    await expect(restoreProgramBackup(root, data, nonce)).rejects.toThrow();
    expect(readFileSync(join(root, 'RemoteCompanion.exe'), 'utf8')).toBe('original helper');
  });
  it('rejects a backup version unrelated to its original package metadata', async () => {
    const backup = await createProgramBackup(root, data, nonce, '0.4.22');
    const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')); manifest.version = '0.4.45';
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(manifest));
    await expect(verifyProgramBackup(backup)).rejects.toThrow('Backup version');
  });
  it('does not start copying when local backup space is insufficient', async () => {
    disk.low = true;
    await expect(createProgramBackup(root, data, nonce, '0.4.22')).rejects.toThrow('Insufficient space');
    expect(existsSync(join(data, 'updates/program-backups', nonce))).toBe(false);
  });
  it('rejects insufficient installation-volume space even when the data-volume check passes', async () => {
    const installVolume = join(dir, 'install-volume'); mkdirSync(installVolume);
    const moved = join(installVolume, 'program');
    const { renameSync } = await import('node:fs'); renameSync(root, moved); root = moved; disk.programLow = true;
    await expect(createProgramBackup(root, data, nonce, '0.4.22')).rejects.toThrow('Insufficient space');
    expect(existsSync(join(data, 'updates/program-backups', nonce))).toBe(false);
  });
  it('refuses cleanup when the restored program has changed and preserves the failed directory', async () => {
    await createProgramBackup(root, data, nonce, '0.4.22');
    const result = await restoreProgramBackup(root, data, nonce);
    writeFileSync(join(root, 'RemoteCompanion.exe'), 'changed again');
    await expect(cleanupFailedProgram(root, data, nonce)).rejects.toThrow('verification');
    expect(existsSync(result.displaced)).toBe(true);
  });
  it('rejects overlapping program and data directories', async () => {
    await expect(createProgramBackup(root, root, nonce, '0.4.22')).rejects.toThrow('separate');
    const nested = join(root, 'userdata'); mkdirSync(nested);
    await expect(createProgramBackup(root, nested, nonce, '0.4.22')).rejects.toThrow('separate');
  });
  it('rejects a linked program directory without copying user data', async () => {
    symlinkSync(data, join(root, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createProgramBackup(root, data, nonce, '0.4.22')).rejects.toThrow('links');
  });
  it('keeps the most recent verified backup and ignores unrelated directories', async () => {
    const first = await createProgramBackup(root, data, nonce, '0.4.22'); const latest = randomUUID();
    const second = await createProgramBackup(root, data, latest, '0.4.22');
    mkdirSync(join(data, 'updates/program-backups/user-notes'));
    await pruneProgramBackups(data, latest);
    expect(existsSync(first)).toBe(false); expect(existsSync(second)).toBe(true);
    expect(existsSync(join(data, 'updates/program-backups/user-notes'))).toBe(true);
  });
});
