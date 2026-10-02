# 航空发动机健康状态评估与剩余寿命预测服务

这是一个可直接在主机运行的纯后端 Node.js + TypeScript 项目，不依赖 Docker、数据库、Redis、Kafka 或云服务。业务状态默认写入本地 `data/state.json`，演示数据由代码生成，适合离线测试和后续接入真实传感器数据。

## 已实现业务

- 发动机档案与型号配置
- 飞行架次和多传感器时序导入
- 时间戳、单位、范围和单调性校验
- 缺失值线性插值与异常点剔除
- 飞行阶段工况归一化
- 排气温度裕度、燃油效率、振动风险、滑油压力裕度计算
- 传感器漂移和突变检测
- 发动机健康评分与状态分级
- 部件级风险排序
- 基于退化趋势的剩余寿命估算
- 预测置信区间与解释性证据
- 维修事件回灌和风险修正
- 维修事件写入后旧健康评估标记为待重算、旧 RUL 预测标记为失效（详情/风险事件/审计三处可见）
- 写入失败（校验失败或持久化失败）整体回滚，不留下半条状态；读取接口纯只读、无副作用
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出

## 运行

```bash
npm install
npm run build
npm test
npm run demo
npm start
```

服务默认监听 `http://127.0.0.1:6195`。

## 主要 API

```text
GET  /api/health
GET  /api/models
POST /api/engines/import
GET  /api/engines/:id
GET  /api/engines/:id/telemetry
POST /api/engines/:id/health-assessment
POST /api/engines/:id/rul-prediction
POST /api/engines/:id/replay
GET  /api/replay/jobs/:id
POST /api/engines/:id/maintenance-simulation
POST /api/maintenance-events
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/audit/:engineId
```

## 维护事件与失效语义

写入 `POST /api/maintenance-events` 成功后（事件校验在任何状态变更之前完成，事件 ID 重复返回 `409`）：

- 该发动机写入前生成、当前仍有效的最新健康评估被标记为 `fresh=false`（`staleness.reason=maintenance_recorded`，**待重算**），旧 RUL 预测同样标记为 `fresh=false`（**已失效**）；事件、失效标记、审计在同一事务内持久化，落盘失败时内存状态整体回滚。
- `GET /api/engines/:id` 返回的 `latestAssessment` / `latestPrediction` 自带 `fresh` 与 `staleness`，并额外给出 `staleSignals`（含 `recalculationRequired`、`cachedHealthScoreStale`）。
- `GET /api/engines/:id/risk-events` 在列表头部插入 `assessment_stale` / `prediction_invalid` 提示事件，历史异常保留并标注其来源评估是否仍有效。
- `GET /api/audit/:engineId` 除 `maintenance_event` 外，还会记录 `assessment_invalidated` / `prediction_invalidated`（含被失效的评估/预测 ID）。
- 在重新评估前调用 `rul-prediction` / `maintenance-simulation` 返回 `412`；下一次 `health-assessment` 仍读取**完整维护历史**（不会因失效流程删除或绕过维修记录），重算并重新预测后 `staleSignals.recalculationRequired` 恢复为 `false`。
- 所有 GET 接口均不写入、不延迟标记失效；失效标记只在维护事件成功写入的事务内产生。

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```
