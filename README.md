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
- 传感器数据按时间顺序重放
- 维护窗口推演
- 模型版本比较
- 告警事件、审计轨迹和本地结果导出
- 维护事件写入后旧健康评估/RUL 自动标记失效（`superseded`），重算前不再作为有效结果返回

## 维护事件与评估失效

- `POST /api/maintenance-events` 成功写入后，该发动机维护前的健康评估与 RUL 预测会在**同一原子提交**中被标记为 `lifecycle: "superseded"`，并记录维护事件 ID、发生时间和失效原因；审计中同时留下 `maintenance_event` 与 `assessment_prediction_invalidated` 两条轨迹。
- 发动机详情 `GET /api/engines/:id` 返回 `healthFreshness`（评估/预测状态、失效原因、重算建议）；`GET /api/engines/:id/risk-events` 每条异常都会带 `assessmentStale` 标注。
- 失效期间 `rul-prediction` 与 `maintenance-simulation` 返回 422（`*_stale_recompute_required`），防止继续使用维护前结果。重新运行健康评估会自动纳入全部维护历史（`maintenanceEventsConsidered` 见审计），新结果恢复为 `current`。
- 所有读取接口均为纯读取，不写盘、不写审计；写入类接口使用内存事务 + 临时文件原子替换，落盘失败自动回滚，不产生半条状态。

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
POST /api/models/compare
GET  /api/engines/:id/risk-events
GET  /api/audit/:engineId
```

## 示例

```bash
curl http://127.0.0.1:6195/api/health
curl http://127.0.0.1:6195/api/engines/ENG-DEMO-001/health-assessment
curl -X POST http://127.0.0.1:6195/api/engines/ENG-DEMO-001/rul-prediction \
  -H 'content-type: application/json' \
  -d '{"horizonCycles":120}'
```
