/**
 * Client half of dsh-page-refresh.
 *
 * Two seats:
 *   sidebar.footer.action  a refresh button: ask the host to recompose, then
 *                          reload, so the reloaded page really gets the new
 *                          bundle bytes (the served body is built once per
 *                          composition and held)
 *   settings.general.item  the auto-refresh switch, stored per browser
 *
 * Both read one module-level store that polls GET /page-refresh/state and
 * compares its `rev` with the graph revision this page booted from.
 */
window.__ModuleLoader__.load({
  id: 'dsh-page-refresh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'page-refresh';
    const AUTO_KEY = 'dsh-page-refresh.auto';
    const LAST_AUTO_KEY = 'dsh-page-refresh.last-auto';
    const POLL_MS = 2500;
    const AUTO_COOLDOWN_MS = 15000;

    const boot = typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null ? window.__DSH_BOOT__ : null;
    const bootRev = boot !== null && typeof boot.rev === 'string' ? boot.rev : null;

    const zh = {
      refreshPage: '刷新页面',
      refreshHint: '重新合成插件产物后刷新页面',
      refreshStale: '插件产物已更新，点击刷新',
      autoTitle: '自动刷新页面',
      autoDescription: '插件的客户端代码变化后自动重新加载页面；关闭后仍可用侧栏按钮手动刷新。',
    };
    const en = {
      refreshPage: 'Refresh page',
      refreshHint: 'Recompose plugin bundles, then reload the page',
      refreshStale: 'A plugin bundle changed — click to refresh',
      autoTitle: 'Auto refresh page',
      autoDescription: 'Reload the page after a plugin’s client code changes. Turn it off to refresh manually from the sidebar button.',
    };

    const CSS = [
      '.dshpr-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.dshpr-btn:hover{background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.dshpr-btn:active{transform:scale(.94)}',
      '.dshpr-btn[data-stale="true"]{color:var(--dsw-alias-brand-primary)}',
      '.dshpr-btn[data-docked="true"]{position:fixed;z-index:30}',
      '.dshpr-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}',
      '.dshpr-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);cursor:default}',
      '.dshpr-text{min-width:0}',
      '.dshpr-title{font-size:14px;line-height:20px}',
      '.dshpr-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshpr-switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color .15s ease,border-color .15s ease}',
      '.dshpr-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshpr-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}',
      '.dshpr-switch[aria-checked="true"] .dshpr-knob{transform:translateX(18px)}',
    ].join('\n');

    function ensureStyle() {
      const existing = document.getElementById('dsh-page-refresh-style');
      if (existing !== null) return () => {};
      const style = document.createElement('style');
      style.id = 'dsh-page-refresh-style';
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style);
      };
    }

    function readAuto() {
      try {
        const stored = window.localStorage.getItem(AUTO_KEY);
        if (stored === 'off') return false;
        if (stored === 'on') return true;
      } catch {}
      return true;
    }

    function writeAuto(value) {
      try {
        window.localStorage.setItem(AUTO_KEY, value ? 'on' : 'off');
      } catch {}
    }

    function useStore(store) {
      const [value, setValue] = React.useState(store.getSnapshot());
      React.useEffect(() => {
        const off = store.subscribe(() => setValue(store.getSnapshot()));
        setValue(store.getSnapshot());
        return off;
      }, [store]);
      return value;
    }

    function url(path) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href;
      return new URL(path, base).toString();
    }

    function createStore() {
      const listeners = new Set();
      let snapshot = { rev: bootRev, stale: false, auto: readAuto(), busy: false, reachable: true };
      let started = false;
      let timer = null;
      let pending = false;
      let warned = false;

      const set = (patch) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[dsh-page-refresh] listener failed', error);
          }
        }
      };

      const warn = (error) => {
        if (warned) return;
        warned = true;
        console.warn('[dsh-page-refresh] state route unavailable:', error && error.message ? error.message : error);
      };

      const reload = async () => {
        if (snapshot.busy) return;
        set({ busy: true });
        try {
          await fetch(url('page-refresh/recompose'), { cache: 'no-store' });
        } catch (error) {
          warn(error);
        }
        try {
          window.sessionStorage.setItem(LAST_AUTO_KEY, String(Date.now()));
        } catch {}
        window.location.reload();
      };

      const maybeAutoReload = () => {
        if (!snapshot.auto || snapshot.busy || !snapshot.stale) return;
        if (document.visibilityState === 'hidden') {
          pending = true;
          return;
        }
        let last = 0;
        try {
          last = Number(window.sessionStorage.getItem(LAST_AUTO_KEY) || 0);
        } catch {}
        if (Number.isFinite(last) && Date.now() - last < AUTO_COOLDOWN_MS) return;
        pending = false;
        void reload();
      };

      const poll = async () => {
        let data = null;
        try {
          const response = await fetch(url('page-refresh/state'), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          });
          if (response.ok) data = await response.json();
          else if (!warned) warn(new Error('HTTP ' + response.status));
        } catch (error) {
          warn(error);
        }
        if (data === null || typeof data.rev !== 'string') {
          if (snapshot.reachable) set({ reachable: false });
          return;
        }
        const stale = bootRev !== null && data.rev !== bootRev;
        set({ rev: data.rev, stale, reachable: true });
        maybeAutoReload();
      };

      const onVisibility = () => {
        if (document.visibilityState !== 'visible' || !pending) return;
        pending = false;
        maybeAutoReload();
      };

      const start = () => {
        if (started) return () => {};
        started = true;
        document.addEventListener('visibilitychange', onVisibility);
        timer = window.setInterval(() => {
          void poll();
        }, POLL_MS);
        void poll();
        return () => {
          started = false;
          if (timer !== null) window.clearInterval(timer);
          timer = null;
          document.removeEventListener('visibilitychange', onVisibility);
        };
      };

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        start,
        refresh: reload,
        setAuto: (value) => {
          writeAuto(value);
          set({ auto: value });
          if (value) maybeAutoReload();
        },
      };
    }

    let activeStore = null;
    let activeT = (key) => key;

    function translatorOf(props) {
      if (props !== null && typeof props === 'object' && typeof props.t === 'function') return props.t;
      return activeT;
    }

    function storeOf(props) {
      if (props !== null && typeof props === 'object' && props.store) return props.store;
      return activeStore;
    }

    /**
     * The sidebar's "更多" row is shell chrome, not a slot: its button is drawn
     * by the sidebar itself, so a plugin cannot register into that line. Keep the
     * seat in `sidebar.footer.action` for the rail layout, but when the sidebar is
     * expanded dock the same button onto that row's trailing edge. Only the
     * anchor's box is read; nothing outside this component is touched.
     */
    function moreRowAnchorFor(node) {
      let scope = node;
      for (let depth = 0; depth < 12 && scope !== null; depth += 1) {
        if (typeof scope.querySelectorAll === 'function') {
          const candidates = scope.querySelectorAll('button[aria-haspopup="menu"]');
          let best = null;
          let bestTop = Number.POSITIVE_INFINITY;
          candidates.forEach((candidate) => {
            const rect = candidate.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            if (rect.top < bestTop) {
              bestTop = rect.top;
              best = candidate;
            }
          });
          if (best !== null) return best;
        }
        if (scope === document.body) break;
        scope = scope.parentElement;
      }
      return null;
    }

    function useMoreRowDock(ref, enabled) {
      const [dock, setDock] = React.useState(null);
      React.useEffect(() => {
        if (!enabled) {
          setDock(null);
          return () => {};
        }
        let timer = 0;
        let applied = null;
        let published = '';
        let settled = false;
        const publish = (next) => {
          const signature = next === null ? 'none' : next.top + ':' + next.left;
          if (signature === published) return;
          published = signature;
          settled = false;
          setDock(next);
        };
        const tick = () => {
          const node = ref.current;
          const anchor = node === null ? null : moreRowAnchorFor(node);
          if (node === null || anchor === null) {
            applied = null;
            publish(null);
            timer = window.setTimeout(tick, 250);
            return;
          }
          const target = anchor.getBoundingClientRect();
          const desiredTop = target.top + (target.height - 32) / 2;
          const desiredLeft = target.right - 32 - 12;
          let nextTop = desiredTop;
          let nextLeft = desiredLeft;
          if (applied !== null && settled) {
            // A transformed ancestor reinterprets `position: fixed` coordinates, so
            // correct by the measured offset error until the button sits on target.
            const current = node.getBoundingClientRect();
            const errorTop = desiredTop - current.top;
            const errorLeft = desiredLeft - current.left;
            if (Math.abs(errorTop) > 1.5 || Math.abs(errorLeft) > 1.5) {
              nextTop = applied.top + errorTop;
              nextLeft = applied.left + errorLeft;
            } else {
              nextTop = applied.top;
              nextLeft = applied.left;
            }
          }
          applied = { top: Math.round(nextTop), left: Math.round(nextLeft) };
          publish(applied);
          if (!settled) settled = true;
          timer = window.setTimeout(tick, 250);
        };
        tick();
        return () => {
          window.clearTimeout(timer);
        };
      }, [enabled]);
      return dock;
    }

    function SidebarButton(props) {
      const store = storeOf(props);
      const state = useStore(store);
      const t = translatorOf(props);
      const ref = React.useRef(null);
      const wide = props !== null && typeof props === 'object' && props.wide === true;
      const dock = useMoreRowDock(ref, wide);
      const style = dock === null ? undefined : {
        position: 'fixed',
        top: dock.top + 'px',
        left: dock.left + 'px',
        zIndex: 30,
      };
      return h(
        'button',
        {
          ref,
          type: 'button',
          className: 'dshpr-btn',
          style,
          'data-docked': dock === null ? undefined : 'true',
          'aria-label': t('refreshPage'),
          title: state.stale ? t('refreshStale') : t('refreshHint'),
          'data-stale': state.stale ? 'true' : undefined,
          disabled: state.busy,
          onClick: () => {
            void store.refresh();
          },
        },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 18,
            height: 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }),
          h('path', { d: 'M20.5 4.2v5.6h-5.6' }),
        ),
        state.stale ? h('span', { className: 'dshpr-dot', 'aria-hidden': true }) : null,
      );
    }

    function AutoRefreshRow(props) {
      const store = storeOf(props);
      const state = useStore(store);
      const t = translatorOf(props);
      return h(
        'div',
        { className: 'dshpr-row' },
        h(
          'div',
          { className: 'dshpr-text' },
          h('div', { className: 'dshpr-title' }, t('autoTitle')),
          h('div', { className: 'dshpr-description' }, t('autoDescription')),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': state.auto ? 'true' : 'false',
            'aria-label': t('autoTitle'),
            className: 'dshpr-switch',
            onClick: () => {
              store.setAuto(!state.auto);
            },
          },
          h('span', { className: 'dshpr-knob', 'aria-hidden': true }),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'page-refresh: dictionaries');
        ctx.effect(ensureStyle, 'page-refresh: styles');

        const store = createStore();
        activeStore = store;
        ctx.effect(() => store.start(), 'page-refresh: poll');

        const t = ctx.locale.bind(NS);
        activeT = t;
        const face = () => ({ store, t });

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'page-refresh',
          order: 2,
          locale: NS,
          inject: face,
        }, SidebarButton));

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'page-refresh-auto',
          order: 25,
          locale: NS,
          inject: face,
        }, AutoRefreshRow));
      },
    };
  },
});
