(function(){
  const ref={"title":"Interactive HR Diagram Lab","anchors":3,"equations":2};
  const style=document.createElement('style');
  style.textContent='.research-quality-panel{position:fixed;right:14px;bottom:14px;z-index:99999;width:min(340px,calc(100vw - 28px));background:rgba(11,15,25,.92);color:#e5eefb;border:1px solid rgba(71,217,255,.35);box-shadow:0 18px 70px rgba(0,0,0,.45);font:12px/1.5 Consolas,monospace;padding:12px}.research-quality-panel strong{display:block;color:#47d9ff;margin-bottom:4px}.research-quality-panel span{color:#8ea0b8}.research-quality-panel button{float:right;background:transparent;color:#8ea0b8;border:0;cursor:pointer}';
  const panel=document.createElement('aside');
  panel.className='research-quality-panel';
  panel.innerHTML='<button aria-label="close">x</button><strong>'+ref.title+'</strong><span>Research layer active: '+ref.anchors+' reference anchors, '+ref.equations+' equation contracts, local validation script available.</span>';
  panel.querySelector('button').onclick=()=>panel.remove();
  window.addEventListener('load',()=>{document.head.appendChild(style);document.body.appendChild(panel);});
})();