/**
 * PulseMonitor Frontend Script
 * Handles WebSocket communication, dynamic UI rendering, and user interactions.
 */
// ─── Configuration & State ──────────────────────────────────────────────────

const MAX_CHART_POINTS = { 1: 60, 5: 300, 60: 3600 };
let currentZoom = 1;
let charts = {};
let processData = [];
let socket = null;
let authToken = localStorage.getItem('pulseToken') || null;
let isReadOnly = localStorage.getItem('pulseReadOnly') === 'true';
let selectedPids = new Set();
let logoPulseTimeout = null;

let isHUD = false;
let autoKillRules = [];
let processBaselines = new Map();
let processHistory = new Map();

// ─── Theme Engine ─────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('pulseTheme') || 'cyberpunk';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('pulseTheme', theme);
  const btn = document.getElementById('themeToggle');
  btn.title = theme === 'cyberpunk' ? 'Switch to Clean Glass' : 'Switch to Cyberpunk';
  btn.querySelector('.theme-icon').textContent = theme === 'cyberpunk' ? '◑' : '●';
}

function toggleTheme() {
  const current = document.body.getAttribute('data-theme');
  applyTheme(current === 'cyberpunk' ? 'glass' : 'cyberpunk');
}

// Also respect OS preference on first visit
if (!localStorage.getItem('pulseTheme')) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  localStorage.setItem('pulseTheme', prefersDark ? 'cyberpunk' : 'glass');
}

// ─── Chart Initialization ───────────────────────────────────────────────────

function initCharts() {
  const chartConfigs = {
    cpu: { type: 'line', target: 'cpuChart', color: '#00f2ff', yMax: 100 },
    net: { type: 'line', target: 'netChart', color: '#00ffc3', yMax: null },
    mem: { type: 'doughnut', target: 'memChart', colors: ['#ff3d71', 'rgba(255,255,255,0.05)'] },
    disk: { type: 'doughnut', target: 'diskChart', colors: ['#bc00ff', 'rgba(255,255,255,0.05)'] }
  };

  Object.entries(chartConfigs).forEach(([key, cfg]) => {
    const ctx = document.getElementById(cfg.target).getContext('2d');

    if (cfg.type === 'line') {
      const gradient = ctx.createLinearGradient(0, 0, 0, 150);
      gradient.addColorStop(0, `${cfg.color}33`);
      gradient.addColorStop(1, `${cfg.color}00`);

      charts[key] = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: cfg.color, backgroundColor: gradient, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: { legend: { display: false } },
          scales: {
            x: { display: false },
            y: {
              grid: { color: 'rgba(255,255,255,0.04)' },
              ticks: { color: '#64748b', font: { size: 10 } },
              min: 0, ...(cfg.yMax ? { max: cfg.yMax } : { beginAtZero: true })
            }
          }
        }
      });
    } else {
      charts[key] = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: ['Used', 'Free'], datasets: [{ data: [0, 100], backgroundColor: cfg.colors, borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false } } }
      });
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => v < 10 ? '0' + v : v).join(':');
}

function updateLineChart(chart, value) {
  const maxPoints = MAX_CHART_POINTS[currentZoom] || 60;
  const labels = chart.data.labels;
  const data = chart.data.datasets[0].data;
  if (data.length >= maxPoints) { data.shift(); labels.shift(); }
  data.push(value);
  labels.push('');
  chart.update('none');
}

// ─── New Features: HUD, Health, Sparklines, Rules ────────────────────────────

function toggleHud() {
  document.body.classList.toggle('hud-mode');
  isHUD = document.body.classList.contains('hud-mode');
}

function calculateHealth(cpu, mem, temp) {
  let score = 100;
  if (cpu > 80) score -= (cpu - 80);
  if (mem > 85) score -= (mem - 85);
  if (temp && temp > 80) score -= (temp - 80);
  return Math.max(0, Math.round(score));
}

function drawSparkline(canvasId, dataPoints) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!dataPoints || dataPoints.length < 2) return;
  const stepX = w / (dataPoints.length - 1);
  ctx.beginPath();
  ctx.strokeStyle = '#00f2ff';
  ctx.lineWidth = 1.5;
  dataPoints.forEach((val, i) => {
    const x = i * stepX;
    const y = h - ((val / 100) * h);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function saveWebhook() {
  const input = document.getElementById('webhookInput').value;
  try {
    await fetch('/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pulse-token': authToken || '' },
      body: JSON.stringify({ urls: [input] })
    });
    triggerAlert('Webhook configured', 'success');
  } catch (e) { triggerAlert('Failed to save webhook', 'danger'); }
}

function addAutoKillRule() {
  const cpu = parseInt(document.getElementById('autoCpu').value);
  const sec = parseInt(document.getElementById('autoSec').value);
  if (cpu && sec) {
    autoKillRules.push({ cpu, sec, triggeredTs: {} });
    renderRules();
  }
}

function renderRules() {
  document.getElementById('ruleList').innerHTML = autoKillRules.map((r, i) => `
    <li>Kill if > ${r.cpu}% for ${r.sec}s 
    <button onclick="autoKillRules.splice(${i},1);renderRules()">✕</button></li>
  `).join('');
}

function evaluateAutoKill(p) {
  if (isReadOnly) return;
  autoKillRules.forEach(rule => {
    if (p.pcpu > rule.cpu) {
      if (!rule.triggeredTs[p.pid]) rule.triggeredTs[p.pid] = Date.now();
      else if ((Date.now() - rule.triggeredTs[p.pid]) > rule.sec * 1000) {
        killProcess(p.pid);
        triggerAlert(`Auto-killed ${p.name}`, 'warning');
        delete rule.triggeredTs[p.pid];
      }
    } else {
      delete rule.triggeredTs[p.pid];
    }
  });
}

function initDraggable() {
  const cards = document.querySelectorAll('.dashboard-card[draggable="true"]');
  const grid = document.querySelector('.dashboard-grid');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = document.querySelector('.dragging');
    if (!dragging) return;
    const siblings = [...grid.querySelectorAll('.dashboard-card:not(.dragging)')];
    let nextSibling = siblings.find(sibling => {
      const rect = sibling.getBoundingClientRect();
      const offset = e.clientY - rect.top - rect.height / 2;
      return offset < 0; 
    });
    if (nextSibling) grid.insertBefore(dragging, nextSibling);
    else grid.appendChild(dragging);
  });
}

async function fetchServices() {
  try {
    const res = await fetch('/services', { headers: { 'x-pulse-token': authToken || '' } });
    if (!res.ok) return;
    const list = await res.json();
    document.getElementById('serviceCount').textContent = list.length;
    document.getElementById('servicesList').innerHTML = list.map(s => `
      <tr>
        <td>${s.name.substring(0, 20)}</td>
        <td><span class="status-tag ${s.running ? 'online' : 'stopped'}">${s.running ? 'Running' : 'Stopped'}</span></td>
        <td>—</td>
      </tr>
    `).join('');
  } catch (e) {}
}

// ─── Logo Pulse Animation (on data receive) ───────────────────────────────────

function animateLogo() {
  const logo = document.getElementById('logoIcon');
  logo.classList.remove('pulse-anim');
  void logo.offsetWidth; // reflow
  logo.classList.add('pulse-anim');
}

// ─── Alert System ─────────────────────────────────────────────────────────────

let alertQueue = [];
let alertShowing = false;

function triggerAlert(message, level = 'warning') {
  alertQueue.push({ message, level });
  if (!alertShowing) showNextAlert();

  // Browser notification
  if (level === 'danger' && Notification.permission === 'granted') {
    new Notification('PulseMonitor Alert', { body: message, icon: '' });
  }
}

function showNextAlert() {
  if (!alertQueue.length) { alertShowing = false; return; }
  alertShowing = true;
  const { message, level } = alertQueue.shift();
  const alertBox = document.getElementById('alertBox');
  alertBox.textContent = message;
  alertBox.className = `alert-box alert-${level} visible`;
  setTimeout(() => {
    alertBox.className = 'alert-box';
    setTimeout(showNextAlert, 400);
  }, 4000);
}

// Request notification permission
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ─── Temperature Display ──────────────────────────────────────────────────────

function updateTempDisplay(temp) {
  const el = document.getElementById('cpuTempDisplay');
  const badge = document.getElementById('cpuTempBadge');

  if (temp === null || temp === undefined) {
    el.textContent = 'N/A';
    badge.style.display = 'none';
    return;
  }

  el.textContent = `${temp}°C`;
  badge.style.display = '';
  badge.textContent = `${temp}°C`;

  el.className = 'value temp-val';
  badge.className = 'temp-badge';

  if (temp >= 80) {
    el.classList.add('temp-hot');
    badge.style.background = 'rgba(255,61,113,0.1)';
    badge.style.color = 'var(--accent-red)';
    badge.style.borderColor = 'rgba(255,61,113,0.3)';
  } else if (temp >= 60) {
    el.classList.add('temp-warm');
    badge.style.background = 'rgba(255,184,0,0.1)';
    badge.style.color = 'var(--accent-gold)';
    badge.style.borderColor = 'rgba(255,184,0,0.3)';
  } else {
    el.classList.add('temp-cool');
  }
}

// ─── Battery Display ──────────────────────────────────────────────────────────

function updateBattery(bat) {
  const bar = document.getElementById('batteryBar');
  const disp = document.getElementById('batteryDisplay');

  if (!bat || !bat.hasBattery) { bar.style.display = 'none'; return; }

  bar.style.display = '';
  const icon = bat.isCharging ? '⚡' : (bat.percent < 20 ? '🪫' : '🔋');
  const time = bat.timeRemaining > 0 ? ` (${Math.round(bat.timeRemaining / 60)}h ${bat.timeRemaining % 60}m)` : '';
  disp.textContent = `${icon} ${bat.percent}%${time}`;

  if (bat.percent < 15 && !bat.isCharging) {
    triggerAlert(`Battery Critical: ${bat.percent}%`, 'danger');
  }
}

// ─── GPU Display ──────────────────────────────────────────────────────────────

function updateGPU(gpus) {
  if (!gpus || gpus.length === 0) return;

  const card = document.getElementById('gpuCard');
  const gpu = gpus[0];

  // Only show card if we have meaningful data
  const hasData = gpu.utilizationGpu !== null || gpu.temperatureGpu !== null;
  if (!hasData) { card.style.display = 'none'; return; }

  card.style.display = '';
  const usagePct = gpu.utilizationGpu ?? 0;
  document.getElementById('gpuUsage').textContent = `${usagePct}%`;
  document.getElementById('gpuBar').style.width = `${usagePct}%`;

  const details = document.getElementById('gpuDetails');
  details.innerHTML = `
    <div class="gpu-stat-row"><span class="g-label">Model</span><span class="g-val">${gpu.model || 'Unknown'}</span></div>
    ${gpu.temperatureGpu !== null ? `<div class="gpu-stat-row"><span class="g-label">Temperature</span><span class="g-val">${gpu.temperatureGpu}°C</span></div>` : ''}
    ${gpu.memoryUsed !== null ? `<div class="gpu-stat-row"><span class="g-label">VRAM Used</span><span class="g-val">${gpu.memoryUsed} / ${gpu.memoryTotal} MB</span></div>` : ''}
  `;
}

// ─── CPU Core Breakdown ───────────────────────────────────────────────────────

function updateCores(cores) {
  if (!cores || cores.length === 0) return;
  const container = document.getElementById('coresBars');
  
  // Build or update
  if (container.children.length !== cores.length) {
    container.innerHTML = cores.map((c, i) => `
      <div class="core-bar-wrap">
        <div class="core-bar-label">C${i}</div>
        <div class="core-bar-track">
          <div class="core-bar-fill" id="core-${i}" style="height:0%"></div>
        </div>
        <div class="core-bar-pct" id="core-pct-${i}">0%</div>
      </div>
    `).join('');
  }

  cores.forEach((c, i) => {
    const fill = document.getElementById(`core-${i}`);
    const pct = document.getElementById(`core-pct-${i}`);
    if (fill) fill.style.height = `${c.load}%`;
    if (pct) pct.textContent = `${c.load}%`;
  });
}

// ─── Network Connections ──────────────────────────────────────────────────────

function updateConnections(list) {
  document.getElementById('connCount').textContent = list.length;
  const tbody = document.getElementById('connectionsList');
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${c.protocol?.toUpperCase() || '?'}</td>
      <td>${c.localPort}</td>
      <td>${c.peerAddress ? `${c.peerAddress}:${c.peerPort}` : '—'}</td>
      <td><span class="conn-state-${c.state}">${c.state}</span></td>
    </tr>
  `).join('');
}

// ─── Timeline Zoom ────────────────────────────────────────────────────────────

function setZoom(minutes) {
  currentZoom = minutes;

  document.querySelectorAll('.zoom-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.zoom) === minutes);
  });

  // Fetch historical data to backfill charts
  fetchHistory(minutes);
}

async function fetchHistory(minutes) {
  try {
    const headers = authToken ? { 'x-pulse-token': authToken } : {};
    const res = await fetch(`/history?minutes=${minutes}`, { headers });
    const data = await res.json();

    // Reset and backfill CPU + Net charts
    charts.cpu.data.labels = [];
    charts.cpu.data.datasets[0].data = [];
    charts.net.data.labels = [];
    charts.net.data.datasets[0].data = [];

    const maxPts = MAX_CHART_POINTS[minutes] || 60;
    const slice = data.slice(-maxPts);

    slice.forEach(m => {
      charts.cpu.data.labels.push('');
      charts.cpu.data.datasets[0].data.push(m.cpu ?? 0);
      charts.net.data.labels.push('');
      charts.net.data.datasets[0].data.push((m.rx ?? 0) / 1024);
    });

    charts.cpu.update('none');
    charts.net.update('none');
  } catch (e) {}
}

// ─── Export ──────────────────────────────────────────────────────────────────

function showExportMenu() {
  const menu = document.getElementById('exportMenu');
  if (menu.classList.contains('hidden')) {
    const btn = document.querySelector('.icon-btn');
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 8) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.classList.remove('hidden');
    setTimeout(() => document.addEventListener('click', closeExportMenu, { once: true }), 10);
  } else {
    menu.classList.add('hidden');
  }
}

function closeExportMenu() {
  document.getElementById('exportMenu').classList.add('hidden');
}

function exportData(format, minutes) {
  closeExportMenu();
  const tokenParam = authToken ? `&token=${authToken}` : '';
  window.location.href = `/export/${format}?minutes=${minutes}${tokenParam}`;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await res.json();
    if (data.success) {
      // No password set
      hideAuthModal();
      return;
    }
  } catch (e) {}

  if (authToken) {
    // Validate stored token
    const res = await fetch('/system', { headers: { 'x-pulse-token': authToken } });
    if (res.ok) { hideAuthModal(); return; }
    authToken = null;
    localStorage.removeItem('pulseToken');
  }

  document.getElementById('authModal').classList.remove('hidden');
}

async function submitAuth(readOnlyMode = false) {
  const input = document.getElementById('authInput').value;
  const payload = readOnlyMode ? { password: '', readOnly: true } : { password: input };

  try {
    const res = await fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      authToken = data.token || null;
      isReadOnly = data.readOnly;
      localStorage.setItem('pulseToken', authToken || '');
      localStorage.setItem('pulseReadOnly', isReadOnly);
      hideAuthModal();
      if (isReadOnly) {
        document.getElementById('readOnlyBadge').style.display = '';
        triggerAlert('Viewing in Read-Only mode', 'warning');
      }
      
      // Re-initialize socket with token
      if (socket) socket.disconnect();
      initSocket();
      
    } else {
      document.getElementById('authError').textContent = 'Invalid password. Try again.';
    }
  } catch (e) {
    document.getElementById('authError').textContent = 'Server unreachable.';
  }
}

function hideAuthModal() {
  document.getElementById('authModal').classList.add('hidden');
}

// ─── Process Actions ──────────────────────────────────────────────────────────

function getAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['x-pulse-token'] = authToken;
  return h;
}

async function killProcess(pid) {
  if (isReadOnly) return triggerAlert('Read-only mode: cannot terminate processes', 'warning');
  if (!confirm(`Terminate PID ${pid}?`)) return;
  try {
    const res = await fetch('/kill', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ pid }) });
    const data = await res.json();
    if (data.success) triggerAlert(`PID ${pid} terminated`, 'success');
    else triggerAlert(`Error: ${data.error}`, 'danger');
  } catch (e) { triggerAlert('Action failed: Server unreachable', 'danger'); }
}

async function suspendProcess(pid) {
  if (isReadOnly) return triggerAlert('Read-only mode', 'warning');
  try {
    const res = await fetch('/suspend', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ pid }) });
    const data = await res.json();
    if (data.success) triggerAlert(`PID ${pid} suspended`, 'warning');
    else triggerAlert(`Error: ${data.error}`, 'danger');
  } catch (e) { triggerAlert('Action failed', 'danger'); }
}

async function resumeProcess(pid) {
  if (isReadOnly) return triggerAlert('Read-only mode', 'warning');
  try {
    const res = await fetch('/resume', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ pid }) });
    const data = await res.json();
    if (data.success) triggerAlert(`PID ${pid} resumed`, 'success');
    else triggerAlert(`Error: ${data.error}`, 'danger');
  } catch (e) { triggerAlert('Action failed', 'danger'); }
}

async function batchKill() {
  if (isReadOnly) return triggerAlert('Read-only mode', 'warning');
  const pids = Array.from(selectedPids);
  if (!pids.length) return;
  if (!confirm(`Terminate ${pids.length} selected processes?`)) return;
  try {
    const res = await fetch('/kill-batch', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ pids }) });
    const data = await res.json();
    if (data.success) {
      const ok = data.results.filter(r => r.success).length;
      triggerAlert(`Terminated ${ok}/${pids.length} processes`, 'success');
      selectedPids.clear();
      updateBatchBtn();
    }
  } catch (e) { triggerAlert('Batch kill failed', 'danger'); }
}

function toggleSelectAll(checkbox) {
  const visible = Array.from(document.querySelectorAll('#processTable .proc-select'));
  visible.forEach(cb => {
    cb.checked = checkbox.checked;
    const pid = parseInt(cb.dataset.pid);
    checkbox.checked ? selectedPids.add(pid) : selectedPids.delete(pid);
  });
  updateBatchBtn();
}

function togglePidSelect(checkbox, pid) {
  checkbox.checked ? selectedPids.add(pid) : selectedPids.delete(pid);
  updateBatchBtn();
}

function updateBatchBtn() {
  const btn = document.getElementById('batchKillBtn');
  if (selectedPids.size > 0) {
    btn.style.display = '';
    btn.textContent = `Kill Selected (${selectedPids.size})`;
  } else {
    btn.style.display = 'none';
  }
}

// ─── Process Detail Modal ─────────────────────────────────────────────────────

function showProcessDetail(proc) {
  const content = document.getElementById('processModalContent');

  // Safe helper - creates text nodes to prevent XSS
  function safe(val) {
    return String(val ?? '\u2014');
  }

  const uptime = proc.started ? `Started: ${safe(proc.started)}` : 'N/A';

  // Build grid safely
  const fields = [
    ['Process Name', proc.name],
    ['PID', proc.pid],
    ['Parent PID', proc.ppid],
    ['User', proc.user],
    ['CPU Usage', `${proc.pcpu}%`],
    ['Memory Usage', `${proc.pmem}%`],
    ['State', proc.state],
    ['Started', uptime]
  ];

  content.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'process-detail-grid';

  fields.forEach(([label, val]) => {
    const item = document.createElement('div');
    item.className = 'detail-item';
    const lbl = document.createElement('div');
    lbl.className = 'd-label';
    lbl.textContent = label;
    const v = document.createElement('div');
    v.className = 'd-value';
    v.textContent = safe(val);
    if (label === 'CPU Usage') v.style.color = 'var(--accent-blue)';
    if (label === 'Memory Usage') v.style.color = 'var(--accent-purple)';
    item.appendChild(lbl);
    item.appendChild(v);
    grid.appendChild(item);
  });

  // Command row
  const cmdItem = document.createElement('div');
  cmdItem.className = 'detail-item detail-cmd';
  cmdItem.innerHTML = '<div class="d-label">Command</div>';
  const cmdVal = document.createElement('div');
  cmdVal.className = 'd-value';
  cmdVal.textContent = safe(proc.command || proc.name);
  cmdItem.appendChild(cmdVal);
  grid.appendChild(cmdItem);

  content.appendChild(grid);

  if (!isReadOnly) {
    const actions = document.createElement('div');
    actions.className = 'process-modal-actions';
    actions.innerHTML = `
      <button class="kill-btn" onclick="killProcess(${proc.pid}); closeModal('processModal')">Terminate</button>
      <button class="proc-btn" onclick="suspendProcess(${proc.pid}); closeModal('processModal')">Suspend</button>
      <button class="proc-btn" onclick="resumeProcess(${proc.pid}); closeModal('processModal')">Resume</button>
    `;
    content.appendChild(actions);
  }

  document.getElementById('processModal').classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showProcessDetailById(btn) {
  const pid = parseInt(btn.getAttribute('data-proc-pid'));
  const proc = processData.find(p => p.pid === pid);
  if (proc) showProcessDetail(proc);
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ─── Process Rendering ────────────────────────────────────────────────────────

function renderProcesses() {
  const search = document.getElementById('search').value.toLowerCase();
  const sort = document.getElementById('sort').value;
  const tbody = document.getElementById('processTable');

  let filtered = processData.filter(p => p.name.toLowerCase().includes(search));
  filtered.sort((a, b) => sort === 'cpu' ? b.pcpu - a.pcpu : b.pmem - a.pmem);

  filtered.forEach(p => {
    // History
    let hist = processHistory.get(p.pid) || [];
    hist.push(p.pcpu);
    if (hist.length > 30) hist.shift();
    processHistory.set(p.pid, hist);

    // Baseline Anomaly
    if (!processBaselines.has(p.pid)) processBaselines.set(p.pid, { count: 0, sum: 0, avg: p.pcpu });
    const base = processBaselines.get(p.pid);
    if (base.count < 60) { base.sum += p.pcpu; base.count++; base.avg = base.sum / base.count; }
    p.anomaly = (base.count > 10 && p.pcpu > base.avg * 3 && p.pcpu > 20);

    evaluateAutoKill(p);
  });

  tbody.innerHTML = filtered.map(p => `
    <tr class="row-entering">
      <td><input type="checkbox" class="proc-select" data-pid="${p.pid}" ${selectedPids.has(p.pid) ? 'checked' : ''} onchange="togglePidSelect(this, ${p.pid})"></td>
      <td><span class="badge">${p.pid}</span></td>
      <td class="app-name">${p.name} ${p.anomaly ? '<span class="anomaly-tag">⚠ Anomaly</span>' : ''}</td>
      <td class="cpu-pct">${p.pcpu}%</td>
      <td><canvas id="spark-${p.pid}" width="60" height="20"></canvas></td>
      <td class="mem-pct">${p.pmem}%</td>
      <td><span class="status-tag ${p.state?.toLowerCase() || 'unknown'}">${p.state || '—'}</span></td>
      <td>
        <div class="proc-controls">
          <button class="proc-btn info-btn" data-proc-pid="${p.pid}" onclick="showProcessDetailById(this)">Info</button>
          ${!isReadOnly ? `<button class="kill-btn" onclick="killProcess(${p.pid})">Kill</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  document.getElementById('procCount').textContent = `${filtered.length} Processes`;

  setTimeout(() => {
    filtered.forEach(p => drawSparkline(`spark-${p.pid}`, processHistory.get(p.pid)));
  }, 10);
}

// ─── Core Static Fetch ────────────────────────────────────────────────────────

async function fetchSystemStatic() {
  try {
    const headers = authToken ? { 'x-pulse-token': authToken } : {};
    const res = await fetch('/system', { headers });
    const data = await res.json();
    document.getElementById('osBadge').textContent = `${data.distro} ${data.release}`;
    document.getElementById('cpuModel').textContent = `${data.cpuModel} (${data.cores} threads)`;
  } catch (e) {
    console.error('Static fetch failed');
  }
}

// ─── WebSocket Integration ───────────────────────────────────────────────────

function initSocket() {
  socket = io(window.location.origin);
  const connStatus = document.getElementById('connStatus');

  socket.on('connect', () => {
    connStatus.textContent = 'Live Core Connected';
    connStatus.className = 'status-pill connected';
  });

  socket.on('disconnect', () => {
    connStatus.textContent = 'Disconnected — Retrying...';
    connStatus.className = 'status-pill disconnected';
  });

  socket.on('pulse', (data) => {
    animateLogo();

    // CPU
    document.getElementById('cpuValue').textContent = `${data.cpu.usage}%`;
    document.getElementById('cpuBar').style.width = `${data.cpu.usage}%`;
    const loadAvg = Array.isArray(data.cpu.loadAvg) ? data.cpu.loadAvg.join(' , ') : '0 , 0 , 0';
    document.getElementById('loadAvg').textContent = loadAvg;
    updateLineChart(charts.cpu, data.cpu.usage);
    updateCores(data.cpu.cores);
    updateTempDisplay(data.cpu.temperature);

    // Memory
    document.getElementById('memPercent').textContent = `${data.mem.usedPercent}%`;
    document.getElementById('memUsed').textContent = formatBytes(data.mem.used);
    document.getElementById('memTotal').textContent = formatBytes(data.mem.total);
    document.getElementById('memFree').textContent = formatBytes(data.mem.free);
    document.getElementById('memBar').style.width = `${data.mem.usedPercent}%`;
    charts.mem.data.datasets[0].data = [data.mem.usedPercent, 100 - data.mem.usedPercent];
    charts.mem.update('none');

    // Disk
    document.getElementById('diskPercent').textContent = `${data.disk.usedPercent}%`;
    document.getElementById('diskUsed').textContent = formatBytes(data.disk.used);
    if (data.disk.rIO_sec !== undefined) {
      document.getElementById('diskRead').textContent = `${(data.disk.rIO_sec / 1024).toFixed(1)} KB/s`;
      document.getElementById('diskWrite').textContent = `${(data.disk.wIO_sec / 1024).toFixed(1)} KB/s`;
    }
    charts.disk.data.datasets[0].data = [data.disk.usedPercent, 100 - data.disk.usedPercent];
    charts.disk.update('none');

    // Network
    const rxKB = (data.net.rx_sec / 1024).toFixed(1);
    const txKB = (data.net.tx_sec / 1024).toFixed(1);
    document.getElementById('netDown').textContent = `${rxKB} KB/s`;
    document.getElementById('netUp').textContent = `${txKB} KB/s`;
    updateLineChart(charts.net, data.net.rx_sec / 1024);

    // GPU
    updateGPU(data.gpu);

    // Battery
    updateBattery(data.battery);

    // Docker
    const dCard = document.getElementById('dockerCard');
    if (data.docker && data.docker.length > 0) {
      dCard.style.display = '';
      document.getElementById('dockerCount').textContent = data.docker.length;
      document.getElementById('dockerList').innerHTML = data.docker.map(d => `
        <tr><td>${d.name}</td><td>${d.image}</td><td><span class="status-tag ${d.state === 'running' ? 'online' : 'offline'}">${d.state}</span></td></tr>
      `).join('');
    } else {
      dCard.style.display = 'none';
    }

    // Misc
    document.getElementById('uptimeDisplay').textContent = `Uptime: ${formatUptime(data.uptime)}`;
    document.getElementById('lastUpdated').textContent = `Sync: ${new Date().toLocaleTimeString()}`;

    // Health Score & Ambient Glow
    const score = calculateHealth(data.cpu.usage, data.mem.usedPercent, data.cpu.temperature);
    const hBadge = document.getElementById('healthScoreBadge');
    if (hBadge) {
      hBadge.textContent = score;
      hBadge.className = `score-badge ${score > 80 ? 'health-good' : (score > 50 ? 'health-warn' : 'health-bad')}`;
    }
    document.querySelector('.cpu-card').style.boxShadow = `0 0 20px ${data.cpu.usage > 85 ? 'rgba(255,61,113,0.3)' : 'transparent'}`;
    document.querySelector('.memory-card').style.boxShadow = `0 0 20px ${data.mem.usedPercent > 85 ? 'rgba(255,61,113,0.3)' : 'transparent'}`;

    // Contextual Alerts
    if (data.cpu.usage > 90) triggerAlert(`Critical CPU Load: ${data.cpu.usage}%`, 'danger');
    if (data.mem.usedPercent > 95) triggerAlert(`Critical Memory Usage: ${data.mem.usedPercent}%`, 'danger');
    if (data.cpu.temperature && data.cpu.temperature > 90) triggerAlert(`CPU Temperature Critical: ${data.cpu.temperature}°C`, 'danger');
  });

  socket.on('processes', (data) => {
    processData = data;
    renderProcesses();
  });

  socket.on('connections', (data) => {
    updateConnections(data);
  });
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
    document.getElementById('exportMenu').classList.add('hidden');
  }
  if (e.key === '/' && !e.ctrlKey) {
    e.preventDefault();
    document.getElementById('search').focus();
  }
});

// ─── Initialization ──────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initCharts();
  initDraggable();

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // Zoom buttons
  document.querySelectorAll('.zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => setZoom(parseInt(btn.dataset.zoom)));
  });

  // Enter key on auth input
  document.getElementById('authInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuth();
  });

  // Request notifications permission
  requestNotificationPermission();

  // Auth check first, then init
  await checkAuth();
  await fetchSystemStatic();
  initSocket();
  
  // Occasional services sync
  fetchServices();
  setInterval(fetchServices, 30000);
});