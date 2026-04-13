import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, loadavg, totalmem, freemem, uptime, hostname, platform, release } from 'node:os';

const run = promisify(exec);

async function sh(cmd: string): Promise<string> {
  const { stdout } = await run(cmd, { timeout: 5000 });
  return stdout;
}

export interface BatteryInfo {
  available: boolean;
  percent: number | null;
  charging: boolean | null;
  source: string | null;
  timeRemaining: string | null;
  raw?: string;
}

export async function getBattery(): Promise<BatteryInfo> {
  if (platform() !== 'darwin') {
    return { available: false, percent: null, charging: null, source: null, timeRemaining: null };
  }
  const out = await sh('pmset -g batt');
  const sourceMatch = out.match(/Now drawing from '([^']+)'/);
  const source = sourceMatch ? sourceMatch[1] : null;

  // Line example: " -InternalBattery-0 (id=...)\t16%; charging; 2:40 remaining present: true"
  const battLine = out.split('\n').find((l) => /\d+%/.test(l));
  if (!battLine) {
    return { available: false, percent: null, charging: null, source, timeRemaining: null, raw: out };
  }
  const pct = battLine.match(/(\d+)%/);
  const stateMatch = battLine.match(/%;\s*([a-zA-Z ]+?);/);
  const timeMatch = battLine.match(/(\d+:\d+)\s+remaining/);
  const state = stateMatch ? stateMatch[1].trim().toLowerCase() : null;
  const charging = state ? /charg/.test(state) || state === 'finishing charge' : null;

  return {
    available: true,
    percent: pct ? parseInt(pct[1], 10) : null,
    charging,
    source,
    timeRemaining: timeMatch ? timeMatch[1] : null,
  };
}

export interface CpuInfo {
  model: string;
  cores: number;
  loadAverages: { '1m': number; '5m': number; '15m': number };
  loadPerCore: { '1m': number; '5m': number; '15m': number };
  totalUsagePercent: number | null;
}

export async function getCpu(): Promise<CpuInfo> {
  const cpuList = cpus();
  const cores = cpuList.length;
  const [l1, l5, l15] = loadavg();

  let totalUsage: number | null = null;
  try {
    const out = await sh("ps -A -o %cpu");
    const sum = out
      .split('\n')
      .slice(1)
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !Number.isNaN(n))
      .reduce((a, b) => a + b, 0);
    totalUsage = Math.round((sum / cores) * 10) / 10;
  } catch {
    totalUsage = null;
  }

  return {
    model: cpuList[0]?.model ?? 'unknown',
    cores,
    loadAverages: { '1m': round2(l1), '5m': round2(l5), '15m': round2(l15) },
    loadPerCore: {
      '1m': round2(l1 / cores),
      '5m': round2(l5 / cores),
      '15m': round2(l15 / cores),
    },
    totalUsagePercent: totalUsage,
  };
}

export interface MemoryInfo {
  totalBytes: number;
  // The Activity Monitor "Memory Used" number = app + wired + compressed.
  // This is what humans mean by "used" — cached files are reclaimable on demand.
  usedBytes: number;
  usedPercent: number;
  availableBytes: number;
  appBytes: number | null;
  wiredBytes: number | null;
  compressedBytes: number | null;
  cachedFilesBytes: number | null; // reclaimable file-backed pages
  swapUsedBytes: number | null;
  // Source-of-truth pressure from the kernel (sysctl kern.memorystatus_vm_pressure_level).
  // 1=normal, 2=warning, 4=critical. Same signal Activity Monitor's green/yellow/red bar uses.
  pressure: 'normal' | 'warning' | 'critical' | 'unknown';
}

export async function getMemory(): Promise<MemoryInfo> {
  const total = totalmem();

  if (platform() !== 'darwin') {
    // Non-mac fallback: best-effort using node os module.
    const free = freemem();
    const used = total - free;
    return {
      totalBytes: total,
      usedBytes: used,
      usedPercent: round2((used / total) * 100),
      availableBytes: free,
      appBytes: null,
      wiredBytes: null,
      compressedBytes: null,
      cachedFilesBytes: null,
      swapUsedBytes: null,
      pressure: 'unknown',
    };
  }

  let appBytes: number | null = null;
  let wiredBytes: number | null = null;
  let compressedBytes: number | null = null;
  let cachedFilesBytes: number | null = null;
  let swapUsedBytes: number | null = null;

  try {
    const out = await sh('vm_stat');
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const grab = (label: string): number | null => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? parseInt(m[1], 10) * pageSize : null;
    };
    // "Anonymous pages" matches Activity Monitor's "App Memory" much better than "Pages active".
    appBytes = grab('Anonymous pages');
    wiredBytes = grab('Pages wired down');
    compressedBytes = grab('Pages occupied by compressor');
    cachedFilesBytes = grab('File-backed pages');
  } catch {
    // best-effort
  }

  try {
    // sysctl vm.swapusage: "total = 2048.00M  used = 736.50M  free = 1311.50M  (encrypted)"
    const out = await sh('sysctl -n vm.swapusage');
    const usedMatch = out.match(/used\s*=\s*([\d.]+)([KMG])/);
    if (usedMatch) {
      const n = parseFloat(usedMatch[1]);
      const unit = usedMatch[2];
      const mult = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : 1024;
      swapUsedBytes = Math.round(n * mult);
    }
  } catch {
    // best-effort
  }

  let pressure: MemoryInfo['pressure'] = 'unknown';
  try {
    const out = await sh('sysctl -n kern.memorystatus_vm_pressure_level');
    const lvl = parseInt(out.trim(), 10);
    if (lvl === 1) pressure = 'normal';
    else if (lvl === 2) pressure = 'warning';
    else if (lvl === 4) pressure = 'critical';
  } catch {
    // best-effort
  }

  const usedBytes =
    (appBytes ?? 0) + (wiredBytes ?? 0) + (compressedBytes ?? 0);
  const usedPercent = round2((usedBytes / total) * 100);
  const availableBytes = total - usedBytes;

  return {
    totalBytes: total,
    usedBytes,
    usedPercent,
    availableBytes,
    appBytes,
    wiredBytes,
    compressedBytes,
    cachedFilesBytes,
    swapUsedBytes,
    pressure,
  };
}

export interface DiskInfo {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export async function getDisk(mount: string = '/'): Promise<DiskInfo> {
  const out = await sh(`df -k ${shellQuote(mount)}`);
  const lines = out.trim().split('\n');
  const last = lines[lines.length - 1];
  const cols = last.split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity ... Mounted on
  const totalKb = parseInt(cols[1], 10);
  const usedKb = parseInt(cols[2], 10);
  const freeKb = parseInt(cols[3], 10);
  const totalBytes = totalKb * 1024;
  const usedBytes = usedKb * 1024;
  const freeBytes = freeKb * 1024;
  return {
    mount,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: round2((usedBytes / totalBytes) * 100),
  };
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  release: string;
  uptimeSeconds: number;
}

export function getSystem(): SystemInfo {
  return {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    uptimeSeconds: Math.round(uptime()),
  };
}

export interface HealthWarning {
  severity: 'warning' | 'critical';
  area: 'battery' | 'cpu' | 'memory' | 'disk';
  message: string;
}

export interface SystemHealth {
  status: 'ok' | 'warning' | 'critical';
  warnings: HealthWarning[];
  battery: BatteryInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  system: SystemInfo;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [battery, cpu, memory, disk] = await Promise.all([
    getBattery().catch(() => ({ available: false, percent: null, charging: null, source: null, timeRemaining: null }) as BatteryInfo),
    getCpu(),
    getMemory(),
    getDisk('/'),
  ]);
  const system = getSystem();
  const warnings: HealthWarning[] = [];

  if (battery.available && battery.percent != null) {
    if (battery.percent <= 10 && battery.charging === false) {
      warnings.push({ severity: 'critical', area: 'battery', message: `Battery at ${battery.percent}% on battery power — plug in now.` });
    } else if (battery.percent <= 20 && battery.charging === false) {
      warnings.push({ severity: 'warning', area: 'battery', message: `Battery at ${battery.percent}% on battery power.` });
    }
  }

  if (cpu.loadPerCore['5m'] >= 2) {
    warnings.push({ severity: 'critical', area: 'cpu', message: `5-min load avg is ${cpu.loadAverages['5m']} (${cpu.loadPerCore['5m']}× cores) — system overloaded.` });
  } else if (cpu.loadPerCore['5m'] >= 1) {
    warnings.push({ severity: 'warning', area: 'cpu', message: `5-min load avg is ${cpu.loadAverages['5m']} (${cpu.loadPerCore['5m']}× cores) — sustained high load.` });
  }

  // Trust the kernel pressure level — NEVER threshold on usedPercent alone.
  // macOS keeps cached files in RAM as a perf boost; they look "used" but are reclaimable.
  // The kernel's memorystatus_vm_pressure_level is the same signal Activity Monitor uses.
  if (memory.pressure === 'critical') {
    warnings.push({
      severity: 'critical',
      area: 'memory',
      message: `Kernel reports CRITICAL memory pressure. App+Wired+Compressed = ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} (${memory.usedPercent}%). Swap used: ${memory.swapUsedBytes != null ? formatBytes(memory.swapUsedBytes) : 'unknown'}.`,
    });
  } else if (memory.pressure === 'warning') {
    warnings.push({
      severity: 'warning',
      area: 'memory',
      message: `Kernel reports WARNING memory pressure. App+Wired+Compressed = ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} (${memory.usedPercent}%).`,
    });
  }

  if (disk.usedPercent >= 95) {
    warnings.push({ severity: 'critical', area: 'disk', message: `Root disk at ${disk.usedPercent}% full — only ${formatBytes(disk.freeBytes)} free.` });
  } else if (disk.usedPercent >= 85) {
    warnings.push({ severity: 'warning', area: 'disk', message: `Root disk at ${disk.usedPercent}% full (${formatBytes(disk.freeBytes)} free).` });
  }

  const status: SystemHealth['status'] = warnings.some((w) => w.severity === 'critical')
    ? 'critical'
    : warnings.length > 0
      ? 'warning'
      : 'ok';

  return { status, warnings, battery, cpu, memory, disk, system };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${round2(bytes / Math.pow(1024, i))} ${units[i]}`;
}
