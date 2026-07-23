'use strict';

// 纯 Node 模块（不依赖 vscode）：扫描 ~/.kimi-code/sessions 下的 wire.jsonl，
// 聚合 token 用量。数据结构（已实测）：
//   sessions/<wd_*>/<session_*>/state.json           — 标题、时间、工作目录
//   sessions/<wd_*>/<session_*>/agents/*/wire.jsonl  — 每行一个 JSON，usage 可能
//     嵌套在 event 等字段内："usage":{"inputOther":N,"output":N,
//     "inputCacheRead":N,"inputCacheCreation":N}
//
// 支持增量缓存：传入 cache 对象（{ version, files: { [path]: summary } }），
// 文件 size + mtimeMs 未变则复用上次的解析结果，只重扫变化过的文件。
// cache 由调用方持久化（插件里存 globalState）。

const fs = require('fs');
const path = require('path');

const MAX_WIRE_BYTES = 20 * 1024 * 1024; // 大文件防护
const CACHE_VERSION = 3; // v3: 只统计 type==="usage.record" 的权威行（修三倍重复）
const EMPTY_USAGE = () => ({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });

function addUsage(dst, u) {
  dst.inputOther += u.inputOther || 0;
  dst.output += u.output || 0;
  dst.inputCacheRead += u.inputCacheRead || 0;
  dst.inputCacheCreation += u.inputCacheCreation || 0;
}

function totalOf(u) {
  return u.inputOther + u.output + u.inputCacheRead + u.inputCacheCreation;
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readStateJson(sessionDir) {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8');
    const s = JSON.parse(raw);
    return {
      title: s.title || '(无标题)',
      createdAt: s.createdAt || null,
      updatedAt: s.updatedAt || null,
      workDir: s.workDir || '',
    };
  } catch {
    return { title: '(无标题)', createdAt: null, updatedAt: null, workDir: '' };
  }
}

const isUsage = (v) => v && typeof v === 'object' && typeof v.output === 'number';

// 解析单个 wire.jsonl，产出可缓存的摘要（按天、按模型聚合，丢弃逐条记录）
// 注意：同一步的 usage 在 wire.jsonl 里有三种记录（context.append_loop_event 包裹的
// step.end、独立的 step.end、usage.record），内容相同，只认 type === "usage.record"
// 的权威行（含顶层 model / usage / time），否则会三倍重复统计。
// displayOf：把原始模型名（如 "k3"）归一化为显示名（如 "K3"），由调用方传入
function summarizeFile(filePath, stat, fallbackMs, displayOf) {
  const byDay = {};
  const byModel = {};
  const total = EMPTY_USAGE();
  let records = 0;

  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage.record"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'usage.record' || !isUsage(obj.usage)) continue;
    records++;
    const ts = typeof obj.time === 'number' ? obj.time : fallbackMs;
    const dk = dayKey(ts);
    byDay[dk] = byDay[dk] || EMPTY_USAGE();
    addUsage(byDay[dk], obj.usage);
    addUsage(total, obj.usage);
    const mk = displayOf(typeof obj.model === 'string' ? obj.model : 'unknown');
    byModel[mk] = byModel[mk] || EMPTY_USAGE();
    addUsage(byModel[mk], obj.usage);
  }
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    byDay,
    byModel,
    models: Object.keys(byModel),
    total,
    records,
  };
}

function newCache() {
  return { version: CACHE_VERSION, files: {} };
}

function scanSessions(homeDir, { recentLimit = 20, cache, modelDisplay } = {}) {
  if (!cache || cache.version !== CACHE_VERSION || !cache.files) cache = newCache();
  const displayOf = (m) => (modelDisplay && modelDisplay[m]) || m;
  const sessionsRoot = path.join(homeDir, 'sessions');
  const result = {
    sessionsRoot,
    exists: fs.existsSync(sessionsRoot),
    scannedSessions: 0,
    skippedLargeFiles: 0,
    reparsedFiles: 0,
    cachedFiles: 0,
    totals: { today: EMPTY_USAGE(), last7d: EMPTY_USAGE(), all: EMPTY_USAGE() },
    byModel: {},
    byDay: {},
    recentSessions: [],
  };
  if (!result.exists) return { result, cache };

  const now = Date.now();
  const today = dayKey(now);
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
  const sessions = [];
  const seenFiles = new Set();

  for (const wd of fs.readdirSync(sessionsRoot)) {
    const wdDir = path.join(sessionsRoot, wd);
    if (!fs.statSync(wdDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(wdDir)) {
      const sDir = path.join(wdDir, sid);
      if (fs.statSync(sDir).isDirectory()) sessions.push({ id: sid, dir: sDir });
    }
  }

  for (const session of sessions) {
    const meta = readStateJson(session.dir);
    const agentsDir = path.join(session.dir, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    const fallbackMs = fs.statSync(session.dir).mtimeMs;

    const sessUsage = EMPTY_USAGE();
    const sessModels = new Set();
    let sessRecords = 0;

    for (const agent of fs.readdirSync(agentsDir)) {
      const wirePath = path.join(agentsDir, agent, 'wire.jsonl');
      if (!fs.existsSync(wirePath)) continue;
      const stat = fs.statSync(wirePath);
      if (stat.size > MAX_WIRE_BYTES) {
        result.skippedLargeFiles++;
        continue;
      }
      seenFiles.add(wirePath);
      const cached = cache.files[wirePath];
      let summary;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        summary = cached;
        result.cachedFiles++;
      } else {
        summary = summarizeFile(wirePath, stat, fallbackMs, displayOf);
        cache.files[wirePath] = summary;
        result.reparsedFiles++;
      }
      if (summary.records === 0) continue;
      sessRecords += summary.records;
      addUsage(sessUsage, summary.total);
      for (const m of summary.models) sessModels.add(m);
      for (const [mk, u] of Object.entries(summary.byModel)) {
        result.byModel[mk] = result.byModel[mk] || EMPTY_USAGE();
        addUsage(result.byModel[mk], u);
      }
      for (const [dk, u] of Object.entries(summary.byDay)) {
        result.byDay[dk] = result.byDay[dk] || EMPTY_USAGE();
        addUsage(result.byDay[dk], u);
        addUsage(result.totals.all, u);
        if (dk === today) addUsage(result.totals.today, u);
        // 按天的起止毫秒判断近7天，避免依赖逐条记录
        const dayStart = new Date(dk + 'T00:00:00').getTime();
        if (dayStart + 24 * 3600 * 1000 > sevenDaysAgo) addUsage(result.totals.last7d, u);
      }
    }

    if (sessRecords > 0) {
      result.scannedSessions++;
      sessions[sessions.indexOf(session)].usage = sessUsage;
      sessions[sessions.indexOf(session)].models = [...sessModels];
      sessions[sessions.indexOf(session)].records = sessRecords;
      sessions[sessions.indexOf(session)].meta = meta;
    }
  }

  // 清理缓存中已不存在的文件
  for (const p of Object.keys(cache.files)) {
    if (!seenFiles.has(p)) delete cache.files[p];
  }

  result.recentSessions = sessions
    .filter((s) => s.usage)
    .sort((a, b) => String(b.meta.updatedAt || '').localeCompare(String(a.meta.updatedAt || '')))
    .slice(0, recentLimit)
    .map((s) => ({
      id: s.id,
      title: s.meta.title,
      workDir: s.meta.workDir,
      updatedAt: s.meta.updatedAt,
      models: s.models,
      usage: s.usage,
      total: totalOf(s.usage),
    }));

  for (const key of ['today', 'last7d', 'all']) {
    result.totals[key].total = totalOf(result.totals[key]);
  }
  for (const m of Object.keys(result.byModel)) result.byModel[m].total = totalOf(result.byModel[m]);

  return { result, cache };
}

module.exports = { scanSessions, totalOf, newCache };
