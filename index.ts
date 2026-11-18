import { Plugin } from "@opencode/plugin"
import { EMPTY_LIMIT, Quota } from "./rpc"

/**
 * Серверная часть zai-quota: получает квоты Z.AI Coding Plan и отдаёт их
 * клиентам (GUI) через RPC. Fetch идёт отсюда, а не из окна приложения,
 * чтобы не зависеть от CORS.
 *
 * API key resolution (first match wins):
 *   1. ZAI_API_KEY env var
 *   2. ~/.config/opencode/zai-quota.key   (Linux/macOS, chmod 600)
 *   3. %APPDATA%/opencode/zai-quota.key   (Windows)
 *   4. $XDG_CONFIG_HOME/opencode/zai-quota.key
 */

const ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit"
const CACHE_MS = 30_000

type Limit = {
  type: string
  unit: number // 3 = hours, 6 = weeks
  number: number
  usage: number
  currentValue: number
  remaining: number
  percentage: number
  nextResetTime: number
}

type LimitStatus = typeof EMPTY_LIMIT
type QuotaStatus = { level: string; fiveHour: LimitStatus; weekly: LimitStatus }

async function readKey(): Promise<string | undefined> {
  const env = process.env.ZAI_API_KEY
  if (env) return env
  const { readFile } = await import("node:fs/promises")
  const { homedir } = await import("node:os")
  const candidates = [
    `${homedir()}/.config/opencode/zai-quota.key`,
    process.env.APPDATA ? `${process.env.APPDATA}/opencode/zai-quota.key` : undefined,
    process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/opencode/zai-quota.key` : undefined,
  ].filter((p): p is string => !!p)
  for (const path of candidates) {
    try {
      const key = (await readFile(path, "utf8")).trim()
      if (key) return key
    } catch {
      // файла нет — пробуем следующий путь
    }
  }
  return undefined
}

const toStatus = (l: Limit | undefined): LimitStatus =>
  l
    ? {
        usage: l.usage,
        currentValue: l.currentValue,
        remaining: l.remaining,
        percentage: l.percentage,
        nextResetTime: l.nextResetTime,
      }
    : { ...EMPTY_LIMIT }

async function fetchQuota(key: string): Promise<QuotaStatus> {
  try {
    const res = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) {
      console.warn("zai-quota: HTTP", res.status)
      return { level: "", fiveHour: { ...EMPTY_LIMIT }, weekly: { ...EMPTY_LIMIT } }
    }
    const json: any = await res.json()
    const limits: Limit[] = json?.data?.limits ?? []
    if (limits.length === 0) {
      console.warn("zai-quota: пустой список limits")
      return { level: "", fiveHour: { ...EMPTY_LIMIT }, weekly: { ...EMPTY_LIMIT } }
    }
    return {
      level: json?.data?.level ?? "",
      fiveHour: toStatus(limits.find((l) => l.unit === 3)),
      weekly: toStatus(limits.find((l) => l.unit === 6)),
    }
  } catch (error) {
    console.warn("zai-quota: запрос не удался", error)
    return { level: "", fiveHour: { ...EMPTY_LIMIT }, weekly: { ...EMPTY_LIMIT } }
  }
}

export default Plugin.define({
  id: "zai-quota",
  async setup(ctx) {
    let cache: { at: number; data: QuotaStatus } | undefined
    let inflight: Promise<QuotaStatus> | undefined

    await ctx.rpc.register(Quota, {
      status: async () => {
        const key = await readKey()
        if (!key) return { level: "", fiveHour: { ...EMPTY_LIMIT }, weekly: { ...EMPTY_LIMIT } }
        const now = Date.now()
        if (cache && now - cache.at < CACHE_MS) return cache.data
        // Схлопываем параллельные запросы (TUI + окна GUI) в один fetch.
        inflight ??= fetchQuota(key).then((data) => {
          cache = { at: Date.now(), data }
          return data
        })
        return inflight.finally(() => {
          inflight = undefined
        })
      },
    })
  },
})
