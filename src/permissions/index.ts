import type {
  RequestPermissionParams, RequestPermissionOutcome, SessionUpdate,
} from '../types/acp.js';
import type { AgentHandle } from '../acp/lifecycle.js';
import type { ActiveSession } from '../sessions/index.js';

export type ElicitationSender = (
  message: string,
  schema: Record<string, unknown>,
) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;

export class PermissionEngine {
  private elicitationSender: ElicitationSender | null = null;

  setElicitationSender(sender: ElicitationSender): void {
    this.elicitationSender = sender;
  }

  async handle(
    session: ActiveSession,
    _handle: AgentHandle,
    params: RequestPermissionParams,
    _updates: SessionUpdate[],
  ): Promise<RequestPermissionOutcome> {
    switch (session.permissionPolicy) {
      case 'allow_all': return this.handleAllowAll(params);
      case 'deny_all': return this.handleDenyAll(params);
      case 'elicit': return this.handleElicit(session, params);
      case 'operator': return this.handleOperator(session, params);
      default: return this.handleAllowAll(params);
    }
  }

  private handleAllowAll(params: RequestPermissionParams): RequestPermissionOutcome {
    const opt = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
    if (opt) return { selected: { optionId: opt.optionId } };
    if (params.options.length > 0) return { selected: { optionId: params.options[0].optionId } };
    return { cancelled: {} };
  }

  private handleDenyAll(params: RequestPermissionParams): RequestPermissionOutcome {
    const opt = params.options.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
    if (opt) return { selected: { optionId: opt.optionId } };
    return { cancelled: {} };
  }

  private async handleElicit(
    session: ActiveSession,
    params: RequestPermissionParams,
  ): Promise<RequestPermissionOutcome> {
    if (!this.elicitationSender) {
      return this.handleOperator(session, params);
    }

    const message = `Agent requests permission: ${params.toolCall.title}`;
    const schema = {
      type: 'object' as const,
      properties: {
        decision: {
          type: 'string' as const,
          title: 'Permission',
          description: `Agent wants to: ${params.toolCall.title}`,
          enum: params.options.map(o => o.optionId),
          enumNames: params.options.map(o => o.name),
        },
      },
      required: ['decision'],
    };

    try {
      const result = await this.elicitationSender(message, schema);
      if (result.action === 'accept' && result.content?.decision) {
        return { selected: { optionId: result.content.decision as string } };
      }
      return { cancelled: {} };
    } catch {
      // Host doesn't support elicitation — fall back to operator mode
      return this.handleOperator(session, params);
    }
  }

  private handleOperator(
    session: ActiveSession,
    params: RequestPermissionParams,
  ): Promise<RequestPermissionOutcome> {
    return new Promise<RequestPermissionOutcome>((resolve) => {
      session.pendingPermission = {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title,
        options: params.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        resolve,
      };
    });
  }
}
