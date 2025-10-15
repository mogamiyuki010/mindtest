/**
 * 行為追蹤系統（本地 + Render 版本）
 * - 支援 /api/events、/api/results 與舊版 /api/track
 * - 自動偵測本地 / 雲端環境
 * - 具離線排隊、退避重試、頁面離開 keepalive/sendBeacon
 */
(function () {
  const LS_KEYS = {
    userId: 'tracker_user_id',
    pending: 'tracker_pending_events',
    userAttrs: 'tracker_user_attrs'
  };
  const SS_KEYS = { sessionId: 'tracker_session_id' };

  /** 自動判斷後端 API 基底網址 */
  const API_BASE = (() => {
    const host = window.location.hostname;
    if (host.includes('github.io')) return 'https://mindtest-backend.onrender.com';
    if (host.includes('onrender.com')) return ''; // 同源部署
    return 'http://localhost:3000'; // 本地開發
  })();

  const nowISO = () => new Date().toISOString();
  const rand = (len = 12) =>
    (self.crypto?.getRandomValues
      ? Array.from(self.crypto.getRandomValues(new Uint8Array(len)))
          .map(b => ('0' + b.toString(16)).slice(-2))
          .join('')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    ).slice(0, len);

  const parseUTM = () => {
    const p = new URLSearchParams(location.search);
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    const utm = {};
    keys.forEach(k => { if (p.get(k)) utm[k] = p.get(k); });
    return utm;
  };

  class Tracker {
    constructor() {
      this.config = {
        eventsEndpoint: `${API_BASE}/api/events`,
        resultEndpoint: `${API_BASE}/api/results`,
        fallbackEndpoint: `${API_BASE}/api/track`,
        flushIntervalMs: 8000,
        maxBatchSize: 20,
        maxRetries: 5
      };

      this.userId = null;
      this.sessionId = null;
      this.isInitialized = false;
      this.queue = [];
      this.retryTimer = null;
      this.flushTimer = null;
      this.backoffBase = 1200;
    }

    configure(opts = {}) {
      Object.assign(this.config, opts || {});
    }

    init() {
      if (this.isInitialized) return;

      // 建立 userId
      let uid = localStorage.getItem(LS_KEYS.userId);
      if (!uid) {
        uid = `user_${Date.now()}_${rand(8)}`;
        localStorage.setItem(LS_KEYS.userId, uid);
      }
      this.userId = uid;

      // 建立 sessionId
      let sid = sessionStorage.getItem(SS_KEYS.sessionId);
      if (!sid) {
        sid = `sess_${Date.now()}_${rand(6)}`;
        sessionStorage.setItem(SS_KEYS.sessionId, sid);
      }
      this.sessionId = sid;

      // 載入未送出的事件
      try {
        this.queue = JSON.parse(localStorage.getItem(LS_KEYS.pending) || '[]');
      } catch {
        this.queue = [];
      }

      this.isInitialized = true;

      // 定時 flush
      this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);

      window.addEventListener('online', () => this.flush());

      const sendOnLeave = () => this.flush({ onUnload: true });
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sendOnLeave();
      });
      window.addEventListener('pagehide', sendOnLeave);
      window.addEventListener('beforeunload', sendOnLeave);
    }

    getUserId() { return this.userId; }
    getSessionId() { return this.sessionId; }

    setUserAttributes(attrs = {}) {
      const prev = this._getUserAttrs();
      const next = { ...prev, ...attrs };
      localStorage.setItem(LS_KEYS.userAttrs, JSON.stringify(next));
      this.track('user_attributes', { attributes: attrs });
    }

    trackPageView(page, props = {}) { this.track('page_view', { page, ...props }); }
    trackButtonClick(name, props = {}) { this.track('button_click', { button: name, ...props }); }
    trackFormSubmit(name, props = {}) { this.track('form_submit', { form: name, ...props }); }
    trackError(message, props = {}) { this.track('error', { error_message: message, ...props }); }
    trackCustomEvent(name, props = {}) { this.track(name, props); }

    saveResult(resultName, scores = {}) {
      return this._postJSON(this.config.resultEndpoint, {
        result_name: resultName,
        scores
      }).catch(() => {
        this.track('quiz_result', { result: resultName, scores });
      });
    }

    track(eventName, properties = {}) {
      if (!this.isInitialized) this.init();

      const payload = {
        event: eventName,
        ts: nowISO(),
        userId: this.userId,
        sessionId: this.sessionId,
        page: window.location.pathname,
        url: window.location.href,
        referrer: document.referrer || '',
        userAgent: navigator.userAgent,
        screen: { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio || 1 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        utm: parseUTM(),
        userAttributes: this._getUserAttrs(),
        properties
      };

      this.queue.push(payload);
      this._persistQueue();

      try { if (typeof gtag === 'function') gtag('event', eventName, properties); } catch {}

      if (this.queue.length >= this.config.maxBatchSize) {
        this.flush().catch(() => {});
      }
    }

    async flush(opts = {}) {
      if (!this.queue.length) return;

      const batch = this.queue.splice(0, this.config.maxBatchSize);
      this._persistQueue();

      const body = JSON.stringify({ batch });

      try {
        const ok = await this._sendWithBestEffort(this.config.eventsEndpoint, body, opts);
        if (!ok) throw new Error('events endpoint fail');
        return;
      } catch {
        for (const item of batch) {
          try {
            const single = JSON.stringify({
              event: item.event,
              properties: {
                ...item.properties,
                timestamp: item.ts,
                userId: item.userId,
                sessionId: item.sessionId,
                page: item.page,
                referrer: item.referrer,
                userAgent: item.userAgent,
                screen: item.screen,
                viewport: item.viewport,
                url: item.url,
                utm: item.utm,
                userAttributes: item.userAttributes
              }
            });
            const ok = await this._sendWithBestEffort(this.config.fallbackEndpoint, single, opts);
            if (!ok) throw new Error('fallback endpoint fail');
          } catch (e) {
            this.queue.push(item);
            this._persistQueue();
            this._scheduleRetry();
          }
        }
      }
    }

    async _sendWithBestEffort(url, body, { onUnload } = {}) {
      if (onUnload && navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        return navigator.sendBeacon(url, blob);
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: !!onUnload
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    async _postJSON(url, obj) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json().catch(() => ({}));
    }

    _getUserAttrs() {
      try { return JSON.parse(localStorage.getItem(LS_KEYS.userAttrs) || '{}'); }
      catch { return {}; }
    }

    _persistQueue() {
      try { localStorage.setItem(LS_KEYS.pending, JSON.stringify(this.queue)); } catch {}
    }

    _scheduleRetry() {
      if (this.retryTimer) return;
      let attempt = 0;
      const tick = async () => {
        attempt++;
        try {
          await this.flush();
          this.retryTimer = null;
        } catch {
          if (attempt >= this.config.maxRetries) {
            this.retryTimer = null;
            return;
          }
          const wait = this.backoffBase * Math.pow(2, attempt);
          this.retryTimer = setTimeout(tick, wait);
        }
      };
      this.retryTimer = setTimeout(tick, this.backoffBase);
    }
  }

  window.Tracker = new Tracker();

  window.addEventListener('online', () => window.Tracker.flush().catch(() => {}));
  window.addEventListener('error', (e) => {
    window.Tracker.trackError(e.message, { filename: e.filename, lineno: e.lineno, colno: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.Tracker.trackError('Unhandled Promise Rejection', { reason: String(e.reason) });
  });
})();
