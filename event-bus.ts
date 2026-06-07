// event-bus.ts — AEHub Event Bus Foundation (Phase 0)
// Clean implementation — no legacy code copied

import { v4 as uuidv4 } from 'uuid';

export interface TaskEnvelope {
  task_id: string;
  lane: string;
  description: string;
  priority: number;
  stakes: 'low' | 'medium' | 'high' | 'irreversible';
  metadata?: Record<string, unknown>;
  provenance?: Array<{
    claim: string;
    source: string;
    verified: boolean;
    timestamp?: string;
  }>;
}

export interface EventLogEntry {
  id: string;
  timestamp: string;
  task_id: string;
  event_type: string;
  payload: unknown;
  would_act?: boolean;
  provenance: TaskEnvelope['provenance'];
}

class AEHubEventBus {
  private queue: TaskEnvelope[] = [];
  private auditLog: EventLogEntry[] = [];

  constructor() {
    console.log('✅ AEHub Event Bus initialized (shadow mode)');
  }

  enqueue(task: TaskEnvelope): { success: boolean; error?: string } {
    if (!task.provenance || task.provenance.length === 0) {
      return { success: false, error: 'Missing provenance — rejected per Four Laws' };
    }

    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);

    this.logEvent(task.task_id, 'enqueued', task, false);
    return { success: true };
  }

  private logEvent(task_id: string, event_type: string, payload: unknown, would_act = false) {
    const entry: EventLogEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      task_id,
      event_type,
      payload,
      would_act,
      provenance: (payload as any).provenance || []
    };
    this.auditLog.push(entry);
    console.log(`📋 [AUDIT] ${event_type} → ${task_id}`);
  }

  getQueue(): TaskEnvelope[] {
    return [...this.queue];
  }

  getAuditLog(): EventLogEntry[] {
    return [...this.auditLog];
  }

  dequeue(): TaskEnvelope | null {
    return this.queue.shift() || null;
  }
}

export const eventBus = new AEHubEventBus();
export default eventBus;
