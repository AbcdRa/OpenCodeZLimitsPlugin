import { Rpc } from "@opencode/plugin/rpc"

/**
 * Общий контракт между серверной частью (index.ts) и клиентами (GUI/TUI).
 * id должен совпадать с обеих сторон — матчится по нему, а не по объекту.
 *
 * Схемы намеренно простые: без union-типов (type: [...]) и с явным input,
 * required и events — упрощённые варианты падают в рантайме 2.2.7 с
 * "Object.entries requires that input parameter not be null or undefined".
 * Отсутствующий пул передаётся объектом с нулями (usage: 0), а не null.
 */

export const EMPTY_LIMIT = {
  usage: 0,
  currentValue: 0,
  remaining: 0,
  percentage: 0,
  nextResetTime: 0,
}

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

/** Z.AI Coding Plan: 5-часовой и недельный пулы кредитов. */
export const Quota = Rpc.define({
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

/**
 * OpenCode Go: три окна расхода одной месячной квоты.
 * status: "ok" | "rate-limited" | "unavailable".
 * percent — сколько процентов окна израсходовано (0..100).
 * resetsAt — момент сброса окна в миллисекундах Unix; 0 — неизвестен.
 */
export const EMPTY_GO_WINDOW = {
  status: "unavailable",
  percent: 0,
  resetsAt: 0,
}

export const EMPTY_GO_STATUS = {
  plan: "",
  rolling: { ...EMPTY_GO_WINDOW },
  weekly: { ...EMPTY_GO_WINDOW },
  monthly: { ...EMPTY_GO_WINDOW },
}

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

export const GoQuota = Rpc.define({
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

/**
 * Bothub (bothub.chat): предоплаченный баланс в Caps, без временных окон.
 * balance — сырой баланс, availableBalance — доступно с учётом кредитного лимита,
 * planTokens — размер купленного пакета (0, если план неизвестен).
 */
export const EMPTY_BOTHUB_STATUS = {
  balance: 0,
  availableBalance: 0,
  plan: "",
  planTokens: 0,
  planPrice: 0,
  currency: "RUB",
}

export const BothubQuota = Rpc.define({
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
