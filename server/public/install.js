import { h, ic } from './dom.js';
export function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)');
  const installed = () => standalone.matches || navigator.standalone === true;
  const demo = window.__paperbotPreview && new URLSearchParams(location.search).get('install-preview');
  const ios = demo === 'iphone' || /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let prompt = null, lastFocus = null, dismissed = false, offered = false;
  try { dismissed = localStorage.getItem('paperbot-install-dismissed') === '1'; } catch {}
  if (installed() && !demo) return;
  const close = h('button', { type:'button', class:'icon-btn', 'aria-label':'Close install instructions', onclick:()=>dialog.close() }, ic('close',20));
  const body = h('div', { class:'install-body' });
  const dialog = h('dialog', { class:'install-modal', 'aria-labelledby':'install-title' },
    h('header', { class:'install-header' }, h('h2',{ id:'install-title' },'Install paperbot'), close), body,
    h('footer', { class:'install-footer' }, h('button',{ type:'button', class:'btn', onclick:()=>dialog.close() },'Done')));
  document.body.append(dialog);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close',()=>{ if(lastFocus?.isConnected) lastFocus.focus({preventScroll:true}); });
  function iphoneGuide() {
    let step=0;
    const steps=[['Open the Safari menu','Tap the ••• button at the bottom right.'],
      ['Tap Share','Choose Share at the top of the menu.'],
      ['Add to Home Screen','Tap the + action along the bottom of the share sheet.'],
      ['Tap Add','Leave “Open as Web App” on, then tap Add.']];
    const appIcon=()=>h('img',{src:'./apple-touch-icon.png',alt:'',class:'guide-app-icon'});
    const action=(label,icon,cls='')=>h('div',{class:`guide-action ${cls}`},h('span',{class:'guide-action-circle'},icon==='chevron'?h('span',{class:'guide-chevron'},'⌄'):ic(icon,18)),h('span',null,label));
    const phone=h('div',{class:'install-phone','aria-hidden':'true'},
      h('div',{class:'guide-status'},h('b',null,'9:41'),h('div',{class:'guide-island'}),h('span',null,'••• ▰')),
      h('div',{class:'guide-page'},h('strong',null,'paperbot'),...['Coffee on the way home','A thought for the weekend','Water the plants'].map(t=>h('div',{class:'guide-row'},h('i'),h('span',null,t)))),
      h('div',{class:'guide-toolbar'},h('span',null,'‹'),h('span',null,'paperbot'),h('span',{class:'guide-menu-button guide-target'},'•••')),
      h('div',{class:'guide-safari-menu'},
        h('div',{class:'guide-menu-row guide-share guide-target'},ic('share',14),'Share'),
        h('div',{class:'guide-menu-row'},ic('note',14),'Add to Bookmarks'),
        h('div',{class:'guide-menu-row'},ic('list',14),'Add Bookmark to…'),
        h('div',{class:'guide-menu-row guide-menu-divider'},h('span',null,'+'),'New Tab'),
        h('div',{class:'guide-menu-row'},ic('box',14),'New Private Tab'),
        h('div',{class:'guide-menu-bottom'},h('span',null,'▣',h('small',null,'Bookmarks')),h('span',null,'▥',h('small',null,'All Tabs')))),
      h('div',{class:'guide-sheet'},
        h('div',{class:'guide-share-site'},appIcon(),h('div',null,h('strong',null,'paperbot'),h('small',null,'app.paperbot.ca'),h('span',{class:'guide-options'},'Options ›'))),
        h('div',{class:'guide-contacts'},...[1,2,3,4].map(()=>h('div',null,h('i',null,'●'),h('small',null,'Contact')))),
        h('div',{class:'guide-apps'},...['AirDrop','Messages','Mail','Notes'].map((t,i)=>h('div',null,h('i',{class:`guide-app-${i}`},ic(['wifi','log','note','list'][i],20)),h('small',null,t)))),
        h('div',{class:'guide-actions'},action('Copy','note'),action('Open in App','box'),action('Add to Home Screen','add-home','guide-target'),action('View More','chevron'))),
      h('div',{class:'guide-confirm'},
        h('div',{class:'guide-confirm-head'},h('span',{class:'guide-cancel'},'×'),h('strong',null,'Add to Home Screen'),h('b',{class:'guide-target'},'Add')),
        h('div',{class:'guide-name'},appIcon(),h('div',null,h('span',null,'paperbot',h('i',{class:'guide-caret'})),h('small',null,'https://app.paperbot.ca'))),
        h('div',{class:'guide-webapp'},h('span',null,'Open as Web App'),h('i',{class:'guide-switch'})),
        h('p',{class:'guide-confirm-note'},'An icon will be added to your Home Screen so you can quickly access this website.'),
        h('div',{class:'guide-keyboard'},...['qwertyuiop','asdfghjkl','⇧zxcvbnm⌫'].map(row=>h('div',null,...[...row].map(key=>h('i',null,key)))),h('div',null,h('i',null,'123'),h('i',{class:'guide-space'},'space'),h('i',{class:'guide-key-done'},'✓')))));
    // The illustration supports the same taps as the real Safari flow.
    const targets=[phone.querySelector('.guide-menu-button'),phone.querySelector('.guide-share'),phone.querySelector('.guide-action.guide-target'),phone.querySelector('.guide-confirm-head .guide-target')];
    const svgNS='http://www.w3.org/2000/svg';
    targets.forEach(target=>{
      const arrow=document.createElementNS(svgNS,'svg');
      arrow.setAttribute('viewBox','0 0 32 44');
      arrow.setAttribute('class','guide-pointer');
      arrow.setAttribute('aria-hidden','true');
      const path=document.createElementNS(svgNS,'path');
      path.setAttribute('d','M12 3H20V25H29L16 41L3 25H12Z');
      arrow.append(path);
      target.append(arrow);
    });
    targets.forEach((target,index)=>target.addEventListener('click',()=>{
      if(step!==index) return;
      if(step<steps.length-1) show(step+1);
    }));
    const stage=h('div',{class:'install-stage',dataset:{step:'0'}},phone);
    const title=h('h3'), description=h('p');
    const caption=h('div',{class:'install-caption','aria-live':'polite'},title,description);
    const dots=h('div',{class:'install-guide-dots','aria-label':'Installation steps'});
    const previous=h('button',{type:'button',class:'btn guide-previous',onclick:()=>{show(Math.max(0,step-1));}},'← Previous');
    const next=h('button',{type:'button',class:'btn primary guide-next',onclick:()=>{
      show(Math.min(steps.length-1,step+1));
    }},'Next →');
    const stepCount=h('span',{class:'guide-step-count'});
    dialog.querySelector('.install-footer').replaceChildren(previous,stepCount,next);
    function show(nextStep) {
      step=nextStep;stage.dataset.step=String(step);
      stage.dataset.manual='true';
      title.textContent=steps[step][0];description.textContent=steps[step][1];
      previous.disabled=step===0;
      next.disabled=step===steps.length-1;
      stepCount.textContent=`${step+1} of ${steps.length}`;
      [...dots.children].forEach((button,i)=>{
        button.setAttribute('aria-pressed',String(i===step));
        button.dataset.complete=String(i<=step);
      });
    }
    steps.forEach((_,i)=>dots.append(h('button',{type:'button','aria-label':`Step ${i+1}: ${steps[i][0]}`,onclick:()=>{show(i);}},h('span',{class:'guide-progress-fill'}))));
    body.replaceChildren(stage,caption,h('div',{class:'install-guide-controls'},dots));
    show(0);
  }
  function instructions() {
    if(ios) iphoneGuide();
    else body.replaceChildren(h('ol',{class:'install-steps'},
      h('li',null,h('span',{class:'install-step-icon'},ic('add-home',22)),h('div',null,h('strong',null,'Open your browser menu'),h('p',null,'Look for Install app or Add to Home Screen.'))),
      h('li',null,h('span',{class:'install-step-icon'},ic('check',22)),h('div',null,h('strong',null,'Confirm installation'),h('p',null,'Then launch paperbot from its app icon.')))));
    lastFocus=document.activeElement;
    document.querySelector('.settings').open=false;
    if (!dialog.open) dialog.showModal();
    close.focus();
  }
  async function install() {
    if (!prompt) { instructions(); return; }
    const pending=prompt; prompt=null;
    try { await pending.prompt(); const choice=await pending.userChoice; if(choice.outcome==='accepted') hide(); }
    catch { instructions(); }
  }
  const setting=h('button',{type:'button',class:'icon-btn',id:'btn-install',onclick:install},ic('add-home',20),h('span',null,'Add to homescreen'));
  document.querySelector('.settings-menu').insertBefore(setting,document.querySelector('#btn-refresh'));
  function dismiss() {
    dismissed=true; invitation.hidden=true;
    try { localStorage.setItem('paperbot-install-dismissed','1'); } catch {}
  }
  const invitation=h('aside',{class:'install-invite',hidden:true,'aria-label':'Install paperbot'},
    h('strong',null,'paperbot on your Home Screen'),h('p',null,'Open it like an app.'),
    h('div',{class:'install-invite-actions'},h('button',{type:'button',class:'btn primary',onclick:install},ios?'Add to Home Screen':'Install paperbot'),h('button',{type:'button',class:'install-later',onclick:dismiss},'Not now')));
  document.body.append(invitation);
  function hide() { invitation.hidden=true; setting.hidden=true; if(dialog.open)dialog.close(); }
  function offer() {
    if (offered || (dismissed && !demo) || (installed() && !demo)) return;
    if (!ios && !prompt && !demo) return;
    if (document.hidden || document.querySelector('dialog[open], .title-edit') || !document.querySelector('#drawer').hidden) return;
    offered=true; invitation.hidden=false;
  }
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;});
  window.addEventListener('appinstalled',hide);
  standalone.addEventListener('change',()=>{if(installed())hide();});
  // Offer after a meaningful interaction, never immediately on arrival.
  document.querySelector('#sections').addEventListener('click',()=>setTimeout(offer,1500),{once:true});
  if (demo) setTimeout(offer,1200);
}
