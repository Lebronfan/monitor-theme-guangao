import { startTransition, useEffect, useState } from "react"

// An explicit extension, because this file is compiled by both tsconfig
// projects: the app's bundler resolution and, through vite.config -> the demo
// plugin, the node project's nodenext one, which requires it.
import {
  mapMe, mapServer, num,
  type CfsmServer, type CfsmSiteConfig, type Me,
} from "./cfsm.ts"

export type { Me }

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  /** CF-Server-Monitor 用 UUID 标识服务器，因而这里是字符串。 */
  id: string
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  /** Set by the operator; empty is ungrouped. */
  group?: string
  public_remark?: string
  last_seen: number
  /** Seconds since `last_seen` on the hub's clock, null for a node never seen. */
  last_seen_ago?: number | null
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /** Days until `expires_at`, negative once past, null without a date. */
  expires_in?: number | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it. */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel-only fields. */
  hostname?: string
  ip?: string
  remark?: string
}

/** Every group in use, in the order of the first node carrying it. */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Every error the hub answers is one line of plain text written for the reader.
 * Anything else came from something in front of it -- a proxy's error page, a
 * CDN's challenge, an empty 502 -- and is described by its status instead.
 */
async function failure(res: Response): Promise<ApiError> {
  const text = res.headers.get("content-type")?.startsWith("text/plain") ? (await res.text()).trim() : ""
  return new ApiError(
    res.status,
    text || (res.status >= 500 ? `服务暂时无法访问（HTTP ${res.status}），稍后再试` : `请求被拦截（HTTP ${res.status}），稍后再试`),
  )
}

/**
 * How long one attempt may go unanswered. A connection that died without
 * closing, as when a NAT on a phone's path forgets it, holds a request sent over
 * it until TCP gives up. Every request here is a GET, so repeating is safe.
 */
const TIMEOUT = 20_000

/** Further attempts after a timeout. */
const RETRIES = 6

export async function api<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`/api${path}`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (!res.ok) throw await failure(res)
      if (res.status === 204) return undefined as T
      // A 200 carrying HTML is a proxy's page, not the hub's JSON.
      return await res.json().catch((e) => {
        throw e instanceof SyntaxError ? new ApiError(res.status, "收到的不是状态数据，稍后再试") : e
      }) as T
    } catch (e) {
      if (e instanceof ApiError) throw e
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
      if (!timedOut || attempt === RETRIES) {
        throw new ApiError(0, "网络连接失败，稍后再试")
      }
    }
  }
}

/**
 * `GET /api/config`, fetched once per page load. Both the site's identity and
 * the operator's theme options live in it, so the two callers share one request.
 * A failure clears the cache so a retry can start over.
 */
let site: Promise<CfsmSiteConfig> | null = null
export function fetchSite(): Promise<CfsmSiteConfig> {
  site ??= api<CfsmSiteConfig>("/config").catch((e) => {
    site = null
    throw e
  })
  return site
}

export function fetchMe(): Promise<Me> {
  return fetchSite().then(mapMe)
}

/**
 * Throughput, one sample per push, as a series for every node (null) and one per
 * group ("" for the ungrouped), so the summary above a group tab draws that
 * group's line rather than the fleet's. Keyed null rather than by any string,
 * since a group may be named anything, "*" included.
 */
const KEEP = 60
export const speedHistory = new Map<string | null, { rx: number; tx: number }[]>()

export function sample(nodes: Node[]) {
  const totals = new Map<string | null, { rx: number; tx: number }>()
  for (const n of nodes) {
    for (const key of [null, n.group ?? ""]) {
      const total = totals.get(key) ?? { rx: 0, tx: 0 }
      if (n.online && n.metrics) {
        total.rx += n.metrics.net_rx
        total.tx += n.metrics.net_tx
      }
      totals.set(key, total)
    }
  }
  for (const key of speedHistory.keys()) if (!totals.has(key)) speedHistory.delete(key)
  for (const [key, total] of totals) {
    const series = speedHistory.get(key) ?? []
    series.push(total)
    if (series.length > KEEP) series.shift()
    speedHistory.set(key, series)
  }
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: Node[]): Node[] {
  if (!Array.isArray(nodes)) throw new ApiError(200, "收到的不是状态数据，稍后再试")
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    return !m || (fields.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number))
      ? node : { ...node, metrics: null }
  })
}

/** How often the fallback snapshot is refetched while the stream is down. */
const POLL_INTERVAL = 20_000

/**
 * How long the stream may stay quiet before it is replaced. CFSM pushes on
 * every report: its own agents every couple of seconds, HTTP-reporting ones as
 * slowly as their `report_interval` (a minute by default). The limit is set
 * above that slowest cadence so a healthy but quiet site is not reconnected on
 * a loop.
 */
const SILENT_LIMIT = 90_000

/**
 * A frame pushed over `/api/ws`. Only `batchUpdate` carries metrics: each
 * sample holds an incremental patch whose fields arrive under `data`, `payload`
 * or `metrics`, and only the last sample of a report carries the report-level
 * fields (disk, GPU, processes, connections, probes).
 */
type WsFrame = {
  type?: string
  updates?: {
    serverId?: string
    samples?: { ts?: number; data?: CfsmServer; payload?: CfsmServer; metrics?: CfsmServer }[]
  }[]
}

/**
 * Live node list. Seeds from `GET /api/servers`, then keeps the nodes current
 * with the `batchUpdate` frames the hub pushes over `/api/ws`, falling back to
 * polling if the socket cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let silent: ReturnType<typeof setTimeout> | null = null
    let expiry: ReturnType<typeof setTimeout> | null = null
    // Set by `resume`. The throughput line is drawn one point per push, so the
    // samples from before the page was hidden, or the stream went silent, would
    // join the new ones as if no time had passed. Dropped on the first arrival.
    let gap = false
    // A slow snapshot must not replace frames received since it began.
    let revision = 0
    // Bumped by `pause`: a request started before the page was hidden may land
    // after a fresh one, and neither result describes the page now.
    let epoch = 0
    // Set once the operator's configured stream lifetime runs out, so the socket
    // is not silently reopened behind the visitor's back.
    let expired = false

    // The accumulated server state: `/api/servers` seeds it, WS frames merge in.
    const servers = new Map<string, CfsmServer>()

    const publish = () => {
      const list: Node[] = []
      for (const server of servers.values()) list.push(mapServer(server))
      const safe = safeNodes(list)
      revision++
      if (gap) speedHistory.clear()
      gap = false
      sample(safe)
      // Live snapshots must yield to taps and navigation on slower devices.
      startTransition(() => setNodes(safe))
      setError(null)
      setClosed(false)
    }

    const subscribe = () => {
      if (socket?.readyState !== WebSocket.OPEN) return
      // `subscribe=all` pushes nothing until the ids are named on the channel.
      socket.send(JSON.stringify({ type: "subscribe", scope: "all", ids: [...servers.keys()] }))
    }

    const fetchOnce = () => {
      const started = epoch
      const startedRevision = revision
      return api<{ servers?: CfsmServer[] }>("/servers")
        .then((d) => {
          if (started !== epoch || startedRevision !== revision) return
          servers.clear()
          for (const server of d.servers ?? []) {
            if (server && typeof server.id === "string") servers.set(server.id, server)
          }
          subscribe()
          publish()
        })
        .catch((e: Error) => {
          if (started !== epoch) return
          // A request lost on a dead pooled connection says nothing of an open
          // stream, whose own watchdog reports it going quiet.
          if (e instanceof ApiError && e.status === 0 && socket?.readyState === WebSocket.OPEN) return
          setError(e.message)
          if (e instanceof ApiError && e.status === 401) setClosed(true)
        })
    }

    const merge = (serverId: string, patch: CfsmServer, ts: number) => {
      const previous = servers.get(serverId)
      const next: CfsmServer = previous ? { ...previous, ...patch } : { ...patch }
      next.id = serverId
      if (ts > 0) next.last_updated = Math.max(num(next.last_updated), ts)
      servers.set(serverId, next)
    }

    const receive = (frame: WsFrame) => {
      if (frame.type !== "batchUpdate") return
      let touched = false
      for (const update of frame.updates ?? []) {
        const serverId = typeof update.serverId === "string" ? update.serverId : ""
        if (!serverId) continue
        for (const s of update.samples ?? []) {
          const patch = s.data ?? s.payload ?? s.metrics
          if (!patch) continue
          // The server must be known: ids drive the subscribe list, so a frame
          // for a server this tab never listed is not ours to show.
          if (!servers.has(serverId)) continue
          merge(serverId, patch, num(s.ts))
          touched = true
        }
      }
      if (touched) publish()
    }

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?subscribe=all`
    const connect = () => {
      let opened: WebSocket
      try {
        opened = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, POLL_INTERVAL)
        return
      }
      socket = opened
      // Re-armed by every frame read. `SILENT_LIMIT` without one means the
      // connection died without closing, as when a NAT on the path forgets it;
      // the browser would notice only when TCP keepalive gives up.
      const watch = () => {
        if (silent) clearTimeout(silent)
        silent = setTimeout(() => {
          setError("实时数据中断，正在重新连接")
          resume()
        }, SILENT_LIMIT)
      }
      opened.onopen = () => {
        subscribe()
        watch()
        void fetchSite().then((config) => {
          const minutes = num(config.frontend_ws_timeout_minutes)
          // The operator may cap how long one stream lives. When they do, close
          // it on time and leave the poll to keep the page current rather than
          // reconnecting behind the visitor's back.
          if (minutes > 0 && opened.readyState === WebSocket.OPEN) {
            expiry = setTimeout(() => {
              expired = true
              opened.close()
            }, minutes * 60_000)
          }
        }).catch(() => { /* No cap: keep the stream. */ })
      }
      opened.onmessage = (event) => {
        try {
          receive(JSON.parse(String(event.data)) as WsFrame)
        } catch (e) {
          console.warn("live frame dropped:", e)
          return
        }
        watch()
        // The stream has returned; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      opened.onerror = () => opened.close()
      opened.onclose = () => {
        if (silent) clearTimeout(silent)
        if (expiry) clearTimeout(expiry)
        silent = expiry = null
        socket = null
        poll ??= setInterval(fetchOnce, POLL_INTERVAL)
        if (!expired) retry = setTimeout(connect, 5000)
      }
    }

    // A phone suspends a page it sends to the background and drops its
    // connections without telling it. So a hidden page lets go of the stream and
    // starts nothing, and a visible one fetches at once and opens a fresh one.
    const pause = () => {
      epoch++
      if (socket) {
        socket.onclose = null
        socket.close()
        socket = null
      }
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
      if (silent) clearTimeout(silent)
      if (expiry) clearTimeout(expiry)
      poll = retry = silent = expiry = null
    }
    const resume = () => {
      pause()
      gap = true
      void fetchOnce()
      connect()
    }
    const visibility = () => (document.hidden ? pause() : resume())
    document.addEventListener("visibilitychange", visibility)
    resume()

    return () => {
      document.removeEventListener("visibilitychange", visibility)
      pause()
    }
  }, [])

  return { nodes, error, closed }
}
