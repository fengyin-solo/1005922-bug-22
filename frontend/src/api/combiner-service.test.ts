import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MARK_BUCKET,
  changeFuseSpec,
  combinerDetail,
  combinerReconciliation,
  confirmPatrolReview,
  conversionLineInfo,
  ensureCombinerMigration,
  registerTempRise,
  resetCombinerDomain,
  scheduleInsulation,
  switchConversionLine,
  writeOffCombiner,
} from './combiner-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'

const NOW = new Date('2026-10-04T10:30:00')

function combinerRow(id: number) {
  const row = listRows('combiner').find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`测试数据缺少汇流箱 #${id}`)
  }
  return row
}

beforeEach(() => {
  resetRows('combiner')
  resetRows('patrol')
  resetCombinerDomain()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('销账一次清到底', () => {
  it('箱体温度、绝缘阻值、箱体状态同笔写回，在办标记一次清讫，结论落巡检台账', () => {
    const result = writeOffCombiner(2, '值班管理员', NOW)
    expect(result.ok).toBe(true)

    const row = combinerRow(2)
    expect(row.status).toBe('正常')
    expect(row.pending).toBe(false)
    expect(row.abnormal).toBe(false)
    expect(row.箱体温度).toBe('45℃')
    expect(row.绝缘阻值).toBe('2.20MΩ')
    expect(row.箱体状态).toBe('正常')
    expect(row.温度换算结果).toBe('')
    expect(row.恢复处理时间).toBe('2026-10-04 10:30')

    // 同一台箱子记了两次温升：残留的那条与绝缘异常一起清掉
    const marks = listRows(MARK_BUCKET).filter((mark) => mark.汇流箱编号 === 'COMB-0002')
    expect(marks.every((mark) => mark.status === '已销账')).toBe(true)
    expect(marks.filter((mark) => mark.销账时间 === '2026-10-04 10:30')).toHaveLength(2)

    const review = listRows('patrol').find((item) => item.关联汇流箱 === 'COMB-0002')
    expect(review).toBeDefined()
    expect(review?.status).toBe('待复核')
    expect(review?.巡视单号).toBe('FH-COMB-0002-01')
    expect(String(review?.销账结论)).toContain('清讫温升×1、绝缘异常×1')

    const recon = combinerReconciliation()
    expect(recon).toEqual({ combinerPending: 1, patrolOpen: 1, matched: true })
  })

  it('写不进去就整笔回退，不清到一半', () => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded')
        },
      },
    }
    const result = writeOffCombiner(2, '值班管理员', NOW)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('整笔回退')

    delete (globalThis as Record<string, unknown>).window
    const row = combinerRow(2)
    expect(row.status).toBe('绝缘异常')
    expect(row.箱体温度).toBe('79℃')
    expect(listRows(MARK_BUCKET).filter((mark) => mark.status === '在办')).toHaveLength(3)
    expect(listRows('patrol').some((item) => item.关联汇流箱)).toBe(false)
  })

  it('重复提交恢复只认头一回的处理时间', () => {
    writeOffCombiner(2, '值班管理员', NOW)
    const again = writeOffCombiner(2, '值班管理员', new Date('2026-10-05T09:00:00'))
    expect(again.ok).toBe(true)
    expect(again.message).toContain('2026-10-04 10:30')
    expect(combinerRow(2).恢复处理时间).toBe('2026-10-04 10:30')
    expect(listRows('patrol').filter((item) => item.关联汇流箱 === 'COMB-0002')).toHaveLength(1)
  })
})

describe('越级与同源校验', () => {
  it('已安排绝缘检测的箱子不许再记温升，当场驳回并说明在办标记', () => {
    const sameSource = registerTempRise(2, 80, 'ALM-0901', '值班管理员', NOW)
    expect(sameSource.ok).toBe(false)
    expect(sameSource.message).toContain('标记#3')
    expect(sameSource.message).toContain('同源（同为 ALM-0901）')

    const diffSource = registerTempRise(2, 80, 'ALM-1002', '值班管理员', NOW)
    expect(diffSource.ok).toBe(false)
    expect(diffSource.message).toContain('不同源')

    expect(combinerRow(2).status).toBe('绝缘异常')
    expect(listRows(MARK_BUCKET).filter((mark) => mark.status === '在办')).toHaveLength(3)
  })

  it('同一台箱子已有在办温升时不得重复记录', () => {
    const dup = registerTempRise(3, 70, '人工巡检', '值班管理员', NOW)
    expect(dup.ok).toBe(false)
    expect(dup.message).toContain('标记#4')
  })

  it('正常箱子可登记温升，换算结果按现行线写入', () => {
    const result = registerTempRise(1, 76, 'ALM-1007', '值班管理员', NOW)
    expect(result.ok).toBe(true)
    const row = combinerRow(1)
    expect(row.status).toBe('温度偏高')
    expect(row.箱体温度).toBe('76℃')
    expect(row.箱体状态).toBe('温度偏高')
    expect(row.温度换算结果).toBe('66.9℃')
    expect(row.换算版本).toBe('v2-2026')
    expect(row.恢复处理时间).toBe('')
  })

  it('温度偏高可升级为绝缘异常，两条标记一并在办、同笔销讫', () => {
    const result = scheduleInsulation(3, 0.5, '人工巡检', '值班管理员', NOW)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('标记#4')
    expect(combinerRow(3).status).toBe('绝缘异常')

    const denied = registerTempRise(3, 70, '人工巡检', '值班管理员', NOW)
    expect(denied.ok).toBe(false)

    const done = writeOffCombiner(3, '值班管理员', NOW)
    expect(done.ok).toBe(true)
    const marks = listRows(MARK_BUCKET).filter((mark) => mark.汇流箱编号 === 'COMB-0003')
    expect(marks.every((mark) => mark.status === '已销账')).toBe(true)
  })

  it('绝缘检测在办时不得重复安排', () => {
    const dup = scheduleInsulation(2, 0.3, '人工巡检', '值班管理员', NOW)
    expect(dup.ok).toBe(false)
    expect(dup.message).toContain('标记#3')
  })
})

describe('熔断器规格专责', () => {
  it('非本方阵专责当场驳回并告知专责是谁', () => {
    const denied = changeFuseSpec(2, '32A/1000V', '值班管理员')
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain('李专责')
    expect(combinerRow(2).熔断器规格).toBe('25A/1000V')
  })

  it('本方阵专责可变更', () => {
    const allowed = changeFuseSpec(2, '32A/1000V', '李专责')
    expect(allowed.ok).toBe(true)
    expect(combinerRow(2).熔断器规格).toBe('32A/1000V')
  })
})

describe('换算线版本', () => {
  it('改线后已换算结果照新线重算，老结果按当时版本留档', () => {
    expect(conversionLineInfo().version).toBe('v2-2026')
    const result = switchConversionLine('值班管理员', NOW)
    expect(result.ok).toBe(true)
    expect(conversionLineInfo().version).toBe('v1-2025')

    const row3 = combinerRow(3)
    expect(row3.温度换算结果).toBe('62.6℃')
    expect(row3.换算版本).toBe('v1-2025')
    const detail3 = combinerDetail(3)
    expect(detail3?.archives).toHaveLength(1)
    expect(detail3?.archives[0]).toMatchObject({ 版本: 'v2-2026', 结果: '59.8℃', 说明: '改线留档' })

    const row2 = combinerRow(2)
    expect(row2.温度换算结果).toBe('72.7℃')

    // 没有换算结果的箱子（正常箱）不参与重算
    expect(combinerRow(1).温度换算结果).toBe('')
  })
})

describe('巡检复核台账', () => {
  it('复核完成后两处在办台数归零且对得上', () => {
    writeOffCombiner(2, '值班管理员', NOW)
    const review = listRows('patrol').find((item) => item.关联汇流箱 === 'COMB-0002')
    const done = confirmPatrolReview(Number(review?.id))
    expect(done?.ok).toBe(true)

    const recon = combinerReconciliation()
    expect(recon).toEqual({ combinerPending: 0, patrolOpen: 0, matched: true })
    const marks = listRows(MARK_BUCKET).filter((mark) => mark.汇流箱编号 === 'COMB-0002')
    expect(marks.every((mark) => mark.复核状态 === '已复核')).toBe(true)
  })

  it('非汇流箱的巡视记录不接管', () => {
    expect(confirmPatrolReview(1)).toBeNull()
  })
})

describe('既有记录兼容', () => {
  it('老记录补齐新字段，异常箱旧读数不许显示成正常，并按当时标准留档', () => {
    const legacy = {
      id: 9,
      status: '温度偏高',
      pending: true,
      abnormal: true,
      汇流箱编号: 'COMB-0099',
      所属方阵: '老方阵',
      接入组串数: '8',
      熔断器规格: '20A/1000V',
      防雷模块: '完好',
      箱体温度: '老数据',
      绝缘阻值: '老数据',
      箱体状态: '正常',
    }
    saveRows('combiner', [...listRows('combiner'), legacy])
    ensureCombinerMigration()

    const row = combinerRow(9)
    expect(row.箱体状态).toBe('温度偏高')
    expect(row.箱体温度).toBe('待复核')
    expect(row.换算版本).toBe('v1-2025')

    const marks = listRows(MARK_BUCKET).filter((mark) => mark.汇流箱编号 === 'COMB-0099')
    expect(marks).toHaveLength(1)
    expect(marks[0].来源).toBe('历史遗留')
    expect(marks[0].status).toBe('在办')
  })
})

describe('绝缘读数补录', () => {
  it('从上次检测的日子补起到销账日', () => {
    const result = writeOffCombiner(2, '值班管理员', NOW)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('自 2026-09-10 补录 25 天')

    const detail = combinerDetail(2)
    expect(detail?.readings).toHaveLength(25)
    expect(detail?.readings[0].日期).toBe('2026-09-10')
    expect(detail?.readings[24].日期).toBe('2026-10-04')
    expect(combinerRow(2).上次绝缘检测日).toBe('2026-10-04')
    expect(combinerRow(2).绝缘阻值).toBe(detail?.readings[24].读数)
  })
})
