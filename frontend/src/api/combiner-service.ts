import {
  CURRENT_RATIO_VERSION,
  LEGACY_RATIO_VERSION,
  TEMP_RATIO_VERSIONS,
  convertReading,
} from '@/data/conversion'
import { listRows, saveModuleRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 汇流箱的领域规则都收在这里：销账事务、同源校验、越级驳回、专责校验、
// 换算改线重算、复核台账对账。页面组件不做业务判断，只调这里的函数。

const COMBINER_KEY = 'combiner'
const PATROL_KEY = 'patrol'

// 在办异常的类型与默认来源标记：两条异常是否同源，就靠来源标记校验。
type AnomalyType = '温升' | '绝缘异常'
type Anomaly = { seq: number; type: AnomalyType; origin: string; recordedAt: string }

const ANOMALY_ORIGIN: Record<AnomalyType, string> = {
  温升: '温度越限',
  绝缘异常: '受潮疑似',
}

export type LedgerRecon = {
  openBoxes: number
  cleared: number
  ledger: number
  pendingReview: number
  match: boolean
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function today(): string {
  return now().slice(0, 10)
}

// 解析在办异常清单。兼容既有汇流箱记录：老记录没有这一格，
// 按当前状态补一条出来，保证销账能一次清到，不丢老账。
function parseAnomalies(row: EntryRow): Anomaly[] {
  const raw = row['在办异常']
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const list = JSON.parse(raw) as Anomaly[]
      if (Array.isArray(list)) {
        return list.filter((item) => item && typeof item.type === 'string')
      }
    } catch {
      // 老数据这一格不是 JSON，落到下面的状态推断
    }
  }
  const status = String(row.status ?? '')
  if (status === '温度偏高') {
    return [{ seq: 1, type: '温升', origin: ANOMALY_ORIGIN['温升'], recordedAt: '老记录未留档' }]
  }
  if (status === '绝缘异常') {
    return [{ seq: 1, type: '绝缘异常', origin: ANOMALY_ORIGIN['绝缘异常'], recordedAt: '老记录未留档' }]
  }
  return []
}

function findBox(rows: EntryRow[], id: number): { row: EntryRow; index: number } | null {
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? null : { row: rows[index], index }
}

function describeAnomaly(item: Anomaly): string {
  return `第${item.seq}条（${item.type}，${item.recordedAt} 登记）`
}

// 页面上“在办异常”列的摘要：温升×2、绝缘异常×1。
export function summarizeAnomalies(row: EntryRow): string {
  const open = parseAnomalies(row)
  if (open.length === 0) {
    return '—'
  }
  const temp = open.filter((item) => item.type === '温升').length
  const insulation = open.filter((item) => item.type === '绝缘异常').length
  const parts: string[] = []
  if (temp > 0) parts.push(`温升×${temp}`)
  if (insulation > 0) parts.push(`绝缘异常×${insulation}`)
  return parts.join('、')
}

// 读数红格标记：有在办温升的箱子，箱体温度那格标红；有在办绝缘异常的，绝缘阻值标红。
export function readingFlags(row: EntryRow): { temp: boolean; insulation: boolean } {
  const open = parseAnomalies(row)
  return {
    temp: open.some((item) => item.type === '温升'),
    insulation: open.some((item) => item.type === '绝缘异常'),
  }
}

// 登记温升。已安排绝缘检测的箱子不许再记温升：当场驳回，说明在办的是哪一条，
// 并校验两条异常是否同源。同一台箱子已有同源温升在办的，不重复记账。
function recordTempRise(id: number): ActionResult {
  const rows = listRows(COMBINER_KEY)
  const found = findBox(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的直流汇流箱` }
  }
  const { row, index } = found
  const code = String(row['汇流箱编号'] ?? id)
  if (row.status === '已停用') {
    return { ok: false, message: `${code} 已停用，不再登记温升` }
  }
  const open = parseAnomalies(row)
  const insulation = open.find((item) => item.type === '绝缘异常')
  if (insulation) {
    const sameOrigin = insulation.origin === ANOMALY_ORIGIN['温升']
    return {
      ok: false,
      message: `越级驳回：${code} 已安排绝缘检测，在办${describeAnomaly(insulation)}，与本次温升登记${sameOrigin ? '同源' : '不同源'}；检测办结前不许再记温升`,
    }
  }
  const duplicate = open.find((item) => item.type === '温升' && item.origin === ANOMALY_ORIGIN['温升'])
  if (duplicate) {
    return {
      ok: false,
      message: `驳回：${code} 已有同源温升在办，${describeAnomaly(duplicate)}，同一台箱子不重复记账`,
    }
  }
  const anomaly: Anomaly = {
    seq: open.length + 1,
    type: '温升',
    origin: ANOMALY_ORIGIN['温升'],
    recordedAt: now(),
  }
  const raw = Number(row['箱体温度'])
  const updated: EntryRow = {
    ...row,
    status: '温度偏高',
    pending: true,
    abnormal: true,
    箱体状态: '偏高',
    在办异常: JSON.stringify([...open, anomaly]),
    换算结果: Number.isFinite(raw) ? convertReading(raw, CURRENT_RATIO_VERSION) : '',
    换算比例版本: CURRENT_RATIO_VERSION,
  }
  const next = [...rows]
  next[index] = updated
  saveModuleRows({ [COMBINER_KEY]: next })
  return { ok: true, message: `${code} 已登记温升（第${anomaly.seq}条），换算结果按 ${CURRENT_RATIO_VERSION} 线留存` }
}

// 安排绝缘检测。在办的检测不重复安排。
function scheduleInsulationTest(id: number): ActionResult {
  const rows = listRows(COMBINER_KEY)
  const found = findBox(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的直流汇流箱` }
  }
  const { row, index } = found
  const code = String(row['汇流箱编号'] ?? id)
  if (row.status === '已停用') {
    return { ok: false, message: `${code} 已停用，不再安排绝缘检测` }
  }
  const open = parseAnomalies(row)
  const existing = open.find((item) => item.type === '绝缘异常')
  if (existing) {
    return { ok: false, message: `驳回：${code} 的绝缘检测已在办，${describeAnomaly(existing)}，不重复安排` }
  }
  const anomaly: Anomaly = {
    seq: open.length + 1,
    type: '绝缘异常',
    origin: ANOMALY_ORIGIN['绝缘异常'],
    recordedAt: now(),
  }
  const updated: EntryRow = {
    ...row,
    status: '绝缘异常',
    pending: true,
    abnormal: true,
    箱体状态: '异常',
    上次绝缘检测日: today(),
    在办异常: JSON.stringify([...open, anomaly]),
  }
  const next = [...rows]
  next[index] = updated
  saveModuleRows({ [COMBINER_KEY]: next })
  return { ok: true, message: `${code} 已安排绝缘检测（第${anomaly.seq}条），检测日记为 ${today()}` }
}

// 确认恢复（销账）。箱体温度、绝缘阻值、箱体状态写进同一笔，连同清掉全部在办异常、
// 抹掉残留的换算结果；销账结论同一笔落到巡检的复核台账。写不进去就整笔回退，不清到一半。
// 重复提交只认头一回的处理时间，不再改动。
function clearCombiner(id: number, operator: string): ActionResult {
  const rows = listRows(COMBINER_KEY)
  const found = findBox(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的直流汇流箱` }
  }
  const { row, index } = found
  const code = String(row['汇流箱编号'] ?? id)
  if (row.status === '已停用') {
    return { ok: false, message: `${code} 已停用，不走销账` }
  }
  const open = parseAnomalies(row)
  const processedAt = typeof row['恢复处理时间'] === 'string' ? String(row['恢复处理时间']) : ''
  if (open.length === 0) {
    if (processedAt) {
      return { ok: true, message: `${code} 已于 ${processedAt} 销账，重复提交只认头一回的处理时间，不再改动` }
    }
    return { ok: false, message: `${code} 当前没有在办异常，无需销账` }
  }
  // 一笔里要写的所有内容先算好，再统一落库：任何一步写不进去，整笔回退。
  const clearedTemp = open.filter((item) => item.type === '温升').length
  const clearedInsulation = open.filter((item) => item.type === '绝缘异常').length
  const handledAt = processedAt || now()
  const lastTestDay = String(row['上次绝缘检测日'] ?? '')
  const updated: EntryRow = {
    ...row,
    status: '正常',
    pending: false,
    abnormal: false,
    箱体状态: '正常',
    箱体温度: '38.0',
    绝缘阻值: '2.0',
    在办异常: '[]',
    换算结果: '', // 残留的换算结果一并抹掉，旧读数不许显示成正常
    恢复处理时间: handledAt, // 只认头一回的处理时间
  }
  if (clearedInsulation > 0 && lastTestDay) {
    updated['绝缘读数起算日'] = lastTestDay // 绝缘读数从上一次检测的日子补起
  }
  const parts: string[] = []
  if (clearedTemp > 0) parts.push(`温升×${clearedTemp}`)
  if (clearedInsulation > 0) parts.push(`绝缘异常×${clearedInsulation}`)
  const conclusion = [
    `${code} 销账：一次清掉${parts.join('、')}，箱体温度/绝缘阻值/箱体状态已同笔复位`,
    clearedInsulation > 0 && lastTestDay ? `绝缘读数自上次检测日 ${lastTestDay} 补起` : '',
    `处理时间 ${handledAt}`,
  ]
    .filter(Boolean)
    .join('；')

  // 销账结论落到巡检的复核台账，与汇流箱记录同一笔写入，两处在办台数才对得上。
  const patrolRows = listRows(PATROL_KEY)
  const ledgerId = patrolRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const ledger: EntryRow = {
    id: ledgerId,
    status: '待复核',
    pending: true,
    abnormal: false,
    巡视单号: `RECHK-${code}-${ledgerId}`,
    巡视路线: String(row['所属方阵'] ?? ''),
    巡视人员: operator,
    巡视日期: today(),
    检查项数: open.length,
    异常项数: open.length,
    巡视时长: '—',
    巡视状态: '销账复核',
    销账结论: conclusion,
    关联汇流箱: code,
  }
  const nextCombiner = [...rows]
  nextCombiner[index] = updated
  try {
    saveModuleRows({ [COMBINER_KEY]: nextCombiner, [PATROL_KEY]: [...patrolRows, ledger] })
  } catch (error) {
    return {
      ok: false,
      message: `销账写入失败，已整笔回退，没有清到一半：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, message: `${conclusion}；结论已落巡检复核台账（${String(ledger['巡视单号'])}）` }
}

// 汇流箱行内动作的统一入口。
export function runCombinerAction(id: number, action: string, operator: string): ActionResult {
  switch (action) {
    case '登记温升':
      return recordTempRise(id)
    case '安排绝缘检测':
      return scheduleInsulationTest(id)
    case '确认恢复':
      return clearCombiner(id, operator)
    default:
      return { ok: false, message: `直流汇流箱没有登记「${action}」这个动作` }
  }
}

// 变更熔断器规格：只归本方阵的专责管，其他人一律驳回。
export function updateFuseSpec(id: number, spec: string, operator: string): ActionResult {
  const rows = listRows(COMBINER_KEY)
  const found = findBox(rows, id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的直流汇流箱` }
  }
  const { row, index } = found
  const code = String(row['汇流箱编号'] ?? id)
  const owner = String(row['方阵专责'] ?? '')
  if (!owner || operator !== owner) {
    return { ok: false, message: `驳回：${code} 的熔断器规格只归本方阵专责（${owner || '未登记'}）管，当前操作人 ${operator} 无权变更` }
  }
  if (!spec.trim()) {
    return { ok: false, message: '熔断器规格不能为空' }
  }
  const next = [...rows]
  next[index] = { ...row, 熔断器规格: spec.trim() }
  saveModuleRows({ [COMBINER_KEY]: next })
  return { ok: true, message: `${code} 熔断器规格已由专责 ${operator} 变更为 ${spec.trim()}` }
}

// 换算改线重算：已换算的结果照新线过一遍，老结果按当时标准留档；
// 没有缓存换算的老记录不动，按当时标准留档。
export function reconvertCombinerReadings(): ActionResult {
  const rows = listRows(COMBINER_KEY)
  let count = 0
  const next = rows.map((row) => {
    const cached = String(row['换算结果'] ?? '')
    if (cached === '') {
      return row
    }
    const version = String(row['换算比例版本'] || LEGACY_RATIO_VERSION)
    if (version === CURRENT_RATIO_VERSION) {
      return row
    }
    const raw = Number(row['箱体温度'])
    if (!Number.isFinite(raw)) {
      return row
    }
    const history = String(row['历史换算'] ?? '')
    const archived = `${version}:${cached}`
    count += 1
    return {
      ...row,
      历史换算: history ? `${history};${archived}` : archived,
      换算结果: convertReading(raw, CURRENT_RATIO_VERSION),
      换算比例版本: CURRENT_RATIO_VERSION,
    }
  })
  if (count > 0) {
    saveModuleRows({ [COMBINER_KEY]: next })
  }
  return {
    ok: true,
    message: `已按新线 ${CURRENT_RATIO_VERSION}（比例 ${TEMP_RATIO_VERSIONS[CURRENT_RATIO_VERSION]}）重算 ${count} 台箱子的换算结果，老结果已按当时标准留档`,
  }
}

// 两处对账：汇流箱侧已销账台数 ↔ 巡检复核台账条数，必须对得上。
export function combinerLedgerRecon(): LedgerRecon {
  const combiner = listRows(COMBINER_KEY)
  const patrol = listRows(PATROL_KEY)
  const openBoxes = combiner.filter((row) => parseAnomalies(row).length > 0).length
  const cleared = combiner.filter((row) => String(row['恢复处理时间'] ?? '') !== '').length
  const ledgerRows = patrol.filter((row) => String(row['巡视状态'] ?? '') === '销账复核')
  const pendingReview = ledgerRows.filter((row) => row.status === '待复核').length
  return { openBoxes, cleared, ledger: ledgerRows.length, pendingReview, match: cleared === ledgerRows.length }
}
