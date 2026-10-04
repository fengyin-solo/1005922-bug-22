# 光伏电站运行维护管理平台

面向电站台账、组串阵列、逆变器、汇流箱、跟踪支架、组件清洗、告警处置与发电结算的一体化光伏电站运行维护工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 电站台账 | `station` | 光伏电站 | 电站编号、电站名称、装机容量 |
| 组串阵列 | `array` | 光伏组串 | 组串编号、所属方阵、组件型号 |
| 逆变器 | `inverter` | 逆变器 | 设备编号、逆变器型号、额定功率 |
| 汇流箱 | `combiner` | 直流汇流箱 | 汇流箱编号、所属方阵、接入组串数 |
| 跟踪支架 | `tracker` | 跟踪支架 | 支架编号、所属方阵、跟踪方式 |
| 组件清洗 | `cleaning` | 清洗任务 | 清洗单号、清洗方阵、清洗方式 |
| 告警事件 | `alarm` | 告警事件 | 告警编号、告警等级、告警来源 |
| 缺陷消缺 | `defect` | 消缺任务 | 缺陷编号、缺陷类别、发现方式 |
| 巡视检查 | `patrol` | 巡视记录 | 巡视单号、巡视路线、巡视人员 |
| 备品备件 | `spare` | 备品备件 | 备件编号、备件名称、适用设备 |
| 电量计量 | `meter` | 关口计量表 | 计量点编号、计量方向、表计型号 |
| 并网调度 | `dispatch` | 调度指令 | 指令编号、调度机构、指令类型 |
| 辐照监测 | `irradiance` | 辐照监测点 | 监测点编号、设备型号、安装高度 |
| 安全工器具 | `tooling` | 安全工器具 | 工器具编号、名称规格、试验类别 |
| 消防设施 | `fire` | 消防器材 | 器材编号、器材类型、布置位置 |
| 发电结算 | `settlement` | 电量结算单 | 结算单号、结算周期、上网电量 |
| 运维合同 | `contract` | 运维合同 | 合同编号、服务范围、合同期限 |
| 运维人员 | `crew` | 运维人员 | 人员编号、姓名、岗位工种 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 汇流箱的域规则单列在 `frontend/src/api/combiner-service.ts`（纯规则函数在
  `frontend/src/data/combiner-rules.ts`）：异常标记成册（`combiner_mark`）、换算线设置成册
  （`combiner_setting`），销账时箱体温度/绝缘阻值/箱体状态同笔写回，写不进去整笔回退；
  销账结论落巡检复核台账，两处在办台数可对账。换算比例现行版本为 `v2-2026`（比例 0.88），
  改线后已换算结果照新线重算，老记录按当时版本留档。
- 想回到初始数据：清掉浏览器里 `pv-plant-ops:entries` 这一项，或调用 `resetModule(模块)`。

## 测试

```bash
cd frontend
npm run test        # vitest：汇流箱域规则与 local-service 集成
npm run typecheck   # vue-tsc
```
