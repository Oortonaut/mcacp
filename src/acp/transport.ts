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
  timer: ReturnType<typeof setTimeout>;
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
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMessage;
          this.lastMessageAt = Date.now();
          this.handleMessage(msg);
        } catch (err) {
          this.emit('parseError', line, err);
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

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this._closed) throw new Error('Transport is closed');
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method} (id=${id})`));
      }, this.requestTimeoutMs);
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

  private handleMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const resp = msg as JsonRpcResponse;
      const idKey = typeof resp.id === 'number' ? resp.id : String(resp.id);
      const pending = this.pendingRequests.get(idKey);
      if (pending) {
        this.pendingRequests.delete(idKey);
        clearTimeout(pending.timer);
        if (resp.error) {
          const err = new Error(resp.error.message);
          (err as any).code = resp.error.code;
          (err as any).data = resp.error.data;
          pending.reject(err);
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
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
      return;
    }

    if ('method' in msg && !('id' in msg)) {
      const notif = msg as JsonRpcNotification;
      if (this.onNotification) {
        this.onNotification(notif.method, notif.params);
      }
      this.emit('notification', notif.method, notif.params);
      return;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
