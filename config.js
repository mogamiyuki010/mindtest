// API 配置 - 根據環境自動切換端點
const API_CONFIG = {
    // 檢測當前環境
    isProduction: window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1',
    
    // 根據環境設定 API 基礎 URL
    getBaseURL: function() {
        if (this.isProduction) {
            // 生產環境：使用 RENDER 部署的 API
            return 'https://mindtest-backend.onrender.com';
        } else {
            // 開發環境：使用本地 API
            return 'http://localhost:3000';
        }
    },
    
    // 獲取完整的 API 端點
    getEndpoint: function(path) {
        return this.getBaseURL() + path;
    }
};

// 導出配置供其他腳本使用
window.API_CONFIG = API_CONFIG;
