/*
   Canvas Effects v2
   PenguinMod, live SVG-filter post-processing on the stage canvas.
   @scaliefanatic47 on PenguinMod
*/
(async function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('Canvas Effects v2 needs to be unsandboxed!');
        return;
    }

    const BT = Scratch.BlockType || {};
    const AT = Scratch.ArgumentType || {};
    const REPORTER = BT.REPORTER || 'reporter';
    const COMMAND = BT.COMMAND || 'command';
    const LABEL = BT.LABEL || 'label';
    const STRING = AT.STRING || 'string';
    const NUMBER = AT.NUMBER || 'number';
    const COLOR = AT.COLOR || 'color';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';

    const finite = (v, fb, min, max) => {
        let n = Number(v);
        if (!Number.isFinite(n)) n = fb;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    };
    const str = (v) => (v === null || v === undefined ? '' : String(v));

    // ================================================================
    // SVG helpers
    // ================================================================
    function svg(tag, attrs, children) {
        const el = document.createElementNS(SVG_NS, tag);
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
        if (children) for (const c of children) el.appendChild(c);
        return el;
    }
    function feImageWithHref(attrs, dataUri) {
        const el = svg('feImage', attrs);
        el.setAttribute('href', dataUri);
        try { el.setAttributeNS(XLINK_NS, 'xlink:href', dataUri); } catch (_) {}
        return el;
    }

    // ================================================================
    // Mask generators
    // ================================================================
    function makeRadialDisplacementMap(mode, strength, size) {
        size = size || 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(size, size);
        const d = img.data;
        const cx = size / 2, cy = size / 2;
        const maxR = Math.sqrt(cx * cx + cy * cy);
        const s = Math.min(1, Math.max(0, strength));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = (y * size + x) * 4;
                const dx = x - cx, dy = y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                const norm = dist / maxR;
                let mag = 0;
                if (mode === 'bulge') mag = Math.cos(norm * Math.PI / 2) * s;
                else if (mode === 'shrink') mag = -Math.cos(norm * Math.PI / 2) * s;
                else if (mode === 'fisheye') mag = Math.pow(norm, 2) * s;
                const rx = (dx / dist) * mag;
                const ry = (dy / dist) * mag;
                d[i] = Math.max(0, Math.min(255, Math.round(128 + rx * 127)));
                d[i + 1] = Math.max(0, Math.min(255, Math.round(128 + ry * 127)));
                d[i + 2] = 0;
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    function makeVignetteMask(strength, softness, size) {
        size = size || 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const cx = size / 2, cy = size / 2;
        const maxR = Math.sqrt(cx * cx + cy * cy);
        const s = Math.min(1, Math.max(0, strength));
        const soft = Math.max(0.01, Math.min(1, softness));
        const start = Math.max(0, 1 - soft);
        const edgeVal = Math.round(255 * (1 - s));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
        g.addColorStop(0, 'rgb(255,255,255)');
        g.addColorStop(start * 0.7, 'rgb(255,255,255)');
        g.addColorStop(1, `rgb(${edgeVal},${edgeVal},${edgeVal})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    }

    function makeRadialGlowMask(lx, ly, falloff, size) {
        size = size || 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const cx = Math.max(0, Math.min(1, lx)) * size;
        const cy = Math.max(0, Math.min(1, ly)) * size;
        let maxD = 0;
        for (const [px, py] of [[0, 0], [size, 0], [0, size], [size, size]]) {
            maxD = Math.max(maxD, Math.hypot(px - cx, py - cy));
        }
        const soft = Math.max(0.01, Math.min(1, falloff));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxD);
        g.addColorStop(0, 'rgb(255,255,255)');
        g.addColorStop(soft * 0.5, 'rgb(200,200,200)');
        g.addColorStop(1, 'rgb(0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    }

    // ================================================================
    // Filter builder
    // ================================================================
    function buildFilter(filterEl, cw, ch, effects) {
        let prev = 'SourceGraphic';
        let idx = 0;
        const R = (tag, attrs, children) => {
            const el = svg(tag, Object.assign({ in: prev }, attrs), children);
            filterEl.appendChild(el);
            return el;
        };
        const nameFor = (suffix) => `fx${idx}_${suffix}`;

        for (const name in effects) {
            const p = effects[name];
            const curIdx = idx++;
            const n = (s) => `fx${curIdx}_${s}`;

            switch (name) {
                case 'blur': {
                    const sd = Math.max(0.1, finite(p.strength, 10) / 5);
                    R('feGaussianBlur', { stdDeviation: sd, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'bloom': {
                    const th = Math.min(0.99, Math.max(0, finite(p.threshold, 0.6)));
                    const slope = 1 / Math.max(0.01, 1 - th);
                    const inter = -th * slope;
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0',
                        result: n('lum'),
                    });
                    const ct = svg('feComponentTransfer', { in: n('lum'), result: n('bright') });
                    for (const ch of ['R', 'G', 'B']) ct.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);
                    R('feGaussianBlur', { in: n('bright'), stdDeviation: Math.max(0.1, finite(p.radius, 6)), result: n('blur') });
                    const boost = svg('feComponentTransfer', { in: n('blur'), result: n('boost') });
                    for (const ch of ['R', 'G', 'B']) boost.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope: finite(p.intensity, 0.8), intercept: 0 }));
                    filterEl.appendChild(boost);
                    R('feComposite', { in: prev, in2: n('boost'), operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'sepia': {
                    const a = Math.min(1, Math.max(0, finite(p.amount, 1)));
                    const idn = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
                    const sep = [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
                    const m = idn.map((v, i) => (v * (1 - a) + sep[i] * a).toFixed(4));
                    R('feColorMatrix', { type: 'matrix', values: m.join(' '), result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'grayscale': {
                    const a = Math.min(1, Math.max(0, finite(p.amount, 1)));
                    R('feColorMatrix', { type: 'saturate', values: 1 - a, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'anaglyph': {
                    const sep = finite(p.separation, 4, -50, 50);
                    const ang = finite(p.angle, 0) * Math.PI / 180;
                    const dx = Math.cos(ang) * sep;
                    const dy = Math.sin(ang) * sep;
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
                        result: n('r'),
                    });
                    R('feOffset', { in: n('r'), dx: -dx, dy: -dy, result: n('rO') });
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0',
                        result: n('gb'),
                    });
                    R('feOffset', { in: n('gb'), dx, dy, result: n('gbO') });
                    R('feComposite', { in: n('rO'), in2: n('gbO'), operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'chromatic': {
                    const amt = Math.min(100, Math.max(0, finite(p.amount, 20)));
                    const strength = amt / 100;
                    const mapOut = makeRadialDisplacementMap('bulge', strength);
                    const mapIn = makeRadialDisplacementMap('shrink', strength);
                    const scale = Math.min(cw, ch) * strength * 0.6;
                    const uriOut = mapOut.toDataURL('image/png');
                    const uriIn = mapIn.toDataURL('image/png');
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
                        result: n('r'),
                    });
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch, preserveAspectRatio: 'none', result: n('mOut'),
                    }, uriOut));
                    R('feDisplacementMap', { in: n('r'), in2: n('mOut'), scale, xChannelSelector: 'R', yChannelSelector: 'G', result: n('rD') });
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
                        result: n('g'),
                    });
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
                        result: n('b'),
                    });
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch, preserveAspectRatio: 'none', result: n('mIn'),
                    }, uriIn));
                    R('feDisplacementMap', { in: n('b'), in2: n('mIn'), scale, xChannelSelector: 'R', yChannelSelector: 'G', result: n('bD') });
                    R('feComposite', { in: n('rD'), in2: n('g'), operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('rg') });
                    R('feComposite', { in: n('rg'), in2: n('bD'), operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'grade': {
                    const br = finite(p.brightness, 0, -1, 1);
                    const ct = finite(p.contrast, 1, 0, 3);
                    const sat = finite(p.saturation, 1, 0, 3);
                    const slope = ct;
                    const inter = br + (1 - ct) * 0.5;
                    const ctEl = svg('feComponentTransfer', { in: prev, result: n('graded') });
                    for (const ch of ['R', 'G', 'B']) ctEl.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ctEl);
                    R('feColorMatrix', { in: n('graded'), type: 'saturate', values: sat, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'vignette': {
                    const mask = makeVignetteMask(finite(p.strength, 0.5), finite(p.softness, 0.5));
                    const uri = mask.toDataURL('image/png');
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch, preserveAspectRatio: 'none', result: n('mask'),
                    }, uri));
                    R('feBlend', { in: prev, in2: n('mask'), mode: 'multiply', result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'fisheye':
                case 'bulge':
                case 'shrink': {
                    const st = Math.min(100, Math.max(0, finite(p.strength, 30)));
                    const map = makeRadialDisplacementMap(name, st / 100);
                    const uri = map.toDataURL('image/png');
                    const scale = Math.min(cw, ch) * (st / 100) * 2;
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch, preserveAspectRatio: 'none', result: n('map'),
                    }, uri));
                    R('feDisplacementMap', { in: prev, in2: n('map'), scale, xChannelSelector: 'R', yChannelSelector: 'G', result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'sharpen': {
                    const a = Math.max(0, finite(p.amount, 1));
                    R('feConvolveMatrix', {
                        order: '3 3',
                        kernelMatrix: `0 ${-a} 0  ${-a} ${1 + 4 * a} ${-a}  0 ${-a} 0`,
                        divisor: 1, preserveAlpha: 'true', result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'edge': {
                    R('feConvolveMatrix', {
                        order: '3 3', kernelMatrix: '0 -1 0  -1 4 -1  0 -1 0',
                        divisor: 1, preserveAlpha: 'true', result: n('edges'),
                    });
                    const gain = 1 / Math.max(0.02, finite(p.threshold, 0.2));
                    R('feColorMatrix', {
                        in: n('edges'), type: 'matrix',
                        values: `${gain} 0 0 0 0  0 ${gain} 0 0 0  0 0 ${gain} 0 0  0 0 0 1 0`,
                        result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'streaks': {
                    const th = Math.min(0.99, Math.max(0, finite(p.threshold, 0.7)));
                    const slope = 1 / Math.max(0.01, 1 - th);
                    const inter = -th * slope;
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0',
                        result: n('lum'),
                    });
                    const ct = svg('feComponentTransfer', { in: n('lum'), result: n('bright') });
                    for (const ch of ['R', 'G', 'B']) ct.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);
                    const vertical = p.mode === 'vertical';
                    const sd = Math.max(0.1, finite(p.length, 30) / 2);
                    R('feGaussianBlur', { in: n('bright'), stdDeviation: vertical ? `0 ${sd}` : `${sd} 0`, result: n('blur') });
                    const boost = svg('feComponentTransfer', { in: n('blur'), result: n('boost') });
                    for (const ch of ['R', 'G', 'B']) boost.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope: finite(p.intensity, 0.6), intercept: 0 }));
                    filterEl.appendChild(boost);
                    R('feComposite', { in: prev, in2: n('boost'), operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'godrays': {
                    const th = Math.min(0.99, Math.max(0, finite(p.threshold, 0.4)));
                    const slope = 1 / Math.max(0.01, 1 - th);
                    const inter = -th * slope;
                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0',
                        result: n('lum'),
                    });
                    const ct = svg('feComponentTransfer', { in: n('lum'), result: n('bright') });
                    for (const ch of ['R', 'G', 'B']) ct.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);
                    R('feGaussianBlur', {
                        in: n('bright'),
                        stdDeviation: Math.max(0.5, finite(p.radius, 20)),
                        result: n('blur'),
                    });
                    const mask = makeRadialGlowMask(finite(p.lx, 0.5), finite(p.ly, 0.3), finite(p.falloff, 0.7));
                    const uri = mask.toDataURL('image/png');
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch, preserveAspectRatio: 'none', result: n('mask'),
                    }, uri));
                    R('feBlend', { in: n('blur'), in2: n('mask'), mode: 'multiply', result: n('weighted') });
                    const boost = svg('feComponentTransfer', { in: n('weighted'), result: n('boost') });
                    for (const ch of ['R', 'G', 'B']) boost.appendChild(svg(`feFunc${ch}`, { type: 'linear', slope: finite(p.intensity, 0.8), intercept: 0 }));
                    filterEl.appendChild(boost);
                    R('feComposite', { in: prev, in2: n('boost'), operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('out') });
                    prev = n('out');
                    break;
                }
            }
        }
        return prev;
    }

    // ================================================================
    // Extension
    // ================================================================
    class Extension {
        constructor(runtime) {
            this.runtime = runtime;
            this.effects = {};
            this.svgRoot = null;
            this.filterElement = null;
            this.filterId = null;
            this.filterDirty = false;
            this.canvas = null;
            this.lastCW = 0;
            this.lastCH = 0;
            this.bgColor = null;
            this._origParentBg = null;
            this._bgParent = null;

            this._ensureSvg();
            this._startWatcher();
        }

        // ---------- SVG container ----------
        _ensureSvg() {
            if (this.svgRoot && this.svgRoot.parentNode) return;
            const s = svg('svg', {
                width: '0', height: '0', 'aria-hidden': 'true',
                style: 'position:fixed;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;',
            });
            document.body.appendChild(s);
            this.svgRoot = s;
        }

        // ---------- Canvas discovery ----------
        _findCanvas() {
            const vm = (typeof Scratch !== 'undefined' && Scratch.vm) || window.vm;
            const runtime = this.runtime || (vm && vm.runtime);
            const renderer = runtime && runtime.renderer;
            if (renderer) {
                if (renderer.canvas && renderer.canvas.tagName === 'CANVAS') return renderer.canvas;
                if (renderer.gl && renderer.gl.canvas && renderer.gl.canvas.tagName === 'CANVAS') return renderer.gl.canvas;
                if (renderer._canvas && renderer._canvas.tagName === 'CANVAS') return renderer._canvas;
            }
            const all = document.querySelectorAll('canvas');
            let best = null, bestArea = 0;
            for (const c of all) {
                if (c.width === 480 && c.height === 360) return c;
                const area = c.width * c.height;
                if (area > bestArea && c.width >= 100 && c.height >= 100) { best = c; bestArea = area; }
            }
            return best;
        }

        // ---------- Watcher: re-apply filter when canvas swaps / resizes / style is stripped ----------
        _startWatcher() {
            const loop = () => {
                try { this._ensureApplied(); } catch (e) { /* silent */ }
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        }

        _ensureApplied() {
            const canvas = this._findCanvas();
            if (!canvas) return;

            if (canvas !== this.canvas) {
                this.canvas = canvas;
                this.filterDirty = true;
                this.lastCW = 0;
                this.lastCH = 0;
            }
            if (canvas.width !== this.lastCW || canvas.height !== this.lastCH) {
                this.lastCW = canvas.width;
                this.lastCH = canvas.height;
                this.filterDirty = true;
            }
            if (this.filterId && (!this.filterElement || !this.filterElement.parentNode)) {
                this.filterDirty = true;
            }

            if (this.filterDirty) this._rebuildFilter();

            const hasFx = Object.keys(this.effects).length > 0;
            const want = hasFx && this.filterId ? `url(#${this.filterId})` : '';
            if ((canvas.style.filter || '') !== want) {
                canvas.style.filter = '';
                void canvas.offsetWidth;
                canvas.style.filter = want;
                canvas.style.webkitFilter = want;
            }

            this._applyBgColor(canvas);
        }

        // ---------- Rebuild the SVG filter ----------
        _rebuildFilter() {
            if (!this._ensureSvgSafe()) return;

            if (this.filterElement && this.filterElement.parentNode) {
                this.filterElement.parentNode.removeChild(this.filterElement);
            }
            this.filterElement = null;
            this.filterId = null;

            const keys = Object.keys(this.effects);
            if (keys.length === 0) {
                this.filterDirty = false;
                return;
            }
            const canvas = this.canvas || this._findCanvas();
            if (!canvas) { this.filterDirty = false; return; }
            const cw = canvas.width || 480;
            const ch = canvas.height || 360;

            const fid = 'canvas-fx-' + Math.random().toString(36).slice(2, 10);
            const filter = svg('filter', {
                id: fid,
                x: '-25%', y: '-25%', width: '150%', height: '150%',
                filterUnits: 'objectBoundingBox',
                primitiveUnits: 'userSpaceOnUse',
                'color-interpolation-filters': 'sRGB',
            });
            buildFilter(filter, cw, ch, this.effects);
            this.svgRoot.appendChild(filter);
            this.filterElement = filter;
            this.filterId = fid;
            this.filterDirty = false;
        }

        _ensureSvgSafe() {
            this._ensureSvg();
            return !!this.svgRoot;
        }

        // ---------- Background colour for distortion gaps ----------
        _applyBgColor(canvas) {
            const parent = canvas.parentElement;
            if (!parent) return;
            if (this.bgColor) {
                if (this._bgParent !== parent) {
                    if (!this._bgParent) this._origParentBg = parent.style.backgroundColor || '';
                    this._bgParent = parent;
                }
                parent.style.backgroundColor = this.bgColor;
            } else if (this._bgParent === parent) {
                parent.style.backgroundColor = this._origParentBg || '';
                this._bgParent = null;
                this._origParentBg = null;
            }
        }

        // ---------- Effect state ----------
        _setEffect(name, params) {
            this.effects[name] = params;
            this.filterDirty = true;
        }
        _clearEffect(name) {
            if (name in this.effects) {
                delete this.effects[name];
                this.filterDirty = true;
            }
        }
        _clearAll() {
            this.effects = {};
            this.filterDirty = true;
        }

        // ---------- Capture ----------
        _capture(withEffects) {
            const canvas = this._findCanvas();
            if (!canvas) return '';
            if (withEffects && this.filterId && Object.keys(this.effects).length > 0) {
                try {
                    const off = document.createElement('canvas');
                    off.width = canvas.width;
                    off.height = canvas.height;
                    const ctx = off.getContext('2d');
                    ctx.filter = `url(#${this.filterId})`;
                    ctx.drawImage(canvas, 0, 0);
                    const uri = off.toDataURL('image/png');
                    if (uri && uri.length > 200) return uri;
                } catch (e) {
                    console.warn('[CanvasEffects] Filter bake failed, falling back to unfiltered:', e);
                }
            }
            try { return canvas.toDataURL('image/png'); } catch (e) {
                console.error('[CanvasEffects] Capture failed:', e);
                return '';
            }
        }

        // ============================================================
        // Block definitions
        // ============================================================
        getInfo() {
            const argNum = (d) => ({ type: NUMBER, defaultValue: d });
            const argStr = (d, m) => ({ type: STRING, defaultValue: d, menu: m });
            const cmd = (opcode, text, args) => ({ opcode, blockType: COMMAND, text, arguments: args || {} });

            return {
                id: 'canvasEffectsV2',
                name: 'Canvas Effects v2',
                color1: '#0fbd8c',
                blocks: [
                    { blockType: LABEL, text: 'Light & Color' },
                    cmd('applyBlur', 'apply blur strength [STRENGTH]', { STRENGTH: argNum(10) }),
                    cmd('applyBloom', 'apply bloom threshold [THRESHOLD] intensity [INTENSITY] radius [RADIUS]', {
                        THRESHOLD: argNum(0.6), INTENSITY: argNum(0.8), RADIUS: argNum(6),
                    }),
                    cmd('applyStreaks', 'apply streaks [MODE] intensity [INTENSITY] length [LENGTH] threshold [THRESHOLD]', {
                        MODE: argStr('horizontal', 'streakModeMenu'), INTENSITY: argNum(0.6), LENGTH: argNum(30), THRESHOLD: argNum(0.7),
                    }),
                    cmd('applyGodRays', 'apply god rays light x [LX] y [LY] intensity [INTENSITY] radius [RADIUS] falloff [FALLOFF] threshold [THRESHOLD]', {
                        LX: argNum(0.5), LY: argNum(0.3), INTENSITY: argNum(0.8), RADIUS: argNum(20), FALLOFF: argNum(0.7), THRESHOLD: argNum(0.4),
                    }),
                    cmd('applySepia', 'apply sepia amount [AMOUNT]', { AMOUNT: argNum(1) }),
                    cmd('applyGrayscale', 'apply grayscale amount [AMOUNT]', { AMOUNT: argNum(1) }),
                    cmd('applyAnaglyph', 'apply anaglyph 3D separation [SEPARATION] angle [ANGLE]', {
                        SEPARATION: argNum(4), ANGLE: argNum(0),
                    }),
                    cmd('applyChromatic', 'apply chromatic aberration amount [AMOUNT]', { AMOUNT: argNum(20) }),
                    cmd('applyGrade', 'apply color grade brightness [BRIGHTNESS] contrast [CONTRAST] saturation [SATURATION]', {
                        BRIGHTNESS: argNum(0), CONTRAST: argNum(1), SATURATION: argNum(1),
                    }),
                    cmd('applyVignette', 'apply vignette strength [STRENGTH] softness [SOFTNESS]', {
                        STRENGTH: argNum(0.5), SOFTNESS: argNum(0.5),
                    }),

                    { blockType: LABEL, text: 'Distortion' },
                    cmd('applyFisheye', 'apply fisheye strength [STRENGTH]', { STRENGTH: argNum(30) }),
                    cmd('applyBulge', 'apply bulge strength [STRENGTH]', { STRENGTH: argNum(30) }),
                    cmd('applyShrink', 'apply shrink strength [STRENGTH]', { STRENGTH: argNum(30) }),

                    { blockType: LABEL, text: 'Detail' },
                    cmd('applySharpen', 'apply sharpen amount [AMOUNT]', { AMOUNT: argNum(1) }),
                    cmd('applyEdge', 'apply edge detect threshold [THRESHOLD]', { THRESHOLD: argNum(0.2) }),

                    { blockType: LABEL, text: 'Control' },
                    cmd('clearEffect', 'clear [EFFECT] effect', {
                        EFFECT: argStr('blur', 'effectNameMenu'),
                    }),
                    cmd('clearAll', 'clear all effects'),
                    cmd('setBgFill', 'set canvas background fill [COLOR]', {
                        COLOR: { type: COLOR, defaultValue: '#000000' },
                    }),
                    cmd('clearBgFill', 'clear canvas background fill'),

                    { blockType: LABEL, text: 'Output' },
                    {
                        opcode: 'stageAsPNG',
                        blockType: REPORTER,
                        text: 'stage as PNG [WITHFX]',
                        arguments: {
                            WITHFX: argStr('with effects', 'captureMenu'),
                        },
                    },
                ],
                menus: {
                    streakModeMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'horizontal', value: 'horizontal' },
                            { text: 'vertical', value: 'vertical' },
                        ],
                    },
                    captureMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'with effects', value: 'with effects' },
                            { text: 'without effects', value: 'without effects' },
                        ],
                    },
                    effectNameMenu: {
                        acceptReporters: false,
                        items: [
                            'blur', 'bloom', 'streaks', 'godrays', 'sepia', 'grayscale',
                            'anaglyph', 'chromatic', 'grade', 'vignette',
                            'fisheye', 'bulge', 'shrink', 'sharpen', 'edge',
                        ],
                    },
                },
            };
        }

        // ============================================================
        // Block implementations
        // ============================================================
        applyBlur(a) { this._setEffect('blur', { strength: finite(a.STRENGTH, 10, 0, 500) }); }
        applyBloom(a) {
            this._setEffect('bloom', {
                threshold: finite(a.THRESHOLD, 0.6, 0, 1),
                intensity: finite(a.INTENSITY, 0.8, 0, 3),
                radius: finite(a.RADIUS, 6, 0.1, 200),
            });
        }
        applyStreaks(a) {
            this._setEffect('streaks', {
                mode: str(a.MODE) === 'vertical' ? 'vertical' : 'horizontal',
                intensity: finite(a.INTENSITY, 0.6, 0, 3),
                length: finite(a.LENGTH, 30, 0, 500),
                threshold: finite(a.THRESHOLD, 0.7, 0, 1),
            });
        }
        applyGodRays(a) {
            this._setEffect('godrays', {
                lx: finite(a.LX, 0.5, 0, 1),
                ly: finite(a.LY, 0.3, 0, 1),
                intensity: finite(a.INTENSITY, 0.8, 0, 3),
                radius: finite(a.RADIUS, 20, 0.1, 400),
                falloff: finite(a.FALLOFF, 0.7, 0.01, 1),
                threshold: finite(a.THRESHOLD, 0.4, 0, 1),
            });
        }
        applySepia(a) { this._setEffect('sepia', { amount: finite(a.AMOUNT, 1, 0, 1) }); }
        applyGrayscale(a) { this._setEffect('grayscale', { amount: finite(a.AMOUNT, 1, 0, 1) }); }
        applyAnaglyph(a) {
            this._setEffect('anaglyph', {
                separation: finite(a.SEPARATION, 4, -100, 100),
                angle: finite(a.ANGLE, 0, -180, 180),
            });
        }
        applyChromatic(a) { this._setEffect('chromatic', { amount: finite(a.AMOUNT, 20, 0, 100) }); }
        applyGrade(a) {
            this._setEffect('grade', {
                brightness: finite(a.BRIGHTNESS, 0, -1, 1),
                contrast: finite(a.CONTRAST, 1, 0, 3),
                saturation: finite(a.SATURATION, 1, 0, 3),
            });
        }
        applyVignette(a) {
            this._setEffect('vignette', {
                strength: finite(a.STRENGTH, 0.5, 0, 1),
                softness: finite(a.SOFTNESS, 0.5, 0.01, 1),
            });
        }
        applyFisheye(a) { this._setEffect('fisheye', { strength: finite(a.STRENGTH, 30, 0, 100) }); }
        applyBulge(a) { this._setEffect('bulge', { strength: finite(a.STRENGTH, 30, 0, 100) }); }
        applyShrink(a) { this._setEffect('shrink', { strength: finite(a.STRENGTH, 30, 0, 100) }); }
        applySharpen(a) { this._setEffect('sharpen', { amount: finite(a.AMOUNT, 1, 0, 10) }); }
        applyEdge(a) { this._setEffect('edge', { threshold: finite(a.THRESHOLD, 0.2, 0.01, 1) }); }

        clearEffect(a) { this._clearEffect(str(a.EFFECT)); }
        clearAll() { this._clearAll(); }

        setBgFill(a) { this.bgColor = str(a.COLOR) || '#000000'; this.filterDirty = false; }
        clearBgFill() { this.bgColor = null; }

        stageAsPNG(a) {
            return this._capture(str(a.WITHFX) !== 'without effects');
        }
    }

    Scratch.extensions.register(new Extension(Scratch.vm && Scratch.vm.runtime));
})(Scratch);
