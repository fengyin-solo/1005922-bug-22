<template>
  <section class="page" data-module="combiner">
    <header class="page-head">
      <div>
        <h2>汇流箱管理</h2>
        <p class="page-desc">维护直流汇流箱，围绕汇流箱编号、所属方阵、接入组串数、熔断器规格做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记直流汇流箱</button>
        <button class="btn" type="button" @click="reconvert">换算改线重算</button>
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
      <span class="legend-item" :class="{ 'legend-warn': !recon.match }">
        在办 {{ recon.openBoxes }} 台 · 已销账 {{ recon.cleared }} 台 ↔ 复核台账 {{ recon.ledger }} 条（待复核 {{ recon.pendingReview }}）
        {{ recon.match ? '· 两处对得上' : '· 两处对不上，请核查' }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>当前操作人</span>
        <input v-model="operator" placeholder="熔断器变更只认本方阵专责" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td
            v-for="column in columns"
            :key="column"
            :class="{ 'cell-abnormal': isAbnormalCell(row, column) }"
          >
            {{ displayCell(row, column) }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="changeFuse(row)">变更熔断器规格</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无汇流箱数据，可先登记直流汇流箱</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条汇流箱记录</span>
      <span v-if="notice" class="notice-text">{{ notice }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  combinerLedgerRecon,
  downloadEntries,
  listEntries,
  moduleMeta,
  readingFlags,
  reconvertCombinerReadings,
  runCombinerAction,
  summarizeAnomalies,
  updateFuseSpec,
} from '@/api/local-service'
import type { LedgerRecon } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('combiner')
const columns = [...meta.fields, '换算结果', '在办异常']
const actions = ['登记温升', '安排绝缘检测', '确认恢复']
const statuses = meta.statuses

const session = useSessionStore()
const operator = computed({
  get: () => session.operator,
  set: (value: string) => session.setOperator(value),
})

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = meta.fields.slice(0, 3)
const recon = ref<LedgerRecon>({ openBoxes: 0, cleared: 0, ledger: 0, pendingReview: 0, match: true })

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

function displayCell(row: EntryRow, column: string): string {
  if (column === '在办异常') {
    return summarizeAnomalies(row)
  }
  if (column === '换算结果') {
    const cached = String(row['换算结果'] ?? '')
    if (!cached) {
      return '—'
    }
    return `${cached}（${String(row['换算比例版本'] || 'v1')}）`
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

// 有在办异常的读数格标红；销账后读数被同笔复位，红格自然消掉，
// 旧读数不会再显示成正常。
function isAbnormalCell(row: EntryRow, column: string): boolean {
  const flags = readingFlags(row)
  if (column === '箱体温度') return flags.temp
  if (column === '绝缘阻值') return flags.insulation
  if (column === '箱体状态') return flags.temp || flags.insulation
  return false
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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  notice.value = ''
  const result = runCombinerAction(Number(row.id), action, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function changeFuse(row: EntryRow) {
  errorMessage.value = ''
  notice.value = ''
  const code = String(row['汇流箱编号'] ?? row.id)
  const next = window.prompt(`变更 ${code} 的熔断器规格（只归本方阵专责管）`, String(row['熔断器规格'] ?? ''))
  if (next === null) {
    return
  }
  const result = updateFuseSpec(Number(row.id), next, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function reconvert() {
  errorMessage.value = ''
  notice.value = ''
  const result = reconvertCombinerReadings()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    recon.value = combinerLedgerRecon()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '汇流箱列表读取失败'
  }
}

onMounted(reload)
</script>
