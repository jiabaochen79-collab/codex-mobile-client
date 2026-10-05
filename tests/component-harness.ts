import { createApp, h, ref } from 'vue';
import FeedbackPanel from '../web/FeedbackPanel.vue';
import NotificationCenter from '../web/NotificationCenter.vue';
import SubscriptionPanel from '../web/SubscriptionPanel.vue';
import OrdersPanel from '../web/OrdersPanel.vue';
import PayApp from '../web/PayApp.vue';
import '../web/style.css';
import '../web/mobile-touch.css';
import '../web/mobile-chat.css';

const components = { feedback: FeedbackPanel, notifications: NotificationCenter, subscription: SubscriptionPanel, orders: OrdersPanel, pay: PayApp };
const kind = new URL(location.href).searchParams.get('component') as keyof typeof components;
const open = ref(true); const unread = ref(0);
createApp({ setup: () => () => h('div', [
  h('output', { id:'unread' }, unread.value),
  open.value ? h(components[kind], { mode:'mobile', deviceId:'123456789', taskLabels:{}, resolveTasks:async()=>{}, openTask:async()=>true, onUnread:(count:number)=>{unread.value=count;}, onClose:()=>{open.value=false;} }) : h('p', {id:'closed'}, 'closed')
]) }).mount('#app');
