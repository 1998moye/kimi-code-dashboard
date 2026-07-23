'use strict';

// 纯 Node 模块（不依赖 vscode）：调用 Kimi Code 官方额度接口。
// 接口（从 CLI 二进制中确认）：
//   GET {base_url}/usages   —— 默认 https://api.kimi.com/coding/v1/usages
//   Header: Authorization: Bearer <access_token>, Accept: application/json
//   access_token 来自 ~/.kimi-code/credentials/kimi-code.json；
//   过期时自动走 OAuth refresh_token 流程（POST auth.kimi.com/api/oauth/token）
//   换新并写回，无需手动运行 CLI；refresh_token 也被拒时才需要重新 /login。
// 响应：{ usage: {limit, used|remaining, name, reset_at...},
//         limits: [{detail|直接字段, window:{duration,timeUnit}}...],
//         boosterWallet: {...} }

const fs = require('fs');
const path = require('path');
const kimiConfig = require('./kimiConfig');

const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';

function readCredentials(homeDir) {
  try {
    const c = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'credentials', 'kimi-code.json'), 'utf8')
    );
    if (!c.access_token) return null;
    return c;
  } catch {
    return null;
  }
}

function expiresAtMs(c) {
  if (typeof c.expires_at !== 'number') return null;
  return c.expires_at < 1e12 ? c.expires_at * 1000 : c.expires_at;
}

// OAuth 刷新（与 CLI 同一流程）：POST auth.kimi.com/api/oauth/token，
// grant_type=refresh_token，成功后写回 credentials/kimi-code.json（先备份）
const OAUTH_HOST = 'https://auth.kimi.com';
const OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

async function refreshAccessToken(homeDir, creds, timeoutMs) {
  if (!creds.refresh_token) return { ok: false, error: '无 refresh_token，请运行 kimi 重新登录' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
      }).toString(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const code = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      return {
        ok: false,
        error:
          code === 'invalid_grant'
            ? '登录态已失效（refresh_token 被拒）：请运行 kimi 用 /login 重新登录'
            : `刷新凭证失败：${code}`,
      };
    }
    const expiresIn = Number(data.expires_in) || 3600;
    const updated = {
      ...creds,
      access_token: data.access_token,
      refresh_token: data.refresh_token || creds.refresh_token,
      expires_in: expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
    const credPath = path.join(homeDir, 'credentials', 'kimi-code.json');
    fs.copyFileSync(credPath, credPath + '.bak');
    fs.writeFileSync(credPath, JSON.stringify(updated, null, 2), 'utf8');
    return { ok: true, token: data.access_token };
  } catch (err) {
    return { ok: false, error: `刷新凭证失败：${err.name === 'AbortError' ? '超时' : err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// 取可用 token：未过期直接用；过期则自动走 OAuth 刷新（不再需要手动跑 CLI）
async function ensureAccessToken(homeDir, timeoutMs) {
  const creds = readCredentials(homeDir);
  if (!creds) return { ok: false, error: '未找到 OAuth 凭证（仅支持 Kimi 账号登录模式）' };
  const expMs = expiresAtMs(creds);
  if (expMs === null || expMs - Date.now() > 60 * 1000) {
    return { ok: true, token: creds.access_token };
  }
  return refreshAccessToken(homeDir, creds, timeoutMs);
}

function baseUrl(homeDir) {
  try {
    const text = fs.readFileSync(kimiConfig.getConfigPath(homeDir), 'utf8');
    const parsed = kimiConfig.parseTomlLite(text);
    const managed = parsed.sections['providers."managed:kimi-code"'];
    if (managed && typeof managed.base_url === 'string' && managed.base_url) {
      return managed.base_url.replace(/\/+$/, '');
    }
  } catch {
    // fallthrough
  }
  return DEFAULT_BASE_URL;
}

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

const isRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function labelOf(item, detail, window, idx) {
  for (const key of ['title', 'name', 'label']) {
    const v = item[key] || detail[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const duration = toInt(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? '');
  if (duration !== null) {
    if (unit.includes('MINUTE')) {
      return duration >= 60 && duration % 60 === 0
        ? `${duration / 60}h limit`
        : `${duration}m limit`;
    }
    if (unit.includes('HOUR')) return `${duration}h limit`;
    if (unit.includes('DAY')) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
}

function rowFrom(raw, defaultLabel) {
  if (!isRec(raw)) return null;
  const limit = toInt(raw.limit);
  let used = toInt(raw.used);
  if (used === null) {
    const remaining = toInt(raw.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (used === null && limit === null) return null;
  const name =
    typeof raw.name === 'string' ? raw.name : typeof raw.title === 'string' ? raw.title : defaultLabel;
  const resetAt = raw.reset_at || raw.resetAt || raw.reset_time || raw.resetTime;
  return {
    label: name,
    used: used ?? 0,
    limit: limit ?? 0,
    percent: limit > 0 && used !== null ? Math.min(100, Math.round((used / limit) * 100)) : null,
    resetAt: typeof resetAt === 'string' ? resetAt : null,
  };
}

// 服务端标签是英文，映射成中文
function zhLabel(label) {
  let m = label.match(/^(\d+)h limit$/i);
  if (m) return `${m[1]} 小时额度`;
  m = label.match(/^(\d+)d limit$/i);
  if (m) {
    const d = Number(m[1]);
    if (d >= 28 && d <= 31) return '每月额度';
    return `${d} 天额度`;
  }
  if (/week/i.test(label)) return '每周额度';
  if (/month/i.test(label)) return '每月额度';
  return label;
}

function parsePayload(payload) {
  if (!isRec(payload)) return { rows: [], extraUsage: null, parallel: null, userId: null };
  const userId =
    isRec(payload.user) && typeof payload.user.userId === 'string' ? payload.user.userId : null;
  const rows = [];
  const summary = rowFrom(payload.usage, '每周额度');
  if (summary) rows.push({ ...summary, label: zhLabel(summary.label) });
  if (Array.isArray(payload.limits)) {
    payload.limits.forEach((item, idx) => {
      if (!isRec(item)) return;
      const detail = isRec(item.detail) ? item.detail : item;
      const window = isRec(item.window) ? item.window : {};
      const row = rowFrom(detail, labelOf(item, detail, window, idx));
      if (row) rows.push({ ...row, label: zhLabel(row.label) });
    });
  }
  // totalQuota = 月总量（部分套餐返回空对象，有数据才显示）
  if (isRec(payload.totalQuota)) {
    const total = rowFrom(payload.totalQuota, '每月总量');
    if (total) rows.push({ ...total, label: '每月总量' });
  }
  // parallel.limit = 并发上限
  let parallel = null;
  if (isRec(payload.parallel)) {
    const pl = toInt(payload.parallel.limit);
    if (pl !== null) parallel = pl;
  }
  let extraUsage = null;
  const w = payload.boosterWallet;
  if (isRec(w) && isRec(w.balance) && w.balance.type === 'BOOSTER') {
    const total = toInt(w.balance.amount);
    const left = toInt(w.balance.amountLeft);
    if (total !== null && total > 0) {
      extraUsage = {
        total,
        left: left ?? 0,
        percent: left !== null ? Math.min(100, Math.round((left / total) * 100)) : null,
      };
    }
  }
  return { rows, extraUsage, parallel, userId };
}

async function fetchQuota(homeDir, { timeoutMs = 8000 } = {}) {
  const auth = await ensureAccessToken(homeDir, timeoutMs);
  if (!auth.ok) return { ok: false, error: auth.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(homeDir)}/usages`, {
      headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const hint =
        res.status === 401
          ? '凭证无效（401）：请在终端运行 kimi 重新登录或触发一次凭证刷新'
          : res.status === 404
            ? '额度接口不可用（404）'
            : `请求失败：HTTP ${res.status}`;
      return { ok: false, error: hint };
    }
    const parsed = parsePayload(await res.json());
    return { ok: true, fetchedAt: Date.now(), ...parsed };
  } catch (err) {
    return { ok: false, error: `请求失败：${err.name === 'AbortError' ? '超时' : err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchQuota, fetchWebStats, jwtExp, ensureAccessToken, refreshAccessToken };

// ---- kimi.com 网页端会员统计（月度总量、赠送额度）----
// POST https://www.kimi.com/apiv2/...MembershipService/GetSubscriptionStats，body {}
// 需要网页登录态 token（app_id=kimi，与 coding OAuth token 不同，有效期约 30 天）

const WEB_STATS_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';

function jwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch {
    return null;
  }
}

function jwtExp(token) {
  const j = jwtPayload(token);
  return j && typeof j.exp === 'number' ? j.exp * 1000 : null;
}

function jwtSub(token) {
  const j = jwtPayload(token);
  return j && typeof j.sub === 'string' ? j.sub : null;
}

const ratioToPct = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 10 : null;

async function fetchWebStats(token, { timeoutMs = 8000, expectedUserId = null } = {}) {
  if (!token || !token.trim()) return { ok: false, error: 'not-configured' };
  const trimmed = token.trim();
  // 换号检测：网页 token 的账号与当前 CLI 登录账号不一致时拒绝使用，防止数据串号
  if (expectedUserId) {
    const sub = jwtSub(trimmed);
    if (sub && sub !== expectedUserId) {
      return { ok: false, error: 'mismatch' };
    }
  }
  const exp = jwtExp(trimmed);
  if (exp !== null && exp < Date.now()) {
    return { ok: false, error: 'expired', expiresAt: exp };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(WEB_STATS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${trimmed}`,
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.status === 401 ? '网页 token 无效或已过期（401），请重新粘贴' : `请求失败：HTTP ${res.status}`,
        expiresAt: exp,
      };
    }
    const j = await res.json();
    const monthly = isRec(j.subscriptionBalance)
      ? {
          usedPercent: ratioToPct(j.subscriptionBalance.amountUsedRatio),
          expireTime: j.subscriptionBalance.expireTime || null,
        }
      : null;
    const gifts = Array.isArray(j.giftBalances)
      ? j.giftBalances.filter(isRec).map((g) => ({
          usedPercent: ratioToPct(g.amountUsedRatio),
          expireTime: g.expireTime || null,
        }))
      : [];
    return { ok: true, expiresAt: exp, monthly, gifts };
  } catch (err) {
    return { ok: false, error: `请求失败：${err.name === 'AbortError' ? '超时' : err.message}`, expiresAt: exp };
  } finally {
    clearTimeout(timer);
  }
}
