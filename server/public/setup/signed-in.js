// /setup/signed-in (the sign-in popup's last page): tell the setup tab, then close.
try { window.opener?.postMessage("pb-signed-in", location.origin); } catch {}
setTimeout(() => window.close(), 700);
