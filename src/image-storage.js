// Operator-only maintenance: no TTL and no deletion of reusable image IDs.
import fs from 'node:fs';
import path from 'node:path';
import { assertImageChat } from './image-config.js';
import { scanImageReferences } from './image-references.js';
import { IMAGE_ASSET_DIR as root, IMAGE_ID_RE, IMAGE_STAGING_FORMAT, MAX_IMAGE_BYTES, readRegularFile, sameFile } from './image-asset-files.js';
import { IMAGE_STORAGE_LOCK, withImageStorageLock } from './image-storage-lock.js';

const UUIDS = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_METADATA_BYTES = 64 * 1024;

function validChat(chatKey) {
  try { if (typeof chatKey !== 'string') return false; assertImageChat(chatKey); return true; }
  catch { return false; }
}

function validMetadata(value, imageId) {
  return value && !Array.isArray(value) && value.imageId === imageId && validChat(value.chatKey)
    && MIMES.has(value.mime) && Number.isSafeInteger(value.bytes) && value.bytes >= 12 && value.bytes <= MAX_IMAGE_BYTES
    && typeof value.source === 'string' && value.source.length > 0
    && Number.isFinite(value.createdAt) && value.createdAt >= 0
    && (value.referenceImageIds === undefined || (Array.isArray(value.referenceImageIds)
      && value.referenceImageIds.length <= 4 && value.referenceImageIds.every(id => typeof id === 'string' && IMAGE_ID_RE.test(id))));
}

function fileRecord(name, stat, type) {
  return { name, bytes: stat.isDirectory() ? 0 : stat.size, type, stat };
}

function inspect(chatKey, locked = false) {
  if (chatKey !== undefined && !validChat(chatKey)) throw new Error('图片清理的会话标识无效');
  const refs = scanImageReferences();
  const blockers = [...refs.issues];
  const report = {
    dryRun: true, scope: chatKey ?? null,
    totals: { files: 0, bytes: 0, completeImages: 0, imageBytes: 0, metadataBytes: 0, temporaryBytes: 0, otherBytes: 0, unscannedDirectories: 0 },
    summary: { retainedFiles: 0, retainedBytes: 0, candidateFiles: 0, candidateBytes: 0, unknownFiles: 0, unknownBytes: 0 },
    excluded: { files: 0, bytes: 0 }, entries: [], blockers,
    references: { complete: refs.complete, imageCount: refs.imageIds.size, issues: refs.issues }
  };
  const candidates = [], entries = [], groups = new Map();
  const checkLock = () => {
    if (locked) return;
    try {
      fs.lstatSync(IMAGE_STORAGE_LOCK);
      if (!blockers.some(b => b.path === 'image-storage.lock')) blockers.push({ path: 'image-storage.lock', reason: '存储正在写入或维护，或存在需人工核查的遗留锁' });
    } catch (error) { if (error.code !== 'ENOENT') blockers.push({ path: 'image-storage.lock', reason: error.code || error.message }); }
  };
  checkLock();
  const protect = (id, source, owner) => {
    refs.imageIds.add(id);
    if (!refs.references.has(id)) refs.references.set(id, []);
    refs.references.get(id).push({ source, ...(owner ? { chatKey: owner } : {}) });
  };
  const entry = (category, disposition, reason, files, extra = {}) => ({ category, disposition, reason, files,
    bytes: files.reduce((n, f) => n + f.bytes, 0), ...extra });
  const readJson = file => JSON.parse(readRegularFile(path.join(root, file.name), file.stat, MAX_METADATA_BYTES).toString('utf8'));

  let rootStat, names = [];
  try {
    rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('图片资源目录不是常规目录，拒绝遍历');
    names = fs.readdirSync(root).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') blockers.push({ path: 'image-assets', reason: error.code || error.message });
  }

  for (const name of names) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, name)); }
    catch (error) { blockers.push({ path: `image-assets/${name}`, reason: error.code || error.message }); continue; }
    const match = /^([a-f0-9-]+)\.(bin|json)$/.exec(name);
    if (match && IMAGE_ID_RE.test(match[1])) {
      const group = groups.get(match[1]) || { imageId: match[1], files: [] };
      const file = fileRecord(name, stat, match[2] === 'bin' ? 'image' : 'metadata');
      group[match[2]] = file; group.files.push(file); groups.set(match[1], group);
      continue;
    }
    const tempId = name.endsWith('.tmp') ? name.slice(0, -4) : '';
    if (!IMAGE_ID_RE.test(tempId) || !stat.isDirectory() || stat.isSymbolicLink()) {
      entries.push(entry('unknown', 'unknown', '未识别的文件、目录或旧临时文件；不能证明可丢弃', [fileRecord(name, stat, 'other')]));
      continue;
    }

    // Only this exact, versioned staging layout was written by saveImage().
    // Never recursively delete unknown files or follow links.
    let files = [], manifest, problem;
    try {
      const children = fs.readdirSync(path.join(root, name)).sort();
      for (const child of children) {
        const childName = `${name}/${child}`;
        const childStat = fs.lstatSync(path.join(root, childName));
        files.push(fileRecord(childName, childStat, 'temporary'));
        if (!['manifest.json', 'image.bin', 'image.json'].includes(child) || !childStat.isFile() || childStat.nlink !== 1) problem = '临时目录含未知条目、链接或非常规文件';
      }
      const marker = files.find(f => f.name === `${name}/manifest.json`);
      if (!marker) throw new Error('临时目录缺少归属标记');
      manifest = readJson(marker);
      if (!manifest || manifest.format !== IMAGE_STAGING_FORMAT || manifest.imageId !== tempId || !validChat(manifest.chatKey)
        || !Number.isFinite(manifest.createdAt) || manifest.createdAt < 0) throw new Error('临时目录归属标记无效');
      const metadataFile = files.find(f => f.name === `${name}/image.json`);
      if (metadataFile) {
        const metadata = readJson(metadataFile);
        if (!validMetadata(metadata, tempId) || metadata.chatKey !== manifest.chatKey) throw new Error('临时元数据与归属标记不一致');
        for (const id of metadata.referenceImageIds || []) protect(id, `image-assets/${metadataFile.name}`, metadata.chatKey);
      }
    } catch (error) { problem = error.code || error.message; }
    if (problem) blockers.push({ path: `image-assets/${name}`, reason: `无法完整检查暂存引用：${problem}` });
    entries.push(entry('temporary', problem ? 'unknown' : 'candidate', problem || '已确认归属的中断写入残留；仅显式清理时移除', files,
      { imageId: tempId, ...(validChat(manifest?.chatKey) && manifest?.imageId === tempId ? { chatKey: manifest.chatKey } : {}), directory: name, directoryStat: stat }));
  }

  // Inspect every metadata file before deciding any candidate, so an edited
  // image protects its parents even if session logging has not yet caught up.
  for (const group of groups.values()) {
    if (!group.json) continue;
    try {
      const raw = readRegularFile(path.join(root, group.json.name), group.json.stat, MAX_METADATA_BYTES).toString('utf8');
      try { group.metadata = JSON.parse(raw); } catch { /* raw IDs still protect recoverable references */ }
      group.valid = validMetadata(group.metadata, group.imageId);
      if (group.valid) {
        for (const id of group.metadata.referenceImageIds || []) protect(id, `image-assets/${group.json.name}`, group.metadata.chatKey);
      } else {
        for (const id of raw.match(UUIDS) || []) protect(id.toLowerCase(), `image-assets/${group.json.name}`);
        blockers.push({ path: `image-assets/${group.json.name}`, reason: '图片元数据无效，无法完整确认编辑参考关系' });
      }
    } catch (error) {
      group.problem = error.code || error.message;
      // An unreadable metadata file could contain edit-parent references.
      blockers.push({ path: `image-assets/${group.json.name}`, reason: group.problem });
    }
  }
  // A crash between BIN and JSON publication can leave the only recoverable
  // ownership metadata in staging. Preserve BOTH sides of a partial commit.
  for (const item of entries) {
    if (item.category !== 'temporary') continue;
    const published = groups.get(item.imageId);
    const stagedData = item.files.some(f => /\/image\.(bin|json)$/.test(f.name));
    if (published && (stagedData || !published.valid || !published.bin || !published.json
      || published.files.some(f => !f.stat.isFile() || f.stat.nlink !== 1)
      || published.metadata.chatKey !== item.chatKey || published.bin.bytes !== published.metadata.bytes)) {
      protect(item.imageId, `image-assets/${item.directory}`, item.chatKey);
    }
  }
  for (const group of groups.values()) {
    const { imageId, files, metadata, valid, bin, json } = group;
    const extra = { imageId, ...(valid ? { chatKey: metadata.chatKey } : {}) };
    const safeFiles = files.every(f => f.stat.isFile() && f.stat.nlink === 1);
    if (!safeFiles || (json && !valid)) {
      entries.push(entry('unknown', 'unknown', group.problem || '元数据无效、归属不明或文件类型不安全；保留以便恢复', files, extra));
    } else if (bin && json) {
      const consistent = bin.bytes === metadata.bytes;
      entries.push(entry('image', consistent ? 'retain' : 'unknown', consistent
        ? (refs.imageIds.has(imageId) ? '被历史记录或编辑关系引用；保留原 imageId' : '完整图片仍可查看、编辑或重发；未被引用不代表废弃')
        : '图片与元数据大小不一致；状态不明，保留', files, { ...extra, completeImage: consistent }));
    } else if (json) {
      entries.push(entry('orphan-metadata', 'candidate', '二进制图片缺失，且未发现引用的有效元数据', files, extra));
    } else {
      entries.push(entry('orphan-binary', 'unknown', '缺少元数据；可能含不可替代的图片字节，归属不明，保留', files, extra));
    }
  }
  checkLock();
  report.references.imageCount = refs.imageIds.size;
  report.references.complete = blockers.length === 0;
  report.references.issues = [...blockers];

  for (const item of entries.sort((a, b) => (a.files[0]?.name || a.directory || '').localeCompare(b.files[0]?.name || b.directory || ''))) {
    if (item.disposition === 'candidate') {
      if (refs.imageIds.has(item.imageId)) {
        item.disposition = 'retain'; item.reason = '被消息、会话或编辑参考关系引用；保留残留以便诊断与恢复';
      } else if (blockers.length) {
        item.disposition = 'retain'; item.reason = '引用或存储检查不完整，禁止清理';
      }
    }
    const files = item.files.filter(f => !f.stat.isDirectory());
    if (chatKey !== undefined && item.chatKey !== chatKey) {
      report.excluded.files += files.length; report.excluded.bytes += item.bytes;
      continue;
    }
    if (item.disposition === 'candidate') candidates.push(item);
    report.totals.files += files.length; report.totals.bytes += item.bytes;
    report.totals.completeImages += item.completeImage ? 1 : 0;
    report.totals.unscannedDirectories += item.files.filter(f => f.stat.isDirectory()).length;
    for (const f of files) report.totals[`${f.type}Bytes`] += f.bytes;
    const prefix = item.disposition === 'retain' ? 'retained' : item.disposition === 'candidate' ? 'candidate' : 'unknown';
    report.summary[`${prefix}Files`] += files.length; report.summary[`${prefix}Bytes`] += item.bytes;
    const { directoryStat, completeImage, ...publicEntry } = item;
    report.entries.push({ ...publicEntry, files: files.map(({ name, bytes }) => ({ name, bytes })),
      unscannedDirectories: item.files.filter(f => f.stat.isDirectory()).map(f => f.name) });
  }
  return { report, candidates, rootStat };
}

/** Never writes, creates directories, acquires a lock, or touches mtimes. */
export function scanImageStorage({ chatKey } = {}) { return inspect(chatKey).report; }

/** Explicit opt-in on every call. A preview is never accepted as a delete plan. */
export function cleanupImageStorage({ chatKey, enabled = false, dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw new Error('dryRun 必须为布尔值');
  if (chatKey !== undefined && !validChat(chatKey)) throw new Error('图片清理的会话标识无效');
  if (dryRun) return scanImageStorage({ chatKey });
  if (enabled !== true) throw new Error('图片清理未明确启用（enabled 必须为 true）');
  return withImageStorageLock(() => {
    const { report, candidates, rootStat } = inspect(chatKey, true);
    report.dryRun = false; report.removed = []; report.removedBytes = 0;
    if (report.blockers.length || !candidates.length) return report;
    try {
      if (!sameFile(rootStat, fs.lstatSync(root))) throw new Error('图片目录在检查期间变化');
      // Revalidate ALL candidates before the first unlink, including directory
      // membership. Cooperating writers cannot change these under this lock.
      for (const item of candidates) {
        if (item.directory) {
          const dir = path.join(root, item.directory);
          if (!sameFile(item.directoryStat, fs.lstatSync(dir))) throw new Error('临时目录在检查期间变化');
          const current = fs.readdirSync(dir).sort();
          if (JSON.stringify(current) !== JSON.stringify(item.files.map(f => path.basename(f.name)).sort())) throw new Error('临时目录条目在检查期间变化');
        }
        for (const file of item.files) if (!sameFile(file.stat, fs.lstatSync(path.join(root, file.name)))) throw new Error('候选文件在检查期间变化');
      }
    } catch (error) {
      report.blockers.push({ path: 'image-assets', reason: error.code || error.message });
      return report;
    }
    for (const item of candidates) {
      try {
        // Keep the marker until last, so a partial cleanup can be retried.
        const files = [...item.files].sort((a, b) => Number(a.name.endsWith('/manifest.json')) - Number(b.name.endsWith('/manifest.json')));
        for (const file of files) {
          const target = path.join(root, file.name);
          if (!sameFile(file.stat, fs.lstatSync(target))) throw new Error('候选文件在删除前变化');
          fs.unlinkSync(target);
          report.removed.push({ name: file.name, bytes: file.bytes }); report.removedBytes += file.bytes;
        }
        if (item.directory) fs.rmdirSync(path.join(root, item.directory));
      } catch (error) {
        report.blockers.push({ path: item.directory || item.files[0].name, reason: error.code || error.message });
        break;
      }
    }
    return report;
  });
}
