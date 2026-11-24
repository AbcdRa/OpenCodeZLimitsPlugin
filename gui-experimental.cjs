// Квоты подписок Z.AI Coding Plan и OpenCode Go для OpenCode Desktop.
//
// Hand-written CommonJS, no bundler: the app provides the shared modules
// (@opencode/plugin/gui, @opencode/plugin/rpc, solid-js) to the plugin, and
// every surface used here accepts plain data or hand-built DOM nodes, so
// nothing needs compiling.
//
// Surfaces:
//   - Slot "session.header": a letter inside a circular SVG progress ring.
//     "z" for Z.AI (5-hour pool), "g" for OpenCode Go (rolling 5-hour window)
//     and "b" for Bothub (prepaid Caps balance), with dynamic color, next to
//     the session title. The circle is filled from the bottom up with the
//     remaining reserve of the longer window (Z.AI weekly; Go weekly or
//     monthly — the tighter one; Bothub — the purchased Caps package).
//   - Commands: palette commands with details toasts for each subscription.
//
// The ring renders only while the routed session's composer model belongs to
// the matching subscription. Quota data comes from the plugin's server part
// over RPC.
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

const goWindowSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    percent: { type: "number" },
    resetsAt: { type: "number" },
  },
  required: ["status", "percent", "resetsAt"],
  additionalProperties: false,
}

const GoQuota = Rpc.define({
  id: "opencode-go-quota",
  methods: {
    status: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          plan: { type: "string" },
          rolling: goWindowSchema,
          weekly: goWindowSchema,
          monthly: goWindowSchema,
        },
        required: ["plan", "rolling", "weekly", "monthly"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

const BothubQuota = Rpc.define({
  id: "bothub-quota",
  methods: {
    status: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          balance: { type: "number" },
          availableBalance: { type: "number" },
          plan: { type: "string" },
          planTokens: { type: "number" },
          planPrice: { type: "number" },
          currency: { type: "string" },
        },
        required: ["balance", "availableBalance", "plan", "planTokens", "planPrice", "currency"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

function countdown(ms) {
  if (!ms || ms <= 0) return ""
  const min = Math.max(1, Math.round(ms / 60000))
  if (min < 60) return min + "мин"
  const h = Math.floor(min / 60)
  if (h < 24) return h + "ч" + (min % 60 ? " " + (min % 60) + "мин" : "")
  return Math.floor(h / 24) + "дн"
}

function usedPct(l) {
  if (!l || !l.usage) return 0
  return Math.min(100, Math.round((l.currentValue / l.usage) * 100))
}

// Отсутствующий или неоплаченный пул приходит с нулями (usage: 0).
function hasData(l) {
  return !!l && (l.usage > 0 || l.remaining > 0)
}

// Окно Go считается доступным, если провайдер его вернул.
function hasGoWindow(w) {
  return !!w && w.status !== "" && w.status !== "unavailable"
}

function hasGo(g) {
  return !!g && [g.rolling, g.weekly, g.monthly].some(hasGoWindow)
}

function goWorstPct(g) {
  if (!g) return 0
  const windows = [g.rolling, g.weekly, g.monthly].filter(hasGoWindow)
  return windows.length ? Math.max.apply(null, windows.map(function (w) { return w.percent })) : 0
}

function colorFor(pct) {
  if (pct >= 80) return "#f7768e" // red — пул почти исчерпан
  if (pct >= 50) return "#e0af68" // amber
  return "#9ece6a" // green
}

// Фон кольца показывает запас «длинного» окна. Из доступных (неделя, месяц)
// берём то, что израсходовано сильнее всего: именно оно исчерпается первым.
// При равенстве — то, у которого раньше сброс.
function pickReserve(windows) {
  const avail = windows.filter(function (w) { return w && w.available })
  if (!avail.length) return undefined
  avail.sort(function (a, b) {
    if (b.used !== a.used) return b.used - a.used
    return (a.resetAt || Infinity) - (b.resetAt || Infinity)
  })
  return avail[0]
}

function reservePct(reserve) {
  return Math.max(0, Math.min(100, 100 - reserve.used))
}

function reserveTip(reserve) {
  return reserve ? " · запас: " + reserve.label + " " + reservePct(reserve) + "%" : ""
}

// Единый формат деталей:
//   OpenCodeGo: 4/100 (5 час, сброс: через 20мин); 23/100 (нед, ...)
//   Zai: 4/1024 (5 час, сброс: через 2ч 24мин); 43/10434 (нед, ...)
function resetPhrase(resetAt) {
  const left = countdown(resetAt - Date.now())
  return "сброс: " + (left ? "через " + left : "—")
}

function segment(label, used, total, resetAt, status) {
  const state = status && status !== "ok" ? ", " + status : ""
  return used + "/" + total + " (" + label + state + ", " + resetPhrase(resetAt) + ")"
}

function zaiSegments(q) {
  const parts = []
  if (hasData(q.fiveHour)) {
    parts.push(segment("5 час", q.fiveHour.currentValue, q.fiveHour.usage, q.fiveHour.nextResetTime))
  }
  if (hasData(q.weekly)) {
    parts.push(segment("нед", q.weekly.currentValue, q.weekly.usage, q.weekly.nextResetTime))
  }
  return parts.join("; ")
}

function goSegments(g) {
  const parts = []
  const add = function (label, w) {
    if (hasGoWindow(w)) parts.push(segment(label, w.percent, 100, w.resetsAt, w.status))
  }
  add("5 час", g.rolling)
  add("нед", g.weekly)
  add("мес", g.monthly)
  return parts.join("; ")
}

// --- Bothub: предоплаченный баланс Caps -------------------------------
function hasBothub(b) {
  return !!b && (b.plan !== "" || b.availableBalance > 0 || b.balance > 0 || b.planTokens > 0)
}

function formatCaps(n) {
  return Math.round(Number(n) || 0).toLocaleString("ru-RU")
}

function bothubAvailable(b) {
  return b.availableBalance > 0 ? b.availableBalance : b.balance
}

function bothubUsedPct(b) {
  if (!b) return 0
  const available = bothubAvailable(b)
  const total = Math.max(b.planTokens, available)
  if (!total) return 0
  return Math.max(0, Math.min(100, Math.round(((total - available) / total) * 100)))
}

function bothubSegments(b) {
  if (!hasBothub(b)) return ""
  const plan = b.plan ? " " + b.plan : ""
  const available = bothubAvailable(b)
  if (b.planTokens > 0) {
    const total = Math.max(b.planTokens, available)
    return formatCaps(available) + "/" + formatCaps(total) + " Caps (остаток, пакет" + plan + ")"
  }
  return formatCaps(available) + " Caps (баланс" + plan + ")"
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v)
  return el
}

// Кольцо-прогресс: буква внутри SVG-круга (трек + дуга использованных %).
// Внутри дополнительно залит остаток длинного окна — снизу вверх, как
// уровень жидкости в баке.
const INNER_R = 7
const INNER_TOP = 10 - INNER_R
const INNER_BOTTOM = 10 + INNER_R
const INNER_H = INNER_BOTTOM - INNER_TOP
let ringSeq = 0

function makeRing() {
  const svg = svgEl("svg", { width: 20, height: 20, viewBox: "0 0 20 20" })
  const tip = svgEl("title")
  // Обрезка по внутреннему кругу, чтобы заливка не заходила под обводку кольца.
  const clipID = "zai-ring-clip-" + ++ringSeq
  const defs = svgEl("defs")
  const clip = svgEl("clipPath", { id: clipID })
  clip.appendChild(svgEl("circle", { cx: 10, cy: 10, r: INNER_R }))
  defs.appendChild(clip)
  // «Стенки бака»: лёгкая подложка, чтобы был виден даже почти полный уровень.
  const base = svgEl("circle", { cx: 10, cy: 10, r: INNER_R, fill: "rgba(127,127,127,0.16)" })
  const fill = svgEl("rect", {
    x: 0,
    y: INNER_BOTTOM,
    width: 20,
    height: 0,
    fill: "transparent",
    "fill-opacity": 0.38,
    "clip-path": "url(#" + clipID + ")",
  })
  // Линия уровня: видна даже при 90–99 % запаса, когда площадь заливки
  // почти не отличается от полного круга.
  const level = svgEl("line", {
    x1: 0,
    x2: 20,
    y1: INNER_BOTTOM,
    y2: INNER_BOTTOM,
    stroke: "transparent",
    "stroke-width": 0.9,
    "stroke-opacity": 0.9,
    "clip-path": "url(#" + clipID + ")",
  })
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
  svg.append(tip, defs, base, fill, level, track, prog, letter)
  return { svg, tip, fill, level, prog, letter, RING_C }
}

// Высота заливки: 100 % запаса = весь видимый внутренний круг, 0 % = пусто.
function applyReserve(fill, level, reserve) {
  if (!reserve) {
    fill.setAttribute("height", "0")
    level.setAttribute("stroke", "transparent")
    return
  }
  const remain = reservePct(reserve)
  const height = (INNER_H * remain) / 100
  const y = INNER_BOTTOM - height
  const color = colorFor(reserve.used)
  fill.setAttribute("fill", color)
  fill.setAttribute("y", String(y))
  fill.setAttribute("height", String(height))
  level.setAttribute("y1", String(y))
  level.setAttribute("y2", String(y))
  level.setAttribute("stroke", color)
}

module.exports = gui.Plugin.define({
  setup(ctx) {
    const [quota, setQuota] = createSignal(undefined)
    const [goQuota, setGoQuota] = createSignal(undefined)
    const [bothubQuota, setBothubQuota] = createSignal(undefined)

    async function refresh() {
      // Провайдеры независимы: ошибка одного не должна скрывать данные другого.
      // ctx.client меняется при перезапуске сервера — читаем в момент вызова.
      const [z, g, b] = await Promise.allSettled([
        ctx.client.rpc(Quota).status({}),
        ctx.client.rpc(GoQuota).status({}),
        ctx.client.rpc(BothubQuota).status({}),
      ])
      if (z.status === "fulfilled") setQuota(z.value)
      if (g.status === "fulfilled") setGoQuota(g.value)
      if (b.status === "fulfilled") setBothubQuota(b.value)
    }

    void refresh()
    const timer = setInterval(refresh, REFRESH_MS)

    function showZaiDetails() {
      const q = quota()
      const text = q ? zaiSegments(q) : ""
      if (!text) {
        ctx.toast.show({ variant: "error", title: "Zai: не удалось получить квоту" })
        return
      }
      const worst = Math.max(usedPct(q.fiveHour), usedPct(q.weekly))
      ctx.toast.show({
        title: "Zai" + (q.level ? " (" + q.level + ")" : ""),
        description: text,
        variant: worst >= 80 ? "error" : "default",
        duration: 8000,
      })
    }

    function showGoDetails() {
      const g = goQuota()
      const text = g && hasGo(g) ? goSegments(g) : ""
      if (!text) {
        ctx.toast.show({ variant: "error", title: "OpenCodeGo: не удалось получить квоту" })
        return
      }
      ctx.toast.show({
        title: "OpenCodeGo" + (g.plan ? " (" + g.plan + ")" : ""),
        description: text,
        variant: goWorstPct(g) >= 80 ? "error" : "default",
        duration: 8000,
      })
    }

    function showBothubDetails() {
      const b = bothubQuota()
      const text = b && hasBothub(b) ? bothubSegments(b) : ""
      if (!text) {
        ctx.toast.show({ variant: "error", title: "Bothub: не удалось получить баланс" })
        return
      }
      ctx.toast.show({
        title: "Bothub" + (b.plan ? " (" + b.plan + ")" : ""),
        description: text,
        variant: bothubUsedPct(b) >= 80 ? "error" : "default",
        duration: 8000,
      })
    }

    // Клик по бейджу — все подписки одним ответом в формате шаблона.
    function showAllDetails() {
      const q = quota()
      const g = goQuota()
      const b = bothubQuota()
      const lines = []
      if (g && hasGo(g)) lines.push("OpenCodeGo: " + goSegments(g))
      if (q && (hasData(q.fiveHour) || hasData(q.weekly))) lines.push("Zai: " + zaiSegments(q))
      if (b && hasBothub(b)) lines.push("Bothub: " + bothubSegments(b))
      if (!lines.length) {
        ctx.toast.show({ variant: "error", title: "Квоты: не удалось получить данные" })
        return
      }
      const worst = Math.max(
        usedPct(q && q.fiveHour),
        usedPct(q && q.weekly),
        goWorstPct(g),
        bothubUsedPct(b && hasBothub(b) ? b : undefined),
      )
      ctx.toast.show({
        title: "Квоты",
        description: lines.join("\n"),
        variant: worst >= 80 ? "error" : "default",
        duration: 10000,
      })
    }

    // --- Заголовок сессии: буква в кольце-прогрессе активной подписки -------
    ctx.add(gui.Slot, {
      at: "session.header",
      order: 10,
      render: (input) => {
        const wrap = document.createElement("span")
        wrap.style.display = "none"
        wrap.style.marginLeft = "8px"
        wrap.style.cursor = "pointer"
        const { svg, tip, fill, level, prog, letter, RING_C } = makeRing()
        wrap.appendChild(svg)
        wrap.addEventListener("click", showAllDetails)
        wrap.addEventListener("mouseenter", () => void refresh())

        createEffect(() => {
          let providerID = ""
          let modelID = ""
          try {
            const model = input.screen.composer.model()
            providerID = String(model?.providerID ?? "")
            modelID = String(model?.modelID ?? model?.id ?? "")
          } catch {
            // модель ещё не выбрана
          }
          // Проверяем Go и Bothub раньше Z.AI: у них тоже бывают модели glm-*.
          const isGo = providerID.startsWith("opencode-go") || providerID === "opencode" || modelID.startsWith("opencode-go/")
          const isBothub = providerID.toLowerCase().includes("bothub") || modelID.toLowerCase().includes("bothub")
          const isZai = providerID.startsWith("zai") || modelID.toLowerCase().startsWith("glm")

          const q = quota()
          const g = goQuota()
          const b = bothubQuota()
          const zaiReady = !!q && (hasData(q.fiveHour) || hasData(q.weekly))
          const goReady = hasGo(g)
          const bothubReady = hasBothub(b)

          let mode = ""
          if (isGo) mode = goReady ? "go" : ""
          else if (isBothub) mode = bothubReady ? "bothub" : ""
          else if (isZai) mode = zaiReady ? "zai" : ""
          else mode = zaiReady ? "zai" : goReady ? "go" : bothubReady ? "bothub" : ""
          wrap.style.display = mode ? "inline-flex" : "none"
          if (!mode) return

          if (mode === "go") {
            const rolling = g.rolling
            const primary = hasGoWindow(rolling) ? rolling : hasGoWindow(g.weekly) ? g.weekly : g.monthly
            const pct = hasGoWindow(primary) ? primary.percent : 0
            const color = colorFor(Math.max(pct, goWorstPct(g)))
            prog.setAttribute("stroke", color)
            prog.setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)))
            letter.textContent = "g"
            letter.setAttribute("fill", color)
            // Фон: неделя или месяц — что израсходовано сильнее.
            const reserve = pickReserve([
              { label: "нед", available: hasGoWindow(g.weekly), used: g.weekly.percent, resetAt: g.weekly.resetsAt },
              { label: "мес", available: hasGoWindow(g.monthly), used: g.monthly.percent, resetAt: g.monthly.resetsAt },
            ])
            applyReserve(fill, level, reserve)
            tip.textContent = "OpenCodeGo: " + goSegments(g) + reserveTip(reserve)
            return
          }

          if (mode === "bothub") {
            const pct = bothubUsedPct(b)
            const color = colorFor(pct)
            prog.setAttribute("stroke", color)
            prog.setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)))
            letter.textContent = "b"
            letter.setAttribute("fill", color)
            // Шкала имеет смысл только когда известен размер пакета.
            const reserve = b.planTokens > 0 ? { label: "пакет", available: true, used: pct } : undefined
            applyReserve(fill, level, reserve)
            tip.textContent = "Bothub: " + bothubSegments(b) + reserveTip(reserve)
            return
          }

          const five = q.fiveHour
          const pct = usedPct(five)
          const color = colorFor(Math.max(pct, usedPct(q.weekly)))
          prog.setAttribute("stroke", color)
          prog.setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)))
          letter.textContent = "z"
          letter.setAttribute("fill", color)
          const reserve = pickReserve([
            { label: "нед", available: hasData(q.weekly), used: usedPct(q.weekly), resetAt: q.weekly.nextResetTime },
          ])
          applyReserve(fill, level, reserve)
          tip.textContent = "Zai: " + zaiSegments(q) + reserveTip(reserve)
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
        showZaiDetails()
      },
    }))

    ctx.add(gui.Command, () => ({
      id: "go-details",
      title: "OpenCode Go: квота",
      group: "OpenCode Go",
      run: async () => {
        await refresh()
        showGoDetails()
      },
    }))

    ctx.add(gui.Command, () => ({
      id: "bothub-details",
      title: "Bothub: баланс",
      group: "Bothub",
      run: async () => {
        await refresh()
        showBothubDetails()
      },
    }))

    return () => clearInterval(timer)
  },
})
