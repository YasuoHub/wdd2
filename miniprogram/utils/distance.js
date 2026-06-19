const INVALID_DISTANCE_LIMIT = 999000

function getDistanceValue(distance) {
  if (distance === undefined || distance === null || distance === '') return null
  const value = Number(distance)
  if (!Number.isFinite(value) || value < 0 || value >= INVALID_DISTANCE_LIMIT) return null
  return value
}

function formatDistanceText(distance, options = {}) {
  const value = getDistanceValue(distance)
  if (value === null) return options.invalidText || ''
  return value < 1000 ? `${Math.ceil(value)}m` : `${(value / 1000).toFixed(1)}km`
}

module.exports = {
  formatDistanceText,
  getDistanceValue
}
