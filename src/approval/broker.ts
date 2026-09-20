// Approval broker: binds one approval to job/attempt/run/native-request,
// first decision wins atomically, expiry/deny-by-default, restart invalidates.
import { Store } from "../storage/store.js";
import { EventEmitter } from "node:events";
import { PermissionOption } from "../contracts/index.js";

export class ApprovalBroker extends EventEmitter {
  constructor(private store: Store) {
    super();
  }

  request(a: { job_id: string; attempt_id: string; run_id: string; native_request_id: string; action: string; target: string; options: (string | PermissionOption)[]; ttl_ms?: number }): string {
    const approval_id = `appr_${a.run_id}_${a.native_request_id}`;
    this.store.createApproval({ ...a, approval_id, ttl_ms: a.ttl_ms ?? 60000 });
    return approval_id;
  }

  // actor derives from authenticated principal — never from request body.
  decide(approvalId: string, principal: string, option: string, jobId: string) {
    const a = this.store.getApproval(approvalId);
    if (!a || a.job_id !== jobId) return { status: "invalid" as const }; // cross-job denial
    const status = this.store.decideApproval(approvalId, principal, option);
    if (status === "approved" || status === "denied") {
      // emit exactly once: only the call that won the decision delivers
      this.emit(`decided:${a.run_id}:${a.native_request_id}`, { status, option });
    }
    return { status };
  }

  // Resolve pending waiters without delivering a decision (e.g. attempt
  // invalidated/cancelled). Waiters observe "invalidated" and deliver nothing.
  invalidate(runId: string, requestId: string) {
    this.emit(`decided:${runId}:${requestId}`, { status: "invalidated" });
  }

  waitFor(runId: string, requestId: string, timeoutMs: number): Promise<{ status: string; option?: string }> {
    return new Promise((resolve) => {
      const key = `decided:${runId}:${requestId}`;
      const timer = setTimeout(() => {
        this.removeAllListeners(key);
        resolve({ status: "expired" }); // deny/default on timeout — never auto-allow
      }, timeoutMs);
      this.once(key, (v: { status: string; option: string }) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }
}
