const fs = require('fs')
const path = require('path')
const { TextDecoder } = require('util')

const root = path.resolve(__dirname, '..')
const textExtensions = new Set(['.js', '.json', '.wxml', '.wxs', '.wxss'])
const ignoreDirs = new Set(['node_modules', 'miniprogram_npm'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const failures = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) walk(fullPath)
      continue
    }

    if (!textExtensions.has(path.extname(entry.name))) continue
    checkFile(fullPath)
  }
}

function checkFile(filePath) {
  const bytes = fs.readFileSync(filePath)
  const rel = path.relative(root, filePath).replace(/\\/g, '/')
  const reasons = []

  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    reasons.push('包含 UTF-8 BOM，微信开发者工具可能编译为非法字符')
  }

  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    reasons.push('文件是 UTF-16 LE，请改为 UTF-8 无 BOM')
  }

  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    reasons.push('文件是 UTF-16 BE，请改为 UTF-8 无 BOM')
  }

  if (bytes.includes(0x00)) {
    reasons.push('包含 NUL 字节，疑似非 UTF-8 文本')
  }

  try {
    const text = decoder.decode(bytes)
    if (text.includes('\uFFFD')) {
      reasons.push('包含乱码替代字符 U+FFFD')
    }
  } catch (err) {
    reasons.push('不是合法 UTF-8 文本')
  }

  if (reasons.length > 0) {
    failures.push({ file: rel, reasons })
  }
}

walk(root)

if (failures.length > 0) {
  console.error('小程序文本编码检查失败：')
  for (const item of failures) {
    console.error(`- ${item.file}`)
    for (const reason of item.reasons) {
      console.error(`  - ${reason}`)
    }
  }
  process.exit(1)
}

console.log('小程序文本编码检查通过：UTF-8 无 BOM，未发现非法字符。')
