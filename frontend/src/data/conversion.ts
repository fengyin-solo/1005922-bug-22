// 箱体温度换算比例：传感器原始值 → 台账口径温度。
// v1 是改线前的老标准，v2 是改线后的现行标准。取哪一版在这里统一权衡，
// 页面不各自换算；老记录上的换算结果按当时标准留档，不重写。
export const TEMP_RATIO_VERSIONS: Record<string, number> = {
  v1: 0.8,
  v2: 0.95,
}

// 现行换算线：改线后一律按 v2 出数。
export const CURRENT_RATIO_VERSION = 'v2'

// 既有记录没有版本号时，按当时标准 v1 对待。
export const LEGACY_RATIO_VERSION = 'v1'

export function ratioOf(version: string): number {
  return TEMP_RATIO_VERSIONS[version] ?? TEMP_RATIO_VERSIONS[CURRENT_RATIO_VERSION]
}

export function convertReading(raw: number, version: string): string {
  return (raw * ratioOf(version)).toFixed(1)
}
