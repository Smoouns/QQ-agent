// 管理员本地维护入口。默认只读；每次执行删除都必须同时指定两个开关。
const HELP = `图片存储统计与保守回收

用法：npm run images:storage -- [选项]

  --dry-run             只预览统计与候选文件（默认）
  --json                输出完整 JSON 报告
  --chat group:123       只检查指定会话；也支持 private:123
  --enable-cleanup      明确允许本次清理，须与 --apply 同时使用
  --apply               执行清理，须与 --enable-cleanup 同时使用
  --help                显示帮助

完整图片始终保留，包括未发送、编辑参考图和发送失败后可重试的图片。
执行清理前必须停止共享数据目录的所有应用进程；运行中只支持预览。
不会按文件年龄删除图片，也不会删除不能确认归属或状态的文件。
数据目录使用 QQ_AGENT_DATA_DIR，未设置时使用项目的 data/。`;

function parseArgs(args) {
  const options = { json: false, dryRun: false, enableCleanup: false, apply: false, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`重复参数：${arg}`);
    seen.add(arg);
    switch (arg) {
      case '--json': options.json = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--enable-cleanup': options.enableCleanup = true; break;
      case '--apply': options.apply = true; break;
      case '--help': options.help = true; break;
      case '--chat': {
        const value = args[++i];
        if (!/^(group|private):[1-9]\d{0,19}$/.test(value ?? '')) throw new Error('--chat 须为 group:群号 或 private:QQ号（1–20 位正整数）');
        options.chatKey = value;
        break;
      }
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.dryRun && options.apply) throw new Error('--dry-run 不能与 --apply 同时使用');
  if (options.enableCleanup !== options.apply) throw new Error('执行清理必须同时指定 --enable-cleanup --apply；预览请使用 --dry-run');
  return options;
}

function size(bytes = 0) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit ? `${value.toFixed(2)} ${units[unit]} (${bytes} B)` : `${bytes} B`;
}

function printReport(report) {
  const { totals, summary } = report;
  console.log(report.dryRun ? '图片存储预览（dry-run，未删除任何文件）' : '图片存储清理结果');
  console.log(`范围：${report.scope ?? '全部会话'}`);
  if (report.skipped) console.log('检测到存档写入者，未扫描存储内容，未执行清理；下方零计数不代表实际占用。');
  console.log(`已统计文件：${totals.files} 个，${size(totals.bytes)}；完整图片：${totals.completeImages} 张`);
  console.log(`未扫描目录：${totals.unscannedDirectories} 个；上述字节数为已统计文件的逻辑大小${totals.unscannedDirectories ? '，不包含这些目录内的占用' : '，不等于文件系统实际分配空间'}。`);
  console.log(`图片字节：${size(totals.imageBytes)}；元数据：${size(totals.metadataBytes)}；临时文件：${size(totals.temporaryBytes)}；其他：${size(totals.otherBytes)}`);
  console.log(`保留：${summary.retainedFiles} 个，${size(summary.retainedBytes)}`);
  console.log(`可回收候选：${summary.candidateFiles} 个，${size(summary.candidateBytes)}`);
  console.log(`状态不明、保留：${summary.unknownFiles} 个，${size(summary.unknownBytes)}`);
  console.log(`引用检查：${report.references.complete ? '完整' : '不完整，禁止删除'}；识别到 ${report.references.imageCount} 个图片 ID`);
  if (report.excluded?.files) console.log(`范围外文件：${report.excluded.files} 个，${size(report.excluded.bytes)}`);
  if (report.entries.length) {
    console.log('\n逐项结果：');
    for (const entry of report.entries) {
      const files = [...entry.files.map(file => JSON.stringify(file.name)),
        ...(entry.unscannedDirectories || []).map(name => `${JSON.stringify(name)}（目录未扫描）`)].join(', ');
      console.log(`- ${entry.disposition} / ${entry.category}：${files}，${size(entry.bytes)}；${entry.reason}`);
    }
  }
  if (report.blockers.length) {
    console.log('\n清理阻断原因：');
    for (const issue of report.blockers) console.log(`- ${JSON.stringify(issue.path)}：${issue.reason}`);
  }
  if (!report.dryRun) {
    console.log(`\n实际删除：${report.removed?.length ?? 0} 个文件，${size(report.removedBytes)}`);
    for (const file of report.removed ?? []) console.log(`- 已删除 ${JSON.stringify(file.name)}，${size(file.bytes)}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
  } else {
    // 参数不合法、仅查看帮助时不加载维护模块，更不会接触数据目录。
    const { scanImageStorage, cleanupImageStorage } = await import('../src/image-storage.js');
    const report = options.apply
      ? cleanupImageStorage({ chatKey: options.chatKey, enabled: true, dryRun: false })
      : scanImageStorage({ chatKey: options.chatKey });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (options.apply && report.blockers.length) process.exitCode = 2;
  }
} catch (error) {
  if (process.argv.includes('--json')) console.error(JSON.stringify({ error: error.message }));
  else console.error(`图片存储操作失败：${error.message}\n运行 npm run images:storage -- --help 查看用法。`);
  process.exitCode = 1;
}
