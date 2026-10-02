import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assessEngine, maintenanceWindows, predictRul } from './health.js';
import { LocalStore } from './store.js';
import { Anomaly, Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

export async function createApp(store = new LocalStore()) {
  await store.init();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  const findEngine = (id: string) => store.engines.find(item => item.id === id);
  const requireEngine = (id: string): Engine => { const engine = findEngine(id); if (!engine) throw Object.assign(new Error('engine_not_found'), { statusCode: 404 }); return engine; };
  const requireFreshAssessment = (id: string): HealthAssessment => { const assessment = store.assessments.find(item => item.engineId === id); if (!assessment) throw Object.assign(new Error('health_assessment_required'), { statusCode: 422 }); if (assessment.fresh === false) throw Object.assign(new Error('health_assessment_stale_recalculate'), { statusCode: 412 }); return assessment; };
  const requireFreshPrediction = (id: string): RulPrediction => { const prediction = store.predictions.find(item => item.engineId === id); if (!prediction) throw Object.assign(new Error('rul_prediction_required'), { statusCode: 422 }); if (prediction.fresh === false) throw Object.assign(new Error('rul_prediction_stale_recalculate'), { statusCode: 412 }); return prediction; };
  const findModel = (id?: string): ModelVersion => store.models.find(item => item.id === id) ?? store.models[store.models.length - 1];
  const fail = (message: string, statusCode = 404): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };
  const components = ['hot_section', 'compressor', 'bearing', 'lubrication'] as const;
  const actions = ['inspection', 'replacement', 'repair', 'calibration'] as const;
  const severities = ['routine', 'important', 'mandatory'] as const;
  const validateMaintenanceEvent = (input: unknown): MaintenanceEvent => {
    const event = input as MaintenanceEvent | undefined;
    if (!event || typeof event !== 'object') fail('maintenance_event is required', 400);
    const checked = event as MaintenanceEvent;
    if (!checked.id) fail('maintenance_event.id is required', 400);
    if (!checked.engineId) fail('maintenance_event.engineId is required', 400);
    requireEngine(checked.engineId);
    if (!(components as readonly string[]).includes(checked.component)) fail(`maintenance_event.component must be one of ${components.join(', ')}`, 400);
    if (!(actions as readonly string[]).includes(checked.action)) fail(`maintenance_event.action must be one of ${actions.join(', ')}`, 400);
    if (!(severities as readonly string[]).includes(checked.severity)) fail(`maintenance_event.severity must be one of ${severities.join(', ')}`, 400);
    if (!checked.occurredAt || Number.isNaN(new Date(checked.occurredAt).getTime())) fail('maintenance_event.occurredAt must be a valid timestamp', 400);
    if (store.maintenance.some(item => item.id === checked.id)) fail(`maintenance_event ${checked.id} already exists`, 409);
    return checked;
  };

  app.get('/api/health', async () => ({ status: 'ok', service: 'engine-health-rul-service', storage: 'local-json', version: '0.1.0' }));
  app.get('/api/models', async () => store.models);
  app.get('/api/engines', async () => store.engines);
  app.post('/api/engines/import', async request => {
    const body = request.body as { engine: Engine; telemetry?: TelemetrySample[]; maintenance?: MaintenanceEvent[] };
    if (!body?.engine?.id) fail('engine.id is required', 400);
    const maintenanceCount = body.maintenance?.length ?? 0;
    for (const event of body.maintenance ?? []) {
      if (!event?.id || !event.engineId || !(components as readonly string[]).includes(event.component) || !(actions as readonly string[]).includes(event.action) || !(severities as readonly string[]).includes(event.severity) || !event.occurredAt || Number.isNaN(new Date(event.occurredAt).getTime())) fail('maintenance array contains an invalid event', 400);
    }
    const invalidated = await store.mutate(() => {
      if (!findEngine(body.engine.id)) store.addEngine(body.engine);
      if (body.telemetry) store.addTelemetry(body.telemetry);
      const assessmentIds: string[] = [], predictionIds: string[] = [];
      for (const event of body.maintenance ?? []) {
        if (store.maintenance.some(item => item.id === event.id)) continue;
        const result = store.recordMaintenance(event);
        assessmentIds.push(...result.invalidatedAssessmentIds);
        predictionIds.push(...result.invalidatedPredictionIds);
      }
      store.log('engine_import', body.engine.id, { telemetry: body.telemetry?.length ?? 0, maintenance: maintenanceCount, invalidatedAssessments: assessmentIds, invalidatedPredictions: predictionIds });
      return { assessmentIds, predictionIds };
    });
    return { engine: body.engine, importedTelemetry: body.telemetry?.length ?? 0, importedMaintenance: maintenanceCount, invalidatedAssessments: invalidated.assessmentIds, invalidatedPredictions: invalidated.predictionIds };
  });
  // 只读接口：失效状态直接从持久化标记派生，不在读取时做任何写入或延迟失效处理
  app.get('/api/engines/:id', async request => {
    const id = (request.params as { id: string }).id; const engine = requireEngine(id);
    const latestAssessment = store.assessments.find(item => item.engineId === id);
    const latestPrediction = store.predictions.find(item => item.engineId === id);
    const assessmentStale = latestAssessment?.fresh === false;
    const predictionStale = latestPrediction?.fresh === false;
    const staleSignals = {
      assessmentStale,
      predictionStale,
      cachedHealthScoreStale: assessmentStale,
      recalculationRequired: assessmentStale || predictionStale,
      assessmentStaleness: latestAssessment?.staleness,
      predictionStaleness: latestPrediction?.staleness
    };
    return { engine, latestAssessment, latestPrediction, staleSignals };
  });
  app.get('/api/engines/:id/telemetry', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const query = request.query as { flightId?: string; limit?: string }; const rows = store.telemetry.filter(item => item.engineId === id && (!query.flightId || item.flightId === query.flightId)); return rows.slice(-(Number(query.limit) || 200)); });
  app.post('/api/engines/:id/health-assessment', async request => {
    const id = (request.params as { id: string }).id; const engine = requireEngine(id);
    const body = (request.body ?? {}) as { modelId?: string; flightId?: string };
    const rows = store.telemetry.filter(item => item.engineId === id && (!body.flightId || item.flightId === body.flightId));
    if (!rows.length) fail('telemetry_not_found', 422);
    // 重算时始终读取完整维护历史，维护事件不会被失效流程删除
    const assessment = assessEngine(engine, rows, findModel(body.modelId), store.maintenance.filter(item => item.engineId === id).length);
    await store.mutate(() => {
      engine.currentHealthScore = assessment.healthScore;
      engine.status = assessment.status;
      engine.lastAssessmentAt = assessment.createdAt;
      store.addAssessment(assessment);
      const previous = store.assessments.find(item => item.engineId === id && item.assessmentId !== assessment.assessmentId);
      store.log('health_assessment', id, { assessmentId: assessment.assessmentId, modelVersion: assessment.modelVersion, maintenanceHistory: store.maintenance.filter(item => item.engineId === id).length, recalculated: previous?.fresh === false });
    });
    return assessment;
  });
  app.post('/api/engines/:id/rul-prediction', async request => {
    const id = (request.params as { id: string }).id; const engine = requireEngine(id);
    const assessment = requireFreshAssessment(id);
    const body = (request.body ?? {}) as { horizonCycles?: number; modelId?: string };
    const prediction = predictRul(engine, assessment, Math.max(30, Math.min(body.horizonCycles ?? 240, 2000)), findModel(body.modelId));
    await store.mutate(() => {
      store.addPrediction(prediction);
      store.log('rul_prediction', id, { predictionId: prediction.predictionId, estimatedRemainingCycles: prediction.estimatedRemainingCycles, basedOnAssessment: assessment.assessmentId });
    });
    return prediction;
  });
  app.post('/api/engines/:id/replay', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const rows = store.telemetry.filter(item => item.engineId === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp)); const body = (request.body ?? {}) as { speed?: number; cursor?: number }; return { id: `REPLAY-${Date.now()}`, engineId: id, status: 'ready', speed: body.speed ?? 1, cursor: body.cursor ?? 0, eventCount: rows.length, next: rows[body.cursor ?? 0] }; });
  app.post('/api/engines/:id/maintenance-simulation', async request => { const id = (request.params as { id: string }).id; requireEngine(id); const prediction = requireFreshPrediction(id); const body = (request.body ?? {}) as { delayCycles?: number }; const delay = Math.max(0, body.delayCycles ?? 0); return { engineId: id, delayCycles: delay, windows: maintenanceWindows({ ...prediction, estimatedRemainingCycles: prediction.estimatedRemainingCycles - delay, lowerBound: Math.max(1, prediction.lowerBound - delay), upperBound: Math.max(1, prediction.upperBound - delay) }), impact: { additionalRisk: Math.min(100, Math.round(delay / Math.max(prediction.estimatedRemainingCycles, 1) * 100)), recommendation: delay > prediction.lowerBound ? '延后超过寿命下界，不建议执行' : '当前延后仍在可评估范围内' } }; });
  app.post('/api/models/compare', async request => { const body = request.body as { engineId: string; modelIds?: string[] }; const engine = requireEngine(body.engineId); const rows = store.telemetry.filter(item => item.engineId === body.engineId); return (body.modelIds ?? store.models.map(item => item.id)).map(id => { const model = findModel(id); const result = assessEngine(engine, rows, model, store.maintenance.filter(item => item.engineId === engine.id).length); return { modelId: model.id, label: model.label, healthScore: result.healthScore, status: result.status, dataQuality: result.dataQuality.score, degradationSlope: result.indicators.degradationSlope }; }); });

  app.post('/api/maintenance-events', async request => {
    const event = validateMaintenanceEvent(request.body);
    // 所有校验在写入前完成：校验失败时状态完全不变
    const invalidated = await store.mutate(() => {
      const result = store.recordMaintenance(event);
      store.log('maintenance_event', event.engineId, { eventId: event.id, component: event.component, action: event.action, severity: event.severity, occurredAt: event.occurredAt });
      if (result.invalidatedAssessmentIds.length) store.log('assessment_invalidated', event.engineId, { reason: 'maintenance_recorded', maintenanceEventId: event.id, invalidatedAssessmentIds: result.invalidatedAssessmentIds, message: '维护事件写入后，旧健康评估待重算' });
      if (result.invalidatedPredictionIds.length) store.log('prediction_invalidated', event.engineId, { reason: 'maintenance_recorded', maintenanceEventId: event.id, invalidatedPredictionIds: result.invalidatedPredictionIds, message: '维护事件写入后，旧 RUL 预测已失效' });
      return result;
    });
    return { event, invalidatedAssessments: invalidated.invalidatedAssessmentIds, invalidatedPredictions: invalidated.invalidatedPredictionIds, recalculationRequired: invalidated.invalidatedAssessmentIds.length > 0 || invalidated.invalidatedPredictionIds.length > 0 };
  });

  // 只读接口：在风险事件列表中显式补充评估待重算 / 预测已失效提示，不产生任何写入
  app.get('/api/engines/:id/risk-events', async request => {
    const id = (request.params as { id: string }).id; requireEngine(id);
    // 只有“当前最新”的评估/预测失效才影响调度决策；历史记录保留其失效标记但不再阻断
    const latestAssessment = store.assessments.find(item => item.engineId === id);
    const latestPrediction = store.predictions.find(item => item.engineId === id);
    const staleAssessment = latestAssessment?.fresh === false ? latestAssessment : undefined;
    const stalePrediction = latestPrediction?.fresh === false ? latestPrediction : undefined;
    const notices: Anomaly[] = [];
    if (staleAssessment?.staleness) notices.push({ id: `NOTICE-ASSESS-${staleAssessment.assessmentId}`, engineId: id, timestamp: staleAssessment.staleness.markedAt, type: 'assessment_stale', severity: 'high', message: `健康评估 ${staleAssessment.assessmentId} 在维护事件 ${staleAssessment.staleness.maintenanceEventId} 写入后待重算，下列历史异常仅作存档参考`, evidence: { assessmentId: staleAssessment.assessmentId, maintenanceEventId: staleAssessment.staleness.maintenanceEventId, component: staleAssessment.staleness.component } });
    if (stalePrediction?.staleness) notices.push({ id: `NOTICE-PRED-${stalePrediction.predictionId}`, engineId: id, timestamp: stalePrediction.staleness.markedAt, type: 'prediction_invalid', severity: 'high', message: `RUL 预测 ${stalePrediction.predictionId} 在维护事件 ${stalePrediction.staleness.maintenanceEventId} 写入后已失效，需重新评估后再预测`, evidence: { predictionId: stalePrediction.predictionId, maintenanceEventId: stalePrediction.staleness.maintenanceEventId, component: stalePrediction.staleness.component } });
    const events = store.assessments.filter(item => item.engineId === id).flatMap(item => item.anomalies.map(anomaly => ({ ...anomaly, assessmentId: item.assessmentId, assessmentFresh: item.fresh !== false })));
    return { engineId: id, recalculationRequired: notices.length > 0, staleAssessments: staleAssessment ? [staleAssessment.assessmentId] : [], stalePredictions: stalePrediction ? [stalePrediction.predictionId] : [], events: [...notices, ...events] };
  });
  app.get('/api/audit/:engineId', async request => store.audit.filter(item => item.engineId === (request.params as { engineId: string }).engineId));
  app.setErrorHandler((error: Error, _request, reply) => reply.code((error as Error & { statusCode?: number }).statusCode ?? 500).send({ error: error.message }));
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await createApp();
  await app.listen({ host: '127.0.0.1', port: 6195 });
}
