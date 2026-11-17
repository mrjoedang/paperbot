(()=>{
const screen=document.getElementById('app-boot'),label=screen.querySelector('.boot-label'),retry=screen.querySelector('button');
try {const theme=localStorage.getItem('pv-theme');if(theme==='dark') document.documentElement.dataset.theme='dark'; else if(theme==='system') delete document.documentElement.dataset.theme;if(sessionStorage.getItem('paperbot-refresh-state'))label.textContent='Updating paperbot';} catch {}
let timer;
function wait(){clearTimeout(timer);timer=setTimeout(()=>{label.textContent=navigator.onLine?'Taking longer than expected':'You’re offline';retry.hidden=false;},12000);}
retry.onclick=()=>location.reload();
window.paperbotBoot={show(){screen.classList.remove('is-ready');retry.hidden=true;label.textContent='Updating paperbot';wait();},ready(){clearTimeout(timer);requestAnimationFrame(()=>requestAnimationFrame(()=>screen.classList.add('is-ready')));}};
wait();
})();
