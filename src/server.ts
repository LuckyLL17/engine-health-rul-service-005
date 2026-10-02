import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assessEngine, maintenanceWindows, predictRul, validateTelemetry } from './health.js';
import { LocalStore } from './store.js';
import { Component, Engine, HealthAssessment, HealthFreshness, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

const VALID_COMPONENTS: Component[] = ['hot_section', 'compressor', 'bearing', 'lubrication'];
const VALID_ACTIONS: MaintenanceEvent['action'][] = ['inspection', 'replacement', 'repair', 'calibration'];
const VALID_SEVERITIES: MaintenanceEvent['severity'][] = ['routine', 'important', 'mandatory'];

export async function createApp(store = new LocalStore()) {
  await store.init();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  const findEngine = (id: string) => store.engines.find(item => item.id === id);
  const requireEngine = (id: string): Engine => { const engine = findEngine(id); if (!engine) throw Object.assign(new Error('engine_not_found'), { statusCode: 404 }); return engine; };
  const fail = (message: string, statusCode = 404): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };

  // 只返回仍然生效（未失效）的快照；失效快照只能作为历史记录查看
  const currentAssessment = (id: string) => store.assessments.find(item => item.engineId === id && item.lifecycle !== 'superseded');
  const currentPrediction = (id: string) => store.predictions.find(item => item.engineId === id && item.lifecycle !== 'superseded');
  const requireCurrentAssessment = (id: string): HealthAssessment => {
    const latest = store.assessments.find(item => item.engineId === id);
    if (!latest) throw Object.assign(new Error('health_assessment_required'), { statusCode: 422 });
    if (latest.lifecycle === 'superseded') throw Object.assign(new Error('health_assessment_stale_recompute_required'), { statusCode: 422 });
    return latest;
  };
  const requireCurrentPrediction = (id: string): RulPrediction => {
    const latest = store.predictions.find(item => item.engineId === id);
    if (!latest) throw Object.assign(new Error('rul_prediction_required'), { statusCode: 422 });
    if (latest.lifecycle === 'superseded') throw Object.assign(new Error('rul_prediction_stale_recompute_required'), { statusCode: 422 });
    return latest;
  };
  const findModel = (id?: string): ModelVersion => store.models.find(item => item.id === id) ?? store.models[store.models.length - 1];

  // 纯读取：汇总评估/预测的新鲜度，供调度员详情页判断是否需要重算
  const freshnessFor = (id: string): HealthFreshness => {
    const latestAssessment = store.assessments.find(item => item.engineId === id);
    const latestPrediction = store.predictions.find(item => item.engineId === id);
    const assessmentState = !latestAssessment ? 'missing' : (latestAssessment.lifecycle ?? 'current');
    const predictionState = !latestPrediction ? 'missing' : (latestPrediction.lifecycle ?? 'current');
    const staleReasons = [latestAssessment?.supersededReason, latestPrediction?.supersededReason]
      .filter((reason): reason is NonNullable<typeof reason> => Boolean(reason))
      // 维护失效时评估与预测原因重复，去重展示
      .filter((reason, index, list) => list.findIndex(item => item.maintenanceEventId === reason.maintenanceEventId && item.code === reason.code) === index);
    const stale = assessmentState === 'superseded' || predictionState === 'superseded';
    return {
      assessmentState,
      predictionState,
      stale,
      staleReasons,
      recommendation: stale ? '维护事件后旧评估/预测已失效，请重新运行健康评估与 RUL 预测' : '评估与预测为最新结果'
    };
  };

  const validateMaintenanceEvent = (raw: Partial<MaintenanceEvent> | null | undefined): MaintenanceEvent => {
    if (!raw || typeof raw !== 'object') fail('maintenance_event_body_required', 400);
    const event = raw as Partial<MaintenanceEvent>;
    if (!event.id || typeof event.id !== 'string') fail('maintenance_event.id is required', 400);
    if (!event.engineId || typeof event.engineId !== 'string') fail('maintenance_event.engineId is required', 400);
    if (!event.component || !VALID_COMPONENTS.includes(event.component)) fail(`component must be one of ${VALID_COMPONENTS.join(', ')}`, 400);
    if (!event.occurredAt || Number.isNaN(new Date(event.occurredAt).getTime())) fail('occurredAt must be a valid date', 400);
    if (!event.action || !VALID_ACTIONS.includes(event.action)) fail(`action must be one of ${VALID_ACTIONS.join(', ')}`, 400);
    if (!event.severity || !VALID_SEVERITIES.includes(event.severity)) fail(`severity must be one of ${VALID_SEVERITIES.join(', ')}`, 400);
    if (event.note === undefined || event.note === null || typeof event.note !== 'string') fail('note is required', 400);
    if (store.maintenance.some(item => item.id === event.id)) fail(`maintenance_event ${event.id} already exists`, 409);
    return event as MaintenanceEvent;
  };

  app.get('/api/health', async () => ({ status: 'ok', service: 'engine-health-rul-service', storage: 'local-json', version: '0.1.0' }));
  app.get('/api/models', async () => store.models);
  app.get('/api/engines', async () => store.engines);

  app.post('/api/engines/import', async request => {
    const body = request.body as { engine: Engine; telemetry?: TelemetrySample[]; maintenance?: MaintenanceEvent[] };
    if (!body?.engine?.id) fail('engine.id is required', 400);
    return store.commit(() => {
      if (!findEngine(body.engine.id)) store.addEngine(body.engine);
      if (body.telemetry) store.addTelemetry(body.telemetry);
      for (const event of body.maintenance ?? []) store.addMaintenance(event);
      store.log('engine_import', body.engine.id, { telemetry: body.telemetry?.length ?? 0, maintenance: body.maintenance?.length ?? 0 });
      return { engine: body.engine, importedTelemetry: body.telemetry?.length ?? 0, importedMaintenance: body.maintenance?.length ?? 0 };
    });
  });

  // 读取接口：只序列化现有状态，不写盘、不产生审计
  app.get('/api/engines/:id', async request => {
    const id = (request.params as { id: string }).id;
    const engine = requireEngine(id);
    return { engine, latestAssessment: store.assessments.find(item => item.engineId === id), latestPrediction: store.predictions.find(item => item.engineId === id), healthFreshness: freshnessFor(id) };
  });

  app.get('/api/engines/:id/telemetry', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const query = request.query as { flightId?: string; limit?: string }; const rows = store.telemetry.filter(item => item.engineId === id && (!query.flightId || item.flightId === query.flightId)); return rows.slice(-(Number(query.limit) || 200)); });

  app.post('/api/engines/:id/health-assessment', async request => {
    const id = (request.params as { id: string }).id;
    const engine = requireEngine(id);
    const body = (request.body ?? {}) as { modelId?: string; flightId?: string };
    const rows = store.telemetry.filter(item => item.engineId === id && (!body.flightId || item.flightId === body.flightId));
    if (!rows.length) fail('telemetry_not_found', 422);
    // 维修历史参与下一次评估（仅统计发生在评估之前的事件）
    const maintenanceHistory = store.maintenance.filter(item => item.engineId === id);
    return store.commit(() => {
      const assessment = assessEngine(engine, rows, findModel(body.modelId), maintenanceHistory.length);
      assessment.lifecycle = 'current';
      store.supersedeForAssessment(id, assessment.createdAt);
      engine.currentHealthScore = assessment.healthScore;
      engine.status = assessment.status;
      engine.lastAssessmentAt = assessment.createdAt;
      store.addAssessment(assessment);
      store.log('health_assessment', id, { assessmentId: assessment.assessmentId, modelVersion: assessment.modelVersion, maintenanceEventsConsidered: maintenanceHistory.length });
      return assessment;
    });
  });

  app.post('/api/engines/:id/rul-prediction', async request => {
    const id = (request.params as { id: string }).id;
    requireEngine(id);
    const assessment = requireCurrentAssessment(id);
    const body = (request.body ?? {}) as { horizonCycles?: number; modelId?: string };
    const engine = findEngine(id)!;
    return store.commit(() => {
      const prediction = predictRul(engine, assessment, Math.max(30, Math.min(body.horizonCycles ?? 240, 2000)), findModel(body.modelId));
      prediction.lifecycle = 'current';
      store.supersedeForPrediction(id, prediction.createdAt);
      store.addPrediction(prediction);
      store.log('rul_prediction', id, { predictionId: prediction.predictionId, estimatedRemainingCycles: prediction.estimatedRemainingCycles, basedOnAssessment: assessment.assessmentId });
      return prediction;
    });
  });

  app.post('/api/engines/:id/replay', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const rows = store.telemetry.filter(item => item.engineId === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp)); const body = (request.body ?? {}) as { speed?: number; cursor?: number }; return { id: `REPLAY-${Date.now()}`, engineId: id, status: 'ready', speed: body.speed ?? 1, cursor: body.cursor ?? 0, eventCount: rows.length, next: rows[body.cursor ?? 0] }; });

  app.post('/api/engines/:id/maintenance-simulation', async request => {
    const id = (request.params as { id: string }).id;
    requireEngine(id);
    const prediction = requireCurrentPrediction(id);
    const body = (request.body ?? {}) as { delayCycles?: number };
    const delay = Math.max(0, body.delayCycles ?? 0);
    return { engineId: id, delayCycles: delay, windows: maintenanceWindows({ ...prediction, estimatedRemainingCycles: prediction.estimatedRemainingCycles - delay, lowerBound: Math.max(1, prediction.lowerBound - delay), upperBound: Math.max(1, prediction.upperBound - delay) }), impact: { additionalRisk: Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)), recommendation: delay > prediction.lowerBound ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内' } };
  });

  // 只读比较：不落盘、不改变任何快照生命周期
  app.post('/api/models/compare', async request => { const body = request.body as { engineId: string; modelIds?: string[] }; const engine = requireEngine(body.engineId); const rows = store.telemetry.filter(item => item.engineId === body.engineId); return (body.modelIds ?? store.models.map(item => item.id)).map(id => { const model = findModel(id); const result = assessEngine(engine, rows, model, store.maintenance.filter(item => item.engineId === engine.id).length); return { modelId: model.id, label: model.label, healthScore: result.healthScore, status: result.status, dataQuality: result.dataQuality.score, degradationSlope: result.indicators.degradationSlope }; }); });

  app.post('/api/maintenance-events', async request => {
    const event = validateMaintenanceEvent(request.body as Partial<MaintenanceEvent>);
    requireEngine(event.engineId);
    return store.commit(() => {
      const at = new Date().toISOString();
      store.addMaintenance(event);
      const invalidated = store.supersedeForMaintenance(event.engineId, event, at);
      // 审计中既体现事件本身，也体现旧评估/预测的失效动作
      store.log('maintenance_event', event.engineId, { eventId: event.id, component: event.component, action: event.action, occurredAt: event.occurredAt });
      store.log('assessment_prediction_invalidated', event.engineId, { reason: 'maintenance_event', maintenanceEventId: event.id, invalidatedAssessments: invalidated.assessmentIds, invalidatedPredictions: invalidated.predictionIds, at });
      return { event, invalidated, healthFreshness: freshnessFor(event.engineId) };
    });
  });

  // 读取接口：逐条标注异常所属评估是否已失效，不写盘
  app.get('/api/engines/:id/risk-events', async request => {
    const id = (request.params as { id: string }).id;
    requireEngine(id);
    return store.assessments
      .filter(item => item.engineId === id)
      .flatMap(item => item.anomalies.map(anomaly => ({
        ...anomaly,
        assessmentId: item.assessmentId,
        assessmentCreatedAt: item.createdAt,
        assessmentStale: item.lifecycle === 'superseded',
        supersededReason: item.supersededReason ?? null
      })));
  });

  app.get('/api/audit/:engineId', async request => store.audit.filter(item => item.engineId === (request.params as { engineId: string }).engineId));
  app.setErrorHandler((error: Error, _request, reply) => reply.code((error as Error & { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await createApp();
  await app.listen({ host: '127.0.0.1', port: 6195 });
}
