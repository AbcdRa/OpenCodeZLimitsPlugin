import { Plugin } from "@opencode/plugin"
import { EMPTY_GO_STATUS, EMPTY_GO_WINDOW, EMPTY_LIMIT, GoQuota, Quota } from "./rpc"

/**
 * Серверная часть плагина квот: получает остатки подписок
 * Z.AI Coding Plan и OpenCode Go и отдаёт их клиентам (GUI/TUI) через RPC.
 * Fetch идёт отсюда, а не из окна приложения, чтобы не зависеть от CORS.
 *
 * Z.AI API key resolution (first match wins):
 *   1. ZAI_API_KEY env var
 *   2. ~/.config/opencode/zai-quota.key   (Linux/macOS, chmod 600)
 *   3. %APPDATA%/opencode/zai-quota.key   (Windows)
 *   4. $XDG_CONFIG_HOME/opencode/zai-quota.key
 *   5. активный ключ интеграции "zai-coding-plan" из хранилища OpenCode
 *
 * OpenCode Go API key resolution (first match wins):
 *   1. OPENCODE_GO_API_KEY / OPENCODE_API_KEY env var
 *   2. ~/.config/opencode/opencode-go-quota.key (ручной override)
 *   3. активный ключ интеграции "opencode-go" (или старой "opencode")
 *      из хранилища OpenCode — отдельный файл с ключом не нужен
 *   4. legacy ~/.local/share/opencode/auth.json
 */

const ZAI_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit"
const GO_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"
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

type GoWindow = typeof EMPTY_GO_WINDOW
type GoStatus = typeof EMPTY_GO_STATUS

type CredentialValue = { type?: string; key?: string; access?: string }

type GoKeyContext = {
  integration?: {
    connection: {
      active(integrationID: string): Promise<unknown>
      resolve(connection: unknown): Promise<CredentialValue | undefined>
    }
  }
}

const emptyQuota = (): QuotaStatus => ({
  level: "",
  fiveHour: { ...EMPTY_LIMIT },
  weekly: { ...EMPTY_LIMIT },
})

const emptyGo = (): GoStatus => ({
  plan: "",
  rolling: { ...EMPTY_GO_WINDOW },
  weekly: { ...EMPTY_GO_WINDOW },
  monthly: { ...EMPTY_GO_WINDOW },
})

async function readTextKey(path: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises")
  try {
    const key = (await readFile(path, "utf8")).trim()
    if (key) return key
  } catch {
    // файла нет — пробуем следующий путь
  }
  return undefined
}

async function configDirKeyPaths(name: string): Promise<string[]> {
  const { homedir } = await import("node:os")
  return [
    `${homedir()}/.config/opencode/${name}`,
    process.env.APPDATA ? `${process.env.APPDATA}/opencode/${name}` : undefined,
    process.env.XDG_CONFIG_HOME ? `${process.env.XDG_CONFIG_HOME}/opencode/${name}` : undefined,
  ].filter((p): p is string => !!p)
}

async function readKey(ctx: GoKeyContext): Promise<string | undefined> {
  const env = process.env.ZAI_API_KEY
  if (env) return env
  for (const path of await configDirKeyPaths("zai-quota.key")) {
    const key = await readTextKey(path)
    if (key) return key
  }
  // Тот же ключ, что сохранён в OpenCode через /connect для Z.AI.
  return readIntegrationKey(ctx, ["zai-coding-plan", "zai"])
}

/**
 * Достаёт ключ из хранилища интеграций самого OpenCode.
 * Это штатный путь V2: ключ уже сохранён через /connect и не дублируется
 * в конфиге плагина.
 */
async function readIntegrationKey(ctx: GoKeyContext, integrationIDs: string[]): Promise<string | undefined> {
  const connection = ctx.integration?.connection
  if (!connection) return undefined
  for (const integrationID of integrationIDs) {
    try {
      const active = await connection.active(integrationID)
      if (!active) continue
      const value = await connection.resolve(active)
      if (!value) continue
      if (value.type === "key" && value.key) return value.key
      if (value.type === "oauth" && value.access) return value.access
    } catch (error) {
      console.warn("zai-quota: не удалось прочитать ключ интеграции", integrationID, error)
    }
  }
  return undefined
}

async function readGoAuthFileKey(): Promise<string | undefined> {
  const { homedir } = await import("node:os")
  const { readFile } = await import("node:fs/promises")
  const candidates = [
    process.env.XDG_DATA_HOME ? `${process.env.XDG_DATA_HOME}/opencode/auth.json` : undefined,
    `${homedir()}/.local/share/opencode/auth.json`,
  ].filter((p): p is string => !!p)
  for (const path of candidates) {
    try {
      const json: any = JSON.parse(await readFile(path, "utf8"))
      for (const providerID of ["opencode-go", "opencode"]) {
        const entry = json?.[providerID]
        if (!entry) continue
        if ((entry.type === "api" || entry.type === "zen") && entry.key) return String(entry.key)
        if (entry.type === "oauth" && entry.access) return String(entry.access)
      }
    } catch {
      // файла нет или он не JSON — пробуем следующий путь
    }
  }
  return undefined
}

async function readGoKey(ctx: GoKeyContext): Promise<string | undefined> {
  const env = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY
  if (env) return env
  for (const name of ["opencode-go-quota.key", "opencode-go.key"]) {
    for (const path of await configDirKeyPaths(name)) {
      const key = await readTextKey(path)
      if (key) return key
    }
  }
  const fromIntegration = await readIntegrationKey(ctx, ["opencode-go", "opencode"])
  if (fromIntegration) return fromIntegration
  return readGoAuthFileKey()
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
    const res = await fetch(ZAI_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) {
      console.warn("zai-quota: HTTP", res.status)
      return emptyQuota()
    }
    const json: any = await res.json()
    const limits: Limit[] = json?.data?.limits ?? []
    if (limits.length === 0) {
      console.warn("zai-quota: пустой список limits")
      return emptyQuota()
    }
    return {
      level: json?.data?.level ?? "",
      fiveHour: toStatus(limits.find((l) => l.unit === 3)),
      weekly: toStatus(limits.find((l) => l.unit === 6)),
    }
  } catch (error) {
    console.warn("zai-quota: запрос не удался", error)
    return emptyQuota()
  }
}

const clampPct = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

const toGoWindow = (w: any): GoWindow => {
  if (!w || typeof w !== "object") return { ...EMPTY_GO_WINDOW }
  const percent = Number(w.percent)
  const rawReset = w.resetsAt ?? w.resetAt ?? w.nextResetTime
  const resetsAt =
    typeof rawReset === "string" ? Date.parse(rawReset) : typeof rawReset === "number" ? rawReset : 0
  return {
    status: typeof w.status === "string" && w.status ? w.status : "ok",
    percent: Number.isFinite(percent) ? clampPct(percent) : 0,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0,
  }
}

async function fetchGo(key: string): Promise<GoStatus> {
  try {
    const res = await fetch(GO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "opencode-quota-plugin/1.0",
      },
    })
    if (!res.ok) {
      console.warn("opencode-go-quota: HTTP", res.status)
      return emptyGo()
    }
    const json: any = await res.json()
    const usage = json?.usage ?? json
    if (!usage || typeof usage !== "object") {
      console.warn("opencode-go-quota: пустой ответ usage")
      return emptyGo()
    }
    return {
      plan: typeof json?.plan === "string" ? json.plan : "",
      rolling: toGoWindow(usage.rolling ?? usage.rolling5h),
      weekly: toGoWindow(usage.weekly),
      monthly: toGoWindow(usage.monthly),
    }
  } catch (error) {
    console.warn("opencode-go-quota: запрос не удался", error)
    return emptyGo()
  }
}

export default Plugin.define({
  id: "zai-quota",
  async setup(ctx) {
    let zaiCache: { at: number; data: QuotaStatus } | undefined
    let zaiInflight: Promise<QuotaStatus> | undefined
    let goCache: { at: number; data: GoStatus } | undefined
    let goInflight: Promise<GoStatus> | undefined

    await ctx.rpc.register(Quota, {
      status: async () => {
        const key = await readKey(ctx)
        if (!key) return emptyQuota()
        const now = Date.now()
        if (zaiCache && now - zaiCache.at < CACHE_MS) return zaiCache.data
        // Схлопываем параллельные запросы (TUI + окна GUI) в один fetch.
        zaiInflight ??= fetchQuota(key).then((data) => {
          zaiCache = { at: Date.now(), data }
          return data
        })
        return zaiInflight.finally(() => {
          zaiInflight = undefined
        })
      },
    })

    await ctx.rpc.register(GoQuota, {
      status: async () => {
        const key = await readGoKey(ctx)
        if (!key) return emptyGo()
        const now = Date.now()
        if (goCache && now - goCache.at < CACHE_MS) return goCache.data
        goInflight ??= fetchGo(key).then((data) => {
          goCache = { at: Date.now(), data }
          return data
        })
        return goInflight.finally(() => {
          goInflight = undefined
        })
      },
    })
  },
})
