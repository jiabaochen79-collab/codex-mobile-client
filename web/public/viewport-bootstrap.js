// Run before the app bundle and remembered-login requests can restore old scroll.
if (location.pathname === '/' || location.pathname === '/index.html') history.scrollRestoration = 'manual';
