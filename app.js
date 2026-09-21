(function(){
  "use strict";

  var CATS = ["Comida","Transporte","Vivienda","Servicios","Entretenimiento","Salud","Educación","Otros"];
  var CAT_COLOR = {"Comida":"var(--cat-1)","Transporte":"var(--cat-2)","Vivienda":"var(--cat-3)","Servicios":"var(--cat-4)","Entretenimiento":"var(--cat-5)","Salud":"var(--cat-6)","Educación":"var(--cat-7)","Otros":"var(--cat-8)"};
  var STORAGE_KEY = "balance-app-data-v1";

  var state = { gastos: [], deudas: [] };
  var bannerTimer = null;

  var fmt = new Intl.NumberFormat('es', {style:'currency', currency:'USD', maximumFractionDigits:2});
  function money(n){ return fmt.format(Number(n)||0); }
  function todayISO(){ var d=new Date(); return d.toISOString().slice(0,10); }
  function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random())); }
  function monthKey(iso){ return (iso||"").slice(0,7); }

  function showBanner(msg, autoHide){
    var b = document.getElementById('banner');
    b.textContent = msg; b.hidden = false;
    if (bannerTimer) clearTimeout(bannerTimer);
    if (autoHide){ bannerTimer = setTimeout(function(){ b.hidden = true; }, 4000); }
  }

  // ---- persistence (localStorage, per device) ----
  function load(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw){
        var parsed = JSON.parse(raw);
        state.gastos = parsed.gastos || [];
        state.deudas = parsed.deudas || [];
      }
    } catch(e){
      console.error(e);
      showBanner('No se pudieron leer tus datos guardados en este navegador.');
    }
  }
  function save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({gastos: state.gastos, deudas: state.deudas}));
    } catch(e){
      console.error(e);
      showBanner('No se pudo guardar — puede que el almacenamiento esté lleno o bloqueado.', true);
    }
  }

  // ---- populate static selects ----
  var gCatSel = document.getElementById('g-categoria');
  var filterCatSel = document.getElementById('filter-cat');
  CATS.forEach(function(c){
    var o = document.createElement('option'); o.value=c; o.textContent=c; gCatSel.appendChild(o);
  });
  var allCatOpt = document.createElement('option'); allCatOpt.value=''; allCatOpt.textContent='Todas las categorías';
  filterCatSel.appendChild(allCatOpt);
  CATS.forEach(function(c){ var o=document.createElement('option'); o.value=c; o.textContent=c; filterCatSel.appendChild(o); });
  document.getElementById('g-fecha').value = todayISO();

  // ---- tabs ----
  var tabs = document.querySelectorAll('nav.tabs button');
  tabs.forEach(function(btn){
    btn.addEventListener('click', function(){
      tabs.forEach(function(b){ b.setAttribute('aria-selected','false'); });
      btn.setAttribute('aria-selected','true');
      document.querySelectorAll('section.panel').forEach(function(p){ p.classList.remove('active'); });
      document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
    });
  });

  // ---- month filter options ----
  function refreshMonthFilter(){
    var sel = document.getElementById('filter-mes');
    var current = sel.value;
    var months = {};
    months[todayISO().slice(0,7)] = true;
    state.gastos.forEach(function(g){ months[monthKey(g.fecha)] = true; });
    var keys = Object.keys(months).sort().reverse();
    sel.innerHTML = '';
    var allOpt = document.createElement('option'); allOpt.value=''; allOpt.textContent='Todos los meses'; sel.appendChild(allOpt);
    keys.forEach(function(k){
      var o = document.createElement('option'); o.value=k;
      var d = new Date(k+'-02');
      o.textContent = d.toLocaleDateString('es', {month:'long', year:'numeric'});
      sel.appendChild(o);
    });
    if (current && months[current]) sel.value = current; else sel.value = todayISO().slice(0,7);
  }

  // ---- rendering ----
  function renderAll(){
    refreshMonthFilter();
    renderGastos();
    renderDeudas();
    renderResumen();
  }

  function renderGastos(){
    var list = document.getElementById('gastos-list');
    var mes = document.getElementById('filter-mes').value;
    var cat = document.getElementById('filter-cat').value;
    var items = state.gastos.filter(function(g){
      if (mes && monthKey(g.fecha) !== mes) return false;
      if (cat && g.categoria !== cat) return false;
      return true;
    }).sort(function(a,b){ return (b.fecha||'').localeCompare(a.fecha||'') || (b.createdAt||0)-(a.createdAt||0); });

    list.innerHTML = '';
    if (!items.length){
      var e = document.createElement('li'); e.className='empty'; e.textContent='No hay gastos registrados para este filtro.';
      list.appendChild(e); return;
    }
    items.forEach(function(g){
      var li = document.createElement('li'); li.className='item';
      var dot = document.createElement('span'); dot.className='dot'; dot.style.background = CAT_COLOR[g.categoria]||'var(--cat-8)';
      var main = document.createElement('div'); main.className='main';
      var desc = document.createElement('div'); desc.className='desc'; desc.textContent = g.descripcion ? g.descripcion : g.categoria;
      var meta = document.createElement('div'); meta.className='meta'; meta.textContent = g.categoria + ' · ' + formatDate(g.fecha);
      main.appendChild(desc); main.appendChild(meta);
      var amount = document.createElement('div'); amount.className='amount mono'; amount.textContent = money(g.monto);
      var del = document.createElement('button'); del.className='del'; del.setAttribute('aria-label','Eliminar gasto'); del.textContent='✕';
      del.addEventListener('click', function(){ deleteGasto(g.id); });
      li.appendChild(dot); li.appendChild(main); li.appendChild(amount); li.appendChild(del);
      list.appendChild(li);
    });
  }

  function formatDate(iso){
    if (!iso) return '';
    var d = new Date(iso+'T00:00:00');
    return d.toLocaleDateString('es', {day:'numeric', month:'short', year:'numeric'});
  }

  function debtStatus(d){
    var restante = Number(d.montoTotal||0) - Number(d.montoPagado||0);
    if (restante <= 0.004) return 'done';
    if (d.fechaLimite && d.fechaLimite < todayISO()) return 'late';
    return 'pending';
  }

  function renderDeudas(){
    var wrap = document.getElementById('deudas-list');
    var filter = document.getElementById('filter-deuda-estado').value;
    var items = state.deudas.filter(function(d){
      var st = debtStatus(d);
      if (filter === 'pendiente') return st !== 'done';
      if (filter === 'pagada') return st === 'done';
      return true;
    }).sort(function(a,b){
      var sa = debtStatus(a), sb = debtStatus(b);
      var rank = {late:0, pending:1, done:2};
      if (rank[sa] !== rank[sb]) return rank[sa]-rank[sb];
      return (a.fechaLimite||'9999').localeCompare(b.fechaLimite||'9999');
    });

    wrap.innerHTML = '';
    if (!items.length){
      var e = document.createElement('div'); e.className='empty'; e.textContent='No hay deudas registradas para este filtro.';
      wrap.appendChild(e); return;
    }

    items.forEach(function(d){
      var total = Number(d.montoTotal||0), pagado = Number(d.montoPagado||0);
      var pct = total > 0 ? Math.min(100, Math.max(0, (pagado/total)*100)) : 0;
      var st = debtStatus(d);

      var card = document.createElement('div'); card.className='debt-card' + (st==='done' ? ' done':'');
      var head = document.createElement('div'); head.className='head';
      var name = document.createElement('div'); name.className='name'; name.textContent = d.entidad;
      var due = document.createElement('div'); due.className='due'; due.textContent = d.fechaLimite ? ('Vence ' + formatDate(d.fechaLimite)) : 'Sin fecha límite';
      head.appendChild(name); head.appendChild(due);

      var figures = document.createElement('div'); figures.className='figures';
      var left = document.createElement('span'); left.innerHTML = '<span class="paid mono">'+money(pagado)+'</span> de <span class="mono">'+money(total)+'</span>';
      var right = document.createElement('span'); right.className='mono'; right.textContent = money(Math.max(0,total-pagado)) + ' restante';
      figures.appendChild(left); figures.appendChild(right);

      var track = document.createElement('div'); track.className='bar-track';
      var fill = document.createElement('div'); fill.className='bar-fill'; fill.style.width = pct+'%';
      track.appendChild(fill);

      var foot = document.createElement('div'); foot.className='foot';
      var pill = document.createElement('span');
      if (st==='done'){ pill.className='pill done'; pill.textContent='Pagada'; }
      else if (st==='late'){ pill.className='pill late'; pill.textContent='Vencida'; }
      else { pill.className='pill pend'; pill.textContent='Pendiente'; }

      var actions = document.createElement('div'); actions.className='debt-actions';
      if (st !== 'done'){
        var input = document.createElement('input'); input.type='number'; input.min='0'; input.step='0.01'; input.placeholder='Abono';
        var addBtn = document.createElement('button'); addBtn.className='small'; addBtn.textContent='Abonar';
        addBtn.addEventListener('click', function(){
          var v = parseFloat(input.value);
          if (!v || v<=0) return;
          var nuevo = Math.min(total, pagado+v);
          updateDeuda(d.id, {montoPagado: nuevo});
          input.value='';
        });
        actions.appendChild(input); actions.appendChild(addBtn);
      }
      var delBtn = document.createElement('button'); delBtn.className='small ghost'; delBtn.textContent='Eliminar';
      delBtn.addEventListener('click', function(){ deleteDeuda(d.id); });
      actions.appendChild(delBtn);

      foot.appendChild(pill); foot.appendChild(actions);

      card.appendChild(head); card.appendChild(figures); card.appendChild(track); card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  function renderResumen(){
    var mes = todayISO().slice(0,7);
    var gastosMes = state.gastos.filter(function(g){ return monthKey(g.fecha)===mes; });
    var totalGastosMes = gastosMes.reduce(function(s,g){ return s+Number(g.monto||0); }, 0);
    var deudaPendiente = state.deudas.reduce(function(s,d){
      var r = Number(d.montoTotal||0)-Number(d.montoPagado||0);
      return s + (r>0 ? r : 0);
    }, 0);

    document.getElementById('sum-gastos-mes').textContent = money(totalGastosMes);
    document.getElementById('sum-deuda-pendiente').textContent = money(deudaPendiente);
    document.getElementById('sum-total').textContent = money(totalGastosMes + deudaPendiente);

    var byCat = {};
    CATS.forEach(function(c){ byCat[c]=0; });
    gastosMes.forEach(function(g){ byCat[g.categoria] = (byCat[g.categoria]||0) + Number(g.monto||0); });
    var max = Math.max.apply(null, CATS.map(function(c){ return byCat[c]; }).concat([1]));

    var svg = document.getElementById('chart');
    svg.innerHTML = '';
    var n = CATS.length;
    var padL = 10, padTop = 10, padBottom = 34;
    var w = 600, h = 200;
    var plotW = w - padL*2;
    var plotH = h - padTop - padBottom;
    var gap = 14;
    var barW = (plotW - gap*(n-1)) / n;
    var cs = getComputedStyle(document.documentElement);

    CATS.forEach(function(c, i){
      var val = byCat[c];
      var barH = max>0 ? (val/max)*plotH : 0;
      var x = padL + i*(barW+gap);
      var y = padTop + (plotH - barH);
      var rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', barW); rect.setAttribute('height', Math.max(barH,1));
      rect.setAttribute('rx', 3);
      rect.setAttribute('fill', cs.getPropertyValue(CAT_COLOR[c].replace('var(','').replace(')','')) || '#999');
      svg.appendChild(rect);

      if (val > 0){
        var label = document.createElementNS('http://www.w3.org/2000/svg','text');
        label.setAttribute('x', x+barW/2); label.setAttribute('y', y-5);
        label.setAttribute('text-anchor','middle'); label.setAttribute('font-size','11');
        label.setAttribute('fill', cs.getPropertyValue('--ink-soft'));
        label.textContent = Math.round(val);
        svg.appendChild(label);
      }

      var catLabel = document.createElementNS('http://www.w3.org/2000/svg','text');
      catLabel.setAttribute('x', x+barW/2); catLabel.setAttribute('y', h-14);
      catLabel.setAttribute('text-anchor','middle'); catLabel.setAttribute('font-size','10');
      catLabel.setAttribute('fill', cs.getPropertyValue('--ink-soft'));
      catLabel.textContent = c.length>8 ? c.slice(0,7)+'…' : c;
      svg.appendChild(catLabel);
    });

    var legend = document.getElementById('chart-legend');
    legend.innerHTML = '';
    if (gastosMes.length === 0){
      legend.innerHTML = '<span>Sin gastos registrados este mes todavía.</span>';
    }

    var upcoming = state.deudas.filter(function(d){ return debtStatus(d)!=='done'; })
      .sort(function(a,b){ return (a.fechaLimite||'9999').localeCompare(b.fechaLimite||'9999'); })
      .slice(0,5);
    var ul = document.getElementById('upcoming-list');
    ul.innerHTML = '';
    if (!upcoming.length){
      var e = document.createElement('li'); e.className='empty'; e.textContent='No tienes deudas pendientes. 🎉';
      ul.appendChild(e);
    } else {
      upcoming.forEach(function(d){
        var restante = Number(d.montoTotal||0)-Number(d.montoPagado||0);
        var li = document.createElement('li'); li.className='item';
        var dot = document.createElement('span'); dot.className='dot';
        dot.style.background = debtStatus(d)==='late' ? 'var(--danger)' : 'var(--warning)';
        var main = document.createElement('div'); main.className='main';
        var desc = document.createElement('div'); desc.className='desc'; desc.textContent = d.entidad;
        var meta = document.createElement('div'); meta.className='meta'; meta.textContent = d.fechaLimite ? formatDate(d.fechaLimite) : 'Sin fecha límite';
        main.appendChild(desc); main.appendChild(meta);
        var amount = document.createElement('div'); amount.className='amount mono'; amount.textContent = money(restante);
        li.appendChild(dot); li.appendChild(main); li.appendChild(amount);
        ul.appendChild(li);
      });
    }
  }

  // ---- data ops ----
  function addGasto(g){
    g.id = uid(); g.createdAt = Date.now();
    state.gastos.push(g); save(); renderAll();
  }
  function deleteGasto(id){
    state.gastos = state.gastos.filter(function(g){ return g.id!==id; }); save(); renderAll();
  }
  function addDeuda(d){
    d.id = uid(); d.createdAt = Date.now();
    state.deudas.push(d); save(); renderAll();
  }
  function updateDeuda(id, patch){
    var d = state.deudas.find(function(x){ return x.id===id; });
    if (d) Object.assign(d, patch);
    save(); renderAll();
  }
  function deleteDeuda(id){
    state.deudas = state.deudas.filter(function(d){ return d.id!==id; }); save(); renderAll();
  }

  // ---- forms ----
  document.getElementById('form-gasto').addEventListener('submit', function(ev){
    ev.preventDefault();
    var fecha = document.getElementById('g-fecha').value || todayISO();
    var categoria = document.getElementById('g-categoria').value;
    var monto = parseFloat(document.getElementById('g-monto').value);
    var descripcion = document.getElementById('g-desc').value.trim();
    if (!monto || monto<=0) return;
    addGasto({fecha:fecha, categoria:categoria, monto:monto, descripcion:descripcion});
    ev.target.reset();
    document.getElementById('g-fecha').value = todayISO();
  });

  document.getElementById('form-deuda').addEventListener('submit', function(ev){
    ev.preventDefault();
    var entidad = document.getElementById('d-entidad').value.trim();
    var total = parseFloat(document.getElementById('d-total').value);
    var pagado = parseFloat(document.getElementById('d-pagado').value) || 0;
    var fechaLimite = document.getElementById('d-fecha').value || '';
    var notas = document.getElementById('d-notas').value.trim();
    if (!entidad || !total || total<=0) return;
    addDeuda({entidad:entidad, montoTotal:total, montoPagado:Math.min(pagado,total), fechaLimite:fechaLimite, notas:notas});
    ev.target.reset();
    document.getElementById('d-pagado').value = '0';
  });

  document.getElementById('filter-mes').addEventListener('change', renderGastos);
  document.getElementById('filter-cat').addEventListener('change', renderGastos);
  document.getElementById('filter-deuda-estado').addEventListener('change', renderDeudas);

  // ---- export to excel ----
  function buildWorkbook(){
    var wb = XLSX.utils.book_new();

    var gastosRows = [['Fecha','Categoría','Monto','Descripción']];
    state.gastos.slice().sort(function(a,b){ return (a.fecha||'').localeCompare(b.fecha||''); })
      .forEach(function(g){ gastosRows.push([g.fecha||'', g.categoria||'', Number(g.monto)||0, g.descripcion||'']); });
    var wsGastos = XLSX.utils.aoa_to_sheet(gastosRows);
    wsGastos['!cols'] = [{wch:12},{wch:16},{wch:12},{wch:40}];
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

    var deudasRows = [['Entidad','Monto total','Pagado','Restante','Fecha límite','Estado','Notas']];
    state.deudas.slice().sort(function(a,b){ return (a.fechaLimite||'9999').localeCompare(b.fechaLimite||'9999'); })
      .forEach(function(d){
        var total = Number(d.montoTotal)||0, pagado = Number(d.montoPagado)||0;
        var estadoTxt = debtStatus(d)==='done' ? 'Pagada' : (debtStatus(d)==='late' ? 'Vencida' : 'Pendiente');
        deudasRows.push([d.entidad||'', total, pagado, Math.max(0,total-pagado), d.fechaLimite||'', estadoTxt, d.notas||'']);
      });
    var wsDeudas = XLSX.utils.aoa_to_sheet(deudasRows);
    wsDeudas['!cols'] = [{wch:22},{wch:12},{wch:12},{wch:12},{wch:13},{wch:11},{wch:34}];
    XLSX.utils.book_append_sheet(wb, wsDeudas, 'Deudas');

    return wb;
  }

  var exportBtn = document.getElementById('btn-export');
  exportBtn.addEventListener('click', function(){
    if (typeof XLSX === 'undefined'){
      showBanner('No se pudo cargar el componente de Excel. Revisa tu conexión e intenta de nuevo.', true);
      return;
    }
    if (!state.gastos.length && !state.deudas.length){
      showBanner('Todavía no hay gastos ni deudas registradas para exportar.', true);
      return;
    }
    try{
      var wb = buildWorkbook();
      XLSX.writeFile(wb, 'balance-' + todayISO() + '.xlsx');
    } catch(err){
      console.error(err);
      showBanner('No se pudo exportar el archivo. Intenta de nuevo.', true);
    }
  });

  // ---- PWA install prompt (Android/desktop Chrome) ----
  var deferredPrompt = null;
  var installBtn = document.getElementById('btn-install');
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', function(){
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function(){
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  });
  window.addEventListener('appinstalled', function(){
    installBtn.hidden = true;
  });

  // iOS Safari: no beforeinstallprompt — show a one-time hint if not already installed
  (function iosHint(){
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    if (isIos && !isStandalone && !localStorage.getItem('balance-ios-hint-shown')){
      showBanner('Para instalar: toca Compartir → "Agregar a pantalla de inicio".');
      localStorage.setItem('balance-ios-hint-shown', '1');
    }
  })();

  // ---- service worker ----
  if ('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(e){ console.error(e); });
    });
  }

  // ---- boot ----
  load();
  renderAll();
})();
