const express = require('express');
const cors = require('cors');
const si = require('systeminformation');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 4000;

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  password: process.env.PULSE_PASSWORD || null, // Set env var to enable auth
  logFile: path.join(__dirname, 'pulse-incidents.json')
};
const isWin = process.platform === 'win32';

// ─── Incident Log ────────────────────────────────────────────────────────────
function logIncident(type, data) {
  let logs = [];
  try {
    if (fs.existsSync(CONFIG.logFile)) {
      logs = JSON.parse(fs.readFileSync(CONFIG.logFile, 'utf8'));
    }
  } catch (e) {}
  logs.push({ timestamp: new Date().toISOString(), type, ...data });
  if (logs.length > 500) logs = logs.slice(-500);
  try { fs.writeFileSync(CONFIG.logFile, JSON.stringify(logs, null, 2)); } catch (e) {}
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!CONFIG.password) return next();
  const token = req.headers['x-pulse-token'] || req.query.token;
  if (token === CONFIG.password) return next();
  // Allow read-only public access if no token matched for non-mutating routes?
  // Our mutating routes use readOnlyCheck which we rename mutatorCheck
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

function mutatorCheck(req, res, next) {
  if (!CONFIG.password) return next();
  const token = req.headers['x-pulse-token'] || req.query.token;
  if (token !== CONFIG.password) {
    return res.status(403).json({ success: false, error: 'Read-only mode. Password required to mutate state.' });
  }
  next();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── Stats Collection ────────────────────────────────────────────────────────
async function getStats() {
  try {
    const [cpuLoad, mem, disk, net, time, cpuTemp, graphics, battery, docker, disksIO] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.time(),
      si.cpuTemperature().catch(() => ({ main: null, cores: [] })),
      si.graphics().catch(() => ({ controllers: [] })),
      si.battery().catch(() => null),
      si.dockerContainers().catch(() => []),
      si.disksIO().catch(() => ({ rIO: 0, wIO: 0, rIO_sec: 0, wIO_sec: 0 }))
    ]);

    const activeNet = net.find(s => s.operstate === 'up') || net[0] || {};
    const mainDisk = disk[0] || { use: 0, size: 0, used: 0 };

    // CPU cores
    const cores = (cpuLoad.cpus || []).map((c, i) => ({
      core: i,
      load: Math.round(c.load)
    }));

    // GPU info
    const gpus = (graphics.controllers || []).map(g => ({
      model: g.model || 'Unknown GPU',
      utilizationGpu: g.utilizationGpu || null,
      temperatureGpu: g.temperatureGpu || null,
      memoryUsed: g.memoryUsed || null,
      memoryTotal: g.memoryTotal || null,
      vendor: g.vendor || ''
    }));

    // Battery
    const bat = battery ? {
      hasBattery: battery.hasBattery,
      percent: battery.percent,
      isCharging: battery.isCharging,
      timeRemaining: battery.timeRemaining,
      acConnected: battery.acConnected,
      type: battery.type
    } : null;

    return {
      cpu: {
        usage: Math.round(cpuLoad.currentLoad),
        loadAvg: Array.isArray(cpuLoad.avgLoad)
          ? cpuLoad.avgLoad.map(v => Math.round(v * 100) / 100)
          : typeof cpuLoad.avgLoad === 'number'
            ? [Math.round(cpuLoad.avgLoad * 100) / 100, Math.round(cpuLoad.avgLoad * 100) / 100, Math.round(cpuLoad.avgLoad * 100) / 100]
            : [0, 0, 0],
        cores,
        temperature: cpuTemp.main || null,
        coreTemps: cpuTemp.cores || []
      },
      mem: {
        used: mem.used,
        total: mem.total,
        free: mem.free,
        usedPercent: Math.round((mem.used / mem.total) * 100)
      },
      disk: {
        used: mainDisk.used,
        total: mainDisk.size,
        usedPercent: Math.round(mainDisk.use),
        rIO_sec: disksIO?.rIO_sec || 0,
        wIO_sec: disksIO?.wIO_sec || 0
      },
      net: {
        rx_sec: Math.round(activeNet.rx_sec || 0),
        tx_sec: Math.round(activeNet.tx_sec || 0),
        iface: activeNet.iface || ''
      },
      gpu: gpus,
      battery: bat,
      docker: docker,
      uptime: time.uptime
    };
  } catch (err) {
    console.error('Error gathering stats:', err);
    return null;
  }
}

// ─── Metrics History (in-memory ring buffer) ─────────────────────────────────
const HISTORY_MAX = 3600; // 1 hour at 1s intervals
const metricsHistory = [];

// ─── Broadcast Loop ──────────────────────────────────────────────────────────
setInterval(async () => {
  const stats = await getStats();
  if (stats) {
    // Artificial Load Average for Windows (using our own history buffer)
    if (isWin && stats.cpu.loadAvg[0] === 0) {
      const now = Date.now();
      const getAvg = (minutes) => {
        const span = minutes * 60 * 1000;
        const subset = metricsHistory.filter(m => now - m.ts <= span);
        if (subset.length === 0) return (stats.cpu.usage / 100).toFixed(2);
        const sum = subset.reduce((acc, m) => acc + (m.cpu.usage || 0), 0);
        return ((sum / subset.length) / 100).toFixed(2); // format as standard load value
      };
      
      stats.cpu.loadAvg = [getAvg(1), getAvg(5), getAvg(15)];
    }

    // Store in history
    metricsHistory.push({ ts: Date.now(), cpu: { usage: stats.cpu.usage }, mem: { usedPercent: stats.mem.usedPercent }, net: stats.net });
    if (metricsHistory.length > HISTORY_MAX) metricsHistory.shift();
    
    io.emit('pulse', stats);
  }
}, 1000);

// Processes every 2s
setInterval(async () => {
  try {
    const procs = await si.processes();
    const list = procs.list
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 100)
      .map(p => ({
        pid: p.pid,
        ppid: p.parentPid,
        name: p.name,
        command: p.command || p.name,
        user: p.user || 'system',
        pcpu: Math.round(p.cpu * 10) / 10,
        pmem: Math.round(p.mem * 10) / 10,
        state: p.state,
        started: p.started || null
      }));
    io.emit('processes', list);
  } catch (err) {
    console.error('Error gathering processes:', err);
  }
}, 2000);

// Network connections every 5s
setInterval(async () => {
  try {
    const conns = await si.networkConnections();
    const list = conns
      .filter(c => c.state === 'ESTABLISHED' || c.state === 'LISTEN')
      .slice(0, 50)
      .map(c => ({
        localAddress: c.localAddress,
        localPort: c.localPort,
        peerAddress: c.peerAddress,
        peerPort: c.peerPort,
        state: c.state,
        protocol: c.protocol,
        pid: c.pid,
        process: c.process
      }));
    io.emit('connections', list);
  } catch (err) {
    console.error('Error gathering connections:', err);
  }
}, 5000);

// ─── HTTP Endpoints ───────────────────────────────────────────────────────────

app.get('/system', async (req, res) => {
  const [os, cpu] = await Promise.all([si.osInfo(), si.cpu()]);
  res.json({
    platform: os.platform,
    distro: os.distro,
    release: os.release,
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`,
    cores: cpu.cores,
    physicalCores: cpu.physicalCores,
    uptime: si.time().uptime,
    isAuthEnabled: !!CONFIG.password
  });
});

let webhooks = [];
app.post('/webhook/config', (req, res) => {
  webhooks = req.body.urls || [];
  res.json({ success: true });
});

// Services list — no auth required (read-only data)
app.get('/services', async (req, res) => {
  try {
    // On Windows, si.services requires specific names; use common ones
    const commonServices = isWin
      ? 'wuauserv,spooler,Themes,AudioSrv,BITS,WSearch,Schedule'
      : '*';
    const services = await Promise.race([
      si.services(commonServices),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    res.json(Array.isArray(services) ? services.slice(0, 50) : []);
  } catch (e) {
    res.json([]);
  }
});

// Kill process
app.post('/kill', mutatorCheck, async (req, res) => {
  const { pid } = req.body;
  if (pid === undefined || pid === null || isNaN(parseInt(pid))) return res.status(400).json({ success: false, error: 'Invalid PID' });
  try {
    const procs = await si.processes();
    const proc = procs.list.find(p => p.pid === parseInt(pid));
    process.kill(parseInt(pid));
    logIncident('KILL', {
      pid, processName: proc?.name || 'unknown',
      killedBy: req.headers['x-forwarded-for'] || req.ip
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Change process priority (Nice value)
app.post('/renice', mutatorCheck, async (req, res) => {
  const { pid, priority } = req.body;
  if (pid === undefined || pid === null || isNaN(parseInt(pid))) return res.status(400).json({ success: false, error: 'Invalid PID' });
  try {
    const { execSync } = require('child_process');
    if (isWin) {
      // Very basic windows priority mapping example via wmic (priority val 32=normal, 64=idle, 128=high)
      execSync(`wmic process where processid="${pid}" call setpriority ${priority > 0 ? 64 : (priority < 0 ? 128 : 32)}`);
    } else {
      execSync(`renice -n ${priority || 0} -p ${pid}`);
    }
    logIncident('RENICE', { pid, priority });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Suspend process
app.post('/suspend', mutatorCheck, async (req, res) => {
  const { pid } = req.body;
  if (pid === undefined || pid === null || isNaN(parseInt(pid))) return res.status(400).json({ success: false, error: 'Invalid PID' });
  try {
    if (isWin) {
      require('child_process').execSync(`powershell -command "Suspend-Process -Id ${pid}"`);
    } else {
      process.kill(parseInt(pid), 'SIGSTOP');
    }
    logIncident('SUSPEND', { pid });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resume process
app.post('/resume', mutatorCheck, async (req, res) => {
  const { pid } = req.body;
  if (pid === undefined || pid === null || isNaN(parseInt(pid))) return res.status(400).json({ success: false, error: 'Invalid PID' });
  try {
    if (isWin) {
      require('child_process').execSync(`powershell -command "Resume-Process -Id ${pid}"`);
    } else {
      process.kill(parseInt(pid), 'SIGCONT');
    }
    logIncident('RESUME', { pid });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Batch kill
app.post('/kill-batch', mutatorCheck, async (req, res) => {
  const { pids } = req.body;
  if (!pids || !Array.isArray(pids)) return res.status(400).json({ success: false, error: 'PIDs array required' });
  const results = [];
  for (const pid of pids) {
    try {
      if (pid === undefined || pid === null || isNaN(parseInt(pid))) throw new Error('Invalid PID');
      process.kill(parseInt(pid));
      logIncident('BATCH_KILL', { pid });
      results.push({ pid, success: true });
    } catch (e) {
      results.push({ pid, success: false, error: e.message });
    }
  }
  res.json({ success: true, results });
});

// Historical metrics
app.get('/history', authMiddleware, (req, res) => {
  const minutes = parseInt(req.query.minutes) || 5;
  const since = Date.now() - minutes * 60 * 1000;
  const data = metricsHistory.filter(m => m.ts >= since).map(m => ({
    ts: m.ts,
    cpu: m.cpu?.usage,
    mem: m.mem?.usedPercent,
    rx: m.net?.rx_sec,
    tx: m.net?.tx_sec
  }));
  res.json(data);
});

// Export metrics
app.get('/export/:format', authMiddleware, (req, res) => {
  const { format } = req.params;
  const minutes = parseInt(req.query.minutes) || 60;
  const since = Date.now() - minutes * 60 * 1000;
  const data = metricsHistory.filter(m => m.ts >= since);

  if (format === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-metrics.json"');
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(data, null, 2));
  }
  if (format === 'csv') {
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-metrics.csv"');
    res.setHeader('Content-Type', 'text/csv');
    const rows = ['timestamp,cpu_usage,mem_percent,net_rx_sec,net_tx_sec'];
    data.forEach(m => {
      rows.push(`${new Date(m.ts).toISOString()},${m.cpu?.usage ?? ''},${m.mem?.usedPercent ?? ''},${m.net?.rx_sec ?? ''},${m.net?.tx_sec ?? ''}`);
    });
    return res.send(rows.join('\n'));
  }
  res.status(400).json({ error: 'Format must be json or csv' });
});

// Incident log
app.get('/incidents', mutatorCheck, (req, res) => {
  try {
    if (fs.existsSync(CONFIG.logFile)) {
      return res.json(JSON.parse(fs.readFileSync(CONFIG.logFile, 'utf8')));
    }
    res.json([]);
  } catch (e) {
    res.json([]);
  }
});

// Auth check
app.post('/auth', (req, res) => {
  if (!CONFIG.password) return res.json({ success: true, readOnly: false });
  const { password, readOnly } = req.body;
  if (readOnly) return res.json({ success: true, readOnly: true, token: null });
  if (password === CONFIG.password) return res.json({ success: true, readOnly: false, token: CONFIG.password });
  res.status(401).json({ success: false, error: 'Wrong password' });
});

server.listen(PORT, () => {
  console.log(`PulseMonitor running on http://localhost:${PORT}`);
  console.log(`System monitoring loops initialized successfully.`);
  if (CONFIG.password) {
    console.log(`Password protection: ENABLED (Mutator)`);
  }
});