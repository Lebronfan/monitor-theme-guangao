// Explicit extensions, because this file is compiled by both tsconfig projects:
// the app's bundler resolution and, through vite.config -> the demo plugin, the
// node project's nodenext one, which requires them.
import type { Metrics, Node } from "./api.ts"
import { daysUntil } from "./format.ts"

/**
 * CF-Server-Monitor（CFSM）与 Monitor 的数据结构不同，这里集中做一次换算：
 * 把 `/api/config`、`/api/servers` 与 `/api/history/all` 的字段映射成主题内部
 * 沿用的 `Node` / 历史点位结构，组件层因此不需要改动。
 *
 * 三处需要特别注意的语义差异：
 * 1. CFSM 的 `net_in_speed` / `net_out_speed` 是**速率**（B/s），`net_rx` / `net_tx`
 *    才是累计值；主题里的 `metrics.net_rx` 表示速率，`node.total_rx` 才是累计。
 * 2. CFSM 的内存、磁盘、流量额度以 MB / 带单位字符串计数，主题一律用字节。
 * 3. CFSM 用 `false` 表示"该线路未配置或未取样"，`null` 才是超时；主题只认数值。
 */

const MB = 1024 * 1024
const GB = 1024 * 1024 * 1024

/** CFSM 返回的单台服务器对象，字段随版本增减，按需读取。 */
export type CfsmServer = Record<string, unknown>

export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function text(value: unknown): string {
  if (typeof value === "string") return value
  return value === null || value === undefined ? "" : String(value)
}

/** 延迟/丢包：数值有效时返回，`false`（未配置）与 `null`（超时）都返回 null。 */
function latency(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 三网与自定义线路在历史表里的字段名，顺序即主题里的 task_id 1..4。 */
export const PROBE_KEYS = ["ct", "cu", "cm", "bd"] as const
export const NODE_KEYS = ["node_1", "node_2", "node_3", "node_4"] as const

/**
 * 流量额度：CFSM 既可能给纯数字（GB），也可能带上单位（`1TB`、`400 GB`）。
 * 主题内部一律折算成字节，无法解析时按不限量（0）处理。
 */
const TRAFFIC_UNITS: Record<string, number> = {
  b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5,
}

export function trafficBytes(value: unknown): number {
  const raw = text(value).trim().toUpperCase()
  if (!raw || raw === "0" || raw === "-1") return 0
  const match = /^([\d.]+)\s*([KMGTP]?B?)$/.exec(raw)
  if (!match) return 0
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return 0
  const unit = match[2] || "GB" // 纯数字按 CFSM 的惯例是 GB
  return amount * (TRAFFIC_UNITS[unit.toLowerCase()] ?? GB)
}

/** 价格：空白表示未设置，`0` 与 `-1` 都表示免费。主题用 0 表示免费。 */
export function priceOf(value: unknown): number {
  const raw = text(value).trim()
  if (!raw) return 0
  const amount = Number(raw)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

/** CFSM 的计费周期名转换成主题认识的那套（月付/季付/…）。 */
const CYCLE_NAMES: Record<string, string> = {
  month: "monthly", monthly: "monthly",
  quarter: "quarterly", quarterly: "quarterly",
  half_year: "semiannual", halfyear: "semiannual", "half-year": "semiannual", semiannual: "semiannual",
  year: "yearly", yearly: "yearly", annual: "yearly",
  two_years: "biennial", "two-years": "biennial", biennial: "biennial",
  three_years: "triennial", "three-years": "triennial", triennial: "triennial",
  once: "once", onetime: "once", "one-time": "once",
}

export function billingCycle(value: unknown): string {
  const raw = text(value).trim()
  if (!raw) return ""
  const known = CYCLE_NAMES[raw.toLowerCase()]
  if (known) return known
  const months = /^(\d+)\s*m$/i.exec(raw)
  if (months) return `${months[1]}m`
  const days = Number(raw)
  if (Number.isFinite(days) && days > 0) return `${Math.max(1, Math.round(days / 30))}m`
  return raw
}

/** CFSM 存的是货币符号，主题的货币格式化需要 ISO 三字母代码。 */
const CURRENCY_CODES: Record<string, string> = {
  "¥": "CNY", "￥": "CNY", "元": "CNY", "RMB": "CNY",
  "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP",
  "HK$": "HKD", "NT$": "TWD", "₩": "KRW", "₽": "RUB",
  "C$": "CAD", "A$": "AUD", "S$": "SGD", "₣": "CHF",
}

export function currencyCode(value: unknown): string {
  const raw = text(value).trim()
  if (!raw) return "CNY"
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase()
  return CURRENCY_CODES[raw] ?? "CNY"
}

/** 主题按 ISO 3166-1 alpha-2 取国旗，CFSM 的 region 通常就是它。 */
export function countryCode(value: unknown): string {
  const raw = text(value).trim().toUpperCase()
  return /^[A-Z]{2}$/.test(raw) ? raw : ""
}

function loadAvg(value: unknown): [number, number, number] {
  const parts = text(value).trim().split(/\s+/).map(Number)
  const at = (i: number) => (Number.isFinite(parts[i]) ? parts[i] : 0)
  return [at(0), at(1), at(2)]
}

/** CFSM 判定在线的阈值与它自己的聚合统计一致：5 分钟没有上报即离线。 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000

export function isOnline(server: CfsmServer, now: number): boolean {
  const updated = num(server.last_updated)
  return updated > 0 && now - updated < ONLINE_WINDOW_MS
}

/**
 * 一台 CFSM 服务器 → 主题的 `Node`。
 * 尚未上报过配置的机器（没有内存、核数）不给 metrics，卡片会显示成"未接入"。
 */
export function mapServer(server: CfsmServer, now = Date.now()): Node {
  const memTotal = num(server.ram_total) * MB
  const diskTotal = num(server.disk_total) * MB
  const swapTotal = num(server.swap_total) * MB
  const cores = num(server.cpu_cores)
  const updated = num(server.last_updated)
  const boot = Number(text(server.boot_time))

  const metrics: Metrics | null =
    memTotal > 0 || cores > 0
      ? {
          uptime: boot > 0 ? Math.max(0, Math.round((now - boot) / 1000)) : 0,
          cpu: num(server.cpu),
          load: loadAvg(server.load_avg),
          mem_total: memTotal,
          mem_used: num(server.ram_used) * MB,
          swap_total: swapTotal,
          swap_used: num(server.swap_used) * MB,
          disk_total: diskTotal,
          disk_used: num(server.disk_used) * MB,
          net_rx: num(server.net_in_speed),
          net_tx: num(server.net_out_speed),
          total_rx: num(server.net_rx),
          total_tx: num(server.net_tx),
          month_rx: num(server.net_rx_monthly),
          month_tx: num(server.net_tx_monthly),
          tcp: num(server.tcp_conn),
          udp: num(server.udp_conn),
          procs: num(server.processes),
        }
      : null

  const expire = text(server.expire_date)

  return {
    id: text(server.id),
    name: text(server.name) || text(server.id).slice(0, 8),
    sort: num(server.sort_order),
    public: text(server.is_hidden) !== "1",
    online: isOnline(server, now),
    country: countryCode(server.region),
    group: text(server.server_group),
    last_seen: updated > 0 ? Math.round(updated / 1000) : 0,
    last_seen_ago: updated > 0 ? Math.max(0, Math.round((now - updated) / 1000)) : null,
    metrics,
    os: text(server.os),
    kernel: text(server.kernel_version),
    arch: text(server.arch),
    // CFSM 不上报虚拟化类型，留空即不显示这一项。
    virt: "",
    cpu_name: text(server.cpu_info),
    cpu_cores: cores,
    mem_total: memTotal,
    swap_total: swapTotal,
    disk_total: diskTotal,
    agent_version: text(server.agent_version),
    price: priceOf(server.price),
    currency: currencyCode(server.currency),
    billing_cycle: billingCycle(server.billing_cycle),
    expires_at: expire || null,
    expires_in: daysUntil(expire || null),
    traffic_limit: trafficBytes(server.traffic_limit),
    traffic_mode: text(server.traffic_calc_type) || "total",
    traffic_reset_day: num(server.reset_day, 1),
    total_rx: num(server.net_rx),
    total_tx: num(server.net_tx),
    month_rx: num(server.net_rx_monthly),
    month_tx: num(server.net_tx_monthly),
    month_start: "",
    // CFSM 不提供当日流量，详情页会据此隐藏该行。
    day_rx: 0,
    day_tx: 0,
    public_remark: text(server.tags) || undefined,
  }
}

/** 历史点位，与 `NodeDetail` 内部的 `Point` 同形。 */
export type HistoryPoint = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  swap_used: number
  tcp: number
  udp: number
  procs: number
}

/** 一条延迟采样，与 `NodeDetail` 内部的 `PingPoint` 同形。 */
export type PingSample = { task_id: number; ts: number; latency: number | null }

/**
 * `/api/history/all` 的行 → 主题需要的两组序列。
 * 资源曲线与延迟曲线的字段在同一次响应里，一次请求即可喂两个标签页。
 */
export function mapHistory(
  rows: unknown[],
  names: Record<string, string>,
  nodeNames?: string[],
): { metrics: HistoryPoint[]; ping: PingSample[]; probes: Record<string, string>; loss: Record<string, number> } {
  const metrics: HistoryPoint[] = []
  const ping: PingSample[] = []
  const probes: Record<string, string> = {}
  const lost = new Map<number, { sum: number; count: number }>()

  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as CfsmServer
    const ts = num(r.timestamp) / 1000

    metrics.push({
      ts,
      cpu: num(r.cpu),
      mem_used: num(r.ram_used) * MB,
      disk_used: num(r.disk_used) * MB,
      // 历史表里同样只有速率字段，正好对应主题期望的 net_rx / net_tx。
      net_rx: num(r.net_in_speed),
      net_tx: num(r.net_out_speed),
      swap_used: num(r.swap_used) * MB,
      tcp: num(r.tcp_conn),
      udp: num(r.udp_conn),
      procs: num(r.processes),
    })

    for (let i = 0; i < PROBE_KEYS.length; i++) {
      const id = i + 1
      // `/api/history/all` prefixes the columns (`ping_ct`, `ping_node_1`); the
      // `/api/servers` window points leave them bare. Read either.
      const net = latency(r[`ping_${PROBE_KEYS[i]}`]) ?? latency(r[PROBE_KEYS[i]])
      const node = latency(r[`ping_${NODE_KEYS[i]}`]) ?? latency(r[NODE_KEYS[i]])
      // 三网线路优先，未配置时退回该机器自定义的探测节点。
      const value = net ?? node
      if (value === null) continue
      probes[String(id)] = net !== null ? (names[String(id)] ?? `探测 ${id}`) : (nodeNames?.[i] ?? `探测 ${id}`)
      ping.push({ task_id: id, ts, latency: value })

      const lostPercent = latency(r[`loss_${PROBE_KEYS[i]}`]) ?? latency(r[`loss_${NODE_KEYS[i]}`])
      if (lostPercent === null) continue
      const total = lost.get(id) ?? { sum: 0, count: 0 }
      total.sum += lostPercent
      total.count += 1
      lost.set(id, total)
    }
  }

  // 主题的 loss 是整个窗口的占比，这里按各采样点求均值，不做加权（CFSM 不返回样本数）。
  const loss: Record<string, number> = {}
  for (const [id, total] of lost) {
    if (total.count > 0) loss[String(id)] = total.sum / total.count
  }

  return { metrics, ping, probes, loss }
}

/** 用站点配置里的自定义名称给四条三网探测线路起名。 */
export function probeNames(config: { custom_ct_name?: unknown; custom_cu_name?: unknown; custom_cm_name?: unknown; custom_bd_name?: unknown } | null): Record<string, string> {
  const at = (value: unknown, fallback: string) => text(value).trim() || fallback
  return {
    1: at(config?.custom_ct_name, "电信"),
    2: at(config?.custom_cu_name, "联通"),
    3: at(config?.custom_cm_name, "移动"),
    4: at(config?.custom_bd_name, "BGP"),
  }
}

/** 自定义探测节点（node_1..node_4）的显示名，未配置时用 CFSM 的默认名。 */
export function nodeProbeNames(config: CfsmSiteConfig | null): string[] {
  const at = (value: unknown, fallback: string) => text(value).trim() || fallback
  return [
    at(config?.node_1_name, "Node 1"),
    at(config?.node_2_name, "Node 2"),
    at(config?.node_3_name, "Node 3"),
    at(config?.node_4_name, "Node 4"),
  ]
}

/** `GET /api/config` 的返回，字段随版本增减。 */
export type CfsmSiteConfig = {
  version?: string
  is_public?: boolean
  authorization?: boolean
  site_title?: string
  theme_options?: Record<string, unknown>
  custom_ct_name?: string
  custom_cu_name?: string
  custom_cm_name?: string
  custom_bd_name?: string
  node_1_name?: string
  node_2_name?: string
  node_3_name?: string
  node_4_name?: string
  frontend_ws_timeout_minutes?: number
  long_history_points?: number
}

/** 主题内部沿用的站点信息，等价于 Monitor 的 `/api/me`。 */
export type Me = {
  authed: boolean
  site_name: string
  public_page: boolean
  history_days: number
  demo: boolean
  version: string
  /** 三网探测线路的显示名，下标 1..4 即 `task_id`。 */
  probes: Record<string, string>
  /** 自定义探测节点 `node_1`..`node_4` 的显示名，顺序即下标 0..3。 */
  nodeProbes: string[]
}

/**
 * 站点配置 → 主题的 `Me`。
 *
 * `history_days` 是主题给访客开放的历史窗口上限：CFSM 的
 * `/api/history/all` 对匿名请求只放行 24 小时（`hours > 24` 返回 401），
 * 登录后才给到 7 天。这里据此取 1 天或 7 天，避免访客点到必然 401 的档位。
 */
export function mapMe(config: CfsmSiteConfig): Me {
  const authed = config.authorization === true
  return {
    authed,
    site_name: text(config.site_title) || "CF 探针",
    public_page: config.is_public !== false,
    history_days: authed ? 7 : 1,
    demo: false,
    version: text(config.version),
    probes: probeNames(config),
    nodeProbes: nodeProbeNames(config),
  }
}

/** `theme_options` 里属于本主题的那份配置：优先取命名空间键，其次扁平键。 */
export function themeConfig(config: CfsmSiteConfig | null): unknown {
  const options = config?.theme_options
  if (!options || typeof options !== "object" || Array.isArray(options)) return {}
  const boxed = (options as Record<string, unknown>).guangao
  return boxed && typeof boxed === "object" && !Array.isArray(boxed) ? boxed : options
}
