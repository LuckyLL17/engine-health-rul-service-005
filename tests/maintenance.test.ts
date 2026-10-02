import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import type { MaintenanceEvent } from '../src/types.js';

class ControllableStore extends LocalStore {
  failPersist = false;
  constructor(file: string) { super(file); }
  async persist(): Promise<void> {
    if (this.failPersist) throw new Error('disk full');
    await super.persist();
  }
}

let dirs: string[] = [];
afterEach(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); dirs = []; });

async function buildApp(): Promise<{ app: FastifyInstance; file: string; store: ControllableStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-state-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  const store = new ControllableStore(file);
  const app = await createApp(store);
  return { app, file, store };
}

async function assess(app: FastifyInstance) {
  const res = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function predict(app: FastifyInstance) {
  const res = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const maintenanceEvent: MaintenanceEvent = {
  id: 'M-TEST-001', engineId: 'ENG-DEMO-001', component: 'compressor',
  occurredAt: '2026-10-02T03:00:00.000Z', action: 'replacement', severity: 'mandatory', note: '压气机叶片更换'
};

describe('maintenance event invalidation flow', () => {
  it('marks the prior assessment stale and the prior RUL invalid after a successful write', async () => {
    const { app, file } = await buildApp();
    const assessment = await assess(app);
    const prediction = await predict(app);
    expect(assessment.fresh).toBe(true);
    expect(prediction.fresh).toBe(true);

    const write = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(write.statusCode).toBe(200);
    const body = write.json();
    expect(body.invalidatedAssessments).toEqual([assessment.assessmentId]);
    expect(body.invalidatedPredictions).toEqual([prediction.predictionId]);
    expect(body.recalculationRequired).toBe(true);

    // 详情接口：旧评估/预测带有明确的待重算/失效标记
    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment.fresh).toBe(false);
    expect(detail.latestPrediction.fresh).toBe(false);
    expect(detail.latestAssessment.staleness).toMatchObject({ reason: 'maintenance_recorded', maintenanceEventId: 'M-TEST-001', component: 'compressor' });
    expect(detail.latestPrediction.staleness.message).toContain('已失效');
    expect(detail.staleSignals).toMatchObject({ assessmentStale: true, predictionStale: true, cachedHealthScoreStale: true, recalculationRequired: true });

    // 风险事件接口：显式插入待重算/失效提示，历史异常标注来源评估已失效
    const risks = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/risk-events' })).json();
    expect(risks.recalculationRequired).toBe(true);
    expect(risks.events.map((item: { type: string }) => item.type)).toContain('assessment_stale');
    expect(risks.events.map((item: { type: string }) => item.type)).toContain('prediction_invalid');
    expect(risks.events.filter((item: { assessmentFresh?: boolean }) => item.assessmentFresh === false).length).toBeGreaterThan(0);

    // 审计接口：维护事件与失效动作都留痕
    const audit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json();
    const actions = audit.map((item: { action: string }) => item.action);
    expect(actions).toContain('maintenance_event');
    expect(actions).toContain('assessment_invalidated');
    expect(actions).toContain('prediction_invalidated');
    const invalidation = audit.find((item: { action: string }) => item.action === 'assessment_invalidated');
    expect(invalidation.detail.invalidatedAssessmentIds).toEqual([assessment.assessmentId]);
    expect(invalidation.detail.maintenanceEventId).toBe('M-TEST-001');

    // 标记已落盘：用一个新的 store 实例重新加载仍然失效
    const reloaded = await createApp(new LocalStore(file));
    const reloadedDetail = (await reloaded.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(reloadedDetail.latestAssessment.fresh).toBe(false);
    expect(reloadedDetail.latestPrediction.fresh).toBe(false);
    await reloaded.close();
    await app.close();
  });

  it('rejects RUL prediction against a stale assessment until a new assessment is run', async () => {
    const { app } = await buildApp();
    await assess(app);
    await predict(app);
    await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });

    const blocked = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: {} });
    expect(blocked.statusCode).toBe(412);
    expect(blocked.json().error).toBe('health_assessment_stale_recalculate');

    const simBlocked = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: {} });
    expect(simBlocked.statusCode).toBe(412);
    expect(simBlocked.json().error).toBe('rul_prediction_stale_recalculate');

    // 下一次评估读取完整维护历史，产出全新评估并解除待重算状态
    const reassessment = await assess(app);
    expect(reassessment.fresh).toBe(true);
    const latestAudit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json()
      .find((item: { action: string }) => item.action === 'health_assessment');
    // 初始演示维护 2 条 + 新写入 1 条
    expect(latestAudit.detail.maintenanceHistory).toBe(3);
    const newPrediction = await predict(app);
    expect(newPrediction.fresh).toBe(true);

    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.staleSignals.recalculationRequired).toBe(false);
    expect(detail.latestAssessment.assessmentId).toBe(reassessment.assessmentId);
    expect(detail.latestPrediction.predictionId).toBe(newPrediction.predictionId);

    // 旧评估仍保留在历史中并维持待重算标记，不被静默改写
    const risks = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/risk-events' })).json();
    expect(risks.recalculationRequired).toBe(false);
    expect(risks.events.some((item: { assessmentId?: string; assessmentFresh?: boolean }) => item.assessmentId !== reassessment.assessmentId && item.assessmentFresh === false)).toBe(true);
    await app.close();
  });

  it('leaves no partial state when validation fails before persistence', async () => {
    const { app, file } = await buildApp();
    await assess(app);

    const bad = await app.inject({
      method: 'POST', url: '/api/maintenance-events',
      payload: { id: 'M-BAD', engineId: 'ENG-DEMO-001', component: 'avionics', occurredAt: '2026-10-02', action: 'replacement', severity: 'mandatory', note: '非法部件' }
    });
    expect(bad.statusCode).toBe(400);

    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment.fresh).toBe(true);
    expect(detail.staleSignals.recalculationRequired).toBe(false);
    const audit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json();
    expect(audit.some((item: { action: string }) => item.action === 'maintenance_event')).toBe(false);

    const reloaded = await createApp(new LocalStore(file));
    const reloadedDetail = (await reloaded.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(reloadedDetail.latestAssessment.fresh).toBe(true);
    await reloaded.close();
    await app.close();
  });

  it('rolls back the maintenance event and invalidation markers when persistence fails', async () => {
    const { app, store } = await buildApp();
    // 先制造一次有效评估（正常持久化）
    await assess(app);

    // 让持久化抛错，模拟磁盘写入失败，触发事务回滚
    store.failPersist = true;
    const failed = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(failed.statusCode).toBe(500);

    // 内存状态必须回滚：评估仍 fresh，无维护事件与失效审计
    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment.fresh).toBe(true);
    expect(detail.staleSignals.recalculationRequired).toBe(false);
    const audit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json();
    expect(audit.some((item: { action: string }) => item.action === 'maintenance_event')).toBe(false);
    expect(audit.some((item: { action: string }) => item.action === 'assessment_invalidated')).toBe(false);
    expect(audit.some((item: { action: string }) => item.action === 'prediction_invalidated')).toBe(false);

    // 回滚后再次成功写入仍然可用（没有残留半条状态）
    store.failPersist = false;
    const retry = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().invalidatedAssessments.length).toBe(1);
    await app.close();
  });

  it('does not mutate state through read endpoints', async () => {
    const { app, file } = await buildApp();
    await assess(app);
    await predict(app);
    await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });

    const before = await readFile(file, 'utf8');
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' });
      await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/risk-events' });
      await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' });
      await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/telemetry' });
    }
    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
    await app.close();
  });

  it('rejects a duplicate maintenance event id without changing state', async () => {
    const { app } = await buildApp();
    await assess(app);
    const first = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(second.statusCode).toBe(409);
    const audit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json()
      .filter((item: { action: string }) => item.action === 'maintenance_event');
    expect(audit).toHaveLength(1);
    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment.fresh).toBe(false);
    await app.close();
  });

  it('does not invalidate when there is nothing to recalculate', async () => {
    const { app } = await buildApp();
    const write = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: maintenanceEvent });
    expect(write.statusCode).toBe(200);
    expect(write.json().invalidatedAssessments).toEqual([]);
    expect(write.json().invalidatedPredictions).toEqual([]);
    expect(write.json().recalculationRequired).toBe(false);
    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment).toBeUndefined();
    expect(detail.staleSignals.recalculationRequired).toBe(false);
    await app.close();
  });
});
