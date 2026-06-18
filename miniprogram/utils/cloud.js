const pendingCalls = {}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return '[' + value.map(item => stableStringify(item)).join(',') + ']'
  }

  return '{' + Object.keys(value).sort().map(key => {
    return JSON.stringify(key) + ':' + stableStringify(value[key])
  }).join(',') + '}'
}

function buildDedupeKey(options) {
  if (options.dedupeKey) return options.dedupeKey
  return `${options.name}:${stableStringify(options.data || {})}`
}

function callCloudFunction(options) {
  const callOptions = { ...(options || {}) }
  const dedupe = !!callOptions.dedupe
  const dedupeKey = buildDedupeKey(callOptions)

  delete callOptions.dedupe
  delete callOptions.dedupeKey

  if (!callOptions.name) {
    return Promise.reject(new Error('cloud function name is required'))
  }

  if (dedupe && pendingCalls[dedupeKey]) {
    return pendingCalls[dedupeKey]
  }

  const promise = wx.cloud.callFunction(callOptions).catch(err => {
    console.error(`[cloud] ${callOptions.name} \u8c03\u7528\u5931\u8d25:`, err)
    throw err
  })

  if (!dedupe) {
    return promise
  }

  pendingCalls[dedupeKey] = promise.finally(() => {
    delete pendingCalls[dedupeKey]
  })

  return pendingCalls[dedupeKey]
}

module.exports = {
  callCloudFunction
}
