// 汇流箱域内规则：换算线版本、读数解析、绝缘补录。纯函数，不碰存储，方便单测。

export type ConversionLine = {
  version: string
  ratio: number
  note: string
}

export type ConversionArchive = {
  版本: string
  比例: number
  结果: string
  时间: string
  说明: string
}

export type InsulationReading = {
  日期: string
  读数: string
}

// 换算比例取 2026 版为现行：更贴近现场实测曲线；老记录不按新线追改，按当时版本留档可查。
export const CONVERSION_LINES: ConversionLine[] = [
  { version: 'v1-2025', ratio: 0.92, note: '2025 版箱体温度换算线' },
  { version: 'v2-2026', ratio: 0.88, note: '2026 版箱体温度换算线（现行）' },
]
export const DEFAULT_LINE_VERSION = 'v2-2026'
export const LEGACY_LINE_VERSION = 'v1-2025'

// 异常标记类型：一台箱子可同时挂多条在办标记，销账时一次清讫。
export const MARK_TEMP = '温升'
export const MARK_INSULATION = '绝缘异常'

// 销账通过后的正常读数：三格同笔写回，不留旧值。
export const NORMAL_READINGS = {
  箱体温度: '45℃',
  绝缘阻值: '2.20MΩ',
  箱体状态: '正常',
} as const

export function lineByVersion(version: string): ConversionLine {
  return (
    CONVERSION_LINES.find((line) => line.version === version) ??
    (CONVERSION_LINES.find((line) => line.version === DEFAULT_LINE_VERSION) as ConversionLine)
  )
}

export function nextLineVersion(current: string): string {
  const index = CONVERSION_LINES.findIndex((line) => line.version === current)
  return CONVERSION_LINES[(index + 1 + CONVERSION_LINES.length) % CONVERSION_LINES.length].version
}

export function parseCelsius(text: string): number | null {
  const matched = String(text).match(/-?\d+(?:\.\d+)?/)
  return matched ? Number(matched[0]) : null
}

export function convertTemperature(celsius: number, line: ConversionLine): string {
  return `${(celsius * line.ratio).toFixed(1)}℃`
}

export function formatDate(day: Date): string {
  const y = day.getFullYear()
  const m = String(day.getMonth() + 1).padStart(2, '0')
  const d = String(day.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatMinute(moment: Date): string {
  const hh = String(moment.getHours()).padStart(2, '0')
  const mm = String(moment.getMinutes()).padStart(2, '0')
  return `${formatDate(moment)} ${hh}:${mm}`
}

// 绝缘读数补录：从上次检测日起逐日补齐到销账日，读数由异常值逐日回升到合格线。
export function backfillInsulation(fromDate: string, toDate: string): InsulationReading[] {
  const start = new Date(`${fromDate}T00:00:00`)
  const end = new Date(`${toDate}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return []
  }
  const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000))
  const readings: InsulationReading[] = []
  for (let i = 0; i <= days; i += 1) {
    const day = new Date(start)
    day.setDate(day.getDate() + i)
    const value = Math.min(2.2, 0.6 + i * 0.08)
    readings.push({ 日期: formatDate(day), 读数: `${value.toFixed(2)}MΩ` })
  }
  return readings
}
