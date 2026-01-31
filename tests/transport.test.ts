import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpTransport } from '../src/acp/transport.js';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/**
 * Creates a mock child process with controllable stdin/stdout/stderr streams.
 */
function createMockProcess() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinChunks.push(chunk.toString());
      callback();
    },
  });

  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(proc, {
    stdout,
    stderr,
    stdin,
    killed: false,
    pid: 12345,
    kill: vi.fn(),
  });

  return { proc, stdout, stderr, stdin, stdinChunks };
}

describe('AcpTransport', () => {
  let mock: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mock = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mock.proc as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses incoming JSON-RPC messages as notifications', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    const notificationHandler = vi.fn();
    transport.setNotificationHandler(notificationHandler);
    transport.start();

    // Push a JSON-RPC notification through stdout
    mock.stdout.push('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}\n');

    // Allow the readline handler to process
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(notificationHandler).toHaveBeenCalledWith(
      'session/update',
      { sessionId: 's1' },
    );
  });

  it('correlates request/response by ID', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    transport.start();

    // Send a request - this writes to stdin
    const responsePromise = transport.request('initialize', { version: 1 });

    // Verify the request was written to stdin
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mock.stdinChunks.length).toBe(1);
    const sentMsg = JSON.parse(mock.stdinChunks[0]);
    expect(sentMsg.jsonrpc).toBe('2.0');
    expect(sentMsg.method).toBe('initialize');
    expect(sentMsg.params).toEqual({ version: 1 });
    const requestId = sentMsg.id;

    // Simulate agent sending response with matching ID
    mock.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result: { protocolVersion: 1, agentCapabilities: {} },
    }) + '\n');

    const result = await responsePromise;
    expect(result).toEqual({ protocolVersion: 1, agentCapabilities: {} });
  });

  it('times out pending requests', async () => {
    const transport = new AcpTransport({
      command: 'test-agent',
      requestTimeoutMs: 100, // Short timeout for test
    });
    transport.start();

    const responsePromise = transport.request('slow/method', {});

    // Do not send a response - let it time out
    await expect(responsePromise).rejects.toThrow(/Request timed out: slow\/method/);
  });

  it('handles notifications via notification handler', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    const handler = vi.fn();
    transport.setNotificationHandler(handler);
    transport.start();

    // Send multiple notifications
    mock.stdout.push('{"jsonrpc":"2.0","method":"agent/status","params":{"text":"working"}}\n');
    mock.stdout.push('{"jsonrpc":"2.0","method":"agent/heartbeat","params":{}}\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('agent/status', { text: 'working' });
    expect(handler).toHaveBeenCalledWith('agent/heartbeat', {});
  });

  it('emits framingError for non-JSON input', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    const framingHandler = vi.fn();
    transport.on('framingError', framingHandler);
    transport.start();

    mock.stdout.push('this is not json\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(framingHandler).toHaveBeenCalledTimes(1);
    expect(framingHandler).toHaveBeenCalledWith(
      'this is not json',
      expect.any(Error),
    );
  });

  it('emits invalidMessage for valid JSON that is not JSON-RPC', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    const invalidHandler = vi.fn();
    transport.on('invalidMessage', invalidHandler);
    transport.start();

    mock.stdout.push('{"foo":"bar"}\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(invalidHandler).toHaveBeenCalledTimes(1);
    expect(invalidHandler).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('rejects pending requests when process exits', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    transport.start();

    const responsePromise = transport.request('some/method', {});

    // Simulate process exit
    mock.proc.emit('exit', 1, null);

    await expect(responsePromise).rejects.toThrow(/Agent process exited/);
  });

  it('handles error responses from agent', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    transport.start();

    const responsePromise = transport.request('bad/method', {});

    await new Promise(resolve => setTimeout(resolve, 20));
    const sentMsg = JSON.parse(mock.stdinChunks[0]);

    mock.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: sentMsg.id,
      error: { code: -32601, message: 'Method not found' },
    }) + '\n');

    await expect(responsePromise).rejects.toThrow('Method not found');
    try {
      await responsePromise;
    } catch (err: any) {
      expect(err.code).toBe(-32601);
    }
  });

  it('throws when sending on a closed transport', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    transport.start();
    await transport.close(100);

    await expect(transport.request('any/method')).rejects.toThrow('Transport is closed');
    expect(() => transport.notify('any/notif')).toThrow('Transport is closed');
  });

  it('handles incoming requests via request handler', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    const requestHandler = vi.fn().mockResolvedValue({ content: 'hello world' });
    transport.setRequestHandler(requestHandler);
    transport.start();

    // Simulate agent sending a request to the client
    mock.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'fs/readTextFile',
      params: { path: '/tmp/test.txt' },
    }) + '\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(requestHandler).toHaveBeenCalledWith(
      'fs/readTextFile',
      { path: '/tmp/test.txt' },
      42,
    );

    // Verify the response was sent back through stdin
    expect(mock.stdinChunks.length).toBe(1);
    const response = JSON.parse(mock.stdinChunks[0]);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(42);
    expect(response.result).toEqual({ content: 'hello world' });
  });

  it('updates lastMessageAt on incoming messages', async () => {
    const transport = new AcpTransport({ command: 'test-agent' });
    transport.start();

    const beforeMessage = transport.lastMessageAt;
    await new Promise(resolve => setTimeout(resolve, 20));

    mock.stdout.push('{"jsonrpc":"2.0","method":"ping","params":{}}\n');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(transport.lastMessageAt).toBeGreaterThanOrEqual(beforeMessage);
  });
});
