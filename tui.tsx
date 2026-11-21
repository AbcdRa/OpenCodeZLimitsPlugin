import { createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { GoQuota, Quota } from "./rpc"

/**
 * Бейдж остатков подписок в футере: Z.AI GLM Coding Plan и OpenCode Go.
 * Показывается квота выбранной модели; если модель не из этих провайдеров —
 * бейдж Z.AI (как раньше), а при отсутствии данных Z.AI — бейдж OpenCode Go.
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
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}м`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}ч${min % 60 ? ` ${min % 60}м` : ""}`
  return `${Math.floor(h / 24)}д ${h % 24}ч`
}

function providerKind(context: any): "zai" | "go" | "" {
  try {
    const model = context.ui.model.current()
    const providerID = String(model?.providerID ?? "")
    const modelID = String(model?.modelID ?? model?.id ?? "")
    // Проверяем Go первым: у opencode-go тоже бывают модели glm-*.
    if (providerID.startsWith("opencode-go") || providerID === "opencode" || modelID.startsWith("opencode-go/")) {
      return "go"
    }
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

export default Plugin.define({
  id: "zai-quota.tui",
  setup(context) {
    const [zai, setZai] = createSignal<QuotaStatus | undefined>(undefined)
    const [go, setGo] = createSignal<GoStatus | undefined>(undefined)
    let timer: ReturnType<typeof setInterval> | undefined

    async function refresh() {
      // Провайдеры независимы: ошибка одного не должна скрывать данные другого.
      const [z, g] = await Promise.allSettled([
        context.client.rpc(Quota).status({}),
        context.client.rpc(GoQuota).status({}),
      ])
      if (z.status === "fulfilled" && z.value) setZai(z.value)
      if (g.status === "fulfilled" && g.value) setGo(g.value)
    }

    void refresh().then(() => {
      timer = setInterval(refresh, REFRESH_MS)
    })

    const Badge = () => {
      const label = createMemo(() => {
        const kind = providerKind(context)
        const z = zai()
        const g = go()
        const zaiReady = !!z && (hasData(z.fiveHour) || hasData(z.weekly))
        const goReady = hasGo(g)

        if (kind === "go") {
          return goReady ? goLabel(g!) : { text: "⚡go нет данных", fg: "#565f89" }
        }
        if (kind === "zai") {
          return zaiReady ? zaiLabel(z!) : { text: "⚡z нет данных", fg: "#565f89" }
        }
        if (zaiReady) return zaiLabel(z!)
        if (goReady) return goLabel(g!)
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
          title: "Квоты: Z.AI и OpenCode Go",
          group: "Квоты",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            await refresh()
            const z = zai()
            const g = go()
            const zaiReady = !!z && (hasData(z.fiveHour) || hasData(z.weekly))
            const goReady = !!g && [g.rolling, g.weekly, g.monthly].some(hasGoWindow)
            if (!zaiReady && !goReady) {
              context.ui.toast.show({ message: "Не удалось получить квоты подписок", variant: "error" })
              return
            }
            const fmtZai = (l?: Limit) =>
              hasData(l)
                ? `${l.currentValue}/${l.usage} кр, ост ${l.remaining}, сброс через ${countdown(l.nextResetTime - Date.now()) || "—"}`
                : "нет данных"
            const fmtGo = (w: GoWindow) =>
              hasGoWindow(w)
                ? `${w.percent}%${w.status !== "ok" ? ` (${w.status})` : ""}, сброс через ${countdown(w.resetsAt - Date.now()) || "—"}`
                : "нет данных"
            const zaiText = zaiReady
              ? `Z.AI Coding Plan${z!.level ? ` (${z!.level})` : ""}: 5ч ${fmtZai(z!.fiveHour)} · нед ${fmtZai(z!.weekly)}`
              : "Z.AI: нет данных"
            const goText = goReady
              ? `OpenCode Go: 5ч ${fmtGo(g!.rolling)} · нед ${fmtGo(g!.weekly)} · мес ${fmtGo(g!.monthly)}`
              : "OpenCode Go: нет данных"
            context.ui.toast.show({
              title: "Квоты подписок",
              message: `${zaiText}\n${goText}`,
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
