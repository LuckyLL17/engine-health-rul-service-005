import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, SupersededReason, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; audit: Array<Record<string, unknown>> };

export class LocalStore {
  private state: State = { engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], audit: [] };
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}

  async init(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as State;
      this.migrate();
    } catch {
      await this.persist();
    }
  }

  /** 兼容旧版 state.json：没有 lifecycle 字段的快照视为仍然有效 */
  private migrate(): void {
    for (const assessment of this.state.assessments) assessment.lifecycle ??= 'current';
    for (const prediction of this.state.predictions) prediction.lifecycle ??= 'current';
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // 临时文件 + 原子 rename，避免进程崩溃或写盘失败损坏状态文件
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }

  /**
   * 原子提交：mutation 只改内存，落盘成功才对外可见；落盘失败回滚内存，
   * 保证不会留下“事件已写入内存但未落盘/旧快照未失效”的半条状态。
   */
  async commit<T>(mutation: () => T): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      const result = mutation();
      await this.persist();
      return result;
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  get engines() { return this.state.engines; }
  get telemetry() { return this.state.telemetry; }
  get maintenance() { return this.state.maintenance; }
  get models() { return this.state.models; }
  get assessments() { return this.state.assessments; }
  get predictions() { return this.state.predictions; }
  get audit() { return this.state.audit; }
  addTelemetry(rows: TelemetrySample[]) { this.state.telemetry.push(...rows); }
  addEngine(engine: Engine) { this.state.engines.push(engine); }
  addMaintenance(event: MaintenanceEvent) { this.state.maintenance.push(event); }
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }

  /**
   * 维护事件成功写入后调用：把该发动机当前生效的评估和预测全部标记为
   * superseded（待重算/失效），返回被失效的快照标识用于审计与响应。
   */
  supersedeForMaintenance(engineId: string, event: MaintenanceEvent, at = new Date().toISOString()) {
    const reason = (kind: 'assessment' | 'prediction'): SupersededReason => ({
      code: 'maintenance_event',
      at,
      message: `维护事件 ${event.id}（${event.action}/${event.component}）已写入，维护前${kind === 'assessment' ? '健康评估' : 'RUL 预测'}已失效，需重新计算`,
      maintenanceEventId: event.id,
      maintenanceOccurredAt: event.occurredAt
    });
    const assessmentIds: string[] = [];
    for (const assessment of this.state.assessments) {
      if (assessment.engineId === engineId && assessment.lifecycle !== 'superseded') {
        assessment.lifecycle = 'superseded';
        assessment.supersededAt = at;
        assessment.supersededReason = reason('assessment');
        assessmentIds.push(assessment.assessmentId);
      }
    }
    const predictionIds: string[] = [];
    for (const prediction of this.state.predictions) {
      if (prediction.engineId === engineId && prediction.lifecycle !== 'superseded') {
        prediction.lifecycle = 'superseded';
        prediction.supersededAt = at;
        prediction.supersededReason = reason('prediction');
        predictionIds.push(prediction.predictionId);
      }
    }
    return { assessmentIds, predictionIds };
  }

  /** 新评估产生时：旧评估与依赖旧评估的预测同时失效 */
  supersedeForAssessment(engineId: string, at = new Date().toISOString()) {
    for (const assessment of this.state.assessments) {
      if (assessment.engineId === engineId && assessment.lifecycle !== 'superseded') {
        assessment.lifecycle = 'superseded';
        assessment.supersededAt = at;
        assessment.supersededReason = { code: 'new_assessment', at, message: '已产生更新的健康评估，旧评估被取代' };
      }
    }
    for (const prediction of this.state.predictions) {
      if (prediction.engineId === engineId && prediction.lifecycle !== 'superseded') {
        prediction.lifecycle = 'superseded';
        prediction.supersededAt = at;
        prediction.supersededReason = { code: 'new_assessment', at, message: '健康评估已重算，基于旧评估的 RUL 预测待重新计算' };
      }
    }
  }

  /** 新预测产生时：仅旧预测失效 */
  supersedeForPrediction(engineId: string, at = new Date().toISOString()) {
    for (const prediction of this.state.predictions) {
      if (prediction.engineId === engineId && prediction.lifecycle !== 'superseded') {
        prediction.lifecycle = 'superseded';
        prediction.supersededAt = at;
        prediction.supersededReason = { code: 'new_prediction', at, message: '已产生更新的 RUL 预测，旧预测被取代' };
      }
    }
  }
}
