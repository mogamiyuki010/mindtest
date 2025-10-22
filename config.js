// API 配置 - 根據環境自動切換端點
const API_CONFIG = {
    // 檢測當前環境 - 更準確的環境檢測
    isProduction: function() {
        const hostname = window.location.hostname;
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
        const isGitHubPages = hostname.includes('github.io');
        return !isLocalhost && !isGitHubPages;
    },
    
    // 根據環境設定 API 基礎 URL
    getBaseURL: function() {
        const hostname = window.location.hostname;
        
        // GitHub Pages 環境
        if (hostname.includes('github.io')) {
            return 'https://mindtest-backend.onrender.com';
        }
        
        // 本地開發環境
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
            return 'http://localhost:3000';
        }
        
        // 其他生產環境
        return 'https://mindtest-backend.onrender.com';
    },
    
    // 獲取完整的 API 端點
    getEndpoint: function(path) {
        const baseURL = this.getBaseURL();
        const endpoint = baseURL + path;
        
        // 調試信息
        console.log('🌐 API 端點:', endpoint);
        return endpoint;
    },
    
    // 檢查 API 連接狀態
    checkConnection: async function() {
        try {
            const response = await fetch(this.getEndpoint('/api/health'), {
                method: 'GET',
                mode: 'cors',
                credentials: 'include'
            });
            return response.ok;
        } catch (error) {
            console.error('❌ API 連接失敗:', error);
            return false;
        }
    }
};

// 導出配置供其他腳本使用
window.API_CONFIG = API_CONFIG;
