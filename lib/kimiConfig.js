'use strict';

// 纯 Node 模块（不依赖 vscode）：定位并读写 ~/.kimi-code/config.toml。
// 只做「够用」的 TOML 处理：section 感知的标量解析与定点写入，
// 目标是安全地读写 [thinking] / [models.*] / [models.*.overrides] 中的少数字段。

const fs = require('fs');
const os = require('os');
const path = require('path');

function getKimiHome(override) {
  if (override && override.trim()) return override.trim();
  if (process.env.KIMI_CODE_HOME && process.env.KIMI_CODE_HOME.trim()) {
    return process.env.KIMI_CODE_HOME.trim();
  }
  return path.join(os.homedir(), '.kimi-code');
}

function getConfigPath(homeDir) {
  return path.join(homeDir, 'config.toml');
}

// ---- 极简 TOML 值解析（仅覆盖标量与字符串数组） ----

function parseValue(raw) {
  const v = stripInlineComment(raw).trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => {
      const t = s.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    });
  }
  const n = Number(v);
  if (!Number.isNaN(n) && v !== '') return n;
  return v;
}

function stripInlineComment(s) {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inStr = !inStr;
    if (c === '#' && !inStr) return s.slice(0, i);
  }
  return s;
}

// section 名保留原始写法，例如：models."kimi-code/k3".overrides
function parseTomlLite(text) {
  const result = { top: {}, sections: {} };
  let current = result.top;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      const name = sec[1].trim();
      current = result.sections[name] || (result.sections[name] = {});
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (kv) current[kv[1]] = parseValue(kv[2]);
  }
  return result;
}

function modelAliasOf(sectionName) {
  const m = sectionName.match(/^models\."(.+)"$/);
  return m ? m[1] : null;
}

function overridesAliasOf(sectionName) {
  const m = sectionName.match(/^models\."(.+)"\.overrides$/);
  return m ? m[1] : null;
}

// ---- 读取：汇总插件关心的状态 ----

function loadConfig(homeDir) {
  const configPath = getConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return { configPath, exists: false };
  }
  const text = fs.readFileSync(configPath, 'utf8');
  const parsed = parseTomlLite(text);

  const defaultModel = parsed.top.default_model || null;
  const thinking = parsed.sections['thinking'] || {};

  const models = [];
  for (const [name, fields] of Object.entries(parsed.sections)) {
    const alias = modelAliasOf(name);
    if (!alias) continue;
    const overrides = parsed.sections[`models."${alias}".overrides`] || {};
    models.push({
      alias,
      model: fields.model || alias,
      displayName: overrides.display_name || fields.display_name || fields.model || alias,
      maxContextSize: overrides.max_context_size || fields.max_context_size || null,
      supportEfforts: overrides.support_efforts || fields.support_efforts || null,
      defaultEffort: overrides.default_effort || fields.default_effort || null,
      capabilities: fields.capabilities || [],
    });
  }

  const current = models.find((m) => m.alias === defaultModel) || null;

  // 生效 effort：全局 [thinking].effort 在当前模型支持列表内则用之，否则回退模型默认
  let effectiveEffort = null;
  if (current) {
    const support = current.supportEfforts;
    if (support && support.length > 0) {
      if (thinking.effort && support.includes(thinking.effort)) {
        effectiveEffort = thinking.effort;
      } else {
        effectiveEffort = current.defaultEffort || support[support.length - 1];
      }
    } else {
      effectiveEffort = thinking.enabled === false ? 'off' : 'on';
    }
  }

  return {
    configPath,
    exists: true,
    text,
    defaultModel,
    thinkingEnabled: thinking.enabled !== false,
    thinkingEffort: thinking.effort || null,
    models,
    current,
    effectiveEffort,
  };
}

// ---- 写入：section 感知的定点更新 ----

function findSectionRange(lines, headerText) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[')) {
      if (start !== -1) return { start, end: i };
      if (t === headerText) start = i;
    }
  }
  return start === -1 ? null : { start, end: lines.length };
}

// 在指定 section 内设置 key = valueLiteral；section 或 key 不存在则创建。
function setScalar(text, sectionHeader, key, valueLiteral) {
  const lines = text.split('\n');
  const range = findSectionRange(lines, sectionHeader);
  const newLine = `${key} = ${valueLiteral}`;
  if (!range) {
    const out = text.endsWith('\n') ? text : text + '\n';
    return `${out}\n${sectionHeader}\n${newLine}\n`;
  }
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = newLine;
      return lines.join('\n');
    }
  }
  lines.splice(range.start + 1, 0, newLine);
  return lines.join('\n');
}

function backupConfig(configPath) {
  const bak = configPath + '.bak';
  fs.copyFileSync(configPath, bak);
  return bak;
}

function setThinkingEffort(configPath, effort) {
  backupConfig(configPath);
  const text = fs.readFileSync(configPath, 'utf8');
  let out = setScalar(text, '[thinking]', 'enabled', 'true');
  out = setScalar(out, '[thinking]', 'effort', `"${effort}"`);
  fs.writeFileSync(configPath, out, 'utf8');
}

function setModelContextSize(configPath, alias, size) {
  backupConfig(configPath);
  const text = fs.readFileSync(configPath, 'utf8');
  const header = `[models."${alias}".overrides]`;
  const out = setScalar(text, header, 'max_context_size', String(size));
  fs.writeFileSync(configPath, out, 'utf8');
}

// ---- 检测最近会话实际运行的思考档位 ----
// 官方插件/CLI 里切 max 不会写入 config.toml（官方设计），但每个会话的 wire.jsonl
// 会记录 config.update / llm.request 里的 thinkingEffort，读取最新会话文件尾部即可。

function detectSessionEffort(homeDir) {
  const sessionsRoot = path.join(homeDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  let latest = null; // { file, mtimeMs }
  for (const wd of fs.readdirSync(sessionsRoot)) {
    const wdDir = path.join(sessionsRoot, wd);
    if (!fs.statSync(wdDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(wdDir)) {
      const agentsDir = path.join(wdDir, sid, 'agents');
      if (!fs.existsSync(agentsDir)) continue;
      for (const agent of fs.readdirSync(agentsDir)) {
        const wirePath = path.join(agentsDir, agent, 'wire.jsonl');
        if (!fs.existsSync(wirePath)) continue;
        const m = fs.statSync(wirePath).mtimeMs;
        if (!latest || m > latest.mtimeMs) latest = { file: wirePath, mtimeMs: m };
      }
    }
  }
  if (!latest) return null;
  // 读文件尾部找最后一次 thinkingEffort；找不到且文件不大则全量找
  const size = fs.statSync(latest.file).size;
  const readTail = (bytes) => {
    const fd = fs.openSync(latest.file, 'r');
    try {
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  };
  const EFFORT_RE = /"thinkingEffort":"([a-zA-Z]+)"/g;
  const lastMatch = (text) => {
    let m,
      last = null;
    while ((m = EFFORT_RE.exec(text)) !== null) last = m[1];
    return last;
  };
  let effort = lastMatch(readTail(Math.min(size, 256 * 1024)));
  if (!effort && size <= 4 * 1024 * 1024) {
    effort = lastMatch(fs.readFileSync(latest.file, 'utf8'));
  }
  return effort ? { effort, mtimeMs: latest.mtimeMs } : null;
}

module.exports = {
  getKimiHome,
  getConfigPath,
  parseTomlLite,
  loadConfig,
  setThinkingEffort,
  setModelContextSize,
  detectSessionEffort,
};
