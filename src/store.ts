import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { demoEngine, demoMaintenance, demoModels, createDemoTelemetry } from './demo-data.js';
import { Engine, HealthAssessment, MaintenanceEvent, ModelVersion, RulPrediction, TelemetrySample } from './types.js';

type State = { engines: Engine[]; telemetry: TelemetrySample[]; maintenance: MaintenanceEvent[]; models: ModelVersion[]; assessments: HealthAssessment[]; predictions: RulPrediction[]; audit: Array<Record<string, unknown>> };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// 演示数据为模块级共享常量，每个 store 实例必须持有独立副本，
// 避免某个实例的写入（如维护事件）污染后续实例的初始状态
const initialState = (): State => clone({ engines: [demoEngine], telemetry: createDemoTelemetry(), maintenance: demoMaintenance, models: demoModels, assessments: [], predictions: [], audit: [] });

export class LocalStore {
  private state: State = initialState();
  constructor(private readonly file = resolve(process.cwd(), 'data/state.json')) {}
  async init(): Promise<void> { try { this.state = JSON.parse(await readFile(this.file, 'utf8')) as State; } catch { await this.persist(); } }
  async persist(): Promise<void> { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.state, null, 2)); }

  /**
   * 以事务方式执行变更：mutate 内只做内存变更，成功后一次性持久化；
   * 持久化失败时恢复快照，保证不会留下半条状态。
   */
  async mutate<T>(mutate: () => T): Promise<T> {
    const snapshot = clone(this.state);
    const result = mutate();
    try {
      await this.persist();
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
    return result;
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
  addAssessment(value: HealthAssessment) { this.state.assessments.unshift(value); }
  addPrediction(value: RulPrediction) { this.state.predictions.unshift(value); }
  log(action: string, engineId: string, detail: Record<string, unknown>) { this.state.audit.unshift({ id: `AUD-${this.state.audit.length + 1}`, action, engineId, at: new Date().toISOString(), detail }); }

  /**
   * 写入一条维护事件，并把该发动机在维护事件之前生成、当前仍有效的
   * 健康评估标记为待重算（fresh=false）、RUL 预测标记为失效（fresh=false）。
   * 所有内存变更与审计记录都在同一事务内提交，调用方应通过 mutate 执行。
   * 返回被标记失效的评估/预测 ID，供审计与响应体使用。
   */
  recordMaintenance(event: MaintenanceEvent): { invalidatedAssessmentIds: string[]; invalidatedPredictionIds: string[] } {
    this.state.maintenance.push(event);
    const markedAt = new Date().toISOString();
    const assessmentStaleness = {
      reason: 'maintenance_recorded' as const, maintenanceEventId: event.id, maintenanceOccurredAt: event.occurredAt,
      component: event.component, markedAt, message: `维护事件 ${event.id}（${event.component} / ${event.action}）已写入，该评估需基于最新维护历史重新计算`
    };
    const predictionStaleness = {
      reason: 'maintenance_recorded' as const, maintenanceEventId: event.id, maintenanceOccurredAt: event.occurredAt,
      component: event.component, markedAt, message: `维护事件 ${event.id}（${event.component} / ${event.action}）已写入，旧 RUL 预测已失效，需重新评估后再预测`
    };
    const invalidatedAssessmentIds: string[] = [];
    const invalidatedPredictionIds: string[] = [];
    for (const assessment of this.state.assessments) {
      if (assessment.engineId === event.engineId && assessment.fresh !== false && assessment.createdAt <= markedAt) {
        assessment.fresh = false;
        assessment.staleness = assessmentStaleness;
        invalidatedAssessmentIds.push(assessment.assessmentId);
      }
    }
    for (const prediction of this.state.predictions) {
      if (prediction.engineId === event.engineId && prediction.fresh !== false && prediction.createdAt <= markedAt) {
        prediction.fresh = false;
        prediction.staleness = predictionStaleness;
        invalidatedPredictionIds.push(prediction.predictionId);
      }
    }
    return { invalidatedAssessmentIds, invalidatedPredictionIds };
  }
}
