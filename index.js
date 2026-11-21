/**
 * Host half of dsh-page-refresh.
 *
 * The graph already knows when a client bundle was republished: `client-hmr`
 * (when mounted) stat-polls every entry and calls `clientModules.rebuilt`, and
 * the composed graph carries a new `rev`. This plugin only exposes that fact to
 * the page, plus a manual `recompose` for the case where no HMR transport is
 * mounted. The browser half compares `window.__DSH_BOOT__.rev` with the rev
 * reported here — a difference means "the bundle you booted from is stale".
 */
import { statSync } from 'node:fs';

export const name = 'dsh-page-refresh';

const STATE_PATH = '/page-refresh/state';
const RECOMPOSE_PATH = '/page-refresh/recompose';
const EVENTS_PATH = '/page-refresh/events';
const RELOAD_PATH = '/page-refresh/reload';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function apply(ctx) {
  ctx.inject(['webServer', 'clientModules', 'tools'], (host) => {
    const modules = host.clientModules;
    let disposers = null;
    // Every reload this plugin asks for gets a number; the page remembers the
    // last one it obeyed, so a reconnect or a cached HTML cannot replay it.
    let seq = 0;
    let last = null;
    const clients = new Set();

    const entries = () => {
      const graph = modules.graph();
      return graph !== undefined && Array.isArray(graph.entries) ? graph.entries : [];
    };

    const state = () => {
      const graph = modules.graph();
      return {
        rev: graph === undefined ? null : graph.rev,
        release: graph === undefined ? null : graph.release,
        count: entries().length,
        seq,
        last,
      };
    };

    const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

    // Ask every connected page to reload. The assistant calls this through the
    // refresh_page tool when it knows the page needs a fresh boot.
    const requestReload = (reason) => {
      seq += 1;
      const command = { seq, at: new Date().toISOString(), reason: typeof reason === 'string' && reason.length > 0 ? reason : null };
      last = command;
      let delivered = 0;
      for (const client of clients) {
        try {
          client.write(frame('reload', command));
          delivered += 1;
        } catch {
          clients.delete(client);
        }
      }
      return { ...command, clients: delivered };
    };

    const changed = (id) => {
      const baseline = modules.artifactBaseline(id);
      if (baseline === undefined || typeof baseline.path !== 'string') return true;
      try {
        const stat = statSync(baseline.path);
        return stat.mtimeMs !== baseline.mtimeMs || stat.ctimeMs !== baseline.ctimeMs || stat.size !== baseline.size;
      } catch {
        return true;
      }
    };

    const recompose = () => {
      const rebuilt = [];
      const failed = [];
      for (const entry of entries()) {
        const id = entry.id;
        if (typeof id !== 'string') continue;
        if (typeof modules.clientPath(id) !== 'string') continue;
        if (!changed(id)) continue;
        try {
          const rev = modules.rebuilt(id);
          if (rev !== undefined) rebuilt.push(id);
        } catch (error) {
          failed.push({ id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { rebuilt, failed, ...state() };
    };

    host.effect(() => {
      if (disposers !== null) return undefined;
      disposers = [
        host.webServer.register({
          kind: 'exact',
          path: STATE_PATH,
          resource: () => Promise.resolve(json(state())),
        }),
        host.webServer.register({
          kind: 'exact',
          path: RECOMPOSE_PATH,
          resource: () => Promise.resolve(json(recompose())),
        }),
        // Server-sent events: the page listens here for an immediate reload
        // request instead of waiting for the next poll to notice a new rev.
        // Same request as the refresh_page tool, exposed over GET so a script or
        // a stray curl can ask the page to reload too.
        host.webServer.register({
          kind: 'exact',
          path: RELOAD_PATH,
          resource: (request) => {
            const target = new URL(request.url, 'http://placeholder');
            const rebuild = target.searchParams.get('recompose') === '0' ? { rebuilt: [], failed: [] } : recompose();
            return Promise.resolve(json({ ...requestReload(target.searchParams.get('reason')), rebuilt: rebuild.rebuilt, failed: rebuild.failed }));
          },
        }),
        host.webServer.register({
          kind: 'exact',
          path: EVENTS_PATH,
          handler: (request, response) => {
            response.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            });
            response.write(`retry: 2000\n\n`);
            response.write(frame('ready', { seq }));
            clients.add(response);
            const drop = () => clients.delete(response);
            request.on('close', drop);
            response.on('close', drop);
            response.on('error', drop);
          },
        }),
      ];
      return () => {
        const off = disposers;
        disposers = null;
        if (off !== null) for (const dispose of off) dispose();
        for (const client of clients) {
          try {
            client.end();
          } catch {
            /* already gone */
          }
        }
        clients.clear();
      };
    }, 'page-refresh: bundle routes');

    host.effect(() => host.tools.register({
      name: 'refresh_page',
      description: '让打开着的页面立刻刷新一次（重新从服务端取插件产物再重载，对话和会话都留在服务端）。改完插件、或你知道页面上的代码已经旧了的时候用。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么刷新，会带给页面做说明（可选）。' },
          recompose: { type: 'boolean', description: '刷新前先重新合成变化过的插件产物，默认 true。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: (args) => {
        const rebuilt = args?.recompose === false ? { rebuilt: [], failed: [] } : recompose();
        const command = requestReload(args?.reason);
        return {
          ok: true,
          seq: command.seq,
          reason: command.reason,
          clients: command.clients,
          rebuilt: rebuilt.rebuilt,
          failed: rebuilt.failed,
        };
      },
    }), 'page-refresh: refresh tool');
  });
}
