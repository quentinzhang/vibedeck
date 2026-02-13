import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { parseAgentProjects } from './scripts/lib/agentMapping.mjs';

export default defineConfig(() => {
  const allowRemote =
    process.env.PRD_DASHBOARD_ALLOW_REMOTE === 'true' ||
    process.env.PRD_DASHBOARD_ALLOW_REMOTE === '1';

  const internalPrdApi = () => {
    const repoRoot = path.resolve(__dirname, '.');
    const agentPath = path.join(repoRoot, 'AGENT.md');
    let agentCache: { mtimeMs: number; mapping: Map<string, string> } | null = null;

    function isLocalRequest(req: any) {
      if (allowRemote) return true;
      const addr = String(req?.socket?.remoteAddress || '');
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    }

    function sendJson(res: any, statusCode: number, payload: unknown) {
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(`${JSON.stringify(payload)}\n`);
    }

    function safeResolveRepoPath(relPath: string) {
      const rel = String(relPath || '').replaceAll('\\', '/').replace(/^\/+/, '');
      const abs = path.resolve(repoRoot, rel);
      const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
      if (!abs.startsWith(rootWithSep)) {
        throw new Error('Invalid path (outside repo)');
      }
      return { rel, abs };
    }

    function isSafeKey(value: string) {
      return /^[A-Za-z0-9_.-]+$/.test(String(value || ''));
    }

    function sanitizeKey(raw: string) {
      return String(raw || '').replaceAll(/[^A-Za-z0-9_.-]+/g, '_');
    }

    async function getAgentMapping() {
      const stat = await fs.stat(agentPath);
      if (agentCache && agentCache.mtimeMs === stat.mtimeMs) return agentCache.mapping;
      const text = await fs.readFile(agentPath, 'utf8');
      const mapping = parseAgentProjects(text);
      agentCache = { mtimeMs: stat.mtimeMs, mapping };
      return mapping;
    }

    async function readLogText(filePath: string, { maxBytes }: { maxBytes: number }) {
      const stat = await fs.stat(filePath);
      const size = stat.size;

      if (size <= maxBytes) {
        return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
      }

      const handle = await fs.open(filePath, 'r');
      try {
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        await handle.read(buf, 0, buf.length, start);
        const header = `...(truncated, showing last ${maxBytes} bytes of ${size})...\n\n`;
        return { text: `${header}${buf.toString('utf8')}`, truncated: true };
      } finally {
        await handle.close();
      }
    }

    async function readJsonBody(req: any) {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          const size = chunks.reduce((acc, b) => acc + b.length, 0);
          if (size > 1024 * 1024) {
            reject(new Error('Request too large'));
            return;
          }
        });
        req.on('end', () => resolve());
        req.on('error', reject);
      });
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, unknown>;
    }

    function runMove(relPath: string, toStatus: string) {
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'prd_cards.mjs'),
          'move',
          '--hub',
          repoRoot,
          '--relPath',
          relPath,
          '--to',
          toStatus,
          '--sync',
        ],
        { cwd: repoRoot, stdio: 'ignore' },
      );
    }

    function tryOpenWithEditors(absPath: string, line?: number, column?: number) {
      const preferred = String(process.env.PRD_DASHBOARD_EDITOR || '').trim();
      const candidates = [
        preferred || null,
        'code-insiders',
        'code',
        'cursor',
        'windsurf',
      ].filter((v): v is string => Boolean(v));

      const suffix =
        typeof line === 'number' && Number.isFinite(line) && line > 0
          ? `:${Math.floor(line)}${typeof column === 'number' && Number.isFinite(column) && column > 0 ? `:${Math.floor(column)}` : ''}`
          : '';

      for (const bin of candidates) {
        try {
          execFileSync(bin, ['-g', `${absPath}${suffix}`], { cwd: repoRoot, stdio: 'ignore' });
          return;
        } catch {
          // ignore
        }
      }

      if (process.platform === 'darwin') {
        execFileSync('open', [absPath], { cwd: repoRoot, stdio: 'ignore' });
        return;
      }

      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'start', '""', absPath], { cwd: repoRoot, stdio: 'ignore' });
        return;
      }

      execFileSync('xdg-open', [absPath], { cwd: repoRoot, stdio: 'ignore' });
    }

    function register(server: any) {
      server.middlewares.use('/__prd/api/open', async (req: any, res: any) => {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'Forbidden' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody(req);
          const relPath = String(body.relPath || '');
          const line = body.line == null ? undefined : Number(body.line);
          const column = body.column == null ? undefined : Number(body.column);

          const { rel, abs } = safeResolveRepoPath(relPath);
          if (!rel.startsWith('projects/')) throw new Error('Only `projects/` paths are allowed');
          if (!rel.endsWith('.md')) throw new Error('Only Markdown files are allowed');

          tryOpenWithEditors(abs, line, column);

          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Bad request' });
        }
      });

      server.middlewares.use('/__prd/api/move', async (req: any, res: any) => {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'Forbidden' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody(req);
          const relPath = String(body.relPath || '');
          const toStatus = String(body.toStatus || '');
          const { rel } = safeResolveRepoPath(relPath);
          if (!rel.startsWith('projects/')) throw new Error('Only `projects/` paths are allowed');
          if (!rel.endsWith('.md')) throw new Error('Only Markdown files are allowed');
          if (!toStatus) throw new Error('Missing toStatus');

          runMove(rel, toStatus);

          const parts = rel.split('/');
          const projectName = parts[1] || '';
          const baseName = path.posix.basename(rel);
          const isArchivedPath = parts.length >= 4 && parts[2] === 'archived';
          const nextRelPath =
            toStatus === 'archived'
              ? `projects/${projectName}/archived/${baseName}`
              : isArchivedPath
                ? `projects/${projectName}/${baseName}`
                : rel;

          sendJson(res, 200, { ok: true, relPath: nextRelPath });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Bad request' });
        }
      });

      server.middlewares.use('/__prd/api/card', async (req: any, res: any) => {
        if (!isLocalRequest(req)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        try {
          const url = new URL(String(req.url || ''), 'http://localhost');
          const relPath = String(url.searchParams.get('relPath') || '');
          const { rel, abs } = safeResolveRepoPath(relPath);
          if (!rel.startsWith('projects/')) throw new Error('Only `projects/` paths are allowed');
          if (!rel.endsWith('.md')) throw new Error('Only Markdown files are allowed');

          const text = await fs.readFile(abs, 'utf8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(text);
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(error instanceof Error ? error.message : 'Bad request');
        }
      });

      server.middlewares.use('/__prd/api/log', async (req: any, res: any) => {
        if (!isLocalRequest(req)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        try {
          const url = new URL(String(req.url || ''), 'http://localhost');
          const project = String(url.searchParams.get('project') || '').trim();
          const cardId = String(url.searchParams.get('cardId') || '').trim();
          if (!project) throw new Error('Missing project');
          if (!cardId) throw new Error('Missing cardId');
          if (!isSafeKey(project) || !isSafeKey(cardId)) throw new Error('Invalid project/cardId');

          const mapping = await getAgentMapping();
          const repoPath = mapping.get(project);
          if (!repoPath) throw new Error(`Unknown project: ${project}`);

          const runKey = sanitizeKey(`${project}-${cardId}`);
          const projectKey = sanitizeKey(project);
          const cardKey = sanitizeKey(cardId);
          const worktreeCandidates = [
            // Current: worktrees are namespaced by project to avoid collisions.
            path.join(repoPath, '.worktrees', projectKey, cardKey),
            // Legacy: worktrees were directly under `.worktrees/<CARD_ID>`.
            path.join(repoPath, '.worktrees', cardKey),
          ];

          let text = '';
          let loaded = false;
          /** @type {any} */
          let lastErr = null;
          try {
            const logAbs = path.resolve(repoPath, '.prd-autopilot', 'results', `${runKey}.log`);
            const baseWithSep = repoPath.endsWith(path.sep) ? repoPath : `${repoPath}${path.sep}`;
            if (!logAbs.startsWith(baseWithSep)) throw new Error('Invalid log path');
            ({ text } = await readLogText(logAbs, { maxBytes: 1024 * 1024 }));
            lastErr = null;
            loaded = true;
          } catch (err: any) {
            lastErr = err;
            if (err?.code !== 'ENOENT') throw err;
          }

          if (!loaded) {
            for (const worktreePath of worktreeCandidates) {
              const logAbs = path.resolve(worktreePath, '.prd-autopilot', 'results', `${runKey}.log`);
              const baseWithSep = worktreePath.endsWith(path.sep) ? worktreePath : `${worktreePath}${path.sep}`;
              if (!logAbs.startsWith(baseWithSep)) throw new Error('Invalid log path');
              try {
                ({ text } = await readLogText(logAbs, { maxBytes: 1024 * 1024 }));
                lastErr = null;
                loaded = true;
                break;
              } catch (err: any) {
                lastErr = err;
                if (err?.code === 'ENOENT') continue;
                throw err;
              }
            }
          }
          if (lastErr?.code === 'ENOENT') throw lastErr;

          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(text);
        } catch (error: any) {
          if (error?.code === 'ENOENT') {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Log not found');
            return;
          }
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(error instanceof Error ? error.message : 'Bad request');
        }
      });
    }

    return {
      name: 'internal-prd-api',
      configureServer(server: any) {
        register(server);
      },
      configurePreviewServer(server: any) {
        register(server);
      },
    };
  };

  return {
    server: {
      port: 5566,
      host: '0.0.0.0',
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          prd: path.resolve(__dirname, 'prd.html'),
        },
      },
    },
    plugins: [internalPrdApi(), react()],
  };
});
