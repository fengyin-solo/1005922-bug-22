import { beforeEach, describe, expect, it } from 'vitest'

import { MARK_BUCKET, combinerReconciliation, resetCombinerDomain } from './combiner-service'
import { listEntries, resetModule, runAction } from './local-service'
import { listRows, resetRows } from '@/data/local-store'

beforeEach(() => {
  resetRows('combiner')
  resetRows('patrol')
  resetCombinerDomain()
})

describe('local-service 集成', () => {
  it('汇流箱确认恢复走域内销账，一次清到底', () => {
    const result = runAction('combiner', 2, '确认恢复')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('一次清讫')
    expect(listRows('combiner').find((row) => Number(row.id) === 2)?.status).toBe('正常')
    expect(
      listRows(MARK_BUCKET).filter((mark) => mark.汇流箱编号 === 'COMB-0002' && mark.status === '在办'),
    ).toHaveLength(0)
  })

  it('汇流箱登记温升走域内规则：绝缘检测在办的箱子越级驳回', () => {
    const result = runAction('combiner', 2, '登记温升')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('越级')
  })

  it('巡检台账确认完成复核件后，两处在办台数对得上', () => {
    runAction('combiner', 2, '确认恢复')
    const review = listRows('patrol').find((row) => row.关联汇流箱 === 'COMB-0002')
    expect(review).toBeDefined()

    const done = runAction('patrol', Number(review?.id), '确认完成')
    expect(done.ok).toBe(true)
    expect(done.message).toContain('复核完成')

    const recon = combinerReconciliation()
    expect(recon.matched).toBe(true)
    expect(recon.combinerPending).toBe(0)
    expect(recon.patrolOpen).toBe(0)
  })

  it('普通巡视记录仍走通用流转', () => {
    const result = runAction('patrol', 1, '确认完成')
    expect(result.ok).toBe(true)
    expect(listRows('patrol').find((row) => Number(row.id) === 1)?.status).toBe('已完成')
  })

  it('读取汇流箱列表前自动迁移老记录', () => {
    const legacy = {
      id: 8,
      status: '绝缘异常',
      pending: true,
      abnormal: true,
      汇流箱编号: 'COMB-0098',
      所属方阵: '老方阵',
      接入组串数: '9',
      熔断器规格: '20A/1000V',
      防雷模块: '完好',
      箱体温度: '老数据',
      绝缘阻值: '老数据',
      箱体状态: '正常',
    }
    const cached = listRows('combiner')
    cached.push(legacy)

    const payload = listEntries('combiner')
    const migrated = payload.items.find((row) => Number(row.id) === 8)
    expect(migrated?.换算版本).toBeDefined()
    expect(migrated?.绝缘读数台账).toBeDefined()
    expect(migrated?.箱体状态).toBe('绝缘异常')
  })

  it('resetModule 连同汇流箱域的标记与设置一起重置', () => {
    runAction('combiner', 2, '确认恢复')
    resetModule('combiner')
    expect(listRows(MARK_BUCKET).filter((mark) => mark.status === '在办')).toHaveLength(3)
    expect(listRows('combiner').find((row) => Number(row.id) === 2)?.status).toBe('绝缘异常')
  })
})
