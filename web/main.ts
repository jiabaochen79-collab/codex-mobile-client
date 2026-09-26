import { createApp, defineAsyncComponent } from 'vue';
import App from './App.vue';
import './style.css';
import './mobile-touch.css';
import './mobile-chat.css';
if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
const entry = location.pathname.startsWith('/pay') ? defineAsyncComponent(() => import('./PayApp.vue')) : App;
createApp(entry).mount('#app');
