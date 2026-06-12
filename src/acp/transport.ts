import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcMessage, JsonRpcError, RequestId,
} from '../types/acp.js';

export interface TransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type IncomingRequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

export class AcpTransport extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private requestTimeoutMs: number;
  private onIncomingRequest: IncomingRequestHandler | null = null;
  private onNotification: NotificationHandler | null = null;
  private _closed = false;

  constructor(private options: TransportOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  }

  get closed(): boolean {
    return this._closed;
  }

  lastMessageAt = Date.now();

  start(): void {
    const env = { ...process.env, ...this.options.env };
    this.process = spawn(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.options.cwd,
      shell: process.platform === 'win32',
    });

    this.process.on('exit', (code, signal) => {
      this._closed = true;
      this.rejectAllPending(new Error(`Agent process exited (code=${code}, signal=${signal})`));
      this.emit('exit', code, signal);
    });

    this.process.on('error', (err) => {
      this._closed = true;
      this.rejectAllPending(err);
      this.emit('error', err);
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        this.emit('stderr', chunk.toString());
      });
    }

    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(trimmed);
        } catch (err) {
          this.emit('framingError', trimmed, err);
          return;
        }
        this.lastMessageAt = Date.now();
        if (!this.handleMessage(msg)) {
          this.emit('invalidMessage', msg);
        }
      });
      rl.on('close', () => {
        this._closed = true;
      });
    }
  }

  setRequestHandler(handler: IncomingRequestHandler): void {
    this.onIncomingRequest = handler;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.onNotification = handler;
  }

  /**
   * Send a JSON-RPC request and await its response.
   *
   * @param timeoutMs Per-call timeout override. Defaults to the transport's
   *   `requestTimeoutMs`. Pass `0` (or any non-positive value) to disable the
   *   timeout entirely — required for inherently long-running requests like
   *   `session/prompt`, which stay open for the full duration of the agent's
   *   work and are bounded instead by `session/cancel` or process exit.
   */
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this._closed) throw new Error('Transport is closed');
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = effectiveTimeout > 0
        ? setTimeout(() => {
            this.pendingRequests.delete(id);
            const err = new Error(`Request timed out: ${method} (id=${id})`);
            // Typed marker so callers can distinguish a transport-level timeout
            // from an agent-side JSON-RPC error that merely mentions "timeout".
            // Agent errors carry a numeric `code`; this string never collides.
            (err as { code?: unknown }).code = 'REQUEST_TIMEOUT';
            reject(err);
          }, effectiveTimeout)
        : null;
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this._closed) throw new Error('Transport is closed');
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(msg);
  }

  async close(killTimeoutMs = 5000): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.rejectAllPending(new Error('Transport closing'));

    if (this.process && !this.process.killed) {
      this.process.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, killTimeoutMs);
        this.process!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Cannot write to agent process');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleMessage(msg: JsonRpcMessage): boolean {
    if ('id' in msg && msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const resp = msg as JsonRpcResponse;
      const idKey = typeof resp.id === 'number' ? resp.id : String(resp.id);
      const pending = this.pendingRequests.get(idKey);
      if (pending) {
        this.pendingRequests.delete(idKey);
        if (pending.timer) clearTimeout(pending.timer);
        if (resp.error) {
          const err = new Error(resp.error.message);
          (err as any).code = resp.error.code;
          (err as any).data = resp.error.data;
          pending.reject(err);
        } else {
          pending.resolve(resp.result);
        }
      }
      return true;
    }

    if ('id' in msg && 'method' in msg && !('result' in msg) && !('error' in msg)) {
      const req = msg as JsonRpcRequest;
      if (this.onIncomingRequest) {
        this.onIncomingRequest(req.method, req.params, req.id)
          .then((result) => {
            this.send({ jsonrpc: '2.0', id: req.id, result } as JsonRpcResponse);
          })
          .catch((err) => {
            const error: JsonRpcError = {
              code: (err as any).code ?? -32603,
              message: err instanceof Error ? err.message : String(err),
            };
            this.send({ jsonrpc: '2.0', id: req.id, error } as JsonRpcResponse);
          });
      }
      return true;
    }

    if ('method' in msg && !('id' in msg)) {
      const notif = msg as JsonRpcNotification;
      if (this.onNotification) {
        this.onNotification(notif.method, notif.params);
      }
      this.emit('notification', notif.method, notif.params);
      return true;
    }

    return false;
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
