import { Rpc } from "@opencode/plugin/rpc"

/**
 * Общий контракт между серверной частью (index.ts) и клиентами (GUI).
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
