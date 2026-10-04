import {
  DEFAULT_LINE_VERSION,
  LEGACY_LINE_VERSION,
  MARK_INSULATION,
  MARK_TEMP,
  NORMAL_READINGS,
  backfillInsulation,
  convertTemperature,
  formatDate,
  formatMinute,
  lineByVersion,
  nextLineVersion,
  parseCelsius,
} from '@/data/combiner-rules'
import type { ConversionArchive, ConversionLine, InsulationReading } from '@/data/combiner-rules'
import { allRows, cloneRows, listRows, resetRows, saveAll } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 汇流箱域存储：主表仍是 combiner，异常标记与换算线设置各自成册，同笔事务一起落库。
export const MARK_BUCKET = 'combiner_mark'
export const SETTING_BUCKET = 'combiner_setting'

export type Reconciliation = {
  combinerPending: number
  patrolOpen: number
  matched: boolean
}

export type CombinerDetail = {
  row: EntryRow
  marks: EntryRow[]
  archives: ConversionArchive[]
  readings: InsulationReading[]
  line: ConversionLine
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(value ?? '')) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function boxCode(row: EntryRow): string {
  return String(row.汇流箱编号 ?? '')
}

function openMarksOf(marks: EntryRow[], code: string): EntryRow[] {
  return marks.filter((mark) => String(mark.汇流箱编号) === code && mark.status === '在办')
}

function makeMark(id: number, code: string, type: string, source: string, at: string): EntryRow {
  return {
    id,
    status: '在办',
    pending: true,
    abnormal: true,
    汇流箱编号: code,
    标记类型: type,
    来源: source,
    登记时间: at,
    销账时间: '',
    复核状态: '',
    同源校验: '',
  }
}

function activeLine(): ConversionLine {
  const setting = listRows(SETTING_BUCKET)[0]
  return lineByVersion(String(setting?.现行换算线 ?? DEFAULT_LINE_VERSION))
}

export function conversionLineInfo(): ConversionLine {
  ensureCombinerMigration()
  return activeLine()
}

// 兼容既有汇流箱记录：老记录缺的新字段补齐，异常箱的旧读数不许再显示成正常，
// 已有换算结果按当时版本补一条留档。幂等，每次读写前都可安全调用。
export function ensureCombinerMigration(): void {
  const rows = listRows('combiner')
  const marks = listRows(MARK_BUCKET)
  let changed = false

  const nextRows = rows.map((row) => {
    if (row.换算版本 !== undefined && row.绝缘读数台账 !== undefined) {
      return row
    }
    changed = true
    const next: EntryRow = { ...row }
    next.换算版本 = String(next.换算版本 ?? LEGACY_LINE_VERSION)
    next.温度换算结果 = String(next.温度换算结果 ?? '')
    next.换算留档 = String(next.换算留档 ?? '[]')
    next.绝缘读数台账 = String(next.绝缘读数台账 ?? '[]')
    next.恢复处理时间 = String(next.恢复处理时间 ?? '')
    next.上次绝缘检测日 = String(next.上次绝缘检测日 ?? '') || '2026-09-01'
    next.方阵专责 = String(next.方阵专责 ?? '')
    if (next.status === '温度偏高' || next.status === '绝缘异常') {
      next.箱体状态 = String(next.status)
      if (next.status === '温度偏高' && parseCelsius(String(next.箱体温度 ?? '')) === null) {
        next.箱体温度 = '待复核'
      }
      if (next.status === '绝缘异常' && parseCelsius(String(next.绝缘阻值 ?? '')) === null) {
        next.绝缘阻值 = '待复核'
      }
    }
    const archives = parseJsonField<ConversionArchive[]>(next.换算留档, [])
    if (next.温度换算结果 && archives.length === 0) {
      next.换算留档 = JSON.stringify([
        {
          版本: LEGACY_LINE_VERSION,
          比例: lineByVersion(LEGACY_LINE_VERSION).ratio,
          结果: String(next.温度换算结果),
          时间: String(next.上次绝缘检测日),
          说明: '老记录按当时标准留档',
        },
      ])
    }
    return next
  })

  const nextMarks = [...marks]
  for (const row of nextRows) {
    if (row.status !== '温度偏高' && row.status !== '绝缘异常') {
      continue
    }
    const code = boxCode(row)
    if (openMarksOf(nextMarks, code).length === 0) {
      changed = true
      const type = row.status === '温度偏高' ? MARK_TEMP : MARK_INSULATION
      nextMarks.push(makeMark(nextId(nextMarks), code, type, '历史遗留', String(row.上次绝缘检测日)))
    }
  }

  const settingMissing = listRows(SETTING_BUCKET).length === 0
  if (!changed && !settingMissing) {
    return
  }
  const draft = cloneRows(allRows())
  draft.combiner = nextRows
  draft[MARK_BUCKET] = nextMarks
  if (settingMissing) {
    draft[SETTING_BUCKET] = [
      {
        id: 1,
        status: '现行',
        pending: false,
        abnormal: false,
        现行换算线: DEFAULT_LINE_VERSION,
        改线时间: '',
        改线人: '',
      },
    ]
  }
  saveAll(draft)
}

// 登记温升：已安排绝缘检测的箱子越级登记当场驳回，并校验两条异常是否同源。
export function registerTempRise(
  id: number,
  temperatureC: number,
  source: string,
  operator: string,
  now: Date = new Date(),
): ActionResult {
  ensureCombinerMigration()
  const rows = listRows('combiner')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的直流汇流箱`)
  }
  const code = boxCode(row)
  if (!Number.isFinite(temperatureC) || temperatureC <= 0) {
    return fail(`已驳回：${code} 温升登记的温度值「${temperatureC}」无效`)
  }
  if (row.status === '已停用') {
    return fail(`已驳回：${code} 已停用，不再登记温升`)
  }
  const openMarks = openMarksOf(listRows(MARK_BUCKET), code)
  const insulationOpen = openMarks.find((mark) => String(mark.标记类型) === MARK_INSULATION)
  if (insulationOpen) {
    const sameSource = String(insulationOpen.来源) === source
    const check = sameSource
      ? `同源（同为 ${source}），无需重复登记`
      : `不同源（本次 ${source} / 在办 ${String(insulationOpen.来源)}），仍须先办结绝缘检测`
    return fail(
      `已驳回：${code} 绝缘检测在办（标记#${insulationOpen.id}，来源 ${String(insulationOpen.来源)}，` +
        `${String(insulationOpen.登记时间)} 登记），温升登记越级不予受理；同源校验：${check}`,
    )
  }
  const tempOpen = openMarks.find((mark) => String(mark.标记类型) === MARK_TEMP)
  if (tempOpen) {
    return fail(
      `已驳回：${code} 已有在办温升标记#${tempOpen.id}（${String(tempOpen.登记时间)} 登记），不得重复记录`,
    )
  }

  const line = activeLine()
  const at = formatMinute(now)
  const draft = cloneRows(allRows())
  const index = draft.combiner.findIndex((item) => Number(item.id) === id)
  draft.combiner[index] = {
    ...draft.combiner[index],
    status: '温度偏高',
    pending: true,
    abnormal: true,
    箱体温度: `${temperatureC}℃`,
    箱体状态: '温度偏高',
    温度换算结果: convertTemperature(temperatureC, line),
    换算版本: line.version,
    恢复处理时间: '',
  }
  draft[MARK_BUCKET] = [...(draft[MARK_BUCKET] ?? []), makeMark(nextId(draft[MARK_BUCKET] ?? []), code, MARK_TEMP, source, at)]
  try {
    saveAll(draft)
  } catch (error) {
    return fail(`温升登记写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    ok: true,
    message: `${code} 已登记温升：箱体温度 ${temperatureC}℃，按 ${line.version} 换算为 ${convertTemperature(temperatureC, line)}（操作人 ${operator}）`,
  }
}

// 安排绝缘检测：温度偏高可升级为绝缘异常，温升标记保留在办，销账时同笔清讫。
export function scheduleInsulation(
  id: number,
  resistanceMohm: number,
  source: string,
  operator: string,
  now: Date = new Date(),
): ActionResult {
  ensureCombinerMigration()
  const rows = listRows('combiner')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的直流汇流箱`)
  }
  const code = boxCode(row)
  if (!Number.isFinite(resistanceMohm) || resistanceMohm <= 0) {
    return fail(`已驳回：${code} 绝缘检测的阻值「${resistanceMohm}」无效`)
  }
  if (row.status === '已停用') {
    return fail(`已驳回：${code} 已停用，不再安排绝缘检测`)
  }
  const openMarks = openMarksOf(listRows(MARK_BUCKET), code)
  const insulationOpen = openMarks.find((mark) => String(mark.标记类型) === MARK_INSULATION)
  if (insulationOpen) {
    return fail(
      `已驳回：${code} 绝缘检测已在办（标记#${insulationOpen.id}，${String(insulationOpen.登记时间)} 登记），不得重复安排`,
    )
  }

  const at = formatMinute(now)
  const tempOpen = openMarks.find((mark) => String(mark.标记类型) === MARK_TEMP)
  const draft = cloneRows(allRows())
  const index = draft.combiner.findIndex((item) => Number(item.id) === id)
  draft.combiner[index] = {
    ...draft.combiner[index],
    status: '绝缘异常',
    pending: true,
    abnormal: true,
    绝缘阻值: `${resistanceMohm}MΩ`,
    箱体状态: '绝缘异常',
    恢复处理时间: '',
  }
  draft[MARK_BUCKET] = [
    ...(draft[MARK_BUCKET] ?? []),
    makeMark(nextId(draft[MARK_BUCKET] ?? []), code, MARK_INSULATION, source, at),
  ]
  try {
    saveAll(draft)
  } catch (error) {
    return fail(`绝缘检测登记写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  const escalate = tempOpen ? `，温升标记#${tempOpen.id} 一并在办，销账时同笔清讫` : ''
  return {
    ok: true,
    message: `${code} 已安排绝缘检测：绝缘阻值 ${resistanceMohm}MΩ（操作人 ${operator}）${escalate}`,
  }
}

// 确认恢复（销账）：箱体温度、绝缘阻值、箱体状态同笔写回正常，在办标记一次清讫，
// 残留换算结果一并抹掉，结论落巡检复核台账。任何一步写不进去，整笔回退。
// 重复提交只认头一回的处理时间，不再改动数据。
export function writeOffCombiner(id: number, operator: string, now: Date = new Date()): ActionResult {
  ensureCombinerMigration()
  const rows = listRows('combiner')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的直流汇流箱`)
  }
  const code = boxCode(row)
  if (row.status === '已停用') {
    return fail(`已驳回：${code} 已停用，不按销账处理`)
  }
  const marks = listRows(MARK_BUCKET)
  const openMarks = openMarksOf(marks, code)
  if (row.status === '正常' && openMarks.length === 0) {
    const firstAt = String(row.恢复处理时间 ?? '')
    return {
      ok: true,
      message: firstAt
        ? `重复提交：${code} 已于 ${firstAt} 销账，以首次处理时间为准，本次不再改动`
        : `${code} 当前无在办异常，无需销账`,
    }
  }

  const at = formatMinute(now)
  const today = formatDate(now)
  const hadInsulation = openMarks.some((mark) => String(mark.标记类型) === MARK_INSULATION)
  const tempCount = openMarks.filter((mark) => String(mark.标记类型) === MARK_TEMP).length
  const insulationCount = openMarks.length - tempCount

  const draft = cloneRows(allRows())
  const index = draft.combiner.findIndex((item) => Number(item.id) === id)
  const updated: EntryRow = {
    ...draft.combiner[index],
    status: '正常',
    pending: false,
    abnormal: false,
    箱体温度: NORMAL_READINGS.箱体温度,
    绝缘阻值: NORMAL_READINGS.绝缘阻值,
    箱体状态: NORMAL_READINGS.箱体状态,
    温度换算结果: '',
    恢复处理时间: String(draft.combiner[index].恢复处理时间 ?? '') || at,
  }
  let backfilled: InsulationReading[] = []
  if (hadInsulation) {
    const from = String(draft.combiner[index].上次绝缘检测日 ?? '') || today
    backfilled = backfillInsulation(from, today)
    if (backfilled.length === 0) {
      return fail(`销账数据不完整：${code} 绝缘读数无法自 ${from} 补起，已整笔回退，未做任何写入`)
    }
    updated.绝缘读数台账 = JSON.stringify(backfilled)
    updated.绝缘阻值 = backfilled[backfilled.length - 1].读数
    updated.上次绝缘检测日 = today
  }
  if (!updated.箱体温度 || !updated.绝缘阻值 || !updated.箱体状态) {
    return fail(`销账数据不完整：${code} 箱体温度/绝缘阻值/箱体状态未能同笔写全，已整笔回退，未做任何写入`)
  }
  draft.combiner[index] = updated

  const openIds = new Set(openMarks.map((mark) => Number(mark.id)))
  draft[MARK_BUCKET] = (draft[MARK_BUCKET] ?? []).map((mark) =>
    openIds.has(Number(mark.id))
      ? { ...mark, status: '已销账', pending: false, abnormal: false, 销账时间: at }
      : mark,
  )

  const patrol = [...(draft.patrol ?? [])]
  const seq = patrol.filter((item) => String(item.巡视单号 ?? '').startsWith(`FH-${code}`)).length + 1
  const conclusion =
    `销账：${code} 清讫温升×${tempCount}、绝缘异常×${insulationCount}；` +
    `箱体温度/绝缘阻值/箱体状态已同笔复核为正常`
  patrol.push({
    id: nextId(patrol),
    status: '待复核',
    pending: true,
    abnormal: false,
    巡视单号: `FH-${code}-${String(seq).padStart(2, '0')}`,
    巡视路线: '汇流箱销账复核',
    巡视人员: operator,
    巡视日期: today,
    检查项数: '3',
    异常项数: '0',
    巡视时长: '—',
    巡视状态: '待复核',
    关联汇流箱: code,
    销账结论: conclusion,
    关联标记: openMarks.map((mark) => `#${mark.id}`).join('/'),
  })
  draft.patrol = patrol

  try {
    saveAll(draft)
  } catch (error) {
    return fail(`销账写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  const backfillNote = backfilled.length
    ? `，绝缘读数自 ${backfilled[0].日期} 补录 ${backfilled.length} 天`
    : ''
  return {
    ok: true,
    message:
      `${code} 销账完成：箱体温度/绝缘阻值/箱体状态已同笔写回正常，` +
      `${openMarks.length} 条在办标记一次清讫，残留换算结果已抹除，结论已落巡检复核台账${backfillNote}`,
  }
}

// 变更熔断器规格：只归本方阵的专责管，其他人当场驳回并告知专责是谁。
export function changeFuseSpec(id: number, newSpec: string, operator: string): ActionResult {
  ensureCombinerMigration()
  const rows = listRows('combiner')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的直流汇流箱`)
  }
  const code = boxCode(row)
  const keeper = String(row.方阵专责 ?? '')
  if (!keeper) {
    return fail(`已驳回：${code} 所属 ${String(row.所属方阵)} 未登记方阵专责，熔断器规格暂不可变更`)
  }
  if (operator !== keeper) {
    return fail(
      `已驳回：熔断器规格只归本方阵专责管，${code} 属 ${String(row.所属方阵)}，` +
        `专责为 ${keeper}，当前操作人 ${operator} 无权变更`,
    )
  }
  const spec = newSpec.trim()
  if (!spec) {
    return fail('已驳回：新熔断器规格不能为空')
  }
  if (spec === String(row.熔断器规格 ?? '')) {
    return fail(`${code} 熔断器规格已是「${spec}」，无需变更`)
  }
  const draft = cloneRows(allRows())
  const index = draft.combiner.findIndex((item) => Number(item.id) === id)
  draft.combiner[index] = { ...draft.combiner[index], 熔断器规格: spec }
  try {
    saveAll(draft)
  } catch (error) {
    return fail(`熔断器规格写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: true, message: `${code} 熔断器规格已变更为「${spec}」（专责 ${operator}）` }
}

// 切换换算线：已换算的结果照新线重算一遍，老结果按当时版本留档，不做追溯改写。
export function switchConversionLine(operator: string, now: Date = new Date()): ActionResult {
  ensureCombinerMigration()
  const current = activeLine()
  const next = lineByVersion(nextLineVersion(current.version))
  const at = formatMinute(now)
  const draft = cloneRows(allRows())
  let recalculated = 0
  draft.combiner = draft.combiner.map((row) => {
    const oldResult = String(row.温度换算结果 ?? '')
    const celsius = parseCelsius(String(row.箱体温度 ?? ''))
    if (!oldResult || celsius === null) {
      return row
    }
    recalculated += 1
    const archives = parseJsonField<ConversionArchive[]>(row.换算留档, [])
    archives.push({
      版本: String(row.换算版本 ?? current.version),
      比例: current.ratio,
      结果: oldResult,
      时间: at,
      说明: '改线留档',
    })
    return {
      ...row,
      温度换算结果: convertTemperature(celsius, next),
      换算版本: next.version,
      换算留档: JSON.stringify(archives),
    }
  })
  const setting = [...(draft[SETTING_BUCKET] ?? [])]
  if (setting.length === 0) {
    setting.push({ id: 1, status: '现行', pending: false, abnormal: false })
  }
  setting[0] = { ...setting[0], 现行换算线: next.version, 改线时间: at, 改线人: operator }
  draft[SETTING_BUCKET] = setting
  try {
    saveAll(draft)
  } catch (error) {
    return fail(`改线写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    ok: true,
    message:
      `换算线已切至 ${next.version}（比例 ${next.ratio}），${recalculated} 台已换算结果照新线重算，` +
      `老结果按当时版本留档（操作人 ${operator}）`,
  }
}

// 巡检侧确认完成：只接管汇流箱销账复核件，其余巡视记录返回 null 走通用流转。
export function confirmPatrolReview(patrolId: number): ActionResult | null {
  ensureCombinerMigration()
  const row = listRows('patrol').find((item) => Number(item.id) === patrolId)
  if (!row || String(row.关联汇流箱 ?? '') === '') {
    return null
  }
  if (row.status === '已完成') {
    return fail(`${String(row.巡视单号)} 已复核归档，不用重复操作`)
  }
  const code = String(row.关联汇流箱)
  const draft = cloneRows(allRows())
  const index = draft.patrol.findIndex((item) => Number(item.id) === patrolId)
  draft.patrol[index] = {
    ...draft.patrol[index],
    status: '已完成',
    pending: false,
    abnormal: false,
    巡视状态: '已完成',
  }
  draft[MARK_BUCKET] = (draft[MARK_BUCKET] ?? []).map((mark) =>
    String(mark.汇流箱编号) === code && mark.status === '已销账' && String(mark.复核状态) !== '已复核'
      ? { ...mark, 复核状态: '已复核' }
      : mark,
  )
  try {
    saveAll(draft)
  } catch (error) {
    return fail(`复核写库失败，已整笔回退：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: true, message: `${String(row.巡视单号)} 复核完成，${code} 销账结论已归档` }
}

// 两处在办台数对账：汇流箱侧待复核台数（按箱计）与巡检台账在办条数必须对得上。
export function combinerReconciliation(): Reconciliation {
  ensureCombinerMigration()
  const boxes = new Set(
    listRows(MARK_BUCKET)
      .filter((mark) => mark.status === '已销账' && String(mark.复核状态) !== '已复核')
      .map((mark) => String(mark.汇流箱编号)),
  )
  const patrolOpen = listRows('patrol').filter(
    (row) => String(row.关联汇流箱 ?? '') !== '' && row.status === '待复核',
  ).length
  return { combinerPending: boxes.size, patrolOpen, matched: boxes.size === patrolOpen }
}

export function combinerDetail(id: number): CombinerDetail | null {
  ensureCombinerMigration()
  const row = listRows('combiner').find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const code = boxCode(row)
  const marks = listRows(MARK_BUCKET)
    .filter((mark) => String(mark.汇流箱编号) === code)
    .sort((a, b) => Number(a.id) - Number(b.id))
  return {
    row,
    marks,
    archives: parseJsonField<ConversionArchive[]>(row.换算留档, []),
    readings: parseJsonField<InsulationReading[]>(row.绝缘读数台账, []),
    line: activeLine(),
  }
}

export function resetCombinerDomain(): void {
  resetRows(MARK_BUCKET)
  resetRows(SETTING_BUCKET)
}
