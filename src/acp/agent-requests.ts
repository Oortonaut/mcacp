import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  FsReadTextFileParams, FsReadTextFileResult,
  FsWriteTextFileParams, FsWriteTextFileResult,
  TerminalCreateParams, TerminalCreateResult,
  TerminalOutputParams, TerminalOutputResult,
  TerminalWaitForExitParams, TerminalWaitForExitResult,
  TerminalKillParams, TerminalReleaseParams,
  TerminalId, SessionId,
} from '../types/acp.js';

interface ManagedTerminal {
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode?: number;
  signal?: string;
  waiters: Array<(result: { exitCode?: number; signal?: string }) => void>;
}

export class AgentRequestHandler {
  private terminals = new Map<string, ManagedTerminal>();
  private nextTerminalId = 1;
  private sessionCwds = new Map<SessionId, string>();
  private sessionTerminals = new Map<SessionId, Set<string>>();

  registerSession(sessionId: SessionId, cwd: string): void {
    this.sessionCwds.set(sessionId, cwd);
    this.sessionTerminals.set(sessionId, new Set());
  }

  unregisterSession(sessionId: SessionId): void {
    // Kill and release all terminals belonging to this session
    const terminalIds = this.sessionTerminals.get(sessionId);
    if (terminalIds) {
      for (const id of terminalIds) {
        const terminal = this.terminals.get(id);
        if (terminal) {
          if (!terminal.process.killed) terminal.process.kill();
          this.terminals.delete(id);
        }
      }
      this.sessionTerminals.delete(sessionId);
    }
    this.sessionCwds.delete(sessionId);
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!params || typeof params !== 'object') {
      throw Object.assign(new Error('Invalid params: expected an object'), { code: -32602 });
    }
    switch (method) {
      case 'fs/read_text_file': return this.readTextFile(params as FsReadTextFileParams);
      case 'fs/write_text_file': return this.writeTextFile(params as FsWriteTextFileParams);
      case 'terminal/create': return this.createTerminal(params as TerminalCreateParams);
      case 'terminal/output': return this.getTerminalOutput(params as TerminalOutputParams);
      case 'terminal/wait_for_exit': return this.waitForExit(params as TerminalWaitForExitParams);
      case 'terminal/kill': return this.killTerminal(params as TerminalKillParams);
      case 'terminal/release': return this.releaseTerminal(params as TerminalReleaseParams);
      default: throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
    }
  }

  private resolvePath(sessionId: SessionId, filePath: string): string {
    const cwd = this.sessionCwds.get(sessionId);
    if (!cwd) throw new Error(`No working directory for session "${sessionId}"`);
    const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
    const normalizedCwd = resolve(cwd);
    // Prevent path traversal outside the session working directory
    if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + sep)) {
      throw new Error(`Path "${filePath}" resolves outside session working directory`);
    }
    return resolved;
  }

  private readTextFile(params: FsReadTextFileParams): FsReadTextFileResult {
    const path = this.resolvePath(params.sessionId, params.path);
    const content = readFileSync(path, 'utf-8');
    if (params.line !== undefined || params.limit !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, (params.line ?? 1) - 1);
      const limit = params.limit !== undefined ? Math.max(0, params.limit) : undefined;
      const end = limit !== undefined ? start + limit : lines.length;
      return { content: lines.slice(start, end).join('\n') };
    }
    return { content };
  }

  private writeTextFile(params: FsWriteTextFileParams): FsWriteTextFileResult {
    const path = this.resolvePath(params.sessionId, params.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, params.content);
    return {};
  }

  private createTerminal(params: TerminalCreateParams): TerminalCreateResult {
    const id = `term_${this.nextTerminalId++}`;
    const cwd = params.cwd ?? this.sessionCwds.get(params.sessionId);
    const env = { ...process.env };
    if (params.env) {
      for (const { name, value } of params.env) env[name] = value;
    }

    const child = spawn(params.command, params.args ?? [], {
      cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });

    const terminal: ManagedTerminal = {
      process: child, output: '', truncated: false,
      outputByteLimit: params.outputByteLimit ?? 1_048_576, waiters: [],
    };

    const appendOutput = (chunk: Buffer) => {
      if (terminal.truncated) return;
      const text = chunk.toString();
      if (terminal.output.length + text.length > terminal.outputByteLimit) {
        terminal.output += text.slice(0, terminal.outputByteLimit - terminal.output.length);
        terminal.truncated = true;
      } else {
        terminal.output += text;
      }
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('exit', (code, signal) => {
      terminal.exitCode = code ?? undefined;
      terminal.signal = signal ?? undefined;
      for (const waiter of terminal.waiters) waiter({ exitCode: terminal.exitCode, signal: terminal.signal });
      terminal.waiters = [];
    });

    this.terminals.set(id, terminal);
    // Track which session owns this terminal for cleanup
    const sessionTerms = this.sessionTerminals.get(params.sessionId);
    if (sessionTerms) sessionTerms.add(id);
    return { terminalId: id };
  }

  private getTerminalOutput(params: TerminalOutputParams): TerminalOutputResult {
    const terminal = this.getTerminal(params.terminalId);
    return {
      output: terminal.output, truncated: terminal.truncated,
      exitStatus: terminal.exitCode !== undefined
        ? { exitCode: terminal.exitCode, signal: terminal.signal } : undefined,
    };
  }

  private waitForExit(params: TerminalWaitForExitParams): Promise<TerminalWaitForExitResult> {
    const terminal = this.getTerminal(params.terminalId);
    if (terminal.exitCode !== undefined) {
      return Promise.resolve({ exitCode: terminal.exitCode, signal: terminal.signal });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = terminal.waiters.indexOf(waiter);
        if (idx !== -1) terminal.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for terminal "${params.terminalId}" to exit`));
      }, 300_000); // 5 minute safety timeout
      const waiter = (result: { exitCode?: number; signal?: string }) => {
        clearTimeout(timeout);
        resolve(result);
      };
      terminal.waiters.push(waiter);
    });
  }

  private killTerminal(params: TerminalKillParams): Record<string, never> {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.process.killed) terminal.process.kill();
    return {};
  }

  private releaseTerminal(params: TerminalReleaseParams): Record<string, never> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      if (!terminal.process.killed) terminal.process.kill();
      this.terminals.delete(params.terminalId);
    }
    return {};
  }

  private getTerminal(id: TerminalId): ManagedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Terminal "${id}" not found`);
    return terminal;
  }
}
