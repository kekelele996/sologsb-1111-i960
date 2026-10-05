# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / handover
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / handover.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验；粘贴库管员移交单按箱号核对货架位与入架时间、入架状态、缺架位提示、整批导入可撤回 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`meta`、`transfers`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD。升级前可用顶栏「导出备份」导出全量 JSON。
- `db.version(3).upgrade(...)` 为岩芯箱增加入架状态 `rackStatus`（未入架/已入架）与入架时间 `rackedAt`，历史箱一律按**未入架**显示、清空入架时间、保留原货架位预排值；同时新增 `transfers` 表记录移交单导入批次（含导入前整箱快照，供整体撤回）。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 移交单对账规则（编录台 ↔ 岩芯库）

编录员台账记回次进尺与岩芯箱，库管员台账记货架位与箱位移交单，两边各留各的底。在「岩芯箱」页点「移交单对账」，把库管员发来的清单整段粘贴（支持 TSV/CSV/空格分隔，表头按列名识别、列序不限）：

- 按**箱号**核对货架位与入架时间（时间按分钟精度比较，兼容 `2026-10-01 09:30`、`2026/10/01`、`2026年10月1日 9:30` 等写法）。
- **箱号本台查无、移交单内箱号重复、货架位重复（批内或占用本台已入架箱）、入架时间空着或无法识别：照本台保留**，只在差异清单中标注原因，不写入。
- 核对一致显示「已一致」；其余正常匹配项才按移交单写入货架位、入架时间并标记**已入架**；移交单未提及的箱保持原样。
- 缺货架位的未入架箱在页顶与台账行内提示补齐；编辑弹窗中货架位可留空、可手填。
- 每次导入保存批次快照，点「撤回上次导入」即可整体还原（导入后的手动改动一并回退），再重新对账导入。
