// Z.AI Coding Plan quota badge for OpenCode Desktop.
//
// Hand-written CommonJS, no bundler: the app provides the shared modules
// (@opencode/plugin/gui, @opencode/plugin/rpc, solid-js) to the plugin, and
// every surface used here accepts plain data or hand-built DOM nodes, so
// nothing needs compiling.
//
// Surfaces:
//   - Slot "session.header": a "z" letter inside a circular SVG progress ring
//     (5-hour pool usage) with dynamic color, next to the session title.
//   - Command: palette command with a details toast.
//
// The ring renders only while the routed session's composer model
// belongs to the z.ai coding plan (providerID starts with "zai" or modelID
// starts with "glm"). Quota data comes from the plugin's server part over RPC.
//
// NOTE: the Rpc.define here must mirror rpc.ts of the server part — tokens
// match by id, and both schemas must agree on the wire format.

const gui = require("@opencode/plugin/gui")
const { Rpc } = require("@opencode/plugin/rpc")
const { createSignal, createEffect } = require("solid-js")

const REFRESH_MS = 60_000
const SVG_NS = "http://www.w3.org/2000/svg"

const limitSchema = {
  type: "object",
  properties: {
    usage: { type: "number" },
    currentValue: { type: "number" },
    remaining: { type: "number" },
    percentage: { type: "number" },
    nextResetTime: { type: "number" },
  },
  required: ["usage", "currentValue", "remaining", "percentage", "nextResetTime"],
  additionalProperties: false,
}

const Quota = Rpc.define({
  id: "zai-quota",
  methods: {
    status: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          level: { type: "string" },
          fiveHour: limitSchema,
          weekly: limitSchema,
        },
        required: ["level", "fiveHour", "weekly"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

function countdown(ms) {
  if (!ms || ms <= 0) return ""
  const min = Math.round(ms / 60000)
  if (min < 60) return min + "м"
  const h = Math.floor(min / 60)
  if (h < 24) return h + "ч" + (min % 60 ? " " + (min % 60) + "м" : "")
  return Math.floor(h / 24) + "д " + (h % 24) + "ч"
}

function usedPct(l) {
  if (!l || !l.usage) return 0
  return Math.min(100, Math.round((l.currentValue / l.usage) * 100))
}

// Отсутствующий или неоплаченный пул приходит с нулями (usage: 0).
function hasData(l) {
  return !!l && (l.usage > 0 || l.remaining > 0)
}

function colorFor(pct) {
  if (pct >= 80) return "#f7768e" // red — пул почти исчерпан
  if (pct >= 50) return "#e0af68" // amber
  return "#9ece6a" // green
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v)
  return el
}

// Кольцо-прогресс: буква "z" внутри SVG-круга (трек + дуга использованных %).
function makeRing() {
  const svg = svgEl("svg", { width: 20, height: 20, viewBox: "0 0 20 20" })
  const tip = svgEl("title")
  const track = svgEl("circle", { cx: 10, cy: 10, r: 8, fill: "none", stroke: "rgba(127,127,127,0.3)", "stroke-width": 2.5 })
  const RING_C = 2 * Math.PI * 8
  const prog = svgEl("circle", {
    cx: 10,
    cy: 10,
    r: 8,
    fill: "none",
    stroke: "transparent",
    "stroke-width": 2.5,
    "stroke-linecap": "round",
    "stroke-dasharray": RING_C,
    "stroke-dashoffset": RING_C,
    transform: "rotate(-90 10 10)",
  })
  const letter = svgEl("text", {
    x: 10,
    y: 13.3,
    "text-anchor": "middle",
    "font-size": 9.5,
    "font-weight": 700,
    "font-family": "system-ui, sans-serif",
  })
  letter.textContent = "z"
  svg.append(tip, track, prog, letter)
  return { svg, tip, prog, letter, RING_C }
}

module.exports = gui.Plugin.define({
  setup(ctx) {
    const [quota, setQuota] = createSignal(undefined)

    async function refresh() {
      try {
        // ctx.client меняется при перезапуске сервера — читаем в момент вызова.
        setQuota(await ctx.client.rpc(Quota).status({}))
      } catch {
        setQuota(undefined)
      }
    }

    void refresh()
    const timer = setInterval(refresh, REFRESH_MS)

    function showDetails() {
      const q = quota()
      if (!q || (!hasData(q.fiveHour) && !hasData(q.weekly))) {
        ctx.toast.show({ variant: "error", title: "Z.AI: не удалось получить квоту" })
        return
      }
      const fmt = (l) =>
        hasData(l)
          ? l.currentValue + "/" + l.usage + " кр · ост " + l.remaining + " · сброс через " +
            (countdown(l.nextResetTime - Date.now()) || "—")
          : "нет данных"
      const worst = Math.max(usedPct(q.fiveHour), usedPct(q.weekly))
      ctx.toast.show({
        title: "Z.AI Coding Plan" + (q.level ? " (" + q.level + ")" : ""),
        description: "5 часов: " + fmt(q.fiveHour) + "\nНеделя: " + fmt(q.weekly),
        variant: worst >= 80 ? "error" : "default",
        duration: 8000,
      })
    }

    // --- Заголовок сессии: буква "z" в кольце-прогрессе 5-часового пула -----
    ctx.add(gui.Slot, {
      at: "session.header",
      order: 10,
      render: (input) => {
        const wrap = document.createElement("span")
        wrap.style.display = "none"
        wrap.style.marginLeft = "8px"
        wrap.style.cursor = "pointer"
        const { svg, tip, prog, letter, RING_C } = makeRing()
        wrap.appendChild(svg)
        wrap.addEventListener("click", showDetails)
        wrap.addEventListener("mouseenter", () => void refresh())

        createEffect(() => {
          let zai = false
          try {
            const model = input.screen.composer.model()
            zai = !!model && (model.providerID.startsWith("zai") || model.modelID.toLowerCase().startsWith("glm"))
          } catch {
            zai = false
          }
          const q = quota()
          const has = !!q && (hasData(q.fiveHour) || hasData(q.weekly))
          wrap.style.display = zai && has ? "inline-flex" : "none"
          if (!zai || !has) return
          const five = q.fiveHour
          const pct = usedPct(five)
          const color = colorFor(Math.max(pct, usedPct(q.weekly)))
          prog.setAttribute("stroke", color)
          prog.setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)))
          letter.setAttribute("fill", color)
          const rst = countdown(five.nextResetTime - Date.now())
          tip.textContent =
            "Z.AI Coding Plan: 5ч " + five.currentValue + "/" + five.usage + " кр (" + pct + "%)" +
            (rst ? ", сброс через " + rst : "") +
            " · нед " + q.weekly.remaining
        })

        return wrap
      },
    })

    ctx.add(gui.Command, () => ({
      id: "details",
      title: "Z.AI: квота Coding Plan",
      group: "Z.AI",
      run: async () => {
        await refresh()
        showDetails()
      },
    }))

    return () => clearInterval(timer)
  },
})
