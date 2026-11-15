const PRESETS = {
  skew: `SELECT m.merchant_id,
       m.merchant_name,
       COUNT(*)      AS order_cnt,
       SUM(o.amount) AS total_amount,
       SUM(o.fee)    AS total_fee
FROM settlement_orders o
JOIN merchants m ON m.merchant_id = o.merchant_id
WHERE left(m.category, 1) = 'A'
GROUP BY m.merchant_id, m.merchant_name
ORDER BY total_amount DESC`,
  single: `SELECT o.order_no, o.amount, o.fee, o.settle_date, m.merchant_name
FROM settlement_orders o
JOIN merchants m ON m.merchant_id = o.merchant_id
WHERE m.merchant_id = 42
  AND o.settle_date >= DATE '2026-11-01'
  AND o.settle_date <  DATE '2026-11-14'
ORDER BY o.settle_date DESC, o.order_no`,
  daily: `SELECT settle_date, COUNT(*) AS order_cnt, SUM(amount) AS total_amount
FROM settlement_orders
WHERE settle_date >= DATE '2026-11-01'
  AND settle_date <  DATE '2026-11-14'
GROUP BY settle_date
ORDER BY settle_date`,
};

const sqlInput = document.getElementById('sql-input');
const versionSelect = document.getElementById('version-select');
sqlInput.value = PRESETS.skew;
document.getElementById('preset').onchange = (e) => {
  sqlInput.value = PRESETS[e.target.value] || '';
};

let versionsState = { current_version_id: null, versions: [] };

const expanded = new Set();   // 展开了计划详情的批次 id

const STATUS_TEXT = {
  pending: '排队中', running: '运行中', completed: '已完成',
  failed: '失败', timeout: '超时', cancelled: '已取消',
};
const SETTING_TEXT = {
  default: '默认 (enable_nestloop=on)',
  nestloop_off: '抑制嵌套循环 (enable_nestloop=off)',
};
const EX_STATUS_TEXT = {
  pending: '待执行', running: '执行中', ok: '成功',
  timeout: '超时', cancelled: '已取消', error: '报错',
};
const VERDICT_TEXT = {
  improved: '有改善', not_improved: '无改善', inconclusive: '无法判断改善',
};
const VSTATUS_TEXT = {
  building: '构建中', published: '已发布', superseded: '被取代（未生效）', failed: '失败',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtMs(v) { return v == null ? '—' : Number(v).toFixed(1) + ' ms'; }
function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString() : '—'; }
function fmtIso(s) { return s ? new Date(s).toLocaleString() : '—'; }

function versionName(v) {
  return `#${v.version_id} ${v.label}（${v.order_count} 单 / 前100家 ${v.top100_share}%）`;
}

async function refreshVersions() {
  try {
    const res = await fetch('/api/demo-versions');
    if (!res.ok) return;
    versionsState = await res.json();
    renderVersionSelect();
    renderVersions();
  } catch (e) { /* 忽略瞬时网络错误，下一轮再试 */ }
}

function renderVersionSelect() {
  const prev = versionSelect.value;
  const published = versionsState.versions.filter(v => v.status === 'published');
  const cur = versionsState.versions.find(v => v.is_current);
  let html = `<option value="">跟随当前默认${cur ? `（${versionName(cur)}）` : ''}</option>`;
  html += published.map(v =>
    `<option value="${v.version_id}">${escapeHtml(versionName(v))}${v.is_current ? '（当前默认）' : ''}</option>`
  ).join('');
  versionSelect.innerHTML = html;
  // 刷新后尽量保留用户已选的版本
  if ([...versionSelect.options].some(o => o.value === prev)) versionSelect.value = prev;
}

function renderVersions() {
  const box = document.getElementById('versions');
  const vs = versionsState.versions;
  if (!vs.length) { box.innerHTML = '<p class="hint">暂无版本</p>'; return; }
  box.innerHTML = `<table class="ex-table">
    <thead><tr><th>版本</th><th>schema</th><th>订单数</th><th>前100家占比</th>
    <th>状态</th><th>提交时间</th><th>发布时间</th><th>备注</th></tr></thead>
    <tbody>${vs.map(v => `<tr>
      <td>#${v.version_id} ${escapeHtml(v.label)}${v.is_current ? ' <span class="badge completed">当前默认</span>' : ''}</td>
      <td><code>${escapeHtml(v.schema_name)}</code></td>
      <td>${v.order_count}</td>
      <td>${v.top100_share}%</td>
      <td><span class="ex-status ${v.status}">${VSTATUS_TEXT[v.status] || v.status}</span></td>
      <td>${fmtIso(v.created_at)}</td>
      <td>${fmtIso(v.published_at)}</td>
      <td>${v.error ? escapeHtml(v.error) : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function refresh() {
  try {
    const res = await fetch('/api/batches');
    const data = await res.json();
    renderSlot(data);
    await renderBatches(data.batches);
  } catch (e) { /* 忽略瞬时网络错误，下一轮再试 */ }
  refreshVersions();
}

function renderSlot(data) {
  const pill = document.getElementById('slot-pill');
  if (data.busy) {
    pill.textContent = '运行中（名额已占用）';
    pill.className = 'pill busy';
  } else {
    pill.textContent = '空闲，可提交对照';
    pill.className = 'pill idle';
  }
}

function conclusionHtml(b) {
  if (b.conclusion) {
    const v = b.conclusion.verdict;
    return `<div class="conclusion ${v}">
      <b>${VERDICT_TEXT[v] || v}</b> · ${escapeHtml(b.conclusion.message)}
    </div>`;
  }
  if (['failed', 'timeout', 'cancelled'].includes(b.status)) {
    const reason = { failed: '报错', timeout: '超时', cancelled: '已取消' }[b.status];
    return `<div class="conclusion none">无比较结论（批次${reason}）</div>`;
  }
  return '';
}

function executionsHtml(b) {
  if (!b.executions.length) {
    return b.status === 'running' ? '<p class="hint">正在建立事务快照…</p>' : '';
  }
  const rows = b.executions.map(ex => `<tr>
    <td>第 ${ex.round} 轮</td>
    <td>#${ex.seq}</td>
    <td>${SETTING_TEXT[ex.setting] || ex.setting}</td>
    <td><span class="ex-status ${ex.status}">${EX_STATUS_TEXT[ex.status] || ex.status}</span></td>
    <td>${fmtMs(ex.execution_time_ms)}</td>
    <td>${fmtMs(ex.planning_time_ms)}</td>
    <td>${ex.error ? escapeHtml(ex.error) : ''}</td>
  </tr>`).join('');
  return `<table class="ex-table">
    <thead><tr><th>轮次</th><th>顺序</th><th>设置</th><th>状态</th>
    <th>执行耗时</th><th>规划耗时</th><th>备注</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function batchCardHtml(b) {
  const cancelBtn = (b.status === 'running' || b.status === 'pending')
    ? (b.cancel_requested
        ? '<span class="msg warn">取消中…</span>'
        : `<button class="btn-cancel" data-cancel="${b.id}">取消本批</button>`)
    : '';
  const toggleBtn = b.executions.length
    ? `<button class="btn-toggle" data-toggle="${b.id}">${expanded.has(b.id) ? '收起计划' : '查看计划与结构'}</button>`
    : '';
  return `<div class="card batch">
    <div class="batch-head">
      <span class="badge ${b.status}">${STATUS_TEXT[b.status] || b.status}</span>
      <code>#${b.id}</code>
      <span class="hint">提交于 ${fmtTime(b.created_at)}</span>
      ${b.version_label ? `<span class="hint">数据版本：${escapeHtml(b.version_label)}（${escapeHtml(b.schema_name || '')}）</span>` : ''}
      <span class="spacer"></span>
      ${cancelBtn}${toggleBtn}
    </div>
    <pre class="sql">${escapeHtml(b.sql)}</pre>
    ${b.error ? `<div class="conclusion none">错误：${escapeHtml(b.error)}</div>` : ''}
    ${conclusionHtml(b)}
    ${executionsHtml(b)}
    <div class="detail" id="detail-${b.id}"></div>
  </div>`;
}

async function renderBatches(batches) {
  const container = document.getElementById('batches');
  container.innerHTML = batches.length
    ? batches.map(batchCardHtml).join('')
    : '<p class="hint">暂无批次</p>';
  container.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.onclick = () => cancelBatch(btn.dataset.cancel);
  });
  container.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.onclick = () => toggleDetail(btn.dataset.toggle);
  });
  for (const id of expanded) {
    if (batches.some(b => b.id === id)) await loadDetail(id);
  }
}

async function loadDetail(id) {
  const box = document.getElementById(`detail-${id}`);
  if (!box) return;
  try {
    const res = await fetch(`/api/batches/${id}`);
    if (!res.ok) { box.innerHTML = ''; return; }
    const d = await res.json();
    box.innerHTML = d.executions.map(ex => {
      const struct = (ex.structure_lines || []).join('\n');
      const plan = ex.plan ? JSON.stringify(ex.plan, null, 2) : '（无计划）';
      return `<div class="ex-detail">
        <h4>第 ${ex.round} 轮 · #${ex.seq} · ${SETTING_TEXT[ex.setting]} ·
            ${EX_STATUS_TEXT[ex.status]}${ex.execution_time_ms != null ? ' · ' + fmtMs(ex.execution_time_ms) : ''}</h4>
        ${struct ? `<pre class="struct">${escapeHtml(struct)}</pre>` : ''}
        <details><summary>完整计划 JSON</summary><pre class="plan">${escapeHtml(plan)}</pre></details>
      </div>`;
    }).join('');
  } catch (e) { /* 下一轮再试 */ }
}

async function toggleDetail(id) {
  if (expanded.has(id)) {
    expanded.delete(id);
    const box = document.getElementById(`detail-${id}`);
    if (box) box.innerHTML = '';
  } else {
    expanded.add(id);
    await loadDetail(id);
  }
  refresh();
}

async function cancelBatch(id) {
  await fetch(`/api/batches/${id}/cancel`, { method: 'POST' });
  refresh();
}

document.getElementById('run-btn').onclick = async () => {
  const msg = document.getElementById('submit-msg');
  msg.className = 'msg';
  msg.textContent = '提交中…';
  const v = versionSelect.value;
  try {
    const res = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sqlInput.value, version_id: v === '' ? null : Number(v) }),
    });
    if (res.status === 409) {
      msg.textContent = '繁忙：已有对照批次在运行，请稍后再试';
      msg.classList.add('warn');
    } else if (res.status === 400) {
      const d = await res.json();
      msg.textContent = '校验失败：' + (d.detail || '');
      msg.classList.add('err');
    } else if (res.ok) {
      msg.textContent = '批次已创建，开始运行';
      msg.classList.add('ok');
    } else {
      msg.textContent = '提交失败（HTTP ' + res.status + '）';
      msg.classList.add('err');
    }
  } catch (e) {
    msg.textContent = '网络错误：' + e;
    msg.classList.add('err');
  }
  refresh();
};

document.getElementById('insert-btn').onclick = async () => {
  const msg = document.getElementById('insert-msg');
  msg.className = 'msg';
  try {
    const res = await fetch('/api/sample-row', { method: 'POST' });
    const d = await res.json();
    if (d.ok) {
      msg.textContent = `已补记 ${d.row.order_no}（商户 ${d.row.merchant_id}，金额 ${d.row.amount}，结算日 ${d.row.settle_date}）`;
      msg.classList.add('ok');
    } else {
      msg.textContent = '写入失败';
      msg.classList.add('err');
    }
  } catch (e) {
    msg.textContent = '网络错误：' + e;
    msg.classList.add('err');
  }
};

document.getElementById('gen-btn').onclick = async () => {
  const msg = document.getElementById('gen-msg');
  const orderCount = Number(document.getElementById('order-count').value);
  const share = Number(document.getElementById('top-share').value);
  msg.className = 'msg';
  if (!Number.isInteger(orderCount) || orderCount < 1 || orderCount > 100000) {
    msg.textContent = '订单数需为 1～100000 的整数';
    msg.classList.add('err');
    return;
  }
  if (!(share >= 0 && share <= 100)) {
    msg.textContent = '前 100 家商户订单占比需在 0～100 之间';
    msg.classList.add('err');
    return;
  }
  msg.textContent = '提交中…';
  try {
    const res = await fetch('/api/demo-versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_count: orderCount, top100_share: share }),
    });
    if (res.ok) {
      const d = await res.json();
      msg.textContent = `版本 #${d.version.version_id} 已提交，后台构建中，完成后自动发布为默认版本`;
      msg.classList.add('ok');
    } else {
      const d = await res.json().catch(() => ({}));
      const detail = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail || {});
      msg.textContent = '提交失败：' + (detail || 'HTTP ' + res.status);
      msg.classList.add('err');
    }
  } catch (e) {
    msg.textContent = '网络错误：' + e;
    msg.classList.add('err');
  }
  refreshVersions();
};

refresh();
setInterval(refresh, 1500);
