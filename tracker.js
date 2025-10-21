/**
 * 行為追蹤系統（整合優化版）
 * - 支援動態 API 端點配置
 * - 支援 /api/events 與 /api/results
 * - 具離線排隊、退避重試、頁面離開 keepalive/sendBeacon
 * - 自動檢測環境並切換 API 端點
 */
(function () {
    const LS_KEYS = {
      userId: 'tracker_user_id',
      pending: 'tracker_pending_events',
      userAttrs: 'tracker_user_attrs'
    };
    const SS_KEYS = {
      sessionId: 'tracker_session_id'
    };
  
    // 小工具
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
      const keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
      const utm = {};
      keys.forEach(k => { if (p.get(k)) utm[k] = p.get(k); });
      return utm;
    };
  
    class Tracker {
      constructor() {
        // 預設改為同源 API；保留舊版 endpoint 做相容
        this.config = {
          eventsEndpoint: window.API_CONFIG ? window.API_CONFIG.getEndpoint('/api/events') : '/api/events',
          resultEndpoint: window.API_CONFIG ? window.API_CONFIG.getEndpoint('/api/results') : '/api/results',
          fallbackEndpoint: 'https://mindtest-backend.onrender.com/api/events', // RENDER 部署端點
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
        this.backoffBase = 1200; // 1.2s 起跳
      }
  
      /** 可在程式啟動時覆寫設定 */
      configure(opts = {}) {
        Object.assign(this.config, opts || {});
      }
  
      /** 初始化：建立 IDs、載入待送佇列、定時 flush */
      init() {
        if (this.isInitialized) return;
  
        // userId（長期）
        let uid = localStorage.getItem(LS_KEYS.userId);
        if (!uid) {
          uid = `user_${Date.now()}_${rand(8)}`;
          localStorage.setItem(LS_KEYS.userId, uid);
        }
        this.userId = uid;
  
        // sessionId（tab/工作階段）
        let sid = sessionStorage.getItem(SS_KEYS.sessionId);
        if (!sid) {
          sid = `sess_${Date.now()}_${rand(6)}`;
          sessionStorage.setItem(SS_KEYS.sessionId, sid);
        }
        this.sessionId = sid;
  
        // 載入尚未送出的事件
        try {
          this.queue = JSON.parse(localStorage.getItem(LS_KEYS.pending) || '[]');
        } catch { this.queue = []; }
  
        this.isInitialized = true;
  
        // 開始定時 flush
        this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
  
        // 上線就試著 flush
        window.addEventListener('online', () => this.flush());
  
        // 頁面離開時用 sendBeacon/keepalive 送出
        const sendOnLeave = () => this.flush({ onUnload: true });
        window.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') sendOnLeave();
        });
        window.addEventListener('pagehide', sendOnLeave);
        window.addEventListener('beforeunload', sendOnLeave);
      }
  
      /** 取得使用者 ID / 會話 ID */
      getUserId() { return this.userId; }
      getSessionId() { return this.sessionId; }
  
      /** 設置使用者屬性（會緩存且附帶在之後的事件中） */
      setUserAttributes(attrs = {}) {
        const prev = this._getUserAttrs();
        const next = { ...prev, ...attrs };
        localStorage.setItem(LS_KEYS.userAttrs, JSON.stringify(next));
        this.track('user_attributes', { attributes: attrs });
      }
  
      /** 常用語法糖 */
      trackPageView(page, props = {}) { this.track('page_view', { page, ...props }); }
      trackButtonClick(name, props = {}) { this.track('button_click', { button: name, ...props }); }
      trackFormSubmit(name, props = {}) { this.track('form_submit', { form: name, ...props }); }
      trackError(message, props = {}) { this.track('error', { error_message: message, ...props }); }
      trackCustomEvent(name, props = {}) { this.track(name, props); }
  
      /** 存測驗結果：優先寫 /api/results；沒有就退回寫事件 */
      saveResult(resultName, scores = {}) {
        return this._postJSON(this.config.resultEndpoint, {
          result_name: resultName,
          scores
        }).catch(() => {
          // 後端沒有 /api/results 時，退回事件型式
          this.track('quiz_result', { result: resultName, scores });
        });
      }
  
      /** 主要追蹤方法 */
      track(eventName, properties = {}) {
        if (!this.isInitialized) {
          // 允許「先呼叫、後 init」：先排隊，init 後 flush
          this.init();
        }
  
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
  
        // 放入佇列，稍後批次送
        this.queue.push(payload);
        this._persistQueue();
  
        // 同步 GA（若有）
        try { if (typeof gtag === 'function') gtag('event', eventName, properties); } catch {}
  
        // 小批量就立即嘗試送
        if (this.queue.length >= this.config.maxBatchSize) {
          this.flush().catch(() => {});
        }
      }
  
      /** 送出佇列事件（支援 onUnload 時的 sendBeacon/keepalive） */
      async flush(opts = {}) {
        if (!this.queue.length) return;
  
        // 批次複製後清空（避免重複讀寫）
        const batch = this.queue.splice(0, this.config.maxBatchSize);
        this._persistQueue();
  
        const body = JSON.stringify(
          // 若後端是舊版 /api/track（單筆），就拆成多次送；新版 /api/events（多筆）一次送
          Array.isArray(batch) ? { batch } : batch
        );
  
        // 嘗試新版 /api/events（支援批次）
        try {
          const ok = await this._sendWithBestEffort(this.config.eventsEndpoint, body, opts);
          if (!ok) throw new Error('events endpoint fail');
          return;
        } catch {
          // 退回舊版 /api/track：逐筆送
          for (const item of Array.isArray(batch) ? batch : [batch]) {
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
              // 送失敗：放回佇列尾端，啟動退避重試
              this.queue.push(item);
              this._persistQueue();
              this._scheduleRetry();
            }
          }
        }
      }
  
      /** 使用 sendBeacon / keepalive 的最佳努力送出 */
      async _sendWithBestEffort(url, body, { onUnload } = {}) {
        // 1) 優先 sendBeacon（只能 POST、不可自訂 header）
        if (onUnload && navigator.sendBeacon) {
          const blob = new Blob([body], { type: 'application/json' });
          return navigator.sendBeacon(url, blob);
        }
        // 2) fetch with keepalive（瀏覽器支援即可在 unload 中送出）
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
  
      /** 直接 POST JSON（非批次，給 saveResult 使用） */
      async _postJSON(url, obj) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(obj)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json().catch(() => ({}));
      }
  
      /** 取得使用者屬性（localStorage） */
      _getUserAttrs() {
        try { return JSON.parse(localStorage.getItem(LS_KEYS.userAttrs) || '{}'); }
        catch { return {}; }
      }
  
      /** 將佇列持久化 */
      _persistQueue() {
        try { localStorage.setItem(LS_KEYS.pending, JSON.stringify(this.queue)); }
        catch {}
      }
  
      /** 安排退避重試 */
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
            const wait = this.backoffBase * Math.pow(2, attempt); // 指數退避
            this.retryTimer = setTimeout(tick, wait);
          }
        };
        this.retryTimer = setTimeout(tick, this.backoffBase);
      }
    }
  
    // 建立全域實例（相容你的寫法）
    window.Tracker = new Tracker();
  
    // 自動重試：上線時 flush（init 會註冊一次，這裡加保險）
    window.addEventListener('online', () => window.Tracker.flush().catch(()=>{}));
  
    // 全域錯誤追蹤（保留你的行為）
    window.addEventListener('error', (e) => {
      window.Tracker.trackError(e.message, { filename: e.filename, lineno: e.lineno, colno: e.colno });
    });
    window.addEventListener('unhandledrejection', (e) => {
      window.Tracker.trackError('Unhandled Promise Rejection', { reason: String(e.reason) });
    });
  })();
  