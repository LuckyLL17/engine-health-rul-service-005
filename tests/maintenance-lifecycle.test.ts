import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { FastifyInstance } from 'fastify';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';
import { MaintenanceEvent } from '../src/types.js';

const tempFile = `/tmp/maintenance-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

let app: FastifyInstance;
let store: LocalStore;

const newMaintenanceEvent = (id: string): MaintenanceEvent => ({
  id,
  engineId: 'ENG-DEMO-001',
  component: 'compressor',
  occurredAt: '2026-10-02T03:00:00.000Z',
  action: 'replacement',
  severity: 'mandatory',
  note: '更换压气机单元体，需重新评估健康状态与剩余寿命'
});

async function assessAndPredict() {
  const assessment = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
  expect(assessment.statusCode).toBe(200);
  const prediction = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
  expect(prediction.statusCode).toBe(200);
  return { assessment: assessment.json(), prediction: prediction.json() };
}

beforeAll(async () => {
  store = new LocalStore(tempFile);
  app = await createApp(store);
  await assessAndPredict();
});

afterAll(async () => {
  await app.close();
  await rm(tempFile, { force: true });
  await rm(`${tempFile}.tmp`, { force: true });
});

describe('maintenance event invalidation lifecycle', () => {
  it('marks prior assessment and RUL as superseded in engine detail', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: newMaintenanceEvent('M-LC-001') });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.invalidated.assessmentIds.length).toBe(1);
    expect(body.invalidated.predictionIds.length).toBe(1);
    expect(body.healthFreshness.stale).toBe(true);
    expect(body.healthFreshness.assessmentState).toBe('superseded');
    expect(body.healthFreshness.predictionState).toBe('superseded');

    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.latestAssessment.lifecycle).toBe('superseded');
    expect(detail.latestAssessment.supersededReason.code).toBe('maintenance_event');
    expect(detail.latestAssessment.supersededReason.maintenanceEventId).toBe('M-LC-001');
    expect(detail.latestPrediction.lifecycle).toBe('superseded');
    expect(detail.latestPrediction.supersededReason.code).toBe('maintenance_event');
    expect(detail.healthFreshness.stale).toBe(true);
    expect(detail.healthFreshness.staleReasons[0].maintenanceEventId).toBe('M-LC-001');
  });

  it('reflects staleness on risk events and audit trail', async () => {
    const risks = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/risk-events' })).json();
    expect(risks.length).toBeGreaterThan(0);
    expect(risks.every((item: { assessmentStale: boolean }) => item.assessmentStale)).toBe(true);
    expect(risks[0].supersededReason.maintenanceEventId).toBe('M-LC-001');

    const audit = (await app.inject({ method: 'GET', url: '/api/audit/ENG-DEMO-001' })).json();
    const actions = audit.map((item: { action: string }) => item.action);
    expect(actions).toContain('maintenance_event');
    expect(actions).toContain('assessment_prediction_invalidated');
    const invalidation = audit.find((item: { action: string }) => item.action === 'assessment_prediction_invalidated');
    expect(invalidation.detail.invalidatedAssessments.length).toBe(1);
    expect(invalidation.detail.invalidatedPredictions.length).toBe(1);
    expect(invalidation.detail.maintenanceEventId).toBe('M-LC-001');
  });

  it('rejects stale snapshots for RUL prediction and maintenance simulation until recompute', async () => {
    const rul = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: {} });
    expect(rul.statusCode).toBe(422);
    expect(rul.json().error).toBe('health_assessment_stale_recompute_required');

    const simulation = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/maintenance-simulation', payload: { delayCycles: 5 } });
    expect(simulation.statusCode).toBe(422);
    expect(simulation.json().error).toBe('rul_prediction_stale_recompute_required');
  });

  it('recomputes assessment using maintenance history and restores current snapshots', async () => {
    const beforeCount = store.maintenance.length;
    expect(beforeCount).toBe(3);

    const assessment = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/health-assessment', payload: { modelId: 'health-v2' } });
    expect(assessment.statusCode).toBe(200);
    expect(assessment.json().lifecycle).toBe('current');

    const latestAudit = store.audit.find(item => item.action === 'health_assessment');
    expect((latestAudit?.detail as { maintenanceEventsConsidered: number }).maintenanceEventsConsidered).toBe(3);

    const prediction = await app.inject({ method: 'POST', url: '/api/engines/ENG-DEMO-001/rul-prediction', payload: { horizonCycles: 240 } });
    expect(prediction.statusCode).toBe(200);
    expect(prediction.json().lifecycle).toBe('current');

    const detail = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001' })).json();
    expect(detail.healthFreshness.stale).toBe(false);
    expect(detail.healthFreshness.assessmentState).toBe('current');

    const risks = (await app.inject({ method: 'GET', url: '/api/engines/ENG-DEMO-001/risk-events' })).json();
    expect(risks.some((item: { assessmentStale: boolean }) => !item.assessmentStale)).toBe(true);
  });

  it('leaves no half state when persistence fails', async () => {
    const maintenanceBefore = store.maintenance.length;
    const auditBefore = store.audit.length;
    const currentAssessmentId = store.assessments.find(item => item.lifecycle !== 'superseded')!.assessmentId;

    const persistStub = async () => { throw new Error('disk full'); };
    (store as unknown as { persist: () => Promise<void> }).persist = persistStub;
    const failed = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: newMaintenanceEvent('M-FAIL-001') });
    delete (store as Partial<LocalStore>).persist;
    expect(failed.statusCode).toBe(500);

    expect(store.maintenance).toHaveLength(maintenanceBefore);
    expect(store.audit).toHaveLength(auditBefore);
    expect(store.maintenance.some(item => item.id === 'M-FAIL-001')).toBe(false);
    const assessment = store.assessments.find(item => item.assessmentId === currentAssessmentId)!;
    expect(assessment.lifecycle).not.toBe('superseded');
  });

  it('rejects invalid or duplicate maintenance events without mutating state', async () => {
    const maintenanceBefore = store.maintenance.length;

    const missingId = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: { ...newMaintenanceEvent('M-BAD-001'), id: '' } });
    expect(missingId.statusCode).toBe(400);

    const badDate = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: { ...newMaintenanceEvent('M-BAD-002'), occurredAt: 'not-a-date' } });
    expect(badDate.statusCode).toBe(400);

    const unknownEngine = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: { ...newMaintenanceEvent('M-BAD-003'), engineId: 'NO-SUCH-ENGINE' } });
    expect(unknownEngine.statusCode).toBe(404);

    const duplicate = await app.inject({ method: 'POST', url: '/api/maintenance-events', payload: newMaintenanceEvent('M-LC-001') });
    expect(duplicate.statusCode).toBe(409);

    expect(store.maintenance).toHaveLength(maintenanceBefore);
  });

  it('read endpoints do not produce side effects on persisted state', async () => {
    const onDisk = await readFile(tempFile, 'utf8');
    const auditLength = store.audit.length;
    for (const url of ['/api/engines/ENG-DEMO-001', '/api/engines/ENG-DEMO-001/risk-events', '/api/audit/ENG-DEMO-001', '/api/engines/ENG-DEMO-001/telemetry']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
    expect(store.audit.length).toBe(auditLength);
    expect(await readFile(tempFile, 'utf8')).toBe(onDisk);
  });
});
