// Snapshot persistence. Every poll is written whole so the history can be
// re-analysed later with better logic — the raw captures are the real asset.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(here, '..', 'data');

const snapshotDir = (dataDir) => join(dataDir, 'snapshots');
const configPath = (dataDir) => join(dataDir, 'config.json');

export function ensureDataDir(dataDir) {
  mkdirSync(snapshotDir(dataDir), { recursive: true });
  return dataDir;
}

/** Timestamps go into the filename, so a lexical sort is a chronological sort. */
export function saveSnapshot(dataDir, snapshot) {
  ensureDataDir(dataDir);
  const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');
  const path = join(snapshotDir(dataDir), `${stamp}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

export function listSnapshotPaths(dataDir) {
  const dir = snapshotDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

export function loadSnapshots(dataDir, { limit = Infinity } = {}) {
  const paths = listSnapshotPaths(dataDir);
  const selected = Number.isFinite(limit) ? paths.slice(-limit) : paths;
  const snapshots = [];
  for (const path of selected) {
    try {
      snapshots.push(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // A partially-written snapshot (interrupted poll) should not take down
      // the whole history.
      process.stderr.write(`warning: skipping unreadable snapshot ${path}\n`);
    }
  }
  return snapshots.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function loadConfig(dataDir) {
  const path = configPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(dataDir, config) {
  ensureDataDir(dataDir);
  writeFileSync(configPath(dataDir), JSON.stringify(config, null, 2));
}
