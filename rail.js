/* ============================================================================
   THE RAIL, THE THEME BUTTON AND THE CALENDAR SECTION
   The rail's own mechanics are Team HQ's / Summit HQ's, ported unchanged; only
   the search's gather() knows anything about the Scheduler.
   ========================================================================== */

/* ============================================================
   THE RAIL

   The menu down the left: show it, hide it, remember which, and the search
   that jumps to a session, a task or a person wherever it lives.
   ============================================================ */
(function(){
  "use strict";
  const KEY='hq.rail.off';
  const rail=()=>document.getElementById('rail');

  function set(off, remember){
    document.body.classList.toggle('railmini', !!off);
    const h=document.getElementById('rail-hide');
    if(h){ h.setAttribute('aria-expanded', off?'false':'true');
      h.setAttribute('aria-label', off?'Open the menu':'Narrow the menu');
      h.title = (off?'Open the menu':'Narrow the menu')+' (backslash)'; }
    if(off) close();                       /* no room for the results while it is narrow */
    if(remember!==false){ try{ localStorage.setItem(KEY, off?'1':'0'); }catch(e){} }
    /* the week sizes itself to what is left of the screen */
    setTimeout(()=>{ try{ if(window.__fitBoard) window.__fitBoard(); }catch(e){}
      window.dispatchEvent(new Event('resize')); }, 230);
  }
  function toggle(){ set(!document.body.classList.contains('railmini')); }

  /* a narrow screen starts with it out of the way; otherwise it is remembered */
  function start(){
    /* Jonna, 2026-09-27: Summit HQ opens with the menu open every time, whatever it was
       left as. Narrowing it still works for the visit. A phone-sized screen still starts
       with it narrow, because open it would cover the page. */
    const off = window.matchMedia('(max-width:900px)').matches;
    set(off, false);
    const h=document.getElementById('rail-hide'); if(h) h.addEventListener('click',toggle);
    const sc=document.getElementById('rail-scrim'); if(sc) sc.addEventListener('click',()=>set(true));
    /* the magnifier stands in for the search box while it is narrow */
    const qb=document.getElementById('rail-qb');
    if(qb) qb.addEventListener('click',()=>{ set(false);
      setTimeout(()=>{ const q=document.getElementById('rail-q'); if(q) q.focus(); },230); });
    /* on a narrow screen, picking a tab narrows it again */
    document.querySelectorAll('.hq nav button[data-hq]').forEach(b=>{
      b.addEventListener('click',()=>{
        /* a card left open on the tab being left goes away with it */
        try{ if(window.__pane) window.__pane.close(); }catch(e){}
        if(window.matchMedia('(max-width:900px)').matches) set(true);
      });
    });
    wireFind();
  }

  /* \\ toggles it from anywhere, Escape closes the search */
  document.addEventListener('keydown',e=>{
    const t=e.target;
    const typing = t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable);
    if(e.key==='\\' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey){ e.preventDefault(); toggle(); }
    if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
      e.preventDefault(); set(false);
      setTimeout(()=>{ const q=document.getElementById('rail-q');
        if(q){ q.focus(); q.select(); } }, 230);
    }
  });

  /* ---------- the search ---------- */
  const HITS=()=>document.getElementById('rail-hits');
  let picked=-1, rows=[];

  function norm(x){ return String(x||'').replace(/\s+/g,' ').trim().toLowerCase(); }

  /* Everything worth finding, asked of the tab that owns it. Each answer says where
     it lives and how to get there, so the search never has to know the inside of
     any tab. */
  function gather(q){
    const t=norm(q); if(t.length<2) return [];
    const out=[];
    const score=(name)=>{ const n=norm(name); return n===t ? 3 : n.indexOf(t)===0 ? 2 : n.indexOf(t)>=0 ? 1 : 0; };
    const push=(group,name,where,go)=>{ if(out.length<60) out.push({group,name,where,go,s:score(name)}); };
    /* every word typed has to appear somewhere, so "kelly booked" or "example lending" both work */
    const words=t.split(' ').filter(Boolean);
    const hit=(hay)=>{ const x=norm(hay); return words.every(w=>x.indexOf(w)>=0); };
    const reqs=(window.allReqs ? window.allReqs() : []);
    const about=(r)=>(window.__sched && window.__sched.about) ? window.__sched.about(r) : { label:'', when:'', staff:[] };
    /* meeting requests: title, who asked, who's in it (MISMO and outside), companies, emails, subject, purpose, status, booked time */
    try{
      reqs.forEach(r=>{
        const a=about(r), rq=(r.robot&&r.robot.requester)||{};
        const subj=(/^Subject:\s*(.*)$/m.exec(r.source||'')||[])[1]||'';
        const hay=[r.title, r.ownerName, r.purpose, r.askedBy, r.askedByEmail, rq.name, rq.email, r.where, subj, a.label, a.when, a.staff.join(' '),
          (r.guests||[]).map(g=>[g.name,g.email,g.org].join(' ')).join(' ')].join(' ');
        if(!hit(hay)) return;
        const who=a.staff.map(n=>n.split(' ')[0]).concat((r.guests||[]).map(g=>g.name||g.email)).slice(0,4).join(', ');
        push('Requests', r.title||'Untitled meeting', [a.label, a.when, who].filter(Boolean).join(' · '),
             ()=>{ window.go && window.go('list', r.id); });
      });
    }catch(e){}
    /* outside guests, by name, email or company */
    try{
      const seen={};
      reqs.forEach(r=>{
        (r.guests||[]).forEach(g=>{
          const nm=g.name||g.email||''; if(!nm || !hit([g.name,g.email,g.org].join(' '))) return;
          const key=norm(nm)+'|'+norm(r.id); if(seen[key]) return; seen[key]=1;
          push('People', nm, [g.org, r.title].filter(Boolean).join(' · '),
               ()=>{ window.go && window.go('list', r.id); });
        });
      });
    }catch(e){}
    /* emails that reached scheduling@mismo.org: subject, sender, who else was on it, and the text */
    try{
      const d=(window.INBOX && window.INBOX.server && window.INBOX.server.docs)||{};
      Object.keys(d).forEach(k=>{
        const m=d[k]; const nm=m.subject||'(no subject)';
        if(!hit([m.subject,m.from,m.fromName,m.to,m.cc,m.body].join(' '))) return;
        push('Incoming', nm, [m.fromName||m.from||'', m.receivedAt ? new Date(m.receivedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''].filter(Boolean).join(' · '),
             ()=>{ const r=reqs.find(x=>x.inboxId===m.id); if(r) window.go && window.go('list', r.id); else window.go && window.go('inbox'); });
      });
    }catch(e){}
    out.sort((x,y)=>(x.group===y.group ? y.s-x.s : 0));
    return out;
  }
  /* Hotel Specs and People have no rail button of their own any more — the shell
     is the one door to every pane. */
  function go(tab){
    if(window.__hqGo){ window.__hqGo(tab); return; }
    const b=document.querySelector('.hq nav button[data-hq="'+tab+'"]');
    if(b && !b.hasAttribute('aria-current')) b.click();
  }

  function draw(list){
    const box=HITS(); if(!box) return;
    box.textContent=''; rows=[]; picked=-1;
    if(!list.length){
      const n=document.createElement('div'); n.className='rh-none';
      n.textContent='Nothing matches.'; box.appendChild(n); box.hidden=false; return;
    }
    let g=null;
    list.slice(0,24).forEach(h=>{
      if(h.group!==g){ g=h.group;
        const hd=document.createElement('div'); hd.className='rh-g'; hd.textContent=g; box.appendChild(hd); }
      const b=document.createElement('button'); b.type='button'; b.className='rh';
      const nm=document.createElement('b'); nm.textContent=h.name; b.appendChild(nm);
      if(h.where){ const w=document.createElement('i'); w.textContent=h.where; b.appendChild(w); }
      b.addEventListener('click',()=>{ close(); h.go(); });
      rows.push(b); box.appendChild(b);
    });
    box.hidden=false;
  }
  function close(){ const b=HITS(); if(b){ b.hidden=true; b.textContent=''; } rows=[]; picked=-1; }
  function mark(){ rows.forEach((r,i)=>r.classList.toggle('on', i===picked));
    if(rows[picked]) try{ rows[picked].scrollIntoView({block:'nearest'}); }catch(e){} }

  function wireFind(){
    const q=document.getElementById('rail-q'), x=document.getElementById('rail-qx');
    if(!q) return;
    let tmr=null;
    const run=()=>{ const v=q.value;
      if(x) x.hidden = !v;
      if(norm(v).length<2){ close(); return; }
      draw(gather(v)); };
    q.addEventListener('input',()=>{ clearTimeout(tmr); tmr=setTimeout(run,150); });
    q.addEventListener('focus',()=>{ if(norm(q.value).length>=2) run(); });
    q.addEventListener('keydown',e=>{
      if(e.key==='Escape'){ close(); q.blur(); return; }
      if(!rows.length) return;
      if(e.key==='ArrowDown'){ e.preventDefault(); picked=(picked+1)%rows.length; mark(); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); picked=(picked-1+rows.length)%rows.length; mark(); }
      else if(e.key==='Enter'){ e.preventDefault(); (rows[picked]||rows[0]).click(); }
    });
    if(x) x.addEventListener('click',()=>{ q.value=''; x.hidden=true; close(); q.focus(); });
    document.addEventListener('click',e=>{
      if(!e.target.closest('.railfind')) close();
    });
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start);
  else start();
  window.__rail={ show:()=>set(false), hide:()=>set(true), toggle,
    mini:()=>document.body.classList.contains('railmini') };
})();


/* --- the theme button, exactly the shared one (mismo.portal.theme) --- */
(function theme(){
  var btn=document.getElementById('theme-btn'), lab=document.getElementById('theme-lab');
  if(!btn) return;
  function cur(){ var t=document.documentElement.getAttribute('data-theme');
    if(t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light'; }
  function paint(){ var d=cur()==='dark'; if(lab) lab.textContent = d ? 'Light Mode' : 'Dark Mode';
    btn.setAttribute('aria-label', d ? 'Switch to light mode' : 'Switch to dark mode'); }
  btn.addEventListener('click',function(){
    document.documentElement.setAttribute('data-theme', cur()==='dark'?'light':'dark');
    paint(); try{ localStorage.setItem('mismo.portal.theme', cur()); }catch(e){}
  });
  try{ var s=localStorage.getItem('mismo.portal.theme'); if(s) document.documentElement.setAttribute('data-theme',s); }catch(e){}
  paint();
})();

/* --- rail buttons drive the page's own router --- */
(function railroute(){
  var RAIL_TABS=['dash','stats','health','help'];
  function mark(tab){
    document.querySelectorAll('.rail nav button[data-hq], #help-btn[data-hq]').forEach(function(b){
      if(b.getAttribute('data-hq')===tab) b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    });
  }
  function open(tab){
    if(window.go) window.go(tab);
    mark(RAIL_TABS.indexOf(tab) >= 0 ? tab : 'dash');
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest && e.target.closest('[data-hq]');
    if(!b) return;
    e.preventDefault(); open(b.getAttribute('data-hq'));
  });
  /* keep the rail in step when the page routes itself (hash links, Back) */
  window.addEventListener('popstate',function(){ sync(); });
  function sync(){
    var s=window.__sched && window.__sched.STATE;
    if(s && s.tab) mark(RAIL_TABS.indexOf(s.tab) >= 0 ? s.tab : 'dash');
  }
  setTimeout(sync,0);
  setInterval(counts, 1200);

  /* the two counts the rail carries */
  function counts(){
    try{
      var inb=window.INBOX && window.INBOX.server ? window.INBOX.server.docs : null;
      var n=0; if(inb) Object.keys(inb).forEach(function(k){ if(inb[k] && inb[k].status==='new') n++; });
      setN('in-count', n);
    }catch(e){}
  }
  function setN(id,n){
    var el=document.getElementById(id); if(!el) return;
    el.textContent=String(n); el.setAttribute('data-z', n>0?'0':'1');
  }

})();
