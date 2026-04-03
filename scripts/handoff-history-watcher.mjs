import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  stat,
  watch,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const historyPath = process.env.HANDOFF_HISTORY_PATH
  ? path.resolve(process.env.HANDOFF_HISTORY_PATH)
  : '';
const statePath = path.resolve(
  cwd,
  process.env.HANDOFF_HISTORY_STATE_PATH ?? '.claude/collab/.handoff-history-state.json',
);
const watchConfigPath = process.env.HANDOFF_WATCH_CONFIG_PATH
  ? path.resolve(process.env.HANDOFF_WATCH_CONFIG_PATH)
  : '';
const runOnce = process.argv.includes('--once');

if (!historyPath) {
  console.error('HANDOFF_HISTORY_PATH is required.');
  process.exit(1);
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function extractField(content, label) {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  return content.match(pattern)?.[1]?.trim() ?? '';
}

function parseHandoff(content) {
  return {
    task: extractField(content, 'Task'),
    owner: extractField(content, 'Owner'),
    reviewer: extractField(content, 'Reviewer'),
    status: extractField(content, 'Status').toLowerCase(),
    nextAction: extractField(content, 'Next Action').toLowerCase(),
    base: extractField(content, 'Base'),
  };
}

function isReadyForReview(handoff) {
  return handoff.status === 'needs-review' && handoff.reviewer && handoff.reviewer !== handoff.owner;
}

function normalizeList(raw) {
  return raw
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function readWatchConfig() {
  if (!watchConfigPath) {
    return [];
  }

  try {
    const raw = await readFile(watchConfigPath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

const HANDOFF_FILENAMES = new Set(['HANDOFF.md', 'HANDOFF_A.md', 'HANDOFF_B.md']);

function resolveConfiguredEntry(entry) {
  const absolutePath = path.resolve(entry);

  if (HANDOFF_FILENAMES.has(path.basename(absolutePath))) {
    const repoRoot = path.resolve(path.dirname(absolutePath), '..', '..');
    return {
      handoffPath: absolutePath,
      repoRoot,
      repoName: path.basename(repoRoot),
    };
  }

  return {
    handoffPath: path.join(absolutePath, '.claude', 'collab', 'HANDOFF_A.md'),
    repoRoot: absolutePath,
    repoName: path.basename(absolutePath),
  };
}

async function collectWatchTargets() {
  const configured = [];

  if (process.env.HANDOFF_PATH) {
    configured.push(process.env.HANDOFF_PATH);
  }

  if (process.env.HANDOFF_WATCH_PATHS) {
    configured.push(...normalizeList(process.env.HANDOFF_WATCH_PATHS));
  }

  configured.push(...(await readWatchConfig()));

  const uniqueEntries = [...new Set(configured.map((entry) => path.resolve(entry)))];
  const targets = [];
  const seenHandoffPaths = new Set();

  for (const entry of uniqueEntries) {
    const target = resolveConfiguredEntry(entry);
    if (seenHandoffPaths.has(target.handoffPath)) {
      continue;
    }

    try {
      await access(target.handoffPath);
      targets.push(target);
      seenHandoffPaths.add(target.handoffPath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        console.warn(`Skipping missing handoff file: ${target.handoffPath}`);
        continue;
      }

      throw error;
    }
  }

  return targets;
}

async function readState() {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed) {
      return parsed;
    }

    return {};
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function writeState(nextState) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
}

async function ensureHistoryFile() {
  await mkdir(path.dirname(historyPath), { recursive: true });

  try {
    await stat(historyPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writeFile(historyPath, '', 'utf8');
      return;
    }

    throw error;
  }
}

function formatEntry({ content, handoff, target, timestamp, trigger }) {
  return [
    `## ${timestamp}`,
    `- Trigger: ${trigger}`,
    `- Repo: ${target.repoName || 'unknown'}`,
    `- Repo Root: ${target.repoRoot}`,
    `- Handoff: ${target.handoffPath}`,
    `- Task: ${handoff.task || 'Unknown task'}`,
    `- Owner: ${handoff.owner || 'Unknown owner'}`,
    `- Reviewer: ${handoff.reviewer || 'Unknown reviewer'}`,
    `- Status: ${handoff.status || 'unknown'}`,
    `- Next Action: ${handoff.nextAction || 'unknown'}`,
    `- Base: ${handoff.base || 'unknown'}`,
    '',
    '```md',
    content.trimEnd(),
    '```',
    '',
  ].join('\n');
}

let serialize = Promise.resolve();

function enqueueCapture(target, trigger) {
  serialize = serialize.then(() => captureIfReady(target, trigger)).catch((error) => {
    console.error(error);
  });

  return serialize;
}

async function captureIfReady(target, trigger) {
  const content = await readFile(target.handoffPath, 'utf8');
  const handoff = parseHandoff(content);

  if (!isReadyForReview(handoff)) {
    return;
  }

  const contentHash = hashContent(content);
  const state = await readState();
  const entries = typeof state.entries === 'object' && state.entries ? state.entries : {};

  const stateKey = `${historyPath}::${target.handoffPath}`;
  const previous = entries[stateKey];

  if (previous?.lastLoggedHash === contentHash) {
    return;
  }

  await ensureHistoryFile();

  const timestamp = new Date().toISOString();
  const entry = formatEntry({ content, handoff, target, timestamp, trigger });
  await appendFile(historyPath, entry, 'utf8');

  entries[stateKey] = {
    lastLoggedAt: timestamp,
    lastLoggedHash: contentHash,
    repoName: target.repoName,
    repoRoot: target.repoRoot,
    handoffPath: target.handoffPath,
  };

  await writeState({
    historyPath,
    watchConfigPath,
    entries,
  });

  console.log(`Appended review-ready handoff snapshot for ${target.repoName} at ${timestamp}.`);
}

async function main() {
  const targets = await collectWatchTargets();

  if (targets.length === 0) {
    console.error('No handoff files found to watch.');
    process.exit(1);
  }

  await Promise.all(targets.map((target) => enqueueCapture(target, 'startup')));

  if (runOnce) {
    return;
  }

  const controller = new AbortController();
  const watchers = targets.map((target) => {
    const watcher = watch(path.dirname(target.handoffPath), { signal: controller.signal });
    return { target, watcher };
  });

  const close = () => {
    controller.abort();
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  console.log(
    `Watching ${targets.length} handoff file(s): ${targets.map((target) => target.handoffPath).join(', ')}`,
  );

  await Promise.all(
    watchers.map(async ({ target, watcher }) => {
      let debounceTimer;
      const handoffName = path.basename(target.handoffPath);

      try {
        for await (const event of watcher) {
          if (event.filename?.toString() !== handoffName) {
            continue;
          }

          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          debounceTimer = setTimeout(() => {
            void enqueueCapture(target, event.eventType || 'change');
          }, 150);
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
          return;
        }

        throw error;
      }
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
