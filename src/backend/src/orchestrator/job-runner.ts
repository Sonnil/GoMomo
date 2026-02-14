// ============================================================
// Job Runner — Polls the job queue and executes jobs
//
// Features:
//   - Configurable concurrency limit
//   - Automatic retry with exponential backoff (built into DB)
//   - Stale job reclamation
//   - Graceful shutdown
//   - Audit logging for every job lifecycle event
// ============================================================

import { jobRepo } from '../repos/job.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { redactPII } from './redact.js';
import type { Job } from '../domain/types.js';

export type JobExecutor = (job: Job) => Promise<void>;

interface JobRunnerConfig {
  pollIntervalMs: number;
  maxConcurrent: number;
  staleTimeoutMs: number;
}

class JobRunner {
  private config: JobRunnerConfig;
  private executors = new Map<string, JobExecutor>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private running = false;

  constructor(config: JobRunnerConfig) {
    this.config = config;
  }

  /**
   * Register an executor for a job type.
   * The runner will only execute jobs whose type has a registered executor.
   */
  registerExecutor(jobType: string, executor: JobExecutor): void {
    this.executors.set(jobType, executor);
  }

  /**
   * Start the runner. Begins polling for jobs.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(`[job-runner] Started (poll=${this.config.pollIntervalMs}ms, max=${this.config.maxConcurrent})`);

    // Poll for new jobs
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error('[job-runner] Poll error:', err);
      });
    }, this.config.pollIntervalMs);

    // Reclaim stale jobs every 60 seconds
    this.staleTimer = setInterval(() => {
      this.reclaimStale().catch((err) => {
        console.error('[job-runner] Stale reclaim error:', err);
      });
    }, 60_000);

    // Initial poll
    this.poll().catch(() => {});
  }

  /**
   * Stop the runner gracefully. Waits for active jobs to drain.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.pollTimer = null;
    this.staleTimer = null;

    // Wait for active jobs to complete (max 10 seconds)
    const deadline = Date.now() + 10_000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`[job-runner] Stopped (${this.activeJobs} jobs still active)`);
  }

  /**
   * Current runner status for API introspection.
   */
  getStatus(): {
    running: boolean;
    activeJobs: number;
    registeredTypes: string[];
  } {
    return {
      running: this.running,
      activeJobs: this.activeJobs,
      registeredTypes: [...this.executors.keys()],
    };
  }

  // ── Private ─────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;

    const available = this.config.maxConcurrent - this.activeJobs;
    if (available <= 0) return;

    const jobs = await jobRepo.claimBatch(available);
    for (const job of jobs) {
      // Fire-and-forget: execute in background
      this.executeJob(job).catch(() => {});
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const executor = this.executors.get(job.type);
    if (!executor) {
      console.warn(`[job-runner] No executor for job type: ${job.type}`);
      await jobRepo.fail(job.id, `No executor registered for type: ${job.type}`);
      return;
    }

    this.activeJobs++;
    const startTime = Date.now();

    try {
      await executor(job);
      await jobRepo.complete(job.id);

      // Audit success
      await auditRepo.log({
        tenant_id: job.tenant_id,
        event_type: 'job.completed',
        entity_type: 'job',
        entity_id: job.id,
        actor: 'job_runner',
        payload: redactPII({
          type: job.type,
          duration_ms: Date.now() - startTime,
          attempt: job.attempts,
        } as unknown as Record<string, unknown>),
      });

      console.log(`[job-runner] ✅ ${job.type} completed (${Date.now() - startTime}ms)`);
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      await jobRepo.fail(job.id, errorMsg);

      // Audit failure
      await auditRepo.log({
        tenant_id: job.tenant_id,
        event_type: 'job.failed',
        entity_type: 'job',
        entity_id: job.id,
        actor: 'job_runner',
        payload: {
          type: job.type,
          error: errorMsg,
          attempt: job.attempts,
          will_retry: job.attempts < job.max_attempts,
        },
      });

      console.error(`[job-runner] ❌ ${job.type} failed (attempt ${job.attempts}/${job.max_attempts}): ${errorMsg}`);
    } finally {
      this.activeJobs--;
    }
  }

  private async reclaimStale(): Promise<void> {
    const reclaimed = await jobRepo.reclaimStale(this.config.staleTimeoutMs);
    if (reclaimed > 0) {
      console.log(`[job-runner] Reclaimed ${reclaimed} stale job(s)`);
    }
  }
}

// ── Factory (configured at startup from env vars) ───────────

let runner: JobRunner | null = null;

export function createJobRunner(config: JobRunnerConfig): JobRunner {
  runner = new JobRunner(config);
  return runner;
}

export function getJobRunner(): JobRunner | null {
  return runner;
}
