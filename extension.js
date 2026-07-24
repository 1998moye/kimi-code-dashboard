'use strict';

const vscode = require('vscode');
const fs = require('fs');
const kimiConfig = require('./lib/kimiConfig');
const usageScanner = require('./lib/usageScanner');
const quotaClient = require('./lib/quotaClient');

let statusBar;
let provider;
let extContext;

const CACHE_KEY = 'usageCache.v1';
const QUOTA_KEY = 'quotaCache.v1';
const QUOTA_TTL_MS = 60 * 1000; // 额度数据缓存 60s，避免频繁打接口

function getHome() {
  const override = vscode.workspace.getConfiguration('kimiCompanion').get('kimiHome');
  return kimiConfig.getKimiHome(override);
}

async function collectState({ forceQuota = false } = {}) {
  const home = getHome();
  const config = kimiConfig.loadConfig(home);
  // 原始模型名 → 显示名：wire.jsonl 里同一模型可能写成 "k3" 或 "kimi-code/k3"
  const modelDisplay = { unknown: '未知模型' };
  for (const m of config.models || []) {
    modelDisplay[m.alias] = m.displayName;
    modelDisplay[m.model] = m.displayName;
  }
  const cache = extContext.globalState.get(CACHE_KEY);
  const { result: usage, cache: updatedCache } = usageScanner.scanSessions(home, { cache, modelDisplay });
  extContext.globalState.update(CACHE_KEY, updatedCache);

  // 官方额度：60s 内用缓存，超时或强制刷新才打接口
  const cached = extContext.globalState.get(QUOTA_KEY);
  let quota = cached && cached.quota;
  if (forceQuota || !cached || Date.now() - cached.fetchedAt > QUOTA_TTL_MS) {
    quota = await quotaClient.fetchQuota(home);
    // 网页端会员统计（月度总量/赠送额度），需在设置里粘贴 kimi.com 的登录 token；
    // 用 coding 接口返回的 userId 校验网页 token 属于同一账号，防换号串数据
    const webToken = vscode.workspace.getConfiguration('kimiCompanion').get('webToken');
    quota.web = await quotaClient.fetchWebStats(webToken || '', {
      expectedUserId: quota.ok ? quota.userId : null,
    });
    extContext.globalState.update(QUOTA_KEY, { fetchedAt: Date.now(), quota });
  }
  // 最近会话实际运行的思考档位（覆盖官方插件选 max 不落盘的情况）
  const sessionEffort = kimiConfig.detectSessionEffort(home);
  return { home, config, usage, quota, sessionEffort };
}

function refreshStatusBar(state) {
  const { config } = state;
  if (!config.exists) {
    statusBar.text = '$(warning) Kimi: 无配置';
    statusBar.tooltip = `未找到 ${config.configPath}`;
    return;
  }
  const name = config.current ? config.current.displayName : (config.defaultModel || '?');
  const effort = config.effectiveEffort || '?';
  statusBar.text = `$(sparkle) ${name} · ${effort}`;
  statusBar.tooltip = `Kimi Code 思考级别：${effort}\n模型：${config.defaultModel}\n点击切换档位（新会话生效）`;
}

async function refreshAll(opts) {
  const state = await collectState(opts);
  refreshStatusBar(state);
  if (provider) provider.postState(state);
}

async function switchEffort() {
  const state = await collectState();
  const { config } = state;
  if (!config.exists) {
    vscode.window.showErrorMessage(`未找到配置文件：${config.configPath}`);
    return;
  }
  const support = config.current && config.current.supportEfforts;
  if (!support || support.length === 0) {
    vscode.window.showInformationMessage('当前模型没有声明可选的思考档位（support_efforts）。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    support.map((e) => ({
      label: e,
      description: e === config.effectiveEffort ? '当前生效' : '',
    })),
    { placeHolder: `切换 ${config.current.displayName} 的思考级别（写入 config.toml，新会话生效）` }
  );
  if (!picked) return;
  try {
    kimiConfig.setThinkingEffort(config.configPath, picked.label);
    vscode.window.showInformationMessage(
      `思考级别已切换为 ${picked.label}（已写入 config.toml，对新会话生效）`
    );
    refreshAll();
  } catch (err) {
    vscode.window.showErrorMessage(`写入失败：${err.message}`);
  }
}

class DashboardProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, retainContextWhenHidden: true };
    view.webview.html = renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    // 从隐藏恢复可见时重推一次数据（retainContextWhenHidden 保内容，这里保新鲜度）
    view.onDidChangeVisibility(() => {
      if (view.visible) collectState().then((s) => this.postState(s));
    });
    collectState().then((s) => this.postState(s));
  }

  postState(state) {
    if (this.view) {
      const safe = { ...state, config: { ...state.config, text: undefined } };
      this.view.webview.postMessage({ type: 'state', state: safe });
    }
  }

  async handleMessage(msg) {
    // webview 脚本加载完成后主动要数据（直接 postState 会因脚本未就绪而丢消息）
    if (msg.type === 'ready') {
      this.postState(await collectState());
      return;
    }
    if (msg.type === 'refreshQuota') {
      await refreshAll({ forceQuota: true });
      return;
    }
    if (msg.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'kimiCompanion.webToken');
      return;
    }
    if (msg.type === 'saveWebToken') {
      const t = (msg.token || '').trim();
      if (!t) return;
      await vscode.workspace
        .getConfiguration('kimiCompanion')
        .update('webToken', t, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('网页 token 已保存');
      await refreshAll({ forceQuota: true });
      return;
    }
    if (msg.type === 'openKimiWeb') {
      vscode.env.openExternal(
        vscode.Uri.parse('https://www.kimi.com/membership/subscription?tab=quota')
      );
      return;
    }
    if (msg.type === 'copyBookmarklet') {
      // 提取脚本：收集 cookie + localStorage 里所有 JWT，解码后筛掉过期的，
      // 优先选 app_id=kimi 且带用户身份的；找不到有效 token 则指引 Application > Cookies。
      // 不用 clipboard API（页面无焦点时被拒），用 prompt 弹窗展示。
      const script =
        "(()=>{const c=[];const m=document.cookie.match(/kimi-auth=([^;]+)/);if(m)c.push(decodeURIComponent(m[1]));" +
        "for(const v of Object.values(localStorage)){if(typeof v==='string'&&v.indexOf('eyJ')===0)c.push(v)}" +
        "const dec=(t)=>{try{return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))}catch(e){return null}};" +
        "let best=null;" +
        "for(const t of c){const j=dec(t);if(!j||!j.exp||j.exp*1000<Date.now())continue;" +
        "const s=(j.app_id==='kimi'?2:0)+(j.sub?1:0);" +
        "if(!best||s>best.s||(s===best.s&&j.exp>best.j.exp))best={t,j,s}}" +
        "if(!best)return '未找到有效 token：请用 F12 → Application → Cookies → kimi.com → kimi-auth 双击值复制';" +
        "prompt('token 如下，Ctrl+A 全选后 Ctrl+C 复制，然后回 VS Code 粘贴',best.t);" +
        "return '已弹出有效 token（有效期至 '+new Date(best.j.exp*1000).toLocaleDateString()+'）'})()";
      await vscode.env.clipboard.writeText(script);
      vscode.window.showInformationMessage('提取脚本已复制：到 kimi.com 页面按 F12 → Console → 粘贴 → 回车');
      return;
    }
    const state = await collectState();
    try {
      if (msg.type === 'refresh') {
        await refreshAll({ forceQuota: true });
      } else if (msg.type === 'setEffort') {
        kimiConfig.setThinkingEffort(state.config.configPath, msg.effort);
        vscode.window.showInformationMessage(`思考级别已切换为 ${msg.effort}（新会话生效）`);
        refreshAll();
      } else if (msg.type === 'setContextSize') {
        const size = Number(msg.size);
        if (!Number.isInteger(size) || size < 1) throw new Error('无效的上下文大小');
        kimiConfig.setModelContextSize(state.config.configPath, msg.alias, size);
        vscode.window.showInformationMessage(`${msg.alias} 上下文已设为 ${size}（新会话生效）`);
        refreshAll();
      }
    } catch (err) {
      vscode.window.showErrorMessage(`操作失败：${err.message}`);
    }
  }
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function renderHtml(webview) {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root {
    --accent: var(--vscode-textLink-foreground, #3794ff);
    --card-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --border: var(--vscode-panel-border, rgba(128,128,128,.25));
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
         padding: 4px 12px 24px; margin: 0; }
  .section { margin-top: 20px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; opacity: .55; text-transform: uppercase; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
          padding: 14px; margin-bottom: 10px; }
  .muted { opacity: .55; font-size: 11px; line-height: 1.6; }
  .accent { color: var(--accent); }

  /* 思考级别 */
  .effort-now { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
  .effort-value { font-size: 26px; font-weight: 700; color: var(--accent); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button { background: transparent; color: var(--vscode-foreground); border: none; padding: 5px 16px;
                cursor: pointer; font-size: 12px; opacity: .7; transition: all .15s; }
  .seg button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .seg button.active { background: var(--accent); color: var(--vscode-button-foreground, #fff); opacity: 1; font-weight: 600; }

  /* 额度占比 */
  .qrow { padding: 8px 0; border-top: 1px solid var(--border); }
  .qrow:first-of-type { border-top: none; }
  .qrow .qhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; gap: 8px; }
  .qrow .qlabel { font-weight: 500; font-size: 12px; }
  .qrow .qval { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .qbar { height: 6px; border-radius: 3px; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); overflow: hidden; }
  .qbar > div { height: 100%; border-radius: 3px; background: var(--accent); transition: width .3s; }
  .qbar.warn > div { background: var(--vscode-editorWarning-foreground, #cca700); }
  .qbar.danger > div { background: var(--vscode-editorError-foreground, #f14c4c); }

  /* 用量统计 */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .stat { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-width: 0; }
  .stat .label { font-size: 11px; opacity: .55; margin-bottom: 4px; }
  .stat .value { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .stat .sub { font-size: 10px; opacity: .5; margin-top: 2px; }

  /* 模型用量行（窄栏友好的紧凑布局） */
  .mrow { padding: 9px 10px; border-top: 1px solid var(--border); }
  .mrow:first-of-type { border-top: none; }
  .mrow:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.08)); }
  .mrow .line1 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .mrow .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow .total { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); white-space: nowrap; }
  .mrow .line2 { margin-top: 3px; font-size: 11px; opacity: .55; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th { font-size: 10px; font-weight: 600; letter-spacing: .5px; opacity: .5; text-align: left;
       padding: 0 8px 6px; text-transform: uppercase; }
  td { padding: 7px 8px; border-top: 1px solid var(--border); }
  tr:hover td { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.08)); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  /* 会话列表 */
  .session { padding: 9px 10px; border-top: 1px solid var(--border); }
  .session:first-of-type { border-top: none; }
  .session:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.08)); }
  .session .line1 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .session .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .session .tokens { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--accent); white-space: nowrap; }
  .session .line2 { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px;
          background: var(--vscode-badge-background, rgba(128,128,128,.3)); color: var(--vscode-badge-foreground, #fff); }
  .list-card { padding: 4px; }

  /* 上下文配置 */
  .ctx-row { display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .ctx-row:first-of-type { border-top: none; }
  .ctx-name { flex: 1; min-width: 110px; font-weight: 500; }
  .ctx-cur { font-variant-numeric: tabular-nums; opacity: .7; min-width: 52px; text-align: right; }
  input.ctx { width: 88px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
              border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; padding: 4px 8px; font-size: 12px; }
  input.ctx:focus { outline: 1px solid var(--accent); }
  .preset { background: transparent; border: 1px solid var(--border); color: var(--vscode-foreground);
            border-radius: 4px; padding: 3px 7px; cursor: pointer; font-size: 10px; opacity: .65; }
  .preset:hover { opacity: 1; border-color: var(--accent); color: var(--accent); }
  .btn { background: var(--vscode-button-background, var(--accent)); color: var(--vscode-button-foreground, #fff);
         border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
  .btn:hover { background: var(--vscode-button-hoverBackground, var(--accent)); filter: brightness(1.1); }
  .btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--vscode-foreground); opacity: .8; }
  .btn.ghost:hover { opacity: 1; filter: none; border-color: var(--accent); }
  details { font-size: 11px; }
  summary { cursor: pointer; opacity: .55; padding: 4px 0; }
  summary:hover { opacity: .9; }
  .paths { padding: 8px 4px; opacity: .6; line-height: 1.8; word-break: break-all; }

  /* token 获取指引 */
  .token-guide { margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px;
                 font-size: 11px; line-height: 1.8; }
  .token-guide .way { margin-bottom: 8px; }
  .token-guide .way:last-child { margin-bottom: 0; }
  .token-guide b { color: var(--accent); }

  /* 窄侧栏（约 <260px）：进一步收紧布局 */
  @media (max-width: 260px) {
    body { padding: 4px 8px 20px; }
    .card { padding: 10px; }
    .stats { grid-template-columns: 1fr; }
    .stat .value { font-size: 18px; }
    .effort-value { font-size: 22px; }
    .seg button { padding: 5px 10px; }
    .session, .mrow { padding: 8px 6px; }
  }
</style>
</head>
<body>
  <div class="section">
    <div class="section-head"><span class="section-title">思考级别</span><span class="muted" id="effort-model"></span></div>
    <div class="card">
      <div class="effort-now"><span class="effort-value" id="effort-current">…</span><span class="muted" id="effort-source">当前生效</span></div>
      <div class="seg" id="effort-buttons"></div>
      <div class="muted" style="margin-top:10px">K3 / K2.7 为 always_thinking 模型，思考不可关闭，只能调强度。档位取自最近会话的实际运行值（官方插件里选 max 不落盘也能识别）；点击按钮写入 config.toml，对新会话生效。</div>
    </div>
  </div>

  <div class="section">
    <div class="section-head"><span class="section-title">额度占比</span><button class="btn ghost" id="refresh-quota">⟳ 刷新</button></div>
    <div class="card" id="quota-list" style="padding:4px 12px"></div>
  </div>

  <div class="section">
    <div class="section-head"><span class="section-title">Token 用量</span><button class="btn ghost" id="refresh">⟳ 刷新</button></div>
    <div class="stats" id="usage-summary"></div>
    <div class="muted" id="usage-note" style="margin-bottom:10px"></div>
    <div class="section-head" style="margin-top:4px"><span class="section-title">按模型</span></div>
    <div class="card list-card" id="usage-by-model"></div>
    <div class="section-head" style="margin-top:14px"><span class="section-title">最近会话</span></div>
    <div class="card list-card" id="usage-sessions"></div>
  </div>

  <div class="section">
    <div class="section-head"><span class="section-title">上下文配置</span></div>
    <div class="card" id="context-list" style="padding:6px 12px"></div>
    <div class="muted">修改写入 overrides 表，抗官方模型目录刷新；对新会话生效。1M 上下文需 Allegretto 及以上会员。</div>
  </div>

  <div class="section">
    <details>
      <summary>数据目录</summary>
      <div class="paths" id="paths"></div>
    </details>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const fmt = (x) => x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : String(x);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

  // 重置倒计时：每秒刷新所有 .countdown 元素
  const fmtLeft = (ms) => {
    if (ms <= 0) return '已到时间（点刷新获取最新）';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60), sec = s % 60;
    let out = '还有 ';
    if (d) out += d + ' 天 ';
    if (h || d) out += h + ' 时 ';
    if (m || h || d) out += m + ' 分 ';
    return out + sec + ' 秒';
  };
  const tick = () => document.querySelectorAll('.countdown').forEach((el) => {
    el.textContent = fmtLeft(Number(el.dataset.ts) - Date.now());
  });
  setInterval(tick, 1000);
  document.getElementById('refresh-quota').onclick = () => {
    document.getElementById('quota-list').innerHTML = '<div class="qrow muted">刷新中…</div>';
    vscode.postMessage({ type: 'refreshQuota' });
  };

  window.addEventListener('message', (ev) => {
    const { state } = ev.data;
    const cfg = state.config, usage = state.usage;

    // 额度占比（官网接口数据）
    const ql = document.getElementById('quota-list');
    const q = state.quota;
    const qbar = (pct) => {
      const cls = pct === null || pct === undefined ? '' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
      return '<div class="qbar ' + cls + '"><div style="width:' + (pct || 0) + '%"></div></div>';
    };
    if (!q) {
      ql.innerHTML = '<div class="qrow muted">加载中…</div>';
    } else if (!q.ok) {
      ql.innerHTML = '<div class="qrow muted">' + esc(q.error || '获取失败') + '</div>';
    } else if (!q.rows.length && !q.extraUsage) {
      ql.innerHTML = '<div class="qrow muted">接口未返回额度数据</div>';
    } else {
      ql.innerHTML = q.rows.map((r) =>
        '<div class="qrow"><div class="qhead"><span class="qlabel">' + esc(r.label) + '</span>' +
        '<span class="qval">' + r.used.toLocaleString() + ' / ' + r.limit.toLocaleString() +
        (r.percent !== null ? '（' + r.percent + '%）' : '') + '</span></div>' + qbar(r.percent) +
        (r.resetAt ? '<div class="muted" style="margin-top:4px">重置：<span class="countdown" data-ts="' +
          Date.parse(r.resetAt) + '"></span></div>' : '') +
        '</div>').join('') +
        (q.extraUsage
          ? '<div class="qrow"><div class="qhead"><span class="qlabel">加油包余额</span>' +
            '<span class="qval">剩 ' + (q.extraUsage.percent === null ? '—' : q.extraUsage.percent + '%') + '</span></div>' +
            qbar(q.extraUsage.percent) + '</div>'
          : '') +
        (q.parallel ? '<div class="qrow muted" style="border-top:1px solid var(--border)">并发上限 ' + q.parallel + '</div>' : '');

      // 网页端会员统计：月度总量 / 赠送额度
      const web = q.web;
      if (web) {
        if (!web.ok) {
          ql.innerHTML += '<div class="qrow">' +
            '<div class="muted" style="margin-bottom:6px">' +
            esc(web.error === 'not-configured'
              ? '月度/赠送额度需要网页 token（约 30 天有效）'
              : web.error === 'mismatch'
                ? '网页 token 属于另一个账号，请粘贴当前登录账号的 token'
                : web.error === 'expired'
                  ? '网页 token 已过期，请按下面步骤重新获取'
                  : web.error) +
            '</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<input class="ctx" id="web-token-input" style="flex:1;min-width:140px" placeholder="粘贴网页 token">' +
            '<button class="btn" id="save-web-token">保存</button>' +
            '<button class="btn ghost" id="open-kimi">打开额度页</button>' +
            '<button class="btn ghost" id="copy-bookmarklet">复制提取脚本</button></div>' +
            '<div class="token-guide">' +
            '<div class="way"><b>方式一（推荐，最可靠）</b>：① 点「打开额度页」并登录 → ② 按 F12 → 切到 Application（应用）标签 → 左侧展开 Cookies → 点 www.kimi.com → 找到 kimi-auth → 双击它的值 → Ctrl+C → ③ 回这里粘贴保存</div>' +
            '<div class="way"><b>方式二（脚本自动提取）</b>：① 打开额度页 → ② 点「复制提取脚本」→ ③ 回 kimi.com 页面按 F12 → Console（控制台）→ 粘贴 → 回车 → 弹窗里 Ctrl+A、Ctrl+C</div>' +
            '</div></div>';
        } else {
          const wrow = (label, usedPct, timeLabel, time) =>
            '<div class="qrow"><div class="qhead"><span class="qlabel">' + label +
            ' <span class="pill">网页</span></span><span class="qval">已用 ' +
            (usedPct === null ? '—' : usedPct + '%') + '</span></div>' + qbar(usedPct) +
            (time ? '<div class="muted" style="margin-top:4px">' + timeLabel +
              '：<span class="countdown" data-ts="' + Date.parse(time) + '"></span></div>' : '') + '</div>';
          if (web.monthly) {
            ql.innerHTML += wrow('每月总量（订阅）', web.monthly.usedPercent, '重置', web.monthly.expireTime);
          }
          for (const g of web.gifts || []) {
            ql.innerHTML += wrow('赠送额度', g.usedPercent, '截止', g.expireTime);
          }
          if (web.expiresAt) {
            ql.innerHTML += '<div class="qrow muted">网页 token 有效期至 ' +
              esc(new Date(web.expiresAt).toLocaleDateString()) + '</div>';
          }
        }
      }
      const osBtn = document.getElementById('open-settings');
      if (osBtn) osBtn.onclick = () => vscode.postMessage({ type: 'openSettings' });
      const stBtn = document.getElementById('save-web-token');
      if (stBtn) stBtn.onclick = () =>
        vscode.postMessage({ type: 'saveWebToken', token: document.getElementById('web-token-input').value });
      const okBtn = document.getElementById('open-kimi');
      if (okBtn) okBtn.onclick = () => vscode.postMessage({ type: 'openKimiWeb' });
      const cbBtn = document.getElementById('copy-bookmarklet');
      if (cbBtn) cbBtn.onclick = () => vscode.postMessage({ type: 'copyBookmarklet' });
    }

    // 思考级别：优先显示最近会话的实际运行档位（能捕获官方插件里选的 max），
    // 与配置持久化值不一致时两者都展示
    const sessEff = state.sessionEffort;
    const cfgEff = cfg.effectiveEffort;
    const showEff = (sessEff && sessEff.effort) || cfgEff || '—';
    document.getElementById('effort-current').textContent = showEff;
    document.getElementById('effort-model').textContent = cfg.current ? cfg.current.displayName : '';
    document.getElementById('effort-source').textContent =
      sessEff && sessEff.effort && sessEff.effort !== cfgEff
        ? '最近会话实际值（配置持久化值：' + (cfgEff || '—') + '）'
        : '当前生效（最近会话实际值）';
    const btns = document.getElementById('effort-buttons');
    btns.innerHTML = '';
    for (const e of (cfg.current && cfg.current.supportEfforts) || []) {
      const b = document.createElement('button');
      b.className = e === showEff ? 'active' : '';
      b.textContent = e;
      b.onclick = () => vscode.postMessage({ type: 'setEffort', effort: e });
      btns.appendChild(b);
    }

    // 用量统计卡
    const s = usage.totals;
    // 命中率 = 缓存读 / (缓存读 + 缓存写 + 普通输入)
    const hitRate = (u) => {
      const denom = u.inputCacheRead + u.inputCacheCreation + u.inputOther;
      return denom > 0 ? Math.round((u.inputCacheRead / denom) * 100) + '%' : '—';
    };
    document.getElementById('usage-summary').innerHTML =
      [['今日', 'today'], ['近 7 天', 'last7d'], ['全部', 'all']].map(([label, k]) =>
        '<div class="stat"><div class="label">' + label + '（合计）</div><div class="value">' + fmt(s[k].total || 0) +
        '</div><div class="sub">入 ' + fmt(s[k].inputOther) + ' · 出 ' + fmt(s[k].output) + '</div>' +
        '<div class="sub">命中率 ' + hitRate(s[k]) + ' · 缓存命中 ' + fmt(s[k].inputCacheRead) + '</div></div>').join('');
    document.getElementById('usage-note').textContent =
      usage.scannedSessions + ' 个会话 · 缓存命中 ' + usage.cachedFiles + ' 文件 / 重扫 ' + usage.reparsedFiles +
      (usage.skippedLargeFiles ? ' · 跳过超大文件 ' + usage.skippedLargeFiles : '') +
      ' · 本地数据聚合，非账号 quota（额度用 CLI /usage 查看）';

    // 按模型：合计 = 输入 + 输出 + 缓存命中 + 缓存写入
    // 命中率 = 缓存读 / (缓存读 + 缓存写 + 普通输入)
    document.getElementById('usage-by-model').innerHTML =
      Object.entries(usage.byModel).map(([m, u]) =>
        '<div class="mrow"><div class="line1"><span class="name">' + esc(m) +
        ' <span class="pill">' + hitRate(u) + '</span></span><span class="total">' + fmt(u.total) + '</span></div>' +
        '<div class="line2">入 ' + fmt(u.inputOther) + ' · 出 ' + fmt(u.output) +
        ' · 命中 ' + fmt(u.inputCacheRead) + ' · 写 ' + fmt(u.inputCacheCreation) + '</div></div>').join('') ||
      '<div class="mrow muted">暂无数据</div>';

    // 最近会话
    document.getElementById('usage-sessions').innerHTML = usage.recentSessions.map((r) =>
      '<div class="session" title="' + esc(r.workDir) + '">' +
      '<div class="line1"><span class="title">' + esc(r.title) + '</span><span class="tokens">' + fmt(r.total) + '</span></div>' +
      '<div class="line2"><span>' + r.models.map((m) => '<span class="pill">' + esc(m) + '</span>').join(' ') +
      '</span><span class="muted">入 ' + fmt(r.usage.inputOther) + ' · 出 ' + fmt(r.usage.output) +
      ' · 命中 ' + fmt(r.usage.inputCacheRead) + '</span></div>' +
      '<div class="line2"><span class="muted">命中率 ' + hitRate(r.usage) + '</span>' +
      '<span class="muted">' + fmtDate(r.updatedAt) + '</span></div></div>').join('') ||
      '<div class="session muted">暂无会话数据</div>';

    // 上下文配置
    const cl = document.getElementById('context-list');
    cl.innerHTML = '';
    for (const m of cfg.models || []) {
      const row = document.createElement('div');
      row.className = 'ctx-row';
      row.innerHTML = '<span class="ctx-name">' + esc(m.displayName) +
        (m.alias === cfg.defaultModel ? ' <span class="pill">默认</span>' : '') + '</span>' +
        '<span class="ctx-cur">' + (m.maxContextSize ? fmt(m.maxContextSize) : '—') + '</span>' +
        '<input class="ctx" value="' + (m.maxContextSize || '') + '">' +
        ['256K', '512K', '1M'].map((p) => '<button class="preset" data-v="' +
          ({ '256K': 262144, '512K': 524288, '1M': 1048576 })[p] + '">' + p + '</button>').join('') +
        '<button class="btn save">保存</button>';
      const input = row.querySelector('input');
      row.querySelectorAll('.preset').forEach((b) => (b.onclick = () => { input.value = b.dataset.v; }));
      row.querySelector('.save').onclick = () =>
        vscode.postMessage({ type: 'setContextSize', alias: m.alias, size: input.value });
      cl.appendChild(row);
    }

    // 路径
    document.getElementById('paths').innerHTML =
      '数据目录：' + esc(state.home) + '<br>配置文件：' + esc(cfg.configPath || '—') +
      '<br>会话目录：' + esc(usage.sessionsRoot || '—');

    tick(); // 渲染后立即填充倒计时
  });

  // 脚本就绪后主动要数据（扩展端直接 postState 会赶在脚本加载前，消息丢失）
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function activate(context) {
  extContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'kimi-companion.switchEffort';
  statusBar.show();

  provider = new DashboardProvider(context.extensionUri);
  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider('kimiCompanion.dashboard', provider),
    vscode.commands.registerCommand('kimi-companion.openDashboard', () =>
      vscode.commands.executeCommand('kimiCompanion.dashboard.focus')
    ),
    vscode.commands.registerCommand('kimi-companion.switchEffort', switchEffort),
    vscode.commands.registerCommand('kimi-companion.refresh', refreshAll)
  );

  // 监听 config.toml 变化自动刷新
  try {
    const configPath = kimiConfig.getConfigPath(getHome());
    if (fs.existsSync(configPath)) {
      const watcher = fs.watch(configPath, { persistent: false }, () => refreshAll());
      context.subscriptions.push({ dispose: () => watcher.close() });
    }
  } catch {
    // 监听失败不影响主功能
  }

  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate };
