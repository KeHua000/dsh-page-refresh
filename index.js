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
export const name = 'dsh-page-refresh';

const STATE_PATH = '/page-refresh/state';
const RECOMPOSE_PATH = '/page-refresh/recompose';

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
  ctx.inject(['webServer', 'clientModules'], (host) => {
    const modules = host.clientModules;
    let disposers = null;

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
      };
    };

    const recompose = () => {
      const rebuilt = [];
      const failed = [];
      for (const entry of entries()) {
        const id = entry.id;
        if (typeof id !== 'string') continue;
        if (typeof modules.clientPath(id) !== 'string') continue;
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
      ];
      return () => {
        const off = disposers;
        disposers = null;
        if (off !== null) for (const dispose of off) dispose();
      };
    }, 'page-refresh: bundle routes');
  });
}
