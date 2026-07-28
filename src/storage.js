// Snapshot persistence. Every poll is written whole so the history can be
// re-analysed later with better logic — the raw captures are the real asset.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(here, '..', 'data');

const snapshotDir = (dataDir) => join(dataDir, 'snapshots');
const configPath = (dataDir) => join(dataDir, 'config.json');

export function ensureDataDir(dataDir) {
  mkdirSync(snapshotDir(dataDir), { recursive: true });
  return dataDir;
}

/**
 * Timestamps go into the filename, so a lexical sort is a chronological sort.
 * Written compact rather than pretty-printed: during a real storm a snapshot
 * holds thousands of outages, and indentation roughly doubles it for no gain —
 * these are machine records, and `report --json` exists for reading.
 */
export function saveSnapshot(dataDir, snapshot) {
  ensureDataDir(dataDir);
  const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');
  const path = join(snapshotDir(dataDir), `${stamp}.json`);
  writeFileSync(path, JSON.stringify(snapshot));
  return path;
}

/**
 * Drop snapshots older than `keepHours`. Unbounded history is fine on a laptop
 * but not for a scheduled job committing to a repo, where every poll is
 * permanent. Returns the paths removed.
 */
export function pruneSnapshots(dataDir, { keepHours }) {
  if (!Number.isFinite(keepHours) || keepHours <= 0) return [];

  const paths = listSnapshotPaths(dataDir);
  if (paths.length <= 2) return []; // always keep enough to compute one diff

  const cutoff = Date.now() - keepHours * 3600 * 1000;
  const removed = [];

  // Filenames are ISO timestamps with : and . swapped for -, so recover the
  // instant from the name rather than reading every file back in.
  for (const path of paths.slice(0, -2)) {
    const name = basename(path, '.json');
    const iso = name.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
    const at = Date.parse(iso);
    if (Number.isNaN(at) || at >= cutoff) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
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
