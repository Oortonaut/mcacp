import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRequestHandler } from '../src/acp/agent-requests.js';

describe('AgentRequestHandler', () => {
  let handler: AgentRequestHandler;
  let tempDir: string;

  beforeEach(() => {
    handler = new AgentRequestHandler();
    tempDir = mkdtempSync(join(tmpdir(), 'mcacp-agent-req-test-'));
    handler.registerSession('sess-1', tempDir);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  describe('dispatch unknown method', () => {
    it('throws with code -32601 for unknown methods', async () => {
      await expect(handler.dispatch('unknown/method', {}))
        .rejects.toThrow('Unknown method: unknown/method');

      // Also verify the error code
      try {
        await handler.dispatch('unknown/method', {});
      } catch (err: any) {
        expect(err.code).toBe(-32601);
      }
    });
  });

  describe('session registration', () => {
    it('registerSession and unregisterSession manage cwd mapping', async () => {
      handler.registerSession('sess-1', tempDir);

      const testFile = join(tempDir, 'test.txt');
      writeFileSync(testFile, 'hello');

      // Should resolve relative path using registered cwd
      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-1',
        path: 'test.txt',
      });
      expect(result).toEqual({ content: 'hello' });

      // After unregister, relative path should fail
      handler.unregisterSession('sess-1');
      await expect(
        handler.dispatch('fs/read_text_file', {
          sessionId: 'sess-1',
          path: 'test.txt',
        }),
      ).rejects.toThrow('No working directory for session "sess-1"');
    });
  });

  describe('fs/read_text_file', () => {
    it('reads a file with absolute path', async () => {
      const filePath = join(tempDir, 'abs-read.txt');
      writeFileSync(filePath, 'absolute content');

      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-1',
        path: filePath,
      });

      expect(result).toEqual({ content: 'absolute content' });
    });

    it('reads a file with relative path using session cwd', async () => {
      handler.registerSession('sess-2', tempDir);
      const filePath = join(tempDir, 'relative-read.txt');
      writeFileSync(filePath, 'relative content');

      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-2',
        path: 'relative-read.txt',
      });

      expect(result).toEqual({ content: 'relative content' });
    });

    it('reads specific lines with line and limit parameters', async () => {
      const filePath = join(tempDir, 'lines.txt');
      writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        line: 2,
        limit: 2,
      });

      expect(result).toEqual({ content: 'line2\nline3' });
    });

    it('reads from a specific line to end when no limit', async () => {
      const filePath = join(tempDir, 'lines-no-limit.txt');
      writeFileSync(filePath, 'a\nb\nc\nd\ne');

      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        line: 3,
      });

      expect(result).toEqual({ content: 'c\nd\ne' });
    });

    it('reads with limit but no line (defaults to line 1)', async () => {
      const filePath = join(tempDir, 'limit-only.txt');
      writeFileSync(filePath, 'x\ny\nz');

      const result = await handler.dispatch('fs/read_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        limit: 2,
      });

      expect(result).toEqual({ content: 'x\ny' });
    });

    it('throws for nonexistent file', async () => {
      await expect(
        handler.dispatch('fs/read_text_file', {
          sessionId: 'sess-1',
          path: join(tempDir, 'nonexistent.txt'),
        }),
      ).rejects.toThrow();
    });

    it('throws when relative path used without registered session', async () => {
      await expect(
        handler.dispatch('fs/read_text_file', {
          sessionId: 'unregistered-sess',
          path: 'some-file.txt',
        }),
      ).rejects.toThrow('No working directory for session "unregistered-sess"');
    });
  });

  describe('fs/write_text_file', () => {
    it('writes a file with absolute path', async () => {
      const filePath = join(tempDir, 'write-abs.txt');

      const result = await handler.dispatch('fs/write_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        content: 'written content',
      });

      expect(result).toEqual({});
      expect(readFileSync(filePath, 'utf-8')).toBe('written content');
    });

    it('writes a file with relative path using session cwd', async () => {
      handler.registerSession('sess-3', tempDir);

      const result = await handler.dispatch('fs/write_text_file', {
        sessionId: 'sess-3',
        path: 'write-rel.txt',
        content: 'relative write',
      });

      expect(result).toEqual({});
      expect(readFileSync(join(tempDir, 'write-rel.txt'), 'utf-8')).toBe('relative write');
    });

    it('creates parent directories automatically', async () => {
      const filePath = join(tempDir, 'sub', 'dir', 'deep.txt');

      await handler.dispatch('fs/write_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        content: 'deep content',
      });

      expect(readFileSync(filePath, 'utf-8')).toBe('deep content');
    });

    it('overwrites existing file content', async () => {
      const filePath = join(tempDir, 'overwrite.txt');
      writeFileSync(filePath, 'old content');

      await handler.dispatch('fs/write_text_file', {
        sessionId: 'sess-1',
        path: filePath,
        content: 'new content',
      });

      expect(readFileSync(filePath, 'utf-8')).toBe('new content');
    });
  });

  describe('terminal/create', () => {
    it('creates a terminal and returns an id', async () => {
      handler.registerSession('sess-term', tempDir);

      const result = await handler.dispatch('terminal/create', {
        sessionId: 'sess-term',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'hello'] : ['hello'],
      });

      expect(result).toHaveProperty('terminalId');
      expect((result as any).terminalId).toMatch(/^term_\d+$/);
    });

    it('assigns sequential terminal IDs', async () => {
      handler.registerSession('sess-term-seq', tempDir);

      const result1 = await handler.dispatch('terminal/create', {
        sessionId: 'sess-term-seq',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', '1'] : ['1'],
      }) as { terminalId: string };

      const result2 = await handler.dispatch('terminal/create', {
        sessionId: 'sess-term-seq',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', '2'] : ['2'],
      }) as { terminalId: string };

      const id1 = parseInt(result1.terminalId.replace('term_', ''), 10);
      const id2 = parseInt(result2.terminalId.replace('term_', ''), 10);
      expect(id2).toBe(id1 + 1);
    });
  });

  describe('terminal/output', () => {
    it('captures stdout output', async () => {
      handler.registerSession('sess-out', tempDir);

      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-out',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'captured'] : ['captured'],
      }) as { terminalId: string };

      // Wait for process to run and produce output
      await new Promise(resolve => setTimeout(resolve, 500));

      const output = await handler.dispatch('terminal/output', {
        sessionId: 'sess-out',
        terminalId,
      }) as { output: string; truncated: boolean };

      expect(output.output).toContain('captured');
      expect(output.truncated).toBe(false);
    });

    it('throws for unknown terminal ID', async () => {
      await expect(
        handler.dispatch('terminal/output', {
          sessionId: 'sess-1',
          terminalId: 'term_999',
        }),
      ).rejects.toThrow('Terminal "term_999" not found');
    });
  });

  describe('terminal/wait_for_exit', () => {
    it('resolves with exit code when process completes', async () => {
      handler.registerSession('sess-wait', tempDir);

      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-wait',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'done'] : ['done'],
      }) as { terminalId: string };

      const result = await handler.dispatch('terminal/wait_for_exit', {
        sessionId: 'sess-wait',
        terminalId,
      }) as { exitCode?: number; signal?: string };

      expect(result.exitCode).toBe(0);
    });

    it('returns immediately if process already exited', async () => {
      handler.registerSession('sess-wait-done', tempDir);

      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-wait-done',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'fast'] : ['fast'],
      }) as { terminalId: string };

      // Wait for process to finish
      await new Promise(resolve => setTimeout(resolve, 500));

      const result = await handler.dispatch('terminal/wait_for_exit', {
        sessionId: 'sess-wait-done',
        terminalId,
      }) as { exitCode?: number; signal?: string };

      expect(result.exitCode).toBe(0);
    });
  });

  describe('terminal/kill', () => {
    it('kills a running terminal process', async () => {
      handler.registerSession('sess-kill', tempDir);

      // Start a long-running process
      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-kill',
        command: process.platform === 'win32' ? 'cmd' : 'sleep',
        args: process.platform === 'win32' ? ['/c', 'timeout', '/t', '30', '/nobreak'] : ['30'],
      }) as { terminalId: string };

      const result = await handler.dispatch('terminal/kill', {
        sessionId: 'sess-kill',
        terminalId,
      });

      expect(result).toEqual({});
    });

    it('throws for unknown terminal ID', async () => {
      await expect(
        handler.dispatch('terminal/kill', {
          sessionId: 'sess-1',
          terminalId: 'term_nonexistent',
        }),
      ).rejects.toThrow('Terminal "term_nonexistent" not found');
    });
  });

  describe('terminal/release', () => {
    it('releases a terminal and removes it from tracking', async () => {
      handler.registerSession('sess-release', tempDir);

      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-release',
        command: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'release-me'] : ['release-me'],
      }) as { terminalId: string };

      // Wait for process to finish
      await new Promise(resolve => setTimeout(resolve, 300));

      const result = await handler.dispatch('terminal/release', {
        sessionId: 'sess-release',
        terminalId,
      });

      expect(result).toEqual({});

      // After release, accessing the terminal should fail
      await expect(
        handler.dispatch('terminal/output', {
          sessionId: 'sess-release',
          terminalId,
        }),
      ).rejects.toThrow(`Terminal "${terminalId}" not found`);
    });

    it('is idempotent for already-released terminal', async () => {
      // Releasing a non-existent terminal should not throw
      const result = await handler.dispatch('terminal/release', {
        sessionId: 'sess-1',
        terminalId: 'term_nonexistent',
      });

      expect(result).toEqual({});
    });
  });

  describe('terminal with custom env', () => {
    it('passes custom environment variables to the spawned process', async () => {
      handler.registerSession('sess-env', tempDir);

      const { terminalId } = await handler.dispatch('terminal/create', {
        sessionId: 'sess-env',
        command: process.platform === 'win32' ? 'cmd' : 'sh',
        args: process.platform === 'win32'
          ? ['/c', 'echo', '%MCACP_TEST_VAR%']
          : ['-c', 'echo $MCACP_TEST_VAR'],
        env: [{ name: 'MCACP_TEST_VAR', value: 'custom_value' }],
      }) as { terminalId: string };

      await handler.dispatch('terminal/wait_for_exit', {
        sessionId: 'sess-env',
        terminalId,
      });

      const output = await handler.dispatch('terminal/output', {
        sessionId: 'sess-env',
        terminalId,
      }) as { output: string; truncated: boolean };

      expect(output.output).toContain('custom_value');
    });
  });
});
