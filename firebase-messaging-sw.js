// Firebase Cloud Messaging 背景通知用的 service worker
// 這個檔案要放在 repo 的「根目錄」（跟 index.html 同一層），不能放在子資料夾，
// 不然瀏覽器抓不到、背景通知不會出現
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

// 這裡的設定值要跟 index.html 裡的 firebaseConfig 完全一樣
firebase.initializeApp({
    apiKey: "AIzaSyB2srYJRT8FqovYt_vCJh35h69H0W7cBLU",
    authDomain: "recipe-synchronization.firebaseapp.com",
    projectId: "recipe-synchronization",
    storageBucket: "recipe-synchronization.firebasestorage.app",
    messagingSenderId: "559668909743",
    appId: "1:559668909743:web:63dc34572b98839479265a"
});

const messaging = firebase.messaging();

// 網站沒有開著（在背景）的時候，收到推播會走這裡，負責跳出系統通知
messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || '食材快到期了';
    const body = (payload.notification && payload.notification.body) || '';
    self.registration.showNotification(title, {
        body,
        icon: '🧊', // 大部分瀏覽器不吃emoji當icon，之後有正式圖示可以換成圖片網址
        // 加上固定的tag：如果同一則推播因為某種原因被觸發了不只一次（實測發現部分裝置會這樣），
        // 瀏覽器看到同一個tag會直接「取代」前一個通知，不會顯示成兩則分開的通知
        tag: 'fridge-expiry-reminder',
    });
});

// 點通知的時候，把使用者帶回網站
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./');
        })
    );
});
