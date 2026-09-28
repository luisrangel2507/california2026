/* ─────────────────────────────────────────────────────────────────────────
   Personajes 3D (estilo avatar de consola) — Alta Vibra Travel

   Cada viajero tiene un monito 3D: cabezón, con pelo, ropa y accesorio a
   elegir. Si no ha armado el suyo, se le genera uno a partir de su nombre
   (siempre el mismo para el mismo nombre).

   API (window.Avatar3D):
     OPTIONS                      catálogo de opciones para el editor
     defaultFor(nombre)           personaje generado a partir del nombre
     normalize(cfg)               completa/limpia una configuración
     faceUrl(cfg) / bodyUrl(cfg)  imagen (dataURL) si ya está lista; si no,
                                  devuelve null y la genera en segundo plano
     onReady(fn)                  avisa cuando hay imágenes nuevas listas
     mountViewer(el, cfg)         personaje en vivo (gira con el dedo,
                                  respira, parpadea y saluda al tocarlo)

   three.js se carga solo la primera vez que hace falta (/vendor).
   ───────────────────────────────────────────────────────────────────────── */
(function(){
  'use strict';

  var OPTIONS = {
    skin: ['#FFE0C7', '#F5C9A6', '#E8B48A', '#C98E62', '#A86B45', '#7A4A2E', '#5A3520'],
    hair: [
      { id: 'corto',   label: 'Corto' },
      { id: 'picos',   label: 'Picos' },
      { id: 'largo',   label: 'Largo' },
      { id: 'coleta',  label: 'Coleta' },
      { id: 'chongo',  label: 'Chongo' },
      { id: 'afro',    label: 'Afro' },
      { id: 'pelon',   label: 'Pelón' },
    ],
    hairColor: ['#1E1612', '#3B2618', '#6B4226', '#A8673A', '#E0B46C', '#C0392B', '#E8E4DC', '#5B7CFA', '#FF6FB5'],
    shirt: ['#00C8FF', '#FF6A50', '#00E598', '#F5A623', '#B983FF', '#FF4FA3', '#FFFFFF', '#23252E', '#2F6BFF', '#E63946'],
    pants: ['#2B3A55', '#1F1F24', '#6B5B45', '#D9CBB0', '#3E6B48', '#7A7F8C'],
    shoes: ['#FFFFFF', '#1F1F24', '#FF6A50', '#00C8FF', '#F5A623'],
    acc: [
      { id: 'ninguno',   label: 'Nada' },
      { id: 'gorra',     label: 'Gorra' },
      { id: 'lentes',    label: 'Lentes de sol' },
      { id: 'sombrero',  label: 'Sombrero' },
      { id: 'audifonos', label: 'Audífonos' },
      { id: 'gorro',     label: 'Gorro' },
    ],
    accColor: ['#E63946', '#1F1F24', '#F5A623', '#00C8FF', '#FFFFFF', '#3E6B48'],
  };
  var HAIR_IDS = OPTIONS.hair.map(function(h){ return h.id; });
  var ACC_IDS = OPTIONS.acc.map(function(a){ return a.id; });

  function hash(str){
    var h = 2166136261;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function pick(list, n){ return list[n % list.length]; }

  function defaultFor(name){
    var h = hash(name);
    var r = function(k){ return (h >>> k) ^ (h >>> (k + 7)); };
    return {
      skin: pick(OPTIONS.skin.slice(0, 6), r(1)),
      hair: pick(['corto', 'picos', 'largo', 'coleta', 'chongo', 'afro', 'corto', 'largo'], r(3)),
      hairColor: pick(OPTIONS.hairColor.slice(0, 6), r(5)),
      shirt: pick(OPTIONS.shirt, r(7)),
      pants: pick(OPTIONS.pants, r(9)),
      shoes: pick(OPTIONS.shoes, r(11)),
      acc: pick(['ninguno', 'ninguno', 'gorra', 'lentes', 'ninguno', 'audifonos', 'sombrero', 'gorro'], r(13)),
      accColor: pick(OPTIONS.accColor, r(15)),
    };
  }

  var HEX = /^#[0-9a-fA-F]{6}$/;
  function normalize(cfg, name){
    var d = defaultFor(name);
    cfg = cfg && typeof cfg === 'object' ? cfg : {};
    var out = {};
    ['skin', 'hairColor', 'shirt', 'pants', 'shoes', 'accColor'].forEach(function(k){
      out[k] = HEX.test(cfg[k]) ? cfg[k] : d[k];
    });
    out.hair = HAIR_IDS.indexOf(cfg.hair) !== -1 ? cfg.hair : d.hair;
    out.acc = ACC_IDS.indexOf(cfg.acc) !== -1 ? cfg.acc : d.acc;
    return out;
  }
  function keyOf(cfg){
    return [cfg.skin, cfg.hair, cfg.hairColor, cfg.shirt, cfg.pants, cfg.shoes, cfg.acc, cfg.accColor].join('|');
  }

  // ── Carga de three.js ──────────────────────────────────────────────────
  var threePromise = null;
  function loadThree(){
    if (window.THREE) return Promise.resolve(window.THREE);
    if (threePromise) return threePromise;
    threePromise = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = '/vendor/three.min.js';
      s.async = true;
      s.onload = function(){ window.THREE ? resolve(window.THREE) : reject(new Error('three')); };
      s.onerror = function(){ threePromise = null; reject(new Error('three')); };
      document.head.appendChild(s);
    });
    return threePromise;
  }
  function webglOk(){
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  // ── Modelo ─────────────────────────────────────────────────────────────
  function mat(T, color, extra){
    return new T.MeshStandardMaterial(Object.assign({ color: color, roughness: 0.62, metalness: 0.02 }, extra || {}));
  }
  function shade(hex, f){
    var n = parseInt(hex.slice(1), 16);
    var r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    var g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    var b = Math.min(255, Math.round((n & 255) * f));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // Devuelve { root, parts } — parts tiene lo que se anima (brazos, ojos...)
  function buildCharacter(T, cfg){
    var root = new T.Group();
    var parts = {};
    var skin = mat(T, cfg.skin);
    var shirt = mat(T, cfg.shirt);
    var pants = mat(T, cfg.pants);
    var shoes = mat(T, cfg.shoes, { roughness: 0.45 });
    var hairM = mat(T, cfg.hairColor, { roughness: 0.8 });
    var accM = mat(T, cfg.accColor, { roughness: 0.5 });
    var dark = mat(T, '#1B1512', { roughness: 0.3 });
    var white = mat(T, '#FFFFFF', { roughness: 0.25 });

    var body = new T.Group();
    root.add(body);
    parts.body = body;

    // Piernas y tenis
    [-1, 1].forEach(function(s){
      var leg = new T.Mesh(new T.CapsuleGeometry(0.15, 0.42, 6, 16), pants);
      leg.position.set(0.17 * s, 0.46, 0);
      body.add(leg);
      var shoe = new T.Mesh(new T.CapsuleGeometry(0.13, 0.16, 6, 12), shoes);
      shoe.rotation.x = Math.PI / 2;
      shoe.scale.set(1.05, 1, 0.75);
      shoe.position.set(0.17 * s, 0.1, 0.07);
      body.add(shoe);
    });

    // Torso
    var torso = new T.Mesh(new T.CapsuleGeometry(0.36, 0.34, 8, 24), shirt);
    torso.scale.set(1.05, 1, 0.78);
    torso.position.y = 1.08;
    body.add(torso);
    // Cuello de la playera
    var collar = new T.Mesh(new T.TorusGeometry(0.15, 0.035, 8, 20), mat(T, shade(cfg.shirt, 0.82)));
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 1.52;
    body.add(collar);

    // Brazos (con pivote en el hombro para poder animarlos)
    parts.arms = [];
    [-1, 1].forEach(function(s){
      var pivot = new T.Group();
      pivot.position.set(0.44 * s, 1.43, 0);
      var arm = new T.Mesh(new T.CapsuleGeometry(0.105, 0.38, 6, 16), shirt);
      arm.position.y = -0.3;
      pivot.add(arm);
      var hand = new T.Mesh(new T.SphereGeometry(0.115, 16, 12), skin);
      hand.position.y = -0.6;
      pivot.add(hand);
      pivot.rotation.z = 0.14 * s;
      body.add(pivot);
      parts.arms.push(pivot);
    });

    // Cuello
    var neck = new T.Mesh(new T.CylinderGeometry(0.1, 0.12, 0.16, 16), skin);
    neck.position.y = 1.6;
    body.add(neck);

    // Cabeza (grande, estilo chibi)
    var head = new T.Group();
    head.position.y = 2.12;
    body.add(head);
    parts.head = head;
    var skull = new T.Mesh(new T.SphereGeometry(0.5, 40, 28), skin);
    skull.scale.set(1, 1.03, 0.96);
    head.add(skull);

    // Orejas
    [-1, 1].forEach(function(s){
      var ear = new T.Mesh(new T.SphereGeometry(0.1, 16, 12), skin);
      ear.scale.set(0.55, 1, 0.8);
      ear.position.set(0.49 * s, -0.02, 0);
      head.add(ear);
    });

    // Ojos (blanco + pupila + brillo) — se escalan para parpadear
    parts.eyes = [];
    [-1, 1].forEach(function(s){
      var eye = new T.Group();
      eye.position.set(0.165 * s, 0.04, 0.42);
      var w = new T.Mesh(new T.SphereGeometry(0.09, 20, 16), white);
      w.scale.set(1, 1.12, 0.55);
      eye.add(w);
      var p = new T.Mesh(new T.SphereGeometry(0.055, 16, 12), dark);
      p.position.set(0, -0.005, 0.04);
      p.scale.set(1, 1.1, 0.6);
      eye.add(p);
      var gl = new T.Mesh(new T.SphereGeometry(0.017, 8, 8), white);
      gl.position.set(0.022, 0.03, 0.075);
      eye.add(gl);
      head.add(eye);
      parts.eyes.push(eye);
      // Ceja
      var brow = new T.Mesh(new T.CapsuleGeometry(0.018, 0.1, 4, 8), hairM);
      brow.rotation.z = Math.PI / 2 + 0.12 * s;
      brow.position.set(0.17 * s, 0.2, 0.45);
      head.add(brow);
    });

    // Nariz, cachetes y sonrisa
    var nose = new T.Mesh(new T.SphereGeometry(0.048, 16, 12), mat(T, shade(cfg.skin, 0.93)));
    nose.position.set(0, -0.06, 0.49);
    head.add(nose);
    [-1, 1].forEach(function(s){
      var cheek = new T.Mesh(new T.CircleGeometry(0.065, 20), new T.MeshBasicMaterial({ color: '#FF8A80', transparent: true, opacity: 0.35 }));
      cheek.position.set(0.28 * s, -0.1, 0.405);
      cheek.lookAt(0.28 * s * 3, -0.1, 3);
      head.add(cheek);
    });
    var smile = new T.Mesh(new T.TorusGeometry(0.1, 0.022, 8, 24, Math.PI), mat(T, '#7A2E2A', { roughness: 0.4 }));
    smile.rotation.z = Math.PI;
    smile.position.set(0, -0.16, 0.455);
    smile.scale.set(1, 0.75, 1);
    head.add(smile);

    addHair(T, head, cfg.hair, hairM);
    addAccessory(T, head, cfg.acc, accM, dark);

    // Sombra suave en el piso
    var shadowTex = shadowTexture(T);
    var shadow = new T.Mesh(new T.PlaneGeometry(1.6, 1.6), new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    root.add(shadow);

    return { root: root, parts: parts };
  }

  // Casquete de esfera: la parte de arriba de la cabeza, un poco inclinada
  // hacia atrás para cubrir la nuca y dejar la frente libre.
  function hairCap(T, m, r, cover, tilt){
    var g = new T.SphereGeometry(r, 40, 20, 0, Math.PI * 2, 0, Math.PI * cover);
    var mesh = new T.Mesh(g, m);
    mesh.rotation.x = -tilt;
    return mesh;
  }
  function addHair(T, head, style, m){
    if (style === 'pelon') return;
    if (style === 'afro') {
      var afro = new T.Mesh(new T.IcosahedronGeometry(0.66, 2), m);
      afro.material = m.clone(); afro.material.flatShading = true;
      afro.position.set(0, 0.16, -0.14);
      head.add(afro);
      return;
    }
    head.add(hairCap(T, m, 0.535, 0.44, 0.42));
    // Fleco
    var fringe = new T.Mesh(new T.SphereGeometry(0.53, 32, 12, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.18, Math.PI * 0.14), m);
    fringe.rotation.x = 0.05;
    head.add(fringe);
    if (style === 'picos') {
      for (var i = 0; i < 9; i++) {
        var a = (i / 9) * Math.PI * 2;
        var spike = new T.Mesh(new T.ConeGeometry(0.12, 0.3, 10), m);
        var rr = i % 2 ? 0.28 : 0.18;
        spike.position.set(Math.cos(a) * rr, 0.5, Math.sin(a) * rr - 0.05);
        spike.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
        head.add(spike);
      }
      var tip = new T.Mesh(new T.ConeGeometry(0.14, 0.38, 10), m);
      tip.position.set(0, 0.62, -0.02);
      head.add(tip);
    }
    if (style === 'largo') {
      var back = new T.Mesh(new T.CapsuleGeometry(0.4, 0.55, 8, 20), m);
      back.scale.set(1.12, 1, 0.5);
      back.position.set(0, -0.32, -0.22);
      head.add(back);
      [-1, 1].forEach(function(s){
        var side = new T.Mesh(new T.CapsuleGeometry(0.1, 0.5, 6, 12), m);
        side.position.set(0.47 * s, -0.25, 0.08);
        head.add(side);
      });
    }
    if (style === 'coleta') {
      var tie = new T.Mesh(new T.TorusGeometry(0.07, 0.03, 8, 16), m.clone());
      tie.material.color.set('#FF4FA3');
      tie.position.set(0, 0.08, -0.55);
      head.add(tie);
      var tail = new T.Mesh(new T.CapsuleGeometry(0.13, 0.42, 8, 16), m);
      tail.position.set(0, -0.2, -0.64);
      tail.rotation.x = 0.35;
      head.add(tail);
    }
    if (style === 'chongo') {
      var bun = new T.Mesh(new T.SphereGeometry(0.2, 24, 16), m);
      bun.position.set(0, 0.56, -0.1);
      head.add(bun);
    }
  }
  function addAccessory(T, head, acc, m, dark){
    if (acc === 'gorra') {
      var cap = hairCap(T, m, 0.555, 0.4, 0.3);
      head.add(cap);
      var visor = new T.Mesh(new T.CylinderGeometry(0.34, 0.34, 0.03, 32, 1, false, -Math.PI / 2, Math.PI), m);
      visor.scale.set(1, 1, 1.25);
      visor.position.set(0, 0.2, 0.36);
      visor.rotation.x = 0.12;
      head.add(visor);
      var btn = new T.Mesh(new T.SphereGeometry(0.04, 12, 8), m);
      btn.position.set(0, 0.555, -0.04);
      head.add(btn);
    }
    if (acc === 'gorro') {
      var beanie = hairCap(T, m, 0.56, 0.47, 0.3);
      head.add(beanie);
      var cuff = new T.Mesh(new T.TorusGeometry(0.47, 0.06, 10, 40), m);
      cuff.rotation.x = Math.PI / 2 - 0.3;
      cuff.position.set(0, 0.13, -0.05);
      head.add(cuff);
      var pom = new T.Mesh(new T.IcosahedronGeometry(0.12, 1), m);
      pom.position.set(0, 0.6, -0.12);
      head.add(pom);
    }
    if (acc === 'sombrero') {
      var straw = new T.MeshStandardMaterial({ color: '#E3C27A', roughness: 0.85 });
      var brim = new T.Mesh(new T.CylinderGeometry(0.88, 0.88, 0.035, 40), straw);
      brim.position.y = 0.32;
      brim.rotation.x = -0.12;
      head.add(brim);
      var crown = new T.Mesh(new T.CylinderGeometry(0.4, 0.46, 0.34, 32), straw);
      crown.position.set(0, 0.5, -0.03);
      crown.rotation.x = -0.12;
      head.add(crown);
      var band = new T.Mesh(new T.CylinderGeometry(0.465, 0.465, 0.07, 32, 1, true), m);
      band.position.set(0, 0.37, -0.02);
      band.rotation.x = -0.12;
      head.add(band);
    }
    if (acc === 'lentes') {
      var lens = new T.MeshStandardMaterial({ color: '#15151C', roughness: 0.15, metalness: 0.4 });
      [-1, 1].forEach(function(s){
        var l = new T.Mesh(new T.CapsuleGeometry(0.075, 0.08, 4, 12), lens);
        l.rotation.z = Math.PI / 2;
        l.scale.set(1, 1, 0.35);
        l.position.set(0.17 * s, 0.05, 0.48);
        head.add(l);
        var arm = new T.Mesh(new T.BoxGeometry(0.02, 0.02, 0.42), lens);
        arm.position.set(0.44 * s, 0.07, 0.25);
        head.add(arm);
      });
      var bridge = new T.Mesh(new T.BoxGeometry(0.09, 0.02, 0.02), lens);
      bridge.position.set(0, 0.08, 0.5);
      head.add(bridge);
    }
    if (acc === 'audifonos') {
      var bandH = new T.Mesh(new T.TorusGeometry(0.56, 0.035, 10, 40, Math.PI), m);
      bandH.position.y = 0.02;
      head.add(bandH);
      [-1, 1].forEach(function(s){
        var cup = new T.Mesh(new T.CylinderGeometry(0.15, 0.15, 0.1, 24), m);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(0.53 * s, 0, 0);
        head.add(cup);
        var pad = new T.Mesh(new T.CylinderGeometry(0.1, 0.1, 0.02, 20), dark);
        pad.rotation.z = Math.PI / 2;
        pad.position.set(0.59 * s, 0, 0);
        head.add(pad);
      });
    }
  }

  var _shadowTex = null;
  function shadowTexture(T){
    if (_shadowTex) return _shadowTex;
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    _shadowTex = new T.CanvasTexture(c);
    return _shadowTex;
  }

  function addLights(T, scene){
    // three r155+ usa luces "físicas": las intensidades van más altas
    scene.add(new T.HemisphereLight(0xffffff, 0x8090b0, 2.3));
    var key = new T.DirectionalLight(0xffffff, 2.6);
    key.position.set(2.5, 4, 4);
    scene.add(key);
    var fill = new T.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-3, 1, 3);
    scene.add(fill);
    var rim = new T.DirectionalLight(0xffb547, 1.8); // contraluz de atardecer
    rim.position.set(-3, 2.5, -3);
    scene.add(rim);
  }

  // ── Imágenes (retrato y cuerpo completo) ──────────────────────────────
  var cache = {};       // key|modo -> dataURL
  var pending = {};
  var queue = [];
  var listeners = [];
  var snapRenderer = null, snapScene = null;
  var notifyTimer = null;

  function onReady(fn){ listeners.push(fn); }
  function notify(){
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function(){ listeners.forEach(function(fn){ try { fn(); } catch (e) {} }); }, 40);
  }

  function snapshot(T, cfg, mode){
    if (!snapRenderer) {
      snapRenderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      snapRenderer.setPixelRatio(1);
      snapScene = new T.Scene();
      addLights(T, snapScene);
    }
    var w = mode === 'face' ? 256 : 240, h = mode === 'face' ? 256 : 360;
    snapRenderer.setSize(w, h, false);
    var ch = buildCharacter(T, cfg);
    if (mode === 'face') ch.root.rotation.y = -0.18;
    else { ch.root.rotation.y = -0.3; ch.parts.arms[1].rotation.z = -0.35; }
    snapScene.add(ch.root);
    var cam = mode === 'face'
      ? new T.PerspectiveCamera(26, 1, 0.1, 50)
      : new T.PerspectiveCamera(28, w / h, 0.1, 50);
    if (mode === 'face') { cam.position.set(0, 2.05, 3.5); cam.lookAt(0, 1.98, 0); }
    else { cam.position.set(0, 1.45, 6.4); cam.lookAt(0, 1.3, 0); }
    snapRenderer.render(snapScene, cam);
    var url = snapRenderer.domElement.toDataURL('image/png');
    snapScene.remove(ch.root);
    ch.root.traverse(function(o){ if (o.geometry) o.geometry.dispose(); });
    return url;
  }

  function pump(){
    if (!queue.length) return;
    loadThree().then(function(T){
      var t0 = performance.now();
      // Unas cuantas por cuadro para no trabar la pantalla
      while (queue.length && performance.now() - t0 < 30) {
        var job = queue.shift();
        try { cache[job.k] = snapshot(T, job.cfg, job.mode); } catch (e) { cache[job.k] = false; }
        delete pending[job.k];
      }
      notify();
      if (queue.length) requestAnimationFrame(pump);
    }).catch(function(){
      // Sin three.js / WebGL: se queda con las iniciales de siempre
      queue.forEach(function(j){ cache[j.k] = false; delete pending[j.k]; });
      queue = [];
    });
  }

  var HAS_GL = null;
  function getUrl(cfg, mode){
    if (HAS_GL === null) HAS_GL = webglOk();
    if (!HAS_GL) return null;
    cfg = normalize(cfg);
    var k = keyOf(cfg) + '|' + mode;
    if (cache[k] !== undefined) return cache[k] || null;
    if (!pending[k]) {
      pending[k] = true;
      queue.push({ k: k, cfg: cfg, mode: mode });
      if (queue.length === 1) requestAnimationFrame(pump);
    }
    return null;
  }

  // ── Visor en vivo ──────────────────────────────────────────────────────
  function mountViewer(el, cfg){
    var api = { update: function(){}, dispose: function(){}, wave: function(){} };
    if (!webglOk()) { el.innerHTML = '<div style="padding:30px;text-align:center;opacity:.6;font-size:13px">Tu teléfono no puede mostrar 3D.</div>'; return api; }
    var disposed = false;
    loadThree().then(function(T){
      if (disposed) return;
      var renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      var canvas = renderer.domElement;
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block'; canvas.style.touchAction = 'pan-y';
      el.innerHTML = '';
      el.appendChild(canvas);
      var scene = new T.Scene();
      addLights(T, scene);
      var cam = new T.PerspectiveCamera(30, 1, 0.1, 50);
      cam.position.set(0, 1.5, 6.6);
      cam.lookAt(0, 1.3, 0);

      var ch = null;
      function setCfg(c){
        if (ch) { scene.remove(ch.root); ch.root.traverse(function(o){ if (o.geometry) o.geometry.dispose(); }); }
        ch = buildCharacter(T, normalize(c));
        ch.root.rotation.y = rotY;
        scene.add(ch.root);
        // Pequeño "pop" al cambiar algo
        popT = 0;
      }
      var rotY = -0.3, velY = 0, dragging = false, lastX = 0, popT = 1, waveT = 1, blinkT = 0, nextBlink = 2;
      setCfg(cfg);

      function resize(){
        var w = el.clientWidth || 300, h = el.clientHeight || 360;
        renderer.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
      resize();
      var ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
      if (ro) ro.observe(el);

      var startX = 0, moved = false;
      canvas.addEventListener('pointerdown', function(e){ dragging = true; moved = false; lastX = startX = e.clientX; try { canvas.setPointerCapture(e.pointerId); } catch (x) {} });
      canvas.addEventListener('pointermove', function(e){
        if (!dragging) return;
        var dx = e.clientX - lastX; lastX = e.clientX;
        if (Math.abs(e.clientX - startX) > 4) moved = true;
        velY = dx * 0.012; rotY += velY;
      });
      var end = function(){ if (dragging && !moved) waveT = 0; dragging = false; };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', function(){ dragging = false; });

      var clock = new T.Clock();
      var raf = 0;
      function tick(){
        if (disposed) return;
        raf = requestAnimationFrame(tick);
        var dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
        if (!dragging) { velY *= 0.93; rotY += velY; rotY += (-0.3 - rotY) * 0.012; }
        var p = ch.parts;
        ch.root.rotation.y = rotY;
        // Respira y se mece
        p.body.position.y = Math.sin(t * 2.2) * 0.025;
        p.body.rotation.z = Math.sin(t * 1.1) * 0.02;
        p.head.rotation.z = Math.sin(t * 0.9) * 0.05;
        p.head.rotation.x = Math.sin(t * 0.7) * 0.03;
        p.arms[0].rotation.z = -0.14 - Math.sin(t * 2.2) * 0.03;
        // Saludo al tocarlo
        if (waveT < 1) {
          waveT = Math.min(1, waveT + dt / 1.6);
          var up = Math.sin(Math.min(waveT * 3, 1) * Math.PI / 2) * (1 - Math.max(0, waveT - 0.8) * 5);
          p.arms[1].rotation.z = 0.14 + up * 2.5;
          p.arms[1].rotation.x = Math.sin(waveT * 30) * 0.25 * up;
        } else {
          p.arms[1].rotation.z = 0.14 + Math.sin(t * 2.2) * 0.03;
          p.arms[1].rotation.x = 0;
        }
        // Parpadeo
        blinkT += dt;
        var sy = 1;
        if (blinkT > nextBlink) { var b = (blinkT - nextBlink) / 0.14; sy = b < 1 ? Math.abs(1 - 2 * b) * 0.9 + 0.1 : 1; if (b >= 1) { blinkT = 0; nextBlink = 2 + Math.random() * 3; } }
        p.eyes.forEach(function(e){ e.scale.y = sy; });
        // Pop al cambiar
        if (popT < 1) { popT = Math.min(1, popT + dt * 3.5); var s = 1 + Math.sin(popT * Math.PI) * 0.06; ch.root.scale.set(s, s, s); }
        renderer.render(scene, cam);
      }
      tick();

      api.update = function(c){ setCfg(c); };
      api.wave = function(){ waveT = 0; };
      api.dispose = function(){
        disposed = true;
        cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e) {}
      };
    }).catch(function(){
      el.innerHTML = '<div style="padding:30px;text-align:center;opacity:.6;font-size:13px">No se pudo cargar el 3D.</div>';
    });
    api.dispose = function(){ disposed = true; };
    return {
      update: function(c){ api.update(c); },
      wave: function(){ api.wave(); },
      dispose: function(){ api.dispose(); },
    };
  }

  window.Avatar3D = {
    OPTIONS: OPTIONS,
    defaultFor: defaultFor,
    normalize: normalize,
    faceUrl: function(cfg){ return getUrl(cfg, 'face'); },
    bodyUrl: function(cfg){ return getUrl(cfg, 'body'); },
    onReady: onReady,
    mountViewer: mountViewer,
    preload: loadThree,
  };
})();
