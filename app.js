(function () {
'use strict';

var LS = 'gds.commute.v1';
var $ = function (id) { return document.getElementById(id); };
var state = {
  plans: [], activeId: null,
  me: null, acc: null,
  monitoring: false, mapSource: 'amap',
  route: null, routeKey: '', routeAt: 0,
  picking: null, alertKey: '', soonKey: '',
  geoErr: null
};
var current = null;
var lastMapSource = 'amap';

/* ============ 基础工具 ============ */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function toMin(s) {
  if (typeof s !== 'string') return NaN;
  var m = s.trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!m) return NaN;
  var h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return NaN;
  return h * 60 + mi;
}
function fmtMin(t) {
  if (!isFinite(t)) return '--:--';
  t = ((Math.round(t) % 1440) + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function fmtCountdown(mins) {
  var total = Math.max(0, Math.round(mins * 60));
  var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
}
function haversine(a, b) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function dayStamp() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/* WGS84 -> GCJ02（高德瓦片用的是 GCJ02） */
var PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}
function tLat(x, y) {
  var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}
function tLng(x, y) {
  var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}
function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  var dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  var rad = lat / 180 * PI, magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  var sq = Math.sqrt(magic);
  dLat = (dLat * 180) / ((AXIS * (1 - EE)) / (magic * sq) * PI);
  dLng = (dLng * 180) / (AXIS / sq * Math.cos(rad) * PI);
  return [lat + dLat, lng + dLng];
}
function gcjToWgs(lat, lng) {
  if (outOfChina(lat, lng)) return { lat: lat, lng: lng };
  var wLat = lat, wLng = lng, i, g;
  for (i = 0; i < 6; i++) {
    g = wgs2gcj(wLat, wLng);
    wLat += lat - g[0];
    wLng += lng - g[1];
  }
  return { lat: wLat, lng: wLng };
}
function toMap(lat, lng) {
  return state.mapSource === 'amap' ? wgs2gcj(lat, lng) : [lat, lng];
}

/* ============ 数据 ============ */
function newPlan(name) {
  return {
    id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36),
    name: name || '通勤方案', line: '', stopName: '', stop: null,
    mode: 'list', times: [], first: '07:00', interval: 15, until: '09:00',
    speed: 1.25, buffer: 2, advance: 5,
    days: [false, true, true, true, true, true, false],
    sound: true, notify: true
  };
}
function load() {
  try {
    var raw = localStorage.getItem(LS);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && o.plans && o.plans.length) {
        state.plans = o.plans;
        state.activeId = o.activeId || o.plans[0].id;
        state.mapSource = o.mapSource === 'osm' ? 'osm' : 'amap';
        return;
      }
    }
  } catch (e) { }
  state.plans = [newPlan('上学通勤')];
  state.activeId = state.plans[0].id;
}
function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      plans: state.plans, activeId: state.activeId, mapSource: state.mapSource
    }));
  } catch (e) { }
}
function active() {
  for (var i = 0; i < state.plans.length; i++) {
    if (state.plans[i].id === state.activeId) return state.plans[i];
  }
  return state.plans[0] || null;
}
function planTimes(p) {
  var out = [], i;
  if (!p) return out;
  if (p.mode === 'interval') {
    var s = toMin(p.first);
    if (isNaN(s)) return out;
    var gap = Math.max(1, Math.round(+p.interval || 15));
    var e = toMin(p.until);
    if (isNaN(e) || e < s) e = s + Math.max(60, gap * 8);
    for (var t = s; t <= e && out.length < 400; t += gap) out.push(t);
  } else {
    (p.times || []).forEach(function (x) {
      var m = toMin(x);
      if (!isNaN(m)) out.push(m);
    });
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

/* ============ 步行时间 ============ */
function walkInfo(p) {
  if (!state.me || !p || !p.stop) return null;
  if (state.route && state.route.dur) {
    return { min: state.route.dur / 60, dist: state.route.dist, exact: true };
  }
  var straight = haversine(state.me, p.stop);
  var est = straight * 1.3;
  var sp = +p.speed || 1.25;
  return { min: est / sp / 60, dist: est, exact: false, straight: straight };
}

/* ============ 核心推算 ============ */
function compute(p) {
  var s = {
    status: 'setup', complete: false, dayOk: true, times: [],
    walk: null, target: null, next: null, remaining: null, now: 0, buffer: 0
  };
  if (!p) return s;
  var times = planTimes(p);
  s.times = times;
  s.complete = !!(p.line && p.stop && times.length);
  s.buffer = Math.max(0, +p.buffer || 0);

  var d = new Date();
  var now = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  s.now = now;
  s.dayOk = !!(p.days && p.days[d.getDay()]);
  s.walk = walkInfo(p);

  var i, t, firstUp = null;
  for (i = 0; i < times.length; i++) {
    t = times[i];
    if (t > now) { firstUp = t; break; }
  }
  s.next = firstUp;

  if (!s.complete) { s.status = 'setup'; return s; }
  if (!s.walk) { s.status = 'noloc'; return s; }

  var need = s.walk.min + s.buffer;
  var advance = Math.max(0, +p.advance || 0);
  var GRACE = 3;
  var target = null, leaveAt;
  for (i = 0; i < times.length; i++) {
    t = times[i];
    if (t <= now) continue;
    leaveAt = t - need;
    if (now > leaveAt + GRACE) continue;
    target = { t: t, leaveAt: leaveAt };
    break;
  }
  s.target = target;

  if (!target) { s.status = 'missed'; return s; }
  s.remaining = target.leaveAt - now;
  if (now < target.leaveAt - advance) s.status = 'ok';
  else if (now < target.leaveAt) s.status = 'soon';
  else s.status = 'go';
  return s;
}

/* ============ 地图 ============ */
var TILES = {
  amap: {
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234', maxZoom: 18, attr: '&copy; 高德地图'
  },
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc', maxZoom: 19, attr: '&copy; OpenStreetMap contributors'
  }
};
var map = null, tileLayer = null, meMarker = null, stopMarker = null, routeLine = null, routeDash = null;

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([24.4798, 118.0894], 13, { animate: false });
  setTiles();
  map.on('click', onMapClick);
  window.addEventListener('resize', function () { if (map) map.invalidateSize(); });
}
function setTiles() {
  if (!map) return;
  if (tileLayer) map.removeLayer(tileLayer);
  var t = TILES[state.mapSource] || TILES.amap;
  tileLayer = L.tileLayer(t.url, {
    subdomains: t.subdomains, maxZoom: t.maxZoom, minZoom: 4, attribution: t.attr
  });
  tileLayer.addTo(map);
}
function drawLayers() {
  if (!map) return;
  var p = active();
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (stopMarker) { map.removeLayer(stopMarker); stopMarker = null; }
  if (state.me) {
    meMarker = L.marker(toMap(state.me.lat, state.me.lng), {
      icon: L.divIcon({ className: '', html: '<div class="dot-me"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false, keyboard: false, zIndexOffset: 600
    }).addTo(map);
  }
  if (p && p.stop) {
    stopMarker = L.marker(toMap(p.stop.lat, p.stop.lng), {
      icon: L.divIcon({ className: '', html: '<div class="pin-stop"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      interactive: false, keyboard: false
    }).addTo(map);
  }
  drawRoute();
}
function drawRoute() {
  if (!map) return;
  var p = active();
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeDash) { map.removeLayer(routeDash); routeDash = null; }
  if (!state.me || !p || !p.stop) return;
  var pts;
  if (state.route && state.route.coords && state.route.coords.length) {
    pts = state.route.coords.map(function (c) { return toMap(c[1], c[0]); });
  } else {
    pts = [toMap(state.me.lat, state.me.lng), toMap(p.stop.lat, p.stop.lng)];
  }
  routeLine = L.polyline(pts, {
    color: state.route ? '#0F5C4E' : '#7C8A82',
    weight: 3, opacity: state.route ? 0.9 : 0.5,
    dashArray: state.route ? null : '7 7', lineJoin: 'round', interactive: false
  }).addTo(map);
  if (state.route) {
    routeDash = L.polyline(pts, {
      color: '#6FD0B6', weight: 3, opacity: 0.85,
      dashArray: '4 18', lineJoin: 'round', interactive: false, className: 'route-dash'
    }).addTo(map);
  }
}
var fitted = false;
function fitAll() {
  if (!map) return;
  var p = active(), pts = [];
  if (state.me) pts.push(toMap(state.me.lat, state.me.lng));
  if (p && p.stop) pts.push(toMap(p.stop.lat, p.stop.lng));
  if (pts.length === 1) { map.setView(pts[0], 16, { animate: false }); fitted = true; return; }
  if (pts.length === 2) {
    map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 16, animate: false });
    fitted = true;
  }
}
function onMapClick(e) {
  if (!state.picking) return;
  var ll = e.latlng;
  var w = state.mapSource === 'amap' ? gcjToWgs(ll.lat, ll.lng) : { lat: ll.lat, lng: ll.lng };
  var p = active();
  if (!p) return;
  if (state.picking === 'stop') {
    p.stop = { lat: w.lat, lng: w.lng };
    state.route = null; state.routeKey = '';
    save(); drawLayers(); updateStopPos(); refreshRoute(true); paint(); tick();
    toast('上车站位置已记录');
    tryReverseName(w);
  } else if (state.picking === 'me') {
    state.me = { lat: w.lat, lng: w.lng };
    state.geoErr = null;
    state.route = null; state.routeKey = '';
    drawLayers(); refreshRoute(true); paint(); tick();
    toast('已把你标记在这里');
  }
  endPick();
}
function startPick(mode) {
  if (!map) return;
  state.picking = mode;
  $('mapWrap').classList.add('picking');
  $('pickHint').textContent = mode === 'stop' ? '在地图上点一下，标出你的上车站' : '在地图上点一下，标出你当前的位置';
  $('pickHint').classList.add('show');
  map.invalidateSize();
  if (window.innerWidth <= 960) {
    try { $('mapWrap').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
  }
}
function endPick() {
  state.picking = null;
  $('mapWrap').classList.remove('picking');
  $('pickHint').classList.remove('show');
}

/* ============ 步行路线（OSRM 公共步行服务，取不到就估算） ============ */
var routeSeq = 0;
function routeKeyNow() {
  var p = active();
  if (!state.me || !p || !p.stop) return '';
  return [
    Math.round(state.me.lat * 1000 / 2), Math.round(state.me.lng * 1000 / 2),
    Math.round(p.stop.lat * 1e4), Math.round(p.stop.lng * 1e4)
  ].join('|');
}
function refreshRoute(force) {
  var p = active();
  if (!state.me || !p || !p.stop) return;
  var key = routeKeyNow();
  if (!force && key === state.routeKey) return;
  if (!force && Date.now() - state.routeAt < 45000) return;
  state.routeKey = key;
  state.routeAt = Date.now();
  var seq = ++routeSeq;
  osrm(state.me, p.stop).then(function (r) {
    if (seq !== routeSeq) return;
    state.route = r || null;
    drawRoute();
    updateStopPos();
    paint();
  });
}
function osrm(a, b) {
  var url = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/' +
    a.lng.toFixed(6) + ',' + a.lat.toFixed(6) + ';' +
    b.lng.toFixed(6) + ',' + b.lat.toFixed(6) + '?overview=full&geometries=geojson';
  var ctrl = null, timer = null;
  try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
  if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 6000);
  return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
    if (timer) clearTimeout(timer);
    if (!r.ok) return null;
    return r.json();
  }).then(function (j) {
    if (!j || !j.routes || !j.routes.length) return null;
    var r = j.routes[0];
    return {
      dist: r.distance, dur: r.duration,
      coords: (r.geometry && r.geometry.coordinates) || []
    };
  }).catch(function () {
    if (timer) clearTimeout(timer);
    return null;
  });
}
function tryReverseName(w) {
  var p = active();
  if (!p || p.stopName) return;
  var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=zh-CN&lat=' +
    w.lat.toFixed(6) + '&lon=' + w.lng.toFixed(6);
  var ctrl = null, timer = null;
  try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
  if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 5000);
  fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
    if (timer) clearTimeout(timer);
    return r.json();
  }).then(function (j) {
    if (!j) return;
    var p2 = active();
    if (!p2 || p2.stopName) return;
    var nm = j.name || (j.address && (j.address.bus_stop || j.address.road || j.address.neighbourhood)) || '';
    if (nm) {
      p2.stopName = nm;
      $('fStopName').value = nm;
      save(); paint();
    }
  }).catch(function () { if (timer) clearTimeout(timer); });
}

/* ============ 定位 ============ */
var watchId = null;
function startGeo() {
  if (!navigator.geolocation) {
    state.geoErr = '这台设备不支持定位，请在地图上手动标出你的位置。';
    paint();
    return;
  }
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onPos, onGeoErr, {
    enableHighAccuracy: true, timeout: 20000, maximumAge: 10000
  });
}
function onPos(pos) {
  var c = pos.coords;
  state.me = { lat: c.latitude, lng: c.longitude };
  state.acc = c.accuracy;
  state.geoErr = null;
  drawLayers();
  if (!fitted) fitAll();
  refreshRoute(false);
  updateStopPos();
  paint();
}
function onGeoErr(err) {
  state.geoErr = err.code === 1
    ? '定位权限被拒绝。请在地址栏允许定位，或点地图手动标出你的位置。'
    : (err.code === 2 ? '暂时拿不到位置，会自动重试；也可以在地图上手动标出你的位置。'
      : '定位超时，会自动重试；也可以在地图上手动标出你的位置。');
  paint();
}

/* ============ 渲染 ============ */
function markStep(id, ok, text) {
  var li = $(id);
  if (!li) return;
  li.classList.toggle('done', !!ok);
  var em = li.querySelector('em');
  if (em) em.textContent = text;
}
function setNotice(text, isRed) {
  var n = $('notice');
  if (!text) { n.classList.remove('show'); n.textContent = ''; return; }
  n.textContent = text;
  n.classList.add('show');
  n.classList.toggle('red', !!isRed);
}
function updateStopPos() {
  var p = active(), el = $('stopPos');
  if (!el) return;
  if (!p || !p.stop) { el.textContent = '尚未设置上车位置'; return; }
  var txt = '已设置：' + p.stop.lat.toFixed(5) + ', ' + p.stop.lng.toFixed(5);
  if (state.me) txt += ' · 直线距离 ' + Math.round(haversine(state.me, p.stop)) + ' 米';
  el.textContent = txt;
}
function setChip() {
  var chip = $('statusChip');
  chip.classList.toggle('on', state.monitoring);
  $('chipText').textContent = state.monitoring ? '监控中' : '未开始监控';
}
/* 数字逐位滚动：只让变了的那几位翻进来 */
function setCount(text, cn) {
  var el = $('countMain');
  if (el.dataset.val === text) return;
  var prev = el.dataset.val || '';
  var first = prev === '';
  el.dataset.val = text;
  el.classList.toggle('cn', !!cn);
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var colon = text.indexOf(':'), i, c, sp;
  el.textContent = '';
  for (i = 0; i < text.length; i++) {
    c = text.charAt(i);
    sp = document.createElement('span');
    sp.className = 'd' + (c === ':' ? ' sep' : '');
    sp.textContent = c;
    el.appendChild(sp);
    var moved = prev.charAt(i) !== c && (colon < 0 || i < colon);
    if (!reduced && !first && moved && sp.animate) {
      sp.animate(
        [{ opacity: 0, transform: 'translateY(-.24em)' }, { opacity: 1, transform: 'none' }],
        { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' }
      );
    }
  }
}
function renderNext(s) {
  var el = $('nextList'), html = '', i, t, n = 0;
  var activeT = s.target ? s.target.t : null;
  for (i = 0; i < s.times.length && n < 4; i++) {
    t = s.times[i];
    if (t <= s.now) continue;
    html += '<span class="nb' + (t === activeT ? ' on' : '') + '">' + fmtMin(t) + '</span>';
    n++;
  }
  if (!html) html = '<span class="nb empty">今天没有后续班次</span>';
  if (el.innerHTML !== html) el.innerHTML = html;
}
function setSettings(open) {
  var box = $('settingsBox'), head = $('settingsToggle');
  if (box) box.classList.toggle('open', !!open);
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function paint() {
  var p = active();
  if (!p) return;
  var s = compute(p);
  current = s;
  document.body.dataset.status = s.status;

  var times = s.times;
  markStep('step1', !!p.line, p.line || '还没填，例如 959路');
  markStep('step2', !!p.stop, p.stop ? ('已选 ' + p.stop.lat.toFixed(4) + ', ' + p.stop.lng.toFixed(4)) : '在地图上点选你的上车站');
  markStep('step3', times.length > 0, times.length ? ('共 ' + times.length + ' 班，首班 ' + fmtMin(times[0]) + ' 到站') : '例如 07:02、07:18、07:34');

  $('setupCard').hidden = s.complete;
  var hero = $('heroCard');
  hero.hidden = !s.complete;
  $('statsRow').hidden = !s.complete;
  updateStopPos();
  setChip();

  if (!s.complete) { setNotice('', false); return; }

  if (!hero.dataset.entered) {
    hero.dataset.entered = '1';
    var bd = document.querySelector('.board');
    if (bd) {
      requestAnimationFrame(function () { bd.classList.add('in'); });
      bd.addEventListener('animationend', function () { bd.classList.remove('in'); }, { once: true });
    }
  }

  var t = s.target;
  var showT = t ? t.t : s.next;
  var walk = s.walk;
  var arriveTxt = (showT !== null && showT !== undefined) ? fmtMin(showT) : '--:--';

  $('heroLine').textContent = p.line || '线路';
  $('heroDesc').textContent = arriveTxt + ' 到 · ' + (p.stopName || '上车站') +
    (walk ? ' · 步行约 ' + Math.round(walk.min) + ' 分钟' : '');

  var big = '', label = '', stateText = '', cn = false;
  if (s.status === 'noloc') {
    big = (s.next !== null && s.next !== undefined) ? fmtMin(s.next) : '--:--';
    label = '下一班到站 · 正在获取你的位置';
    stateText = '定位中';
  } else if (s.status === 'ok') {
    big = fmtCountdown(s.remaining); label = '距离必须出门'; stateText = '时间充裕';
  } else if (s.status === 'soon') {
    big = fmtCountdown(s.remaining); label = '距离必须出门'; stateText = '准备出门';
  } else if (s.status === 'go') {
    big = '现在出发'; label = '公交 ' + fmtMin(t.t) + ' 到站，别磨蹭'; stateText = '该走了'; cn = true;
  } else if (s.status === 'missed') {
    big = s.next !== null ? fmtMin(s.next) : '--:--';
    label = s.next !== null ? '下一班到站 · 这一班赶不上了' : '今天没有后续班次了';
    stateText = s.next !== null ? '错过一班' : '收班了';
  } else {
    big = '--:--'; label = '还没设置班次'; stateText = '待设置';
  }
  setCount(big, cn);
  $('countLabel').textContent = label;
  $('stateText').textContent = stateText;

  var waitMin = (t && s.status !== 'missed') ? Math.max(0, t.leaveAt - s.now) : 0;
  var walkMin = walk ? walk.min : 0;
  var bufMin = s.buffer;
  var totalMin = waitMin + walkMin + bufMin;
  if (totalMin <= 0) totalMin = 1;
  $('segWait').style.width = (waitMin / totalMin * 100) + '%';
  $('segWalk').style.width = (walkMin / totalMin * 100) + '%';
  $('segBuf').style.width = (bufMin / totalMin * 100) + '%';
  $('tlKnob').style.left = (waitMin / totalMin * 100) + '%';
  $('tlArrive').textContent = arriveTxt;
  $('lgWait').textContent = '等待 ' + Math.round(waitMin) + ' 分';
  $('lgWalk').textContent = '步行 ' + Math.round(walkMin) + ' 分';
  $('lgBuf').textContent = '缓冲 ' + Math.round(bufMin) + ' 分';

  $('stArrive').textContent = arriveTxt;
  $('stArriveSub').textContent = (showT !== null && showT !== undefined)
    ? ('还有 ' + Math.max(0, Math.round(showT - s.now)) + ' 分钟') : '今天没有后续班次';
  $('stWalk').innerHTML = walk ? (Math.round(walk.min) + '<small>分</small>') : '--<small>分</small>';
  $('stWalkSub').textContent = walk
    ? (Math.round(walk.dist) + ' 米 · ' + (walk.exact ? '实际路线' : '直线估算'))
    : '还没定位';
  $('stLeave').textContent = t ? fmtMin(t.leaveAt) : '--:--';
  $('stLeaveSub').textContent = '含预留 ' + Math.round(s.buffer) + ' 分钟';
  renderNext(s);

  /* 提示条 */
  var notes = [];
  if (state.geoErr) notes.push(state.geoErr);
  else if (s.status === 'noloc') notes.push('正在获取你的位置。如果一直没反应，请允许定位权限，或在地图上手动标出你的位置。');
  if (s.status === 'offday' || !s.dayOk) notes.push('今天不在你设置的提醒日，不会主动弹提醒。');
  if (s.status === 'missed' && s.next === null && times.length) notes.push('今天的班次都过完了，明天再见。');
  setNotice(notes.join(' '), !!state.geoErr);
}

/* ============ 声音与通知 ============ */
var actx = null;
function ensureAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { actx = null; }
  return actx;
}
function beep(times, force) {
  var p = active();
  if (!force && p && p.sound === false) return;
  var ctx = ensureAudio();
  if (!ctx) return;
  var n = times || 1;
  for (var i = 0; i < n; i++) {
    var t0 = ctx.currentTime + i * 0.58;
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(940, t0);
    osc.frequency.setValueAtTime(700, t0 + 0.16);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.25, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.44);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.48);
  }
}
function notify(title, body) {
  var p = active();
  if (p && p.notify === false) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body: body, tag: 'gds-' + dayStamp() }); } catch (e) { }
}
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
}

/* ============ 提醒 ============ */
function fireAlert(p, s) {
  $('alertTitle').textContent = '现在出发';
  $('alertTime').textContent = p.line + ' · ' + fmtMin(s.target.t) + ' 到 ' + (p.stopName || '上车站');
  $('alertDetail').innerHTML =
    '步行约 ' + Math.round(s.walk.min) + ' 分钟，预留 ' + Math.round(s.buffer) + ' 分钟<br>现在出门，刚刚好赶上';
  $('alertBox').classList.add('show');
  beep(3);
  notify('该出发了', p.line + ' ' + fmtMin(s.target.t) + ' 到 ' + (p.stopName || '上车站') + '，现在出门');
}
function checkAlerts(p, s) {
  if (!state.monitoring || !s.complete) return;
  if (!s.dayOk) return;
  if (s.status === 'go' && s.target) {
    var key = dayStamp() + '|' + s.target.t + '|go';
    if (state.alertKey === key) return;
    state.alertKey = key;
    fireAlert(p, s);
  } else if (s.status === 'soon' && s.target) {
    var k2 = dayStamp() + '|' + s.target.t + '|soon';
    if (state.soonKey === k2) return;
    state.soonKey = k2;
    var left = Math.max(0, Math.round(s.remaining));
    toast('还有 ' + left + ' 分钟该出门了');
    beep(1);
    notify('准备出门', '距离必须出门还有 ' + left + ' 分钟');
  }
}

/* ============ 表单 ============ */
function updateModeUI() {
  var m = $('fMode').value;
  $('wrapTimes').hidden = m !== 'list';
  $('wrapInterval').hidden = m !== 'interval';
}
function syncForm() {
  var p = active();
  if (!p) return;
  $('fName').value = p.name || '';
  $('fLine').value = p.line || '';
  $('fStopName').value = p.stopName || '';
  $('fMode').value = p.mode === 'interval' ? 'interval' : 'list';
  $('fTimes').value = (p.times || []).join(', ');
  $('fFirst').value = p.first || '07:00';
  $('fInterval').value = p.interval || 15;
  $('fUntil').value = p.until || '09:00';
  $('fSpeed').value = String(p.speed || 1.25);
  $('fBuffer').value = p.buffer;
  $('fAdvance').value = p.advance;
  var boxes = document.querySelectorAll('.daybox');
  for (var i = 0; i < boxes.length; i++) {
    boxes[i].checked = !!(p.days && p.days[+boxes[i].value]);
  }
  $('fSound').checked = p.sound !== false;
  $('fNotify').checked = p.notify !== false;
  $('fMap').value = state.mapSource;
  updateModeUI();
  updateStopPos();
  syncPlanSelect();
}
function readForm() {
  var p = active();
  if (!p) return;
  p.name = $('fName').value.trim() || '未命名方案';
  p.line = $('fLine').value.trim();
  p.stopName = $('fStopName').value.trim();
  p.mode = $('fMode').value === 'interval' ? 'interval' : 'list';
  p.times = $('fTimes').value.split(/[\s,，、;；]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return x.length > 0; });
  p.first = $('fFirst').value || '07:00';
  p.interval = Math.max(1, +($('fInterval').value || 15));
  p.until = $('fUntil').value || '09:00';
  p.speed = +($('fSpeed').value || 1.25);
  p.buffer = Math.max(0, +($('fBuffer').value || 0));
  p.advance = Math.max(0, +($('fAdvance').value || 0));
  var days = [false, false, false, false, false, false, false];
  var boxes = document.querySelectorAll('.daybox');
  for (var i = 0; i < boxes.length; i++) days[+boxes[i].value] = boxes[i].checked;
  p.days = days;
  p.sound = $('fSound').checked;
  p.notify = $('fNotify').checked;
  state.mapSource = $('fMap').value === 'osm' ? 'osm' : 'amap';
}
function syncPlanSelect() {
  var sel = $('planSelect'), html = '';
  state.plans.forEach(function (p) {
    html += '<option value="' + esc(p.id) + '">' + esc(p.name || '未命名') + '</option>';
  });
  sel.innerHTML = html;
  sel.value = state.activeId;
}

/* ============ 交互绑定 ============ */
function bind() {
  $('planSelect').addEventListener('change', function () {
    state.activeId = this.value;
    save();
    state.route = null; state.routeKey = '';
    syncForm();
    drawLayers();
    refreshRoute(true);
    tick();
  });

  $('btnNewPlan').addEventListener('click', function () {
    var n = newPlan('新方案');
    state.plans.push(n);
    state.activeId = n.id;
    save();
    syncForm();
    state.route = null; state.routeKey = '';
    drawLayers();
    tick();
    setSettings(true);
    $('fName').focus();
    $('fName').select();
  });

  $('settingsToggle').addEventListener('click', function () {
    setSettings(!$('settingsBox').classList.contains('open'));
  });

  Array.prototype.slice.call(document.querySelectorAll('[data-goto]')).forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-goto');
      setSettings(true);
      setTimeout(function () {
        var el = $(id);
        if (!el) return;
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
        el.focus();
      }, 240);
    });
  });

  $('btnPickFromStep').addEventListener('click', function () { startPick('stop'); });
  $('btnPickStop').addEventListener('click', function () { startPick('stop'); });
  $('pickHint').addEventListener('click', function () { endPick(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.picking) endPick();
  });

  $('btnUseMe').addEventListener('click', function () {
    var p = active();
    if (!state.me) { toast('还没定位到，先允许定位，或在地图上点选'); startPick('me'); return; }
    p.stop = { lat: state.me.lat, lng: state.me.lng };
    if (!p.stopName) p.stopName = '我的位置';
    state.route = null; state.routeKey = '';
    save(); drawLayers(); updateStopPos(); refreshRoute(true); tick();
    toast('已用当前位置作为上车站');
  });

  $('fMode').addEventListener('change', updateModeUI);

  $('btnSave').addEventListener('click', function () {
    var prevMap = state.mapSource;
    readForm();
    var p = active();
    var bad = (p.times || []).filter(function (x) { return isNaN(toMin(x)); });
    if (p.mode === 'list' && bad.length) {
      toast('这些时刻看不懂：' + bad.slice(0, 3).join('、') + '，请写成 07:02 这样');
      return;
    }
    if (p.mode === 'interval' && isNaN(toMin(p.first))) {
      toast('首班时间格式不对');
      return;
    }
    save();
    if (state.mapSource !== prevMap) { setTiles(); state.route = null; state.routeKey = ''; }
    syncForm();
    drawLayers();
    refreshRoute(true);
    setSettings(false);
    tick();
    toast('已保存');
  });

  $('btnDelete').addEventListener('click', function () {
    if (state.plans.length <= 1) { toast('至少保留一个方案'); return; }
    if (!window.confirm('删除「' + (active().name || '这个方案') + '」？')) return;
    var idx = 0;
    for (var i = 0; i < state.plans.length; i++) if (state.plans[i].id === state.activeId) idx = i;
    state.plans.splice(idx, 1);
    state.activeId = state.plans[0].id;
    state.route = null; state.routeKey = '';
    save(); syncForm(); drawLayers(); tick();
  });

  $('btnStart').addEventListener('click', toggleMonitor);
  $('btnTest').addEventListener('click', function () {
    var p = active();
    if (!p || !p.line) { toast('先填好线路再试'); setSettings(true); return; }
    ensureAudio();
    $('alertTitle').textContent = '现在出发';
    $('alertTime').textContent = p.line + ' · 提醒效果预览';
    $('alertDetail').textContent = '这是提醒效果预览，不会真的打扰你';
    $('alertBox').classList.add('show');
    beep(3, true);
  });

  $('btnAlertOk').addEventListener('click', function () {
    $('alertBox').classList.remove('show');
  });
  $('btnAlertStop').addEventListener('click', function () {
    $('alertBox').classList.remove('show');
    if (state.monitoring) toggleMonitor();
  });
}

function toggleMonitor() {
  var p = active();
  var btn = $('btnStart');
  if (!state.monitoring) {
    if (!p || !p.line || !p.stop || !planTimes(p).length) {
      toast('先把线路、上车站和班次时刻填好');
      setSettings(true);
      return;
    }
    state.monitoring = true;
    ensureAudio();
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) { }
    }
    startGeo();
    refreshRoute(true);
    btn.textContent = '停止监控';
    btn.classList.remove('primary');
    btn.classList.add('ghost');
    toast('已开始监控，到点会提醒你');
  } else {
    state.monitoring = false;
    btn.textContent = '开始监控';
    btn.classList.add('primary');
    btn.classList.remove('ghost');
    toast('已停止监控');
  }
  setChip();
  tick();
}

function tick() {
  paint();
  var p = active();
  if (p && current) checkAlerts(p, current);
}

/* ============ 启动 ============ */
function boot() {
  load();
  initMap();
  syncForm();
  lastMapSource = state.mapSource;
  drawLayers();
  bind();
  paint();
  startGeo();
  if (active() && active().stop) setTimeout(function () { fitAll(); }, 300);
  setInterval(tick, 1000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
