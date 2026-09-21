(function(){
  "use strict";

  var CATS = ["Comida","Transporte","Vivienda","Servicios","Entretenimiento","Salud","Educación","Otros"];
  var CAT_COLOR = {"Comida":"var(--cat-1)","Transporte":"var(--cat-2)","Vivienda":"var(--cat-3)","Servicios":"var(--cat-4)","Entretenimiento":"var(--cat-5)","Salud":"var(--cat-6)","Educación":"var(--cat-7)","Otros":"var(--cat-8)"};
  var TIPOS_DEUDA = ["Tarjeta de crédito","Préstamo personal","Préstamo hipotecario","Préstamo automotriz","Préstamo estudiantil","Servicio/Recibo","Préstamo entre personas","Otro"];
  var FRECUENCIAS = [
    {value:'unica', label:'Fecha única'},
    {value:'semanal', label:'Semanal'},
    {value:'quincenal', label:'Quincenal'},
    {value:'mensual', label:'Mensual'}
  ];
  var FRECUENCIA_LABEL = {unica:'Pago único', semanal:'Semanal', quincenal:'Quincenal', mensual:'Mensual'};
  var ESTADO_LABEL = {pagada:'Pagada', parcial:'Parcial', atrasada:'Atrasada', pendiente:'Pendiente'};
  var STORAGE_KEY = "balance-app-data-v3";
  var LEGACY_KEYS = ["balance-app-data-v2", "balance-app-data-v1"];

  var state = { gastos: [], deudas: [], recurrentes: [], remindersShown: {} };
  var bannerTimer = null;

  var fmt = new Intl.NumberFormat('es-MX', {style:'currency', currency:'MXN', maximumFractionDigits:2});
  function money(n){ return fmt.format(Number(n)||0); }
  function todayISO(){ var d=new Date(); return d.toISOString().slice(0,10); }
  function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random())); }
  function monthKey(iso){ return (iso||"").slice(0,7); }
  function pad2(n){ return String(n).length<2 ? '0'+n : String(n); }
  function addMonthsKey(mk, n){
    var parts = mk.split('-'); var y = parseInt(parts[0],10); var m = parseInt(parts[1],10)-1;
    var d = new Date(y, m+n, 1);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  }
  function addDaysISO(iso, n){ var d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
  function addMonthsISO(iso, n){ var d = new Date(iso+'T00:00:00'); d.setMonth(d.getMonth()+n); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }

  // ---- installment schedule (cuotas) ----
  // Builds the expected payment schedule for a debt: one lump sum for "unica",
  // or a series of fixed installments for recurring frequencies.
  function buildCuotas(d){
    var freq = d.frecuencia || 'unica';
    var total = Number(d.montoTotal||0);
    if (!d.fechaInicio) return [];
    if (freq === 'unica'){
      return [{ n:1, fecha:d.fechaInicio, monto: total }];
    }
    var cuota = Number(d.montoCuota||0);
    if (cuota <= 0 || total <= 0) return [];
    var n = (d.numCuotas && d.numCuotas>0) ? Math.round(d.numCuotas) : Math.ceil(total/cuota);
    n = Math.min(n, 600); // sanity cap
    var list = [];
    var fecha = d.fechaInicio;
    var acumulado = 0;
    for (var i=0;i<n;i++){
      var monto = cuota;
      if (i === n-1){
        var restoTeorico = total - acumulado;
        if (restoTeorico > 0 && restoTeorico < cuota*1.5) monto = restoTeorico;
      }
      list.push({ n:i+1, fecha:fecha, monto: monto });
      acumulado += monto;
      if (freq === 'semanal') fecha = addDaysISO(fecha,7);
      else if (freq === 'quincenal') fecha = addDaysISO(fecha,14);
      else if (freq === 'mensual') fecha = addMonthsISO(fecha,1);
    }
    return list;
  }

  // Allocates total payments made (FIFO) across the schedule to derive each
  // installment's status: pagada / parcial / atrasada / pendiente.
  function cuotasConEstado(d){
    var cuotas = buildCuotas(d);
    var disponible = pagadoTotal(d);
    var today = todayISO();
    return cuotas.map(function(c){
      var cubierto = Math.min(c.monto, Math.max(0, disponible));
      disponible -= cubierto;
      var estado;
      if (cubierto >= c.monto - 0.01) estado = 'pagada';
      else if (cubierto > 0) estado = 'parcial';
      else estado = (c.fecha < today) ? 'atrasada' : 'pendiente';
      return { n:c.n, fecha:c.fecha, monto:c.monto, cubierto:cubierto, estado:estado };
    });
  }

  function nextPendingCuota(d){
    var cuotas = cuotasConEstado(d);
    for (var i=0;i<cuotas.length;i++){ if (cuotas[i].estado !== 'pagada') return cuotas[i]; }
    return null;
  }

  function nextDueDate(d){
    var c = nextPendingCuota(d);
    if (c) return c.fecha;
    return d.fechaInicio || '';
  }

  // ---- money inputs: live "50,000.00" formatting, typed as plain digits ----
  function attachMoneyInput(el){
    el.setAttribute('inputmode','decimal');
    el.addEventListener('input', function(){
      var raw = el.value;
      var clean = raw.replace(/[^\d.]/g,'');
      var firstDot = clean.indexOf('.');
      var intPart = firstDot===-1 ? clean : clean.slice(0,firstDot);
      var decPart = firstDot===-1 ? '' : '.'+clean.slice(firstDot+1).replace(/\./g,'').slice(0,2);
      intPart = intPart.replace(/^0+(?=\d)/,'');
      var withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      el.value = withCommas + decPart;
    });
  }
  function parseMoneyInput(el){ return parseFloat(String(el.value).replace(/,/g,'')) || 0; }

  function showBanner(msg, autoHide){
    var b = document.getElementById('banner');
    b.textContent = msg; b.hidden = false;
    if (bannerTimer) clearTimeout(bannerTimer);
    if (autoHide){ bannerTimer = setTimeout(function(){ b.hidden = true; }, 4000); }
  }

  // ---- persistence (localStorage, per device) ----
  function pagadoTotal(d){
    return (d.pagos||[]).reduce(function(s,p){ return s + (Number(p.monto)||0); }, 0);
  }

  function migrate(parsed){
    var data = { gastos: parsed.gastos||[], deudas: parsed.deudas||[], recurrentes: parsed.recurrentes||[], remindersShown: parsed.remindersShown||{} };
    data.deudas.forEach(function(d){
      if (!d.pagos){
        d.pagos = [];
        if (d.montoPagado && Number(d.montoPagado) > 0){
          d.pagos.push({id: uid(), fecha: d.createdAt ? new Date(d.createdAt).toISOString().slice(0,10) : todayISO(), monto: Number(d.montoPagado)});
        }
        delete d.montoPagado;
      }
      if (!d.tipo) d.tipo = 'Otro';
      if (!d.frecuencia) d.frecuencia = 'unica';
      if (d.fechaLimite && !d.fechaInicio) d.fechaInicio = d.fechaLimite;
      delete d.fechaLimite;
      if (d.montoCuota == null) d.montoCuota = (d.frecuencia === 'unica') ? Number(d.montoTotal||0) : 0;
      if (d.numCuotas == null) d.numCuotas = null;
    });
    return data;
  }

  function load(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw){
        state = migrate(JSON.parse(raw));
        return;
      }
      for (var i=0;i<LEGACY_KEYS.length;i++){
        var legacy = localStorage.getItem(LEGACY_KEYS[i]);
        if (legacy){
          state = migrate(JSON.parse(legacy));
          save();
          return;
        }
      }
    } catch(e){
      console.error(e);
      showBanner('No se pudieron leer tus datos guardados en este navegador.');
    }
  }
  function save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch(e){
      console.error(e);
      showBanner('No se pudo guardar — puede que el almacenamiento esté lleno o bloqueado.', true);
    }
  }

  // ---- populate static selects ----
  function fillCategorySelect(sel, withAll){
    sel.innerHTML = '';
    if (withAll){
      var allOpt = document.createElement('option'); allOpt.value=''; allOpt.textContent='Todas las categorías';
      sel.appendChild(allOpt);
    }
    CATS.forEach(function(c){ var o=document.createElement('option'); o.value=c; o.textContent=c; sel.appendChild(o); });
  }
  fillCategorySelect(document.getElementById('g-categoria'), false);
  fillCategorySelect(document.getElementById('filter-cat'), true);
  fillCategorySelect(document.getElementById('r-categoria'), false);
  document.getElementById('g-fecha').value = todayISO();

  var dTipoSel = document.getElementById('d-tipo');
  TIPOS_DEUDA.forEach(function(t){ var o=document.createElement('option'); o.value=t; o.textContent=t; dTipoSel.appendChild(o); });
  var dFreqSel = document.getElementById('d-frecuencia');
  FRECUENCIAS.forEach(function(f){ var o=document.createElement('option'); o.value=f.value; o.textContent=f.label; dFreqSel.appendChild(o); });

  [document.getElementById('g-monto'), document.getElementById('d-total'), document.getElementById('d-pagado'),
   document.getElementById('r-monto'), document.getElementById('d-monto-cuota')]
    .forEach(function(el){ if (el) attachMoneyInput(el); });

  function updateCuotaFieldsVisibility(){
    var freq = dFreqSel.value;
    var fields = document.getElementById('cuota-fields');
    var fechaLabel = document.getElementById('d-fecha-label');
    if (fields) fields.hidden = (freq === 'unica');
    if (fechaLabel) fechaLabel.textContent = (freq === 'unica') ? 'Fecha límite' : 'Fecha de la primera cuota';
  }
  dFreqSel.addEventListener('change', updateCuotaFieldsVisibility);
  updateCuotaFieldsVisibility();

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
    renderRecurrentes();
    renderGastos();
    renderDeudas();
    renderResumen();
    renderProgreso();
  }

  function renderRecurrentes(){
    var mes = todayISO().slice(0,7);
    var list = document.getElementById('recurrentes-list');
    list.innerHTML = '';
    if (!state.recurrentes.length){
      var e = document.createElement('li'); e.className='empty'; e.textContent='No tienes pagos recurrentes todavía. Agrega renta, suscripciones, servicios...';
      list.appendChild(e); return;
    }
    state.recurrentes.slice().sort(function(a,b){ return (a.dia||0)-(b.dia||0); }).forEach(function(r){
      var linked = state.gastos.find(function(g){ return g.recurrenteId===r.id && monthKey(g.fecha)===mes; });
      var li = document.createElement('li'); li.className = 'rec-item' + (linked ? ' checked':'');
      var box = document.createElement('span'); box.className='checkbox';
      box.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
      box.addEventListener('click', function(){ toggleRecurrente(r, linked); });
      var main = document.createElement('div'); main.className='main';
      var desc = document.createElement('div'); desc.className='desc'; desc.textContent = r.nombre;
      var meta = document.createElement('div'); meta.className='meta'; meta.textContent = r.categoria + ' · día ' + r.dia + ' de cada mes';
      main.appendChild(desc); main.appendChild(meta);
      var amount = document.createElement('div'); amount.className='amount mono'; amount.textContent = money(r.monto);
      var del = document.createElement('button'); del.className='del'; del.setAttribute('aria-label','Eliminar recurrente'); del.textContent='✕';
      del.addEventListener('click', function(){ deleteRecurrente(r.id); });
      li.appendChild(box); li.appendChild(main); li.appendChild(amount); li.appendChild(del);
      list.appendChild(li);
    });
  }

  function toggleRecurrente(r, existingGasto){
    if (existingGasto){
      deleteGasto(existingGasto.id);
    } else {
      addGasto({fecha: todayISO(), categoria: r.categoria, monto: r.monto, descripcion: r.nombre, recurrenteId: r.id});
    }
  }

  function deleteRecurrente(id){
    state.recurrentes = state.recurrentes.filter(function(r){ return r.id!==id; });
    save(); renderAll();
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
      var meta = document.createElement('div'); meta.className='meta'; meta.textContent = g.categoria + ' · ' + formatDate(g.fecha) + (g.recurrenteId ? ' · recurrente' : '');
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
    var restante = Number(d.montoTotal||0) - pagadoTotal(d);
    if (restante <= 0.004) return 'done';
    var due = nextDueDate(d);
    if (due && due < todayISO()) return 'late';
    return 'pending';
  }

  var openHistory = {};
  var openCuotas = {};

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
      return (nextDueDate(a)||'9999').localeCompare(nextDueDate(b)||'9999');
    });

    wrap.innerHTML = '';
    if (!items.length){
      var e = document.createElement('div'); e.className='empty'; e.textContent='No hay deudas registradas para este filtro.';
      wrap.appendChild(e); return;
    }

    items.forEach(function(d){
      var total = Number(d.montoTotal||0), pagado = pagadoTotal(d);
      var pct = total > 0 ? Math.min(100, Math.max(0, (pagado/total)*100)) : 0;
      var st = debtStatus(d);
      var cuotas = cuotasConEstado(d);
      var nextC = nextPendingCuota(d);

      var card = document.createElement('div'); card.className='debt-card' + (st==='done' ? ' done':'');
      var head = document.createElement('div'); head.className='head';
      var nameWrap = document.createElement('div'); nameWrap.className='name-wrap';
      var name = document.createElement('div'); name.className='name'; name.textContent = d.entidad;
      var typeTag = document.createElement('span'); typeTag.className='pill type'; typeTag.textContent = d.tipo || 'Otro';
      nameWrap.appendChild(name); nameWrap.appendChild(typeTag);
      var due = document.createElement('div'); due.className='due';
      var nextDue = nextDueDate(d);
      var freqLabel = (d.frecuencia && d.frecuencia!=='unica') ? (' · ' + FRECUENCIA_LABEL[d.frecuencia] + (cuotas.length ? ' · cuota '+(nextC?nextC.n:cuotas.length)+'/'+cuotas.length : '')) : '';
      due.textContent = nextDue ? ('Vence ' + formatDate(nextDue) + freqLabel) : 'Sin fecha límite';
      head.appendChild(nameWrap); head.appendChild(due);

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
        var input = document.createElement('input'); input.type='text';
        var sugerido = nextC ? Math.max(0, nextC.monto - nextC.cubierto) : Math.max(0,total-pagado);
        input.placeholder = sugerido>0 ? money(sugerido) : 'Abono';
        attachMoneyInput(input);
        var addBtn = document.createElement('button'); addBtn.className='small';
        addBtn.textContent = (cuotas.length>1 && nextC) ? ('Pagar cuota '+nextC.n) : 'Abonar';
        addBtn.addEventListener('click', function(){
          var v = parseMoneyInput(input);
          if (!v || v<=0) v = sugerido;
          if (!v || v<=0) return;
          var restante = Math.max(0, total-pagado);
          var monto = Math.min(v, restante);
          addPago(d.id, monto);
          input.value='';
        });
        actions.appendChild(input); actions.appendChild(addBtn);
      }
      if (d.fechaInicio){
        var calBtn = document.createElement('button'); calBtn.className='small cal';
        calBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg> Recordatorio';
        calBtn.addEventListener('click', function(){
          downloadICS({
            uid: 'deuda-'+d.id,
            title: 'Vence: ' + d.entidad,
            description: 'Pago pendiente de ' + money(Math.max(0,total-pagado)) + ' — registrado en Balance.',
            dateISO: d.fechaInicio,
            frecuencia: d.frecuencia
          });
        });
        actions.appendChild(calBtn);
      }
      var delBtn = document.createElement('button'); delBtn.className='small ghost'; delBtn.textContent='Eliminar';
      delBtn.addEventListener('click', function(){ deleteDeuda(d.id); });
      actions.appendChild(delBtn);

      foot.appendChild(pill); foot.appendChild(actions);

      card.appendChild(head); card.appendChild(figures); card.appendChild(track); card.appendChild(foot);

      if (cuotas.length > 1){
        var toggleCuotasBtn = document.createElement('button'); toggleCuotasBtn.className='toggle-history';
        var cuotasOpen = !!openCuotas[d.id];
        toggleCuotasBtn.textContent = cuotasOpen ? 'Ocultar calendario de cuotas' : 'Ver calendario de cuotas (' + cuotas.length + ')';
        toggleCuotasBtn.addEventListener('click', function(){ openCuotas[d.id] = !openCuotas[d.id]; renderDeudas(); });
        card.appendChild(toggleCuotasBtn);

        if (cuotasOpen){
          var sched = document.createElement('div'); sched.className='pay-history';
          cuotas.forEach(function(c){
            var row = document.createElement('div'); row.className='pay-row cuota-row';
            var left2 = document.createElement('span'); left2.textContent = 'Cuota ' + c.n + ' · ' + formatDate(c.fecha);
            var right2 = document.createElement('span'); right2.className='cuota-right';
            var amtSpan = document.createElement('span'); amtSpan.className='amt mono'; amtSpan.textContent = money(c.monto);
            var statePill = document.createElement('span');
            statePill.className = 'pill ' + (c.estado==='pagada'?'done':c.estado==='atrasada'?'late':c.estado==='parcial'?'pend':'neutral');
            statePill.textContent = ESTADO_LABEL[c.estado];
            right2.appendChild(amtSpan); right2.appendChild(statePill);
            row.appendChild(left2); row.appendChild(right2);
            sched.appendChild(row);
          });
          card.appendChild(sched);
        }
      }

      if ((d.pagos||[]).length){
        var toggleBtn = document.createElement('button'); toggleBtn.className='toggle-history';
        var isOpen = !!openHistory[d.id];
        toggleBtn.textContent = isOpen ? 'Ocultar historial de pagos' : 'Ver historial de pagos (' + d.pagos.length + ')';
        toggleBtn.addEventListener('click', function(){
          openHistory[d.id] = !openHistory[d.id];
          renderDeudas();
        });
        card.appendChild(toggleBtn);

        if (isOpen){
          var hist = document.createElement('div'); hist.className='pay-history';
          d.pagos.slice().sort(function(a,b){ return (b.fecha||'').localeCompare(a.fecha||''); }).forEach(function(p){
            var row = document.createElement('div'); row.className='pay-row';
            var left2 = document.createElement('span'); left2.textContent = formatDate(p.fecha);
            var right2 = document.createElement('span');
            var amtSpan = document.createElement('span'); amtSpan.className='amt mono'; amtSpan.textContent = money(p.monto);
            var delP = document.createElement('button'); delP.textContent='✕'; delP.setAttribute('aria-label','Eliminar pago');
            delP.addEventListener('click', function(){ deletePago(d.id, p.id); });
            right2.appendChild(amtSpan); right2.appendChild(delP);
            row.appendChild(left2); row.appendChild(right2);
            hist.appendChild(row);
          });
          card.appendChild(hist);
        }
      }

      wrap.appendChild(card);
    });
  }

  function renderResumen(){
    var mes = todayISO().slice(0,7);
    var gastosMes = state.gastos.filter(function(g){ return monthKey(g.fecha)===mes; });
    var totalGastosMes = gastosMes.reduce(function(s,g){ return s+Number(g.monto||0); }, 0);
    var pagadoMes = 0;
    state.deudas.forEach(function(d){
      (d.pagos||[]).forEach(function(p){ if (monthKey(p.fecha)===mes) pagadoMes += Number(p.monto||0); });
    });
    var deudaPendiente = state.deudas.reduce(function(s,d){
      var r = Number(d.montoTotal||0)-pagadoTotal(d);
      return s + (r>0 ? r : 0);
    }, 0);

    document.getElementById('sum-gastos-mes').textContent = money(totalGastosMes);
    document.getElementById('sum-pagado-mes').textContent = money(pagadoMes);
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
      .sort(function(a,b){ return (nextDueDate(a)||'9999').localeCompare(nextDueDate(b)||'9999'); })
      .slice(0,5);
    var ul = document.getElementById('upcoming-list');
    ul.innerHTML = '';
    if (!upcoming.length){
      var e = document.createElement('li'); e.className='empty'; e.textContent='No tienes deudas pendientes. 🎉';
      ul.appendChild(e);
    } else {
      upcoming.forEach(function(d){
        var restante = Number(d.montoTotal||0)-pagadoTotal(d);
        var li = document.createElement('li'); li.className='item';
        var dot = document.createElement('span'); dot.className='dot';
        dot.style.background = debtStatus(d)==='late' ? 'var(--danger)' : 'var(--warning)';
        var main = document.createElement('div'); main.className='main';
        var desc = document.createElement('div'); desc.className='desc'; desc.textContent = d.entidad;
        var nextDue = nextDueDate(d);
        var freqLabel = (d.frecuencia && d.frecuencia!=='unica') ? (' · ' + FRECUENCIA_LABEL[d.frecuencia]) : '';
        var meta = document.createElement('div'); meta.className='meta'; meta.textContent = nextDue ? (formatDate(nextDue) + freqLabel) : 'Sin fecha límite';
        main.appendChild(desc); main.appendChild(meta);
        var amount = document.createElement('div'); amount.className='amount mono'; amount.textContent = money(restante);
        li.appendChild(dot); li.appendChild(main); li.appendChild(amount);
        if (d.fechaInicio){
          var calBtn = document.createElement('button'); calBtn.className='small cal';
          calBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
          calBtn.title = 'Agregar al calendario';
          calBtn.addEventListener('click', function(){
            downloadICS({ uid:'deuda-'+d.id, title:'Vence: '+d.entidad, description:'Pago pendiente de '+money(restante)+' — Balance.', dateISO: d.fechaInicio, frecuencia: d.frecuencia });
          });
          li.appendChild(calBtn);
        }
        ul.appendChild(li);
      });
    }
  }

  function renderProgreso(){
    var pagadoHist = 0, totalHist = 0;
    state.deudas.forEach(function(d){ pagadoHist += pagadoTotal(d); totalHist += Number(d.montoTotal||0); });
    document.getElementById('prog-pagado-total').textContent = money(pagadoHist);
    document.getElementById('prog-pct').textContent = totalHist>0 ? Math.round((pagadoHist/totalHist)*100)+'%' : '—';

    var months = [];
    var cursor = todayISO().slice(0,7);
    for (var i=5;i>=0;i--){ months.push(addMonthsKey(cursor,-i)); }

    var gastoPorMes = {}, pagoPorMes = {};
    months.forEach(function(m){ gastoPorMes[m]=0; pagoPorMes[m]=0; });
    state.gastos.forEach(function(g){ var mk=monthKey(g.fecha); if (mk in gastoPorMes) gastoPorMes[mk]+=Number(g.monto||0); });
    state.deudas.forEach(function(d){ (d.pagos||[]).forEach(function(p){ var mk=monthKey(p.fecha); if (mk in pagoPorMes) pagoPorMes[mk]+=Number(p.monto||0); }); });

    var promedio = months.reduce(function(s,m){ return s+gastoPorMes[m]; }, 0) / months.length;
    document.getElementById('prog-promedio').textContent = money(promedio);

    drawTendencia(months, gastoPorMes, pagoPorMes);

    var wrap = document.getElementById('progreso-deudas-list');
    wrap.innerHTML = '';
    if (!state.deudas.length){
      wrap.innerHTML = '<div class="empty">Agrega una deuda para ver su avance aquí.</div>';
      return;
    }
    state.deudas.slice().sort(function(a,b){
      var pa = Number(a.montoTotal)>0 ? pagadoTotal(a)/Number(a.montoTotal) : 0;
      var pb = Number(b.montoTotal)>0 ? pagadoTotal(b)/Number(b.montoTotal) : 0;
      return pb-pa;
    }).forEach(function(d){
      var total = Number(d.montoTotal||0), pagado = pagadoTotal(d);
      var pct = total>0 ? Math.min(100, (pagado/total)*100) : 0;
      var row = document.createElement('div'); row.className='prog-debt-row';
      var name = document.createElement('div'); name.className='name'; name.textContent = d.entidad;
      var track = document.createElement('div'); track.className='bar-track';
      var fill = document.createElement('div'); fill.className='bar-fill'; fill.style.width = pct+'%';
      if (pct>=100) fill.style.background = 'var(--success)';
      track.appendChild(fill);
      var pctEl = document.createElement('div'); pctEl.className='pct mono'; pctEl.textContent = Math.round(pct)+'%';
      row.appendChild(name); row.appendChild(track); row.appendChild(pctEl);
      wrap.appendChild(row);
    });
  }

  function drawTendencia(months, gastoPorMes, pagoPorMes){
    var svg = document.getElementById('chart-tendencia');
    svg.innerHTML = '';
    var w = 600, h = 220;
    var padL = 10, padTop = 10, padBottom = 34;
    var plotW = w - padL*2;
    var plotH = h - padTop - padBottom;
    var n = months.length;
    var groupGap = 18;
    var groupW = (plotW - groupGap*(n-1)) / n;
    var barGap = 4;
    var barW = (groupW - barGap) / 2;
    var max = Math.max.apply(null, months.map(function(m){ return Math.max(gastoPorMes[m], pagoPorMes[m]); }).concat([1]));
    var cs = getComputedStyle(document.documentElement);
    var colorGasto = cs.getPropertyValue('--danger');
    var colorPago = cs.getPropertyValue('--accent');

    months.forEach(function(m, i){
      var gx = padL + i*(groupW+groupGap);
      var gVal = gastoPorMes[m], pVal = pagoPorMes[m];
      var gH = max>0 ? (gVal/max)*plotH : 0;
      var pH = max>0 ? (pVal/max)*plotH : 0;

      var r1 = document.createElementNS('http://www.w3.org/2000/svg','rect');
      r1.setAttribute('x', gx); r1.setAttribute('y', padTop+(plotH-gH));
      r1.setAttribute('width', barW); r1.setAttribute('height', Math.max(gH,1));
      r1.setAttribute('rx', 2); r1.setAttribute('fill', colorGasto);
      svg.appendChild(r1);

      var r2 = document.createElementNS('http://www.w3.org/2000/svg','rect');
      r2.setAttribute('x', gx+barW+barGap); r2.setAttribute('y', padTop+(plotH-pH));
      r2.setAttribute('width', barW); r2.setAttribute('height', Math.max(pH,1));
      r2.setAttribute('rx', 2); r2.setAttribute('fill', colorPago);
      svg.appendChild(r2);

      var label = document.createElementNS('http://www.w3.org/2000/svg','text');
      label.setAttribute('x', gx+groupW/2); label.setAttribute('y', h-14);
      label.setAttribute('text-anchor','middle'); label.setAttribute('font-size','10');
      label.setAttribute('fill', cs.getPropertyValue('--ink-soft'));
      var d = new Date(m+'-02');
      label.textContent = d.toLocaleDateString('es', {month:'short'});
      svg.appendChild(label);
    });

    var legend = document.getElementById('tendencia-legend');
    legend.innerHTML =
      '<span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+colorGasto+';"></i> Gastos</span>' +
      '<span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+colorPago+';"></i> Pagos a deudas</span>';
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
  function addPago(deudaId, monto){
    var d = state.deudas.find(function(x){ return x.id===deudaId; });
    if (!d) return;
    d.pagos = d.pagos || [];
    d.pagos.push({id: uid(), fecha: todayISO(), monto: monto});
    save(); renderAll();
  }
  function deletePago(deudaId, pagoId){
    var d = state.deudas.find(function(x){ return x.id===deudaId; });
    if (!d) return;
    d.pagos = (d.pagos||[]).filter(function(p){ return p.id!==pagoId; });
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
    var monto = parseMoneyInput(document.getElementById('g-monto'));
    var descripcion = document.getElementById('g-desc').value.trim();
    if (!monto || monto<=0) return;
    addGasto({fecha:fecha, categoria:categoria, monto:monto, descripcion:descripcion});
    ev.target.reset();
    document.getElementById('g-fecha').value = todayISO();
  });

  document.getElementById('form-deuda').addEventListener('submit', function(ev){
    ev.preventDefault();
    var entidad = document.getElementById('d-entidad').value.trim();
    var tipo = document.getElementById('d-tipo').value;
    var frecuencia = document.getElementById('d-frecuencia').value;
    var total = parseMoneyInput(document.getElementById('d-total'));
    var pagado = parseMoneyInput(document.getElementById('d-pagado'));
    var fechaInicio = document.getElementById('d-fecha').value || '';
    var notas = document.getElementById('d-notas').value.trim();
    var montoCuota = frecuencia === 'unica' ? total : parseMoneyInput(document.getElementById('d-monto-cuota'));
    var numCuotasRaw = document.getElementById('d-num-cuotas').value;
    var numCuotas = numCuotasRaw ? parseInt(numCuotasRaw,10) : null;
    if (!entidad || !total || total<=0) return;
    if (frecuencia !== 'unica' && (!montoCuota || montoCuota<=0)){
      showBanner('Ingresa el monto de cada cuota para esta deuda.', true);
      return;
    }
    var nueva = {entidad:entidad, tipo:tipo, frecuencia:frecuencia, montoTotal:total, montoCuota:montoCuota, numCuotas:numCuotas, fechaInicio:fechaInicio, notas:notas, pagos:[]};
    if (pagado>0){ nueva.pagos.push({id:uid(), fecha: todayISO(), monto: Math.min(pagado,total)}); }
    addDeuda(nueva);
    ev.target.reset();
    updateCuotaFieldsVisibility();
    document.getElementById('d-pagado').value = '0';
  });

  document.getElementById('btn-toggle-recurrente').addEventListener('click', function(){
    var form = document.getElementById('form-recurrente');
    form.hidden = !form.hidden;
  });
  document.getElementById('form-recurrente').addEventListener('submit', function(ev){
    ev.preventDefault();
    var nombre = document.getElementById('r-nombre').value.trim();
    var categoria = document.getElementById('r-categoria').value;
    var monto = parseMoneyInput(document.getElementById('r-monto'));
    var dia = parseInt(document.getElementById('r-dia').value, 10);
    if (!nombre || !monto || monto<=0 || !dia || dia<1 || dia>28) return;
    state.recurrentes.push({id: uid(), nombre:nombre, categoria:categoria, monto:monto, dia:dia, createdAt: Date.now()});
    save(); renderAll();
    ev.target.reset();
    document.getElementById('form-recurrente').hidden = true;
  });

  document.getElementById('filter-mes').addEventListener('change', renderGastos);
  document.getElementById('filter-cat').addEventListener('change', renderGastos);
  document.getElementById('filter-deuda-estado').addEventListener('change', renderDeudas);

  // ---- export to excel ----
  function buildWorkbook(){
    var wb = XLSX.utils.book_new();

    var gastosRows = [['Fecha','Categoría','Monto','Descripción','Recurrente']];
    state.gastos.slice().sort(function(a,b){ return (a.fecha||'').localeCompare(b.fecha||''); })
      .forEach(function(g){ gastosRows.push([g.fecha||'', g.categoria||'', Number(g.monto)||0, g.descripcion||'', g.recurrenteId ? 'Sí' : 'No']); });
    var wsGastos = XLSX.utils.aoa_to_sheet(gastosRows);
    wsGastos['!cols'] = [{wch:12},{wch:16},{wch:12},{wch:40},{wch:11}];
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

    var deudasRows = [['Entidad','Tipo','Frecuencia','Monto total','Pagado','Restante','Próximo vencimiento','Estado','Notas']];
    state.deudas.slice().sort(function(a,b){ return (nextDueDate(a)||'9999').localeCompare(nextDueDate(b)||'9999'); })
      .forEach(function(d){
        var total = Number(d.montoTotal)||0, pagado = pagadoTotal(d);
        var estadoTxt = debtStatus(d)==='done' ? 'Pagada' : (debtStatus(d)==='late' ? 'Vencida' : 'Pendiente');
        deudasRows.push([d.entidad||'', d.tipo||'Otro', FRECUENCIA_LABEL[d.frecuencia]||'Fecha única', total, pagado, Math.max(0,total-pagado), nextDueDate(d)||'', estadoTxt, d.notas||'']);
      });
    var wsDeudas = XLSX.utils.aoa_to_sheet(deudasRows);
    wsDeudas['!cols'] = [{wch:22},{wch:18},{wch:12},{wch:12},{wch:12},{wch:12},{wch:16},{wch:11},{wch:34}];
    XLSX.utils.book_append_sheet(wb, wsDeudas, 'Deudas');

    var pagosRows = [['Entidad','Fecha de pago','Monto']];
    state.deudas.forEach(function(d){
      (d.pagos||[]).slice().sort(function(a,b){ return (a.fecha||'').localeCompare(b.fecha||''); })
        .forEach(function(p){ pagosRows.push([d.entidad||'', p.fecha||'', Number(p.monto)||0]); });
    });
    var wsPagos = XLSX.utils.aoa_to_sheet(pagosRows);
    wsPagos['!cols'] = [{wch:22},{wch:14},{wch:12}];
    XLSX.utils.book_append_sheet(wb, wsPagos, 'Historial de pagos');

    var cuotasRows = [['Entidad','Cuota #','Fecha esperada','Monto esperado','Cubierto','Estado']];
    state.deudas.forEach(function(d){
      cuotasConEstado(d).forEach(function(c){
        cuotasRows.push([d.entidad||'', c.n, c.fecha||'', c.monto, c.cubierto, ESTADO_LABEL[c.estado]||'']);
      });
    });
    var wsCuotas = XLSX.utils.aoa_to_sheet(cuotasRows);
    wsCuotas['!cols'] = [{wch:22},{wch:9},{wch:14},{wch:14},{wch:12},{wch:11}];
    XLSX.utils.book_append_sheet(wb, wsCuotas, 'Calendario de cuotas');

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

  // ---- calendar (.ics) reminders — work even when the app is closed, via the phone's own calendar ----
  function icsDateCompact(iso){ return iso.replace(/-/g,''); }
  function icsEscape(s){ return String(s||'').replace(/[\\;,]/g, function(m){ return '\\'+m; }).replace(/\n/g,'\\n'); }

  function downloadICS(opts){
    var start = icsDateCompact(opts.dateISO);
    var end = icsDateCompact(addDaysISO(opts.dateISO, 1));
    var stamp = icsDateCompact(todayISO()) + 'T000000Z';
    var lines = [
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Balance App//ES','CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:'+opts.uid+'-'+Date.now()+'@balance-app',
      'DTSTAMP:'+stamp,
      'DTSTART;VALUE=DATE:'+start,
      'DTEND;VALUE=DATE:'+end,
      'SUMMARY:'+icsEscape(opts.title),
      'DESCRIPTION:'+icsEscape(opts.description||'')
    ];
    if (opts.recurringMonthly) lines.push('RRULE:FREQ=MONTHLY');
    else if (opts.frecuencia === 'semanal') lines.push('RRULE:FREQ=WEEKLY');
    else if (opts.frecuencia === 'quincenal') lines.push('RRULE:FREQ=WEEKLY;INTERVAL=2');
    else if (opts.frecuencia === 'mensual') lines.push('RRULE:FREQ=MONTHLY');
    lines.push('BEGIN:VALARM','TRIGGER:-P1D','ACTION:DISPLAY','DESCRIPTION:Recordatorio','END:VALARM');
    lines.push('END:VEVENT','END:VCALENDAR');
    var blob = new Blob([lines.join('\r\n')], {type:'text/calendar;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (opts.title||'recordatorio').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
    showBanner('Se descargó el evento — ábrelo para agregarlo a tu calendario y recibir el recordatorio en tu celular.', true);
  }

  // ---- notifications (only fire while you have the app open — see note below) ----
  function notify(title, body){
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (navigator.serviceWorker && navigator.serviceWorker.ready){
      navigator.serviceWorker.ready.then(function(reg){
        if (reg && reg.showNotification){ reg.showNotification(title, {body: body, icon:'icons/icon-192.png'}); }
        else { new Notification(title, {body: body}); }
      }).catch(function(){ new Notification(title, {body: body}); });
    } else {
      new Notification(title, {body: body});
    }
  }

  function updateNotifyUI(){
    var supported = 'Notification' in window;
    var btnHeader = document.getElementById('btn-notify');
    var card = document.getElementById('notify-card');
    if (!supported){ btnHeader.hidden = true; card.hidden = true; return; }
    if (Notification.permission === 'granted'){
      btnHeader.hidden = false; btnHeader.classList.add('active'); card.hidden = true;
    } else if (Notification.permission === 'denied'){
      btnHeader.hidden = true; card.hidden = true;
    } else {
      btnHeader.hidden = true; card.hidden = false;
    }
  }

  function requestNotifyPermission(){
    if (!('Notification' in window)) return;
    Notification.requestPermission().then(function(){
      updateNotifyUI();
      checkReminders(true);
    });
  }
  document.getElementById('btn-notify').addEventListener('click', requestNotifyPermission);
  document.getElementById('btn-notify-inline').addEventListener('click', requestNotifyPermission);

  function checkReminders(force){
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var today = todayISO();
    if (!force && state.remindersShown[today]) return;

    var in3 = addDaysISO(today, 3);
    var urgentes = state.deudas.filter(function(d){
      if (debtStatus(d)==='done') return false;
      var due = nextDueDate(d);
      return due && due <= in3;
    });
    var hoyDia = new Date().getDate();
    var recPendientes = state.recurrentes.filter(function(r){
      if (r.dia > hoyDia) return false;
      var mk = today.slice(0,7);
      return !state.gastos.some(function(g){ return g.recurrenteId===r.id && monthKey(g.fecha)===mk; });
    });

    var total = urgentes.length + recPendientes.length;
    if (total === 0) return;

    var nombres = urgentes.map(function(d){ return d.entidad; }).concat(recPendientes.map(function(r){ return r.nombre; }));
    var body = nombres.slice(0,4).join(', ') + (nombres.length>4 ? ' y ' + (nombres.length-4) + ' más' : '');
    notify('Tienes ' + total + ' pago(s) pendiente(s)', body);
    state.remindersShown[today] = true;
    save();
  }

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
  updateNotifyUI();
  checkReminders(false);
})();
