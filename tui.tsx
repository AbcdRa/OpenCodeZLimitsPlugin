import { Show, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Quota } from "./rpc"

/**
 * Z.AI GLM Coding Plan quota badge.
 * Shows remaining credits of the 5-hour and weekly pools in the footer.
 *
 * Данные приходят из серверной части плагина (index.ts) через RPC — там
 * общий кэш на 30 с, поэтому TUI и GUI не дёргают api.z.ai по отдельности.
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

function hasData(l: Limit): boolean {
  return !!l && (l.usage > 0 || l.remaining > 0)
}

function usedPct(l?: Limit): number {
  if (!l || !l.usage) return 0
  return Math.min(100, Math.round((l.currentValue / l.usage) * 100))
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

export default Plugin.define({
  id: "zai-quota.tui",
  setup(context) {
    const [quota, setQuota] = createSignal<QuotaStatus | undefined>(undefined)
    let timer: ReturnType<typeof setInterval> | undefined

    async function refresh() {
      try {
        // client создается заново при перезапуске сервера — читаем в момент вызова.
        const data = await context.client.rpc(Quota).status({})
        if (data) setQuota(data)
      } catch {
        // сервер недоступен или RPC не зарегистрирован — оставляем старые данные
      }
    }

    void refresh().then(() => {
      timer = setInterval(refresh, REFRESH_MS)
    })

    const Badge = () => (
      <Show when={quota()} keyed fallback={<text fg="#565f89">⚡ нет данных</text>}>
        {(q) => {
          const five = q.fiveHour
          const week = q.weekly
          if (!hasData(five) && !hasData(week)) return <text fg="#565f89">⚡ нет данных</text>
          const worst = Math.max(usedPct(five), usedPct(week))
          const rst = hasData(five) ? countdown(five.nextResetTime - Date.now()) : ""
          const fiveTxt = hasData(five) ? `${five.remaining}` : "—"
          const weekTxt = hasData(week) ? `${week.remaining}` : "—"
          return (
            <text fg={colorFor(worst)}>
              {`⚡5ч ${fiveTxt}${rst ? ` (${rst})` : ""} · нед ${weekTxt}`}
            </text>
          )
        }}
      </Show>
    )

    // Слоты и keymap-слой OpenCode отслеживает автоматически (scope tracking),
    // поэтому их дипозеры вручную не вызываем — это вызывало WARN в логе
    // ("unregisterCommand is not a function") при горячей перезагрузке плагина.
    context.ui.slot({ append: "home.footer.status", render: () => <Badge /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <Badge /> })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "zai.quota",
          title: "Z.AI: quota details",
          group: "Z.AI",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            await refresh()
            const q = quota()
            if (!q || (!hasData(q.fiveHour) && !hasData(q.weekly))) {
              context.ui.toast.show({ message: "z.ai: не удалось получить квоту", variant: "error" })
              return
            }
            const fmt = (l?: Limit) =>
              hasData(l)
                ? `${l.currentValue}/${l.usage} кр, ост ${l.remaining}, сброс через ${countdown(l.nextResetTime - Date.now()) || "—"}`
                : "нет данных"
            context.ui.toast.show({
              title: `Z.AI Coding Plan${q.level ? ` (${q.level})` : ""}`,
              message: `5 часов: ${fmt(q.fiveHour)}\nНеделя: ${fmt(q.weekly)}`,
              duration: 8000,
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
