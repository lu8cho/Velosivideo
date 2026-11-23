// ==UserScript==
// @name         Velocidad Mínima (Móvil)
// @namespace    https://clintbrowser/
// @version      2.0
// @description  Barra compacta para cambiar la velocidad de video/audio: 1x, 2x, 2.5x, 3x
// @author       Tú
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Evita ejecutarse dos veces en el mismo documento
    if (window.__vspMinimal) return;
    try { Object.defineProperty(window, '__vspMinimal', { value: true }); }
    catch (_) { window.__vspMinimal = true; }

    // ---------- Configuración ----------
    const SPEEDS        = [1, 2, 2.5, 3];
    const ACTIVE_COLOR  = '#00e676';   // verde brillante
    const MIN_SECONDS   = 8;           // audios/videos más cortos que esto (sonidos de UI) no muestran la barra
    const SCAN_EVERY_MS = 2500;        // red de seguridad periódica
    const THROTTLE_MS   = 60;          // máx. 1 actualización cada 60 ms
    const MSG_KEY       = '__vsp_v2';  // marca de los mensajes entre iframes
    const IS_TOP        = window.top === window;

    // ---------- Estado ----------
    let current  = 1;      // velocidad actual
    let chosen   = false;  // true cuando el usuario ya eligió una velocidad (antes no tocamos la página)
    let ui       = null;   // { host, buttons }
    let timer    = 0;
    let reported = false;  // último estado enviado al frame padre

    const hooked    = new WeakSet();  // medios con listeners ya puestos
    const played    = new WeakSet();  // medios que han reproducido alguna vez
    const watched   = new WeakSet();  // shadow roots ya observados
    const active    = new Set();      // medios vivos que conocemos
    const childWins = new Set();      // iframes hijos que reportan medios

    const nativeAttach = Element.prototype.attachShadow;
    const isMedia = n => !!n && n.nodeType === 1 &&
                         (n.localName === 'video' || n.localName === 'audio');

    // ---------- Mensajería entre frames ----------
    function post(win, data) {
        try { data.k = MSG_KEY; win.postMessage(data, '*'); } catch (_) {}
    }

    function isChildFrame(win) {
        try {
            for (let i = 0; i < window.frames.length; i++) {
                if (window.frames[i] === win) return true;
            }
        } catch (_) {}
        return false;
    }

    // ---------- Lógica de velocidad ----------
    function applyRate(el) {
        if (!chosen) return;
        try {
            if (el.defaultPlaybackRate !== current) el.defaultPlaybackRate = current;
            if (el.playbackRate !== current) el.playbackRate = current;
        } catch (_) {}
    }

    function broadcast(speed, from) {
        // Hacia arriba: solo si el cambio no vino del padre
        if (!IS_TOP && from !== window.parent) post(window.parent, { t: 'speed', speed });
        // Hacia abajo: a todos los iframes hijos menos el que lo originó
        try {
            for (let i = 0; i < window.frames.length; i++) {
                const w = window.frames[i];
                if (w !== from) post(w, { t: 'speed', speed });
            }
        } catch (_) {}
    }

    function setSpeed(speed, from) {
        if (!(speed > 0 && speed <= 16)) return;
        chosen  = true;
        current = speed;
        document.querySelectorAll('video, audio').forEach(register);
        active.forEach(applyRate);
        updateButtons();
        broadcast(speed, from || null);
    }

    // ---------- Registro de medios ----------
    const APPLY_EVENTS = new Set(['loadstart', 'loadedmetadata', 'play', 'playing']);
    const MEDIA_EVENTS = ['loadstart', 'loadedmetadata', 'durationchange',
                          'play', 'playing', 'pause', 'ended', 'emptied'];

    function onMediaEvent(e) {
        const el = e.target;
        if (e.type === 'play' || e.type === 'playing') played.add(el);
        if (APPLY_EVENTS.has(e.type)) applyRate(el);
        active.add(el);
        schedule();
    }

    function register(el) {
        if (!isMedia(el)) return;
        active.add(el);
        if (hooked.has(el)) return;
        hooked.add(el);
        MEDIA_EVENTS.forEach(t => el.addEventListener(t, onMediaEvent));
        applyRate(el);
    }

    function scanNode(node) {
        if (isMedia(node)) { register(node); return; }
        if (node && node.querySelectorAll) {
            node.querySelectorAll('video, audio').forEach(register);
        }
    }

    // Escaneo profundo (incluye shadow roots abiertos ya existentes)
    function deepScan(root) {
        root.querySelectorAll('video, audio').forEach(register);
        root.querySelectorAll('*').forEach(el => {
            const sr = el.shadowRoot;
            if (sr) { watchRoot(sr); deepScan(sr); }
        });
    }

    // ¿Vale la pena mostrar la barra para este medio?
    function isRelevant(el) {
        if (!el.paused && !el.ended) return true;      // reproduciéndose
        if (!el.isConnected) return false;             // Audio() suelto y pausado
        if (played.has(el) || el.controls) return true;
        const d = el.duration;
        return Number.isFinite(d) ? d >= MIN_SECONDS : el.readyState > 0;
    }

    function checkLocal() {
        let has = false;
        for (const el of active) {
            if (!el.isConnected && (el.paused || el.ended)) { active.delete(el); continue; }
            if (isRelevant(el)) has = true;
        }
        return has;
    }

    // ---------- UI (Shadow DOM: la CSS de la página no la afecta) ----------
    function buildUI() {
        const host = document.createElement('div');
        host.style.cssText = 'all:initial;position:fixed;left:50%;' +
            'bottom:calc(16px + env(safe-area-inset-bottom,0px));' +
            'transform:translateX(-50%);z-index:2147483647;display:none;';

        const root = nativeAttach ? nativeAttach.call(host, { mode: 'closed' }) : host;

        const style = document.createElement('style');
        style.textContent = `
            .bar{display:flex;gap:2px;padding:3px;background:rgba(0,0,0,.7);
                 -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
                 border-radius:999px;font-family:system-ui,-apple-system,sans-serif;
                 user-select:none;-webkit-user-select:none;touch-action:manipulation;
                 -webkit-tap-highlight-color:transparent;opacity:.8;transition:opacity .2s}
            .bar:active,.bar:focus-within{opacity:1}
            button{background:transparent;color:#fff;border:0;border-radius:999px;
                   padding:6px 12px;font:600 13px/1 system-ui,-apple-system,sans-serif;
                   min-height:32px;cursor:pointer;margin:0;
                   transition:background .15s,color .15s,transform .15s,box-shadow .15s}
            button.on{background:${ACTIVE_COLOR};color:#000;font-weight:800;
                      box-shadow:0 0 8px rgba(0,230,118,.6);transform:scale(1.06)}
        `;

        const bar = document.createElement('div');
        bar.className = 'bar';

        const buttons = SPEEDS.map(speed => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = speed + 'x';
            b.addEventListener('click', e => {
                e.stopPropagation();
                setSpeed(speed, null);
            });
            bar.appendChild(b);
            return { el: b, speed };
        });

        root.appendChild(style);
        root.appendChild(bar);
        ui = { host, buttons };
        updateButtons();
    }

    function updateButtons() {
        if (!ui) return;
        ui.buttons.forEach(({ el, speed }) => el.classList.toggle('on', speed === current));
    }

    // Coloca la barra en <html> (y la repone si la página la quitó)
    function mount() {
        if (!ui) buildUI();
        const target = document.documentElement;
        if (target && ui.host.parentNode !== target) target.appendChild(ui.host);
    }

    function syncUI(show) {
        if (!show) {
            if (ui) ui.host.style.display = 'none';
            return;
        }
        if (!document.documentElement) return;
        mount();                       // si la página la quitó, se vuelve a poner
        ui.host.style.display = 'block';
    }

    // ---------- Actualización con throttle ----------
    function schedule() {
        if (!timer) timer = setTimeout(refresh, THROTTLE_MS);
    }

    function refresh() {
        timer = 0;

        for (const w of childWins) {
            try { if (w.closed) childWins.delete(w); } catch (_) { childWins.delete(w); }
        }

        const local = checkLocal();
        const any   = local || childWins.size > 0;

        // Los iframes avisan al padre; solo el frame superior muestra la barra
        if (!IS_TOP && any !== reported) {
            reported = any;
            post(window.parent, { t: 'has', has: any });
        }

        syncUI(IS_TOP && any);
    }

    // ---------- Mensajes entre frames ----------
    window.addEventListener('message', e => {
        const d = e.data;
        if (!d || typeof d !== 'object' || d.k !== MSG_KEY) return;
        const src = e.source;
        if (!src || src === window) return;

        if (d.t === 'speed') {
            if (typeof d.speed !== 'number') return;
            if (src !== window.parent && !isChildFrame(src)) return;
            if (chosen && d.speed === current) return;
            setSpeed(d.speed, src);
        } else if (d.t === 'has') {
            if (!isChildFrame(src)) return;
            if (d.has) childWins.add(src); else childWins.delete(src);
            if (chosen) post(src, { t: 'speed', speed: current });  // sincroniza iframes nuevos
            schedule();
        }
    });

    // ---------- Observador del DOM ----------
    const observer = new MutationObserver(muts => {
        let dirty = false;
        for (const m of muts) {
            if (m.removedNodes.length) dirty = true;
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) { scanNode(n); dirty = true; }
            }
        }
        if (dirty || (ui && !ui.host.isConnected)) schedule();
    });

    function watchRoot(root) {
        if (watched.has(root)) return;
        watched.add(root);
        observer.observe(root, { childList: true, subtree: true });
        scanNode(root);
    }

    // ---------- Hooks: detectan audio/video que no están en el DOM ----------
    // new Audio().play() o <video> creados por JS nunca generan mutaciones.
    try {
        const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
        if (proto && proto.play) {
            const nativePlay = proto.play;
            proto.play = function () {
                try {
                    played.add(this);
                    register(this);
                    applyRate(this);
                    schedule();
                } catch (_) {}
                return nativePlay.apply(this, arguments);
            };
        }
    } catch (_) {}

    // Reproductores dentro de Web Components (Shadow DOM)
    try {
        if (nativeAttach) {
            Element.prototype.attachShadow = function (init) {
                const root = nativeAttach.call(this, init);
                try { watchRoot(root); } catch (_) {}
                return root;
            };
        }
    } catch (_) {}

    // ---------- Arranque ----------
    observer.observe(document, { childList: true, subtree: true });
    deepScan(document);
    schedule();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { deepScan(document); schedule(); }, { once: true });
    }
    if (document.readyState !== 'complete') {
        window.addEventListener('load', () => { deepScan(document); schedule(); }, { once: true });
    }

    document.addEventListener('visibilitychange', schedule);

    // Red de seguridad: recoge medios que se hayan escapado y repone la barra si desapareció
    setInterval(() => {
        if (document.hidden) return;
        document.querySelectorAll('video, audio').forEach(register);
        schedule();
    }, SCAN_EVERY_MS);

    // Un iframe nuevo se presenta al padre para recibir la velocidad actual
    if (!IS_TOP) post(window.parent, { t: 'has', has: false });
})();
