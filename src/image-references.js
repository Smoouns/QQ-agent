import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CHAT_KEY = /^(group|private):[1-9]\d{0,19}$/;
const IMAGE_ID = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi;
const MESSAGE_FILE = /^(group|private)_([1-9]\d{0,19})\.json(?:\.[1-9]\d*\.tmp)?$/;
const SESSION_FILE = /^([\w-]+)\.json(?:\.[1-9]\d*\.tmp)?$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function collectIds(text, ids) {
  for (const match of text.matchAll(IMAGE_ID)) ids.add(match[0].toLowerCase());
}

function collectDecodedIds(value, ids) {
  // JSON strings can contain escaped UUID characters. Inspect decoded values as
  // well as raw text, including nested/stringified tool arguments and results.
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      collectIds(current, ids);
      // Tool arguments/results can themselves be serialized JSON, with another
      // layer of Unicode escapes. Plain prose is deliberately not an error.
      if (/^[\s]*[\[{\"]/.test(current)) {
        try {
          const decoded = JSON.parse(current);
          if (decoded !== current) pending.push(decoded);
        } catch { /* arbitrary text, including truncated tool results */ }
      }
    } else if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    }
    else if (object(current)) {
      for (const [key, child] of Object.entries(current)) {
        collectIds(key, ids);
        pending.push(child);
      }
    }
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Conservative, read-only reference inventory. A mention anywhere protects an
 * image globally; chatKey only explains the source and never grants access.
 * Missing directories mean no archives. Any other unreadable/unknown state
 * makes the snapshot incomplete, so callers must not delete from it.
 */
export function scanImageReferences({ dataDir = DATA_DIR } = {}) {
  const imageIds = new Set(), references = new Map(), issues = [];
  const issue = (source, reason) => issues.push({ path: source, reason });
  const failed = (source, reason, error) => issue(source, `${reason}${error?.code ? `:${error.code}` : ''}`);
  const result = () => ({ imageIds, references, issues, complete: issues.length === 0 });

  let dataStat;
  try {
    dataStat = fs.lstatSync(dataDir);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      issue('.', dataStat.isSymbolicLink() ? 'symbolic-link' : 'not-a-directory');
      return result();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') failed('.', 'unreadable-root', error);
    return result();
  }

  for (const directory of ['messages', 'sessions']) {
    const root = path.join(dataDir, directory);
    let rootStat, entries;
    try {
      rootStat = fs.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        issue(directory, rootStat.isSymbolicLink() ? 'symbolic-link' : 'not-a-directory');
        continue;
      }
      entries = fs.readdirSync(root).sort();
    } catch (error) {
      if (error.code !== 'ENOENT' || rootStat) failed(directory, 'unreadable-root', error);
      continue;
    }

    for (const name of entries) {
      const source = `${directory}/${name}`, file = path.join(root, name);
      const match = (directory === 'messages' ? MESSAGE_FILE : SESSION_FILE).exec(name);
      if (!match) issue(source, 'unexpected-filename');
      const expectedChat = directory === 'messages' && match ? `${match[1]}:${match[2]}` : undefined;
      const ids = new Set();
      let text, fd, stat;
      try {
        stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          issue(source, stat.isSymbolicLink() ? 'symbolic-link' : 'not-a-regular-file');
          continue;
        }
        // O_NOFOLLOW prevents a file symlink substitution between lstat/open on
        // platforms supporting it; fstat/path checks detect other changes.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        if (!sameFile(stat, fs.fstatSync(fd))) {
          issue(source, 'changed-during-scan');
          continue;
        }
        text = fs.readFileSync(fd, 'utf8');
        if (!sameFile(stat, fs.fstatSync(fd)) || !sameFile(stat, fs.lstatSync(file))) {
          issue(source, 'changed-during-scan');
        }
      } catch (error) {
        failed(source, 'unreadable-file', error);
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (error) { failed(source, 'unreadable-file', error); }
        }
      }
      if (text === undefined) continue;

      collectIds(text, ids);
      let archive, chatKey = expectedChat;
      try {
        archive = JSON.parse(text.replace(/^\uFEFF/, ''));
        collectDecodedIds(archive, ids);
        if (object(archive) && typeof archive.chatKey === 'string' && CHAT_KEY.test(archive.chatKey)) {
          chatKey = archive.chatKey;
        }
        if (!object(archive) || typeof archive.chatKey !== 'string' || !CHAT_KEY.test(archive.chatKey)
            || !Array.isArray(archive.messages) || archive.messages.some(entry => !object(entry))) {
          issue(source, 'invalid-archive-shape');
        } else if (directory === 'messages') {
          if (!Number.isInteger(archive.nextLocalId) || archive.nextLocalId <= 0) issue(source, 'invalid-message-counter');
          if (expectedChat && archive.chatKey !== expectedChat) issue(source, 'chat-key-mismatch');
        } else {
          if (typeof archive.id !== 'string' || (match && archive.id !== match[1])) issue(source, 'session-id-mismatch');
          if (!Array.isArray(archive.sent) || archive.sent.some(entry => !object(entry))) issue(source, 'invalid-session-sent');
        }
      } catch {
        // Malformed archives still protect every recognizable raw UUID. A
        // truncated tool result or failed-send error can be the only copy.
        issue(source, 'invalid-json');
      }
      for (const id of ids) {
        imageIds.add(id);
        if (!references.has(id)) references.set(id, []);
        references.get(id).push({ source, ...(chatKey ? { chatKey } : {}) });
      }
    }
    try {
      if (!sameFile(rootStat, fs.lstatSync(root))) issue(directory, 'changed-during-scan');
    } catch (error) { failed(directory, 'unreadable-root', error); }
  }
  try {
    if (!sameFile(dataStat, fs.lstatSync(dataDir))) issue('.', 'changed-during-scan');
  } catch (error) { failed('.', 'unreadable-root', error); }
  return result();
}
