<template>
  <section class="page" data-module="combiner">
    <header class="page-head">
      <div>
        <h2>汇流箱管理</h2>
        <p class="page-desc">维护直流汇流箱，围绕汇流箱编号、所属方阵、接入组串数、熔断器规格做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记直流汇流箱</button>
        <button class="btn" type="button" @click="onSwitchLine">切换换算线</button>
        <button class="btn" type="button" @click="exportRows">导出汇流箱清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p class="domain-line">
      <span>现行换算线：{{ lineInfo.version }}（比例 {{ lineInfo.ratio }}），改线后已换算结果照新线重算，老记录按当时版本留档</span>
      <span class="reconcile" :class="recon.matched ? 'ok' : 'bad'">
        销账复核对账：汇流箱侧在办 {{ recon.combinerPending }} 台 · 巡检台账在办 {{ recon.patrolOpen }} 台 ·
        {{ recon.matched ? '两处对得上' : '两处对不上，需核查' }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="infoMessage" class="info-text">{{ infoMessage }}</p>

    <table class="data-table clickable-rows">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-selected': selectedId === Number(row.id) }"
          @click="select(row)"
        >
          <td v-for="column in columns" :key="column" :class="cellClass(column, row)">
            {{ row[column] ?? '—' }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions" @click.stop>
            <button class="link" type="button" @click="onRegisterTemp(row)">登记温升</button>
            <button class="link" type="button" @click="onScheduleInsulation(row)">安排绝缘检测</button>
            <button class="link" type="button" @click="onWriteOff(row)">确认恢复</button>
            <button class="link" type="button" @click="onChangeFuse(row)">变更熔断器规格</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无汇流箱数据，可先登记直流汇流箱</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail-panel">
      <h3 class="detail-title">详情面板：{{ detail.row.汇流箱编号 }}</h3>
      <div class="detail-grid">
        <span>方阵专责：{{ detail.row.方阵专责 || '未登记' }}</span>
        <span>上次绝缘检测日：{{ detail.row.上次绝缘检测日 || '—' }}</span>
        <span>恢复处理时间：{{ detail.row.恢复处理时间 || '—' }}</span>
        <span>温度换算结果：{{ detail.row.温度换算结果 || '已抹除' }}</span>
        <span>换算版本：{{ detail.row.换算版本 }}</span>
      </div>

      <h4 class="detail-subtitle">异常标记（{{ detail.marks.length }} 条）</h4>
      <table v-if="detail.marks.length" class="data-table">
        <thead>
          <tr><th>标记</th><th>类型</th><th>来源</th><th>登记时间</th><th>状态</th><th>销账时间</th><th>复核状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="mark in detail.marks" :key="String(mark.id)">
            <td>#{{ mark.id }}</td>
            <td>{{ mark.标记类型 }}</td>
            <td>{{ mark.来源 }}</td>
            <td>{{ mark.登记时间 }}</td>
            <td>{{ mark.status }}</td>
            <td>{{ mark.销账时间 || '—' }}</td>
            <td>{{ mark.复核状态 || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">暂无异常标记</p>

      <h4 class="detail-subtitle">换算留档（{{ detail.archives.length }} 条）</h4>
      <ul v-if="detail.archives.length" class="detail-list">
        <li v-for="(item, index) in detail.archives" :key="index">
          {{ item.时间 }} · {{ item.版本 }}（比例 {{ item.比例 }}）· {{ item.结果 }} · {{ item.说明 }}
        </li>
      </ul>
      <p v-else class="muted">暂无留档</p>

      <h4 class="detail-subtitle">绝缘读数台账（{{ detail.readings.length }} 天）</h4>
      <p v-if="detail.readings.length" class="muted">
        自 {{ detail.readings[0].日期 }} 补至 {{ detail.readings[detail.readings.length - 1].日期 }}，
        最近读数 {{ detail.readings[detail.readings.length - 1].读数 }}
      </p>
      <p v-else class="muted">暂无补录读数</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条汇流箱记录</span>
      <span>当前操作人：{{ operator }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  changeFuseSpec,
  combinerDetail,
  combinerReconciliation,
  conversionLineInfo,
  downloadEntries,
  listEntries,
  moduleMeta,
  registerTempRise,
  scheduleInsulation,
  switchConversionLine,
  writeOffCombiner,
} from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'
import type { CombinerDetail, Reconciliation } from '@/api/local-service'
import type { ConversionLine } from '@/data/combiner-rules'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('combiner')
const columns = ["汇流箱编号", "所属方阵", "接入组串数", "熔断器规格", "防雷模块", "箱体温度", "绝缘阻值", "箱体状态"]
const statuses = ["正常", "温度偏高", "绝缘异常", "已停用"]

const session = useSessionStore()
const operator = session.operator

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedId = ref<number | null>(null)
const detail = ref<CombinerDetail | null>(null)
const recon = ref<Reconciliation>({ combinerPending: 0, patrolOpen: 0, matched: true })
const lineInfo = ref<ConversionLine>(conversionLineInfo())

const stats = computed(() => [
  { label: '在运汇流箱', value: rows.value.filter((row) => row.status !== '已停用').length },
  { label: '温度偏高台数', value: rows.value.filter((row) => row.status === '温度偏高').length },
  { label: '绝缘异常台数', value: rows.value.filter((row) => row.status === '绝缘异常').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 读数格按数值本身标红：旧读数不许因为状态字段被改而显示成正常。
function cellClass(column: string, row: EntryRow): string {
  if (column === '箱体温度') {
    const value = Number.parseFloat(String(row[column] ?? ''))
    if (Number.isFinite(value) && value >= 60) return 'cell-bad'
  }
  if (column === '绝缘阻值') {
    const value = Number.parseFloat(String(row[column] ?? ''))
    if (Number.isFinite(value) && value < 1) return 'cell-bad'
  }
  if (column === '箱体状态' && String(row[column] ?? '') !== '正常') return 'cell-bad'
  return ''
}

function select(row: EntryRow) {
  selectedId.value = Number(row.id)
  refreshDetail()
}

function refreshDetail() {
  detail.value = selectedId.value === null ? null : combinerDetail(selectedId.value)
}

function handle(result: ActionResult) {
  reload()
  infoMessage.value = ''
  errorMessage.value = ''
  if (result.ok) {
    infoMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
}

function onRegisterTemp(row: EntryRow) {
  const tempInput = window.prompt(`登记 ${String(row.汇流箱编号)} 实测箱体温度（℃）`, '75')
  if (tempInput === null) return
  const sourceInput = window.prompt('异常来源（告警编号 / 人工巡检）', '人工巡检')
  handle(registerTempRise(Number(row.id), Number(tempInput), sourceInput?.trim() || '人工巡检', operator))
}

function onScheduleInsulation(row: EntryRow) {
  const resistanceInput = window.prompt(`登记 ${String(row.汇流箱编号)} 实测绝缘阻值（MΩ）`, '0.4')
  if (resistanceInput === null) return
  const sourceInput = window.prompt('异常来源（告警编号 / 人工巡检）', '人工巡检')
  handle(scheduleInsulation(Number(row.id), Number(resistanceInput), sourceInput?.trim() || '人工巡检', operator))
}

function onWriteOff(row: EntryRow) {
  handle(writeOffCombiner(Number(row.id), operator))
}

function onChangeFuse(row: EntryRow) {
  const spec = window.prompt(
    `变更 ${String(row.汇流箱编号)} 熔断器规格（只归本方阵专责管）`,
    String(row.熔断器规格 ?? ''),
  )
  if (spec === null) return
  handle(changeFuseSpec(Number(row.id), spec, operator))
}

function onSwitchLine() {
  handle(switchConversionLine(operator))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '直流汇流箱登记入口尚未接入审批流'
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    recon.value = combinerReconciliation()
    lineInfo.value = conversionLineInfo()
    refreshDetail()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汇流箱列表读取失败'
  }
}

onMounted(reload)
</script>
