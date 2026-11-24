import { createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { BothubQuota, GoQuota, Quota } from "./rpc"

/**
 * Бейдж остатков подписок в футере: Z.AI GLM Coding Plan, OpenCode Go и баланс
 * Bothub. Показывается квота выбранной модели; если модель не из этих
 * провайдеров — бейдж Z.AI (как раньше), затем OpenCode Go, затем Bothub.
 *
 * Данные приходят из серверной части плагина (index.ts) через RPC — там
 * общий кэш на 30 с, поэтому TUI и GUI не дёргают провайдеров по отдельности.
 */

const REFRESH_MS = 60_000

type Limit = {
  usage: number
  currentValue: number
  remaining: number
  percentage: number
  nextResetTime: number
}

type QuotaStatus = {
  level: string
  fiveHour: Limit
  weekly: Limit
}

type GoWindow = {
  status: string
  percent: number
  resetsAt: number
}

type GoStatus = {
  plan: string
  rolling: GoWindow
  weekly: GoWindow
  monthly: GoWindow
}

type BothubStatus = {
  balance: number
  availableBalance: number
  plan: string
  planTokens: number
  planPrice: number
  currency: string
}

function hasData(l: Limit): boolean {
  return !!l && (l.usage > 0 || l.remaining > 0)
}

function usedPct(l?: Limit): number {
  if (!l || !l.usage) return 0
  return Math.min(100, Math.round((l.currentValue / l.usage) * 100))
}

/** Окно OpenCode Go считается доступным, если провайдер его вернул. */
function hasGoWindow(w?: GoWindow): boolean {
  return !!w && w.status !== "" && w.status !== "unavailable"
}

function hasGo(g?: GoStatus): boolean {
  return !!g && [g.rolling, g.weekly, g.monthly].some(hasGoWindow)
}

function goWorstPct(g: GoStatus): number {
  const windows = [g.rolling, g.weekly, g.monthly].filter(hasGoWindow)
  return windows.length ? Math.max(...windows.map((w) => w.percent)) : 0
}

function colorFor(pct: number): string {
  if (pct >= 80) return "#f7768e" // red — пул почти исчерпан
  if (pct >= 50) return "#e0af68" // amber
  return "#9ece6a" // green
}

function countdown(ms: number): string {
  if (!ms || ms <= 0) return ""
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min}мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}ч${min % 60 ? ` ${min % 60}мин` : ""}`
  return `${Math.floor(h / 24)}дн`
}

function resetPhrase(resetAt: number): string {
  const left = countdown(resetAt - Date.now())
  return `сброс: ${left ? `через ${left}` : "—"}`
}

function segment(label: string, used: number, total: number, resetAt: number, status?: string): string {
  const state = status && status !== "ok" ? `, ${status}` : ""
  return `${used}/${total} (${label}${state}, ${resetPhrase(resetAt)})`
}

function zaiSegments(q: QuotaStatus): string {
  const parts: string[] = []
  if (hasData(q.fiveHour)) {
    parts.push(segment("5 час", q.fiveHour.currentValue, q.fiveHour.usage, q.fiveHour.nextResetTime))
  }
  if (hasData(q.weekly)) {
    parts.push(segment("нед", q.weekly.currentValue, q.weekly.usage, q.weekly.nextResetTime))
  }
  return parts.join("; ")
}

function goSegments(g: GoStatus): string {
  const parts: string[] = []
  const add = (label: string, w: GoWindow) => {
    if (hasGoWindow(w)) parts.push(segment(label, w.percent, 100, w.resetsAt, w.status))
  }
  add("5 час", g.rolling)
  add("нед", g.weekly)
  add("мес", g.monthly)
  return parts.join("; ")
}

function hasBothub(b?: BothubStatus): boolean {
  return !!b && (b.plan !== "" || b.availableBalance > 0 || b.balance > 0 || b.planTokens > 0)
}

function formatCaps(n: number): string {
  return Math.round(n || 0).toLocaleString("ru-RU")
}

function bothubAvailable(b: BothubStatus): number {
  return b.availableBalance > 0 ? b.availableBalance : b.balance
}

function bothubUsedPct(b?: BothubStatus): number {
  if (!b) return 0
  const available = bothubAvailable(b)
  const total = Math.max(b.planTokens, available)
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round(((total - available) / total) * 100)))
}

function bothubSegments(b: BothubStatus): string {
  const plan = b.plan ? ` ${b.plan}` : ""
  const available = bothubAvailable(b)
  if (b.planTokens > 0) {
    const total = Math.max(b.planTokens, available)
    return `${formatCaps(available)}/${formatCaps(total)} Caps (остаток, пакет${plan})`
  }
  return `${formatCaps(available)} Caps (баланс${plan})`
}

function providerKind(context: any): "zai" | "go" | "bothub" | "" {
  try {
    const model = context.ui.model.current()
    const providerID = String(model?.providerID ?? "")
    const modelID = String(model?.modelID ?? model?.id ?? "")
    // Проверяем Go и Bothub раньше Z.AI: у них тоже бывают модели glm-*.
    if (providerID.startsWith("opencode-go") || providerID === "opencode" || modelID.startsWith("opencode-go/")) {
      return "go"
    }
    if (providerID.toLowerCase().includes("bothub") || modelID.toLowerCase().includes("bothub")) return "bothub"
    if (providerID.startsWith("zai") || modelID.toLowerCase().startsWith("glm")) return "zai"
  } catch {
    // модель ещё не выбрана или API недоступен
  }
  return ""
}

function zaiLabel(q: QuotaStatus): { text: string; fg: string } {
  const five = q.fiveHour
  const week = q.weekly
  const worst = Math.max(usedPct(five), usedPct(week))
  const rst = hasData(five) ? countdown(five.nextResetTime - Date.now()) : ""
  const fiveTxt = hasData(five) ? `${five.remaining}` : "—"
  const weekTxt = hasData(week) ? `${week.remaining}` : "—"
  return {
    text: `⚡5ч ${fiveTxt}${rst ? ` (${rst})` : ""} · нед ${weekTxt}`,
    fg: colorFor(worst),
  }
}

function goLabel(g: GoStatus): { text: string; fg: string } {
  const fmt = (w: GoWindow) => (hasGoWindow(w) ? `${w.percent}%` : "—")
  const rst = hasGoWindow(g.rolling) ? countdown(g.rolling.resetsAt - Date.now()) : ""
  return {
    text: `⚡go 5ч ${fmt(g.rolling)}${rst ? ` (${rst})` : ""} · нед ${fmt(g.weekly)} · мес ${fmt(g.monthly)}`,
    fg: colorFor(goWorstPct(g)),
  }
}

function bothubLabel(b: BothubStatus): { text: string; fg: string } {
  const pct = bothubUsedPct(b)
  const plan = b.plan ? ` ${b.plan}` : ""
  const gauge = b.planTokens > 0 ? ` · ост. ${100 - pct}%` : ""
  return {
    text: `⚡b ${formatCaps(bothubAvailable(b))} Caps${plan}${gauge}`,
    fg: colorFor(pct),
  }
}

export default Plugin.define({
  id: "zai-quota.tui",
  setup(context) {
    const [zai, setZai] = createSignal<QuotaStatus | undefined>(undefined)
    const [go, setGo] = createSignal<GoStatus | undefined>(undefined)
    const [bothub, setBothub] = createSignal<BothubStatus | undefined>(undefined)
    let timer: ReturnType<typeof setInterval> | undefined

    async function refresh() {
      // Провайдеры независимы: ошибка одного не должна скрывать данные другого.
      const [z, g, b] = await Promise.allSettled([
        context.client.rpc(Quota).status({}),
        context.client.rpc(GoQuota).status({}),
        context.client.rpc(BothubQuota).status({}),
      ])
      if (z.status === "fulfilled" && z.value) setZai(z.value)
      if (g.status === "fulfilled" && g.value) setGo(g.value)
      if (b.status === "fulfilled" && b.value) setBothub(b.value)
    }

    void refresh().then(() => {
      timer = setInterval(refresh, REFRESH_MS)
    })

    const Badge = () => {
      const label = createMemo(() => {
        const kind = providerKind(context)
        const z = zai()
        const g = go()
        const b = bothub()
        const zaiReady = !!z && (hasData(z.fiveHour) || hasData(z.weekly))
        const goReady = hasGo(g)
        const bothubReady = hasBothub(b)

        if (kind === "go") {
          return goReady ? goLabel(g!) : { text: "⚡go нет данных", fg: "#565f89" }
        }
        if (kind === "zai") {
          return zaiReady ? zaiLabel(z!) : { text: "⚡z нет данных", fg: "#565f89" }
        }
        if (kind === "bothub") {
          return bothubReady ? bothubLabel(b!) : { text: "⚡b нет данных", fg: "#565f89" }
        }
        if (zaiReady) return zaiLabel(z!)
        if (goReady) return goLabel(g!)
        if (bothubReady) return bothubLabel(b!)
        return { text: "⚡ нет данных", fg: "#565f89" }
      })

      return <text fg={label().fg}>{label().text}</text>
    }

    // Слоты и keymap-слой OpenCode отслеживает автоматически (scope tracking),
    // поэтому их диспозеры вручную не вызываем — это вызывало WARN в логе
    // ("unregisterCommand is not a function") при горячей перезагрузке плагина.
    context.ui.slot({ append: "home.footer.status", render: () => <Badge /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <Badge /> })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "zai.quota",
          title: "Квоты: Z.AI, Go, Bothub",
          group: "Квоты",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            await refresh()
            const z = zai()
            const g = go()
            const b = bothub()
            const zaiReady = !!z && (hasData(z.fiveHour) || hasData(z.weekly))
            const goReady = !!g && [g.rolling, g.weekly, g.monthly].some(hasGoWindow)
            const bothubReady = hasBothub(b)
            if (!zaiReady && !goReady && !bothubReady) {
              context.ui.toast.show({ message: "Не удалось получить квоты подписок", variant: "error" })
              return
            }
            const lines: string[] = []
            if (goReady) lines.push(`OpenCodeGo: ${goSegments(g!)}`)
            if (zaiReady) lines.push(`Zai: ${zaiSegments(z!)}`)
            if (bothubReady) lines.push(`Bothub: ${bothubSegments(b!)}`)
            context.ui.toast.show({
              title: "Квоты",
              message: lines.join("\n"),
              duration: 10_000,
            })
          },
        },
      ],
    }))

    return () => {
      if (timer) clearInterval(timer)
    }
  },
})
