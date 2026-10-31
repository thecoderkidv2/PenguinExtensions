/*
   Canvas Effects v2.1
   PenguinMod, live SVG-filter post-processing on the stage canvas.
   Credits: @scaliefanatic47 (original Speedi Blurs), extended & rearchitected.

   All effects are SVG filter primitives applied via canvas.style.filter.
   Pen-layer targeting uses the pen skin's canvas as a binary mask.
*/
(async function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('Canvas Effects v2.1 needs to be unsandboxed!');
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
    function createCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    // ================================================================
    // Mask generators
    // ================================================================
    function makeRadialDisplacementMap(mode, strength, size) {
        size = size || 256;
        const c = createCanvas(size, size);
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
                if (mode === 'bulge')        mag =  Math.cos(norm * Math.PI / 2) * s;
                else if (mode === 'shrink')  mag = -Math.cos(norm * Math.PI / 2) * s;
                else if (mode === 'fisheye') mag =  Math.pow(norm, 2) * s;
                d[i]     = Math.max(0, Math.min(255, Math.round(128 + (dx / dist) * mag * 127)));
                d[i + 1] = Math.max(0, Math.min(255, Math.round(128 + (dy / dist) * mag * 127)));
                d[i + 2] = 0;
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    function makeVignetteMask(strength, softness, size) {
        size = size || 256;
        const c = createCanvas(size, size);
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
        const c = createCanvas(size, size);
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
    function buildFilter(filterEl, cw, ch, effects, opts) {
        let prev = 'SourceGraphic';
        let idx = 0;
        const R = (tag, attrs, children) => {
            const el = svg(tag, Object.assign({ in: prev }, attrs), children);
            filterEl.appendChild(el);
            return el;
        };

        for (const name in effects) {
            const p = effects[name];
            const curIdx = idx++;
            const n = (suffix) => `fx${curIdx}_${suffix}`;

            switch (name) {
                case 'blur': {
                    const sd = Math.max(0.1, finite(p.strength, 10) / 5);
                    R('feGaussianBlur', { stdDeviation: sd, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'bloom': {
                    const th     = Math.min(0.99, Math.max(0, finite(p.threshold, 0.6)));
                    const slope  = 1 / Math.max(0.01, 1 - th);
                    const inter  = -th * slope;
                    const inten  = finite(p.intensity, 0.8, 0, 3);
                    const radius = Math.max(0.1, finite(p.radius, 6, 0.1, 200));
                    const wR     = finite(p.weightR, 1, 0, 5);
                    const wG     = finite(p.weightG, 1, 0, 5);
                    const wB     = finite(p.weightB, 1, 0, 5);

                    // Extract channels as grayscale
                    R('feColorMatrix', { type: 'matrix', values: '1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0', result: n('rG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0', result: n('gG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0', result: n('bG') });

                    // max(R, G, B)
                    R('feBlend', { in: n('rG'), in2: n('gG'), mode: 'lighten', result: n('rgG') });
                    R('feBlend', { in: n('rgG'), in2: n('bG'), mode: 'lighten', result: n('maxG') });

                    // Threshold max channel → binary brightness mask
                    const ct = svg('feComponentTransfer', { in: n('maxG'), result: n('mask') });
                    for (const chn of ['R', 'G', 'B'])
                        ct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);

                    // Bright pass = source colour × mask (preserves hue)
                    R('feComposite', {
                        in: prev, in2: n('mask'),
                        operator: 'arithmetic', k1: 1, k2: 0, k3: 0, k4: 0,
                        result: n('bright'),
                    });

                    // Per-channel colour weights
                    const wct = svg('feComponentTransfer', { in: n('bright'), result: n('weighted') });
                    wct.appendChild(svg('feFuncR', { type: 'linear', slope: wR, intercept: 0 }));
                    wct.appendChild(svg('feFuncG', { type: 'linear', slope: wG, intercept: 0 }));
                    wct.appendChild(svg('feFuncB', { type: 'linear', slope: wB, intercept: 0 }));
                    filterEl.appendChild(wct);

                    // Blur the bright pass
                    R('feGaussianBlur', { in: n('weighted'), stdDeviation: radius, result: n('blurred') });

                    // Scale by intensity
                    const bct = svg('feComponentTransfer', { in: n('blurred'), result: n('boost') });
                    for (const chn of ['R', 'G', 'B'])
                        bct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope: inten, intercept: 0 }));
                    filterEl.appendChild(bct);

                    // Add original + boosted
                    R('feComposite', {
                        in: prev, in2: n('boost'),
                        operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0,
                        result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'streaks': {
                    const th    = Math.min(0.99, Math.max(0, finite(p.threshold, 0.7)));
                    const slope = 1 / Math.max(0.01, 1 - th);
                    const inter = -th * slope;
                    const vertical = p.mode === 'vertical';
                    const sd = Math.max(0.1, finite(p.length, 30) / 2);

                    // Bright pass via max-channel mask (same fix as bloom)
                    R('feColorMatrix', { type: 'matrix', values: '1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0', result: n('rG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0', result: n('gG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0', result: n('bG') });
                    R('feBlend', { in: n('rG'), in2: n('gG'), mode: 'lighten', result: n('rgG') });
                    R('feBlend', { in: n('rgG'), in2: n('bG'), mode: 'lighten', result: n('maxG') });
                    const ct = svg('feComponentTransfer', { in: n('maxG'), result: n('mask') });
                    for (const chn of ['R', 'G', 'B'])
                        ct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);
                    R('feComposite', {
                        in: prev, in2: n('mask'),
                        operator: 'arithmetic', k1: 1, k2: 0, k3: 0, k4: 0,
                        result: n('bright'),
                    });

                    R('feGaussianBlur', {
                        in: n('bright'),
                        stdDeviation: vertical ? `0 ${sd}` : `${sd} 0`,
                        result: n('blurred'),
                    });

                    const bct = svg('feComponentTransfer', { in: n('blurred'), result: n('boost') });
                    for (const chn of ['R', 'G', 'B'])
                        bct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope: finite(p.intensity, 0.6), intercept: 0 }));
                    filterEl.appendChild(bct);

                    R('feComposite', {
                        in: prev, in2: n('boost'),
                        operator: 'arithmetic', k2: 1, k3: 1, k4: 0,
                        result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'godrays': {
                    const th    = Math.min(0.99, Math.max(0, finite(p.threshold, 0.4)));
                    const slope = 1 / Math.max(0.01, 1 - th);
                    const inter = -th * slope;

                    // Bright pass (max-channel)
                    R('feColorMatrix', { type: 'matrix', values: '1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0', result: n('rG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0', result: n('gG') });
                    R('feColorMatrix', { type: 'matrix', values: '0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0', result: n('bG') });
                    R('feBlend', { in: n('rG'), in2: n('gG'), mode: 'lighten', result: n('rgG') });
                    R('feBlend', { in: n('rgG'), in2: n('bG'), mode: 'lighten', result: n('maxG') });
                    const ct = svg('feComponentTransfer', { in: n('maxG'), result: n('mask') });
                    for (const chn of ['R', 'G', 'B'])
                        ct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ct);
                    R('feComposite', {
                        in: prev, in2: n('mask'),
                        operator: 'arithmetic', k1: 1, k2: 0, k3: 0, k4: 0,
                        result: n('bright'),
                    });

                    R('feGaussianBlur', {
                        in: n('bright'),
                        stdDeviation: Math.max(0.5, finite(p.radius, 20)),
                        result: n('blurred'),
                    });

                    const mask = makeRadialGlowMask(
                        finite(p.lx, 0.5), finite(p.ly, 0.3), finite(p.falloff, 0.7)
                    );
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch,
                        preserveAspectRatio: 'none', result: n('glowMask'),
                    }, mask.toDataURL('image/png')));
                    R('feBlend', { in: n('blurred'), in2: n('glowMask'), mode: 'multiply', result: n('weighted') });

                    const bct = svg('feComponentTransfer', { in: n('weighted'), result: n('boost') });
                    for (const chn of ['R', 'G', 'B'])
                        bct.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope: finite(p.intensity, 0.8), intercept: 0 }));
                    filterEl.appendChild(bct);

                    R('feComposite', {
                        in: prev, in2: n('boost'),
                        operator: 'arithmetic', k2: 1, k3: 1, k4: 0,
                        result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'sepia': {
                    const a = Math.min(1, Math.max(0, finite(p.amount, 1)));
                    const idn = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
                    const sep = [0.393,0.769,0.189,0,0, 0.349,0.686,0.168,0,0, 0.272,0.534,0.131,0,0, 0,0,0,1,0];
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
                    const sep = finite(p.separation, 4, -100, 100);
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
                    R('feComposite', {
                        in: n('rO'), in2: n('gbO'),
                        operator: 'arithmetic', k2: 1, k3: 1, k4: 0,
                        result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'chromatic': {
                    const amt = Math.min(100, Math.max(0, finite(p.amount, 20))) / 100;
                    const mapOut = makeRadialDisplacementMap('bulge', amt);
                    const mapIn  = makeRadialDisplacementMap('shrink', amt);
                    const scale  = Math.min(cw, ch) * amt * 0.6;

                    R('feColorMatrix', {
                        type: 'matrix',
                        values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
                        result: n('r'),
                    });
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch,
                        preserveAspectRatio: 'none', result: n('mOut'),
                    }, mapOut.toDataURL('image/png')));
                    R('feDisplacementMap', {
                        in: n('r'), in2: n('mOut'), scale,
                        xChannelSelector: 'R', yChannelSelector: 'G', result: n('rD'),
                    });

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
                        x: 0, y: 0, width: cw, height: ch,
                        preserveAspectRatio: 'none', result: n('mIn'),
                    }, mapIn.toDataURL('image/png')));
                    R('feDisplacementMap', {
                        in: n('b'), in2: n('mIn'), scale,
                        xChannelSelector: 'R', yChannelSelector: 'G', result: n('bD'),
                    });

                    R('feComposite', {
                        in: n('rD'), in2: n('g'),
                        operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('rg'),
                    });
                    R('feComposite', {
                        in: n('rg'), in2: n('bD'),
                        operator: 'arithmetic', k2: 1, k3: 1, k4: 0, result: n('out'),
                    });
                    prev = n('out');
                    break;
                }

                case 'grade': {
                    const br  = finite(p.brightness, 0, -1, 1);
                    const ct  = finite(p.contrast, 1, 0, 3);
                    const sat = finite(p.saturation, 1, 0, 3);
                    const slope = ct;
                    const inter = br + (1 - ct) * 0.5;

                    const ctEl = svg('feComponentTransfer', { in: prev, result: n('graded') });
                    for (const chn of ['R', 'G', 'B'])
                        ctEl.appendChild(svg(`feFunc${chn}`, { type: 'linear', slope, intercept: inter }));
                    filterEl.appendChild(ctEl);

                    R('feColorMatrix', { in: n('graded'), type: 'saturate', values: sat, result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'vignette': {
                    const mask = makeVignetteMask(
                        finite(p.strength, 0.5), finite(p.softness, 0.5)
                    );
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch,
                        preserveAspectRatio: 'none', result: n('mask'),
                    }, mask.toDataURL('image/png')));
                    R('feBlend', { in: prev, in2: n('mask'), mode: 'multiply', result: n('out') });
                    prev = n('out');
                    break;
                }

                case 'fisheye':
                case 'bulge':
                case 'shrink': {
                    const st  = Math.min(100, Math.max(0, finite(p.strength, 30)));
                    const map = makeRadialDisplacementMap(name, st / 100);
                    // Scale is invariant: proportional to canvas size
                    const scale = Math.min(cw, ch) * (st / 100) * 2;
                    filterEl.appendChild(feImageWithHref({
                        x: 0, y: 0, width: cw, height: ch,
                        preserveAspectRatio: 'none', result: n('map'),
                    }, map.toDataURL('image/png')));
                    R('feDisplacementMap', {
                        in: prev, in2: n('map'), scale,
                        xChannelSelector: 'R', yChannelSelector: 'G', result: n('out'),
                    });
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
            }
        }

        // ---- Pen mask composite (sprites-only / pen-only targeting) ----
        if (opts && opts.penMaskUri && opts.targetLayer && opts.targetLayer !== 'both') {
            filterEl.appendChild(feImageWithHref({
                x: 0, y: 0, width: cw, height: ch,
                preserveAspectRatio: 'none', result: 'penMask',
            }, opts.penMaskUri));

            if (opts.targetLayer === 'pen') {
                // effect where pen, source everywhere else
                filterEl.appendChild(svg('feComposite', {
                    in: prev, in2: 'penMask', operator: 'in', result: 'effectInPen',
                }));
                filterEl.appendChild(svg('feComposite', {
                    in: 'SourceGraphic', in2: 'penMask', operator: 'out', result: 'sourceOutPen',
                }));
                filterEl.appendChild(svg('feComposite', {
                    in: 'effectInPen', in2: 'sourceOutPen', operator: 'over', result: 'layerOut',
                }));
                prev = 'layerOut';
            } else if (opts.targetLayer === 'sprites') {
                // source where pen, effect everywhere else
                filterEl.appendChild(svg('feComposite', {
                    in: 'SourceGraphic', in2: 'penMask', operator: 'in', result: 'sourceInPen',
                }));
                filterEl.appendChild(svg('feComposite', {
                    in: prev, in2: 'penMask', operator: 'out', result: 'effectOutPen',
                }));
                filterEl.appendChild(svg('feComposite', {
                    in: 'sourceInPen', in2: 'effectOutPen', operator: 'over', result: 'layerOut',
                }));
                prev = 'layerOut';
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
            this.effects = {};               // { name: params }
            this.targetLayer = 'both';       // 'both' | 'pen' | 'sprites'
            this.penMaskUri = null;

            this.svgRoot = null;
            this.filterElement = null;
            this.filterId = null;
            this.filterDirty = false;

            this.canvas = null;
            this.lastCW = 0;
            this.lastCH = 0;

            this.bgColor = null;
            this._bgParent = null;
            this._origParentBg = null;

            this._lastPenCheck = 0;
            this._lastPenHash = -1;
            this._penUnavailableWarned = false;

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

        // ---------- Pen canvas access ----------
        _getPenCanvas() {
            try {
                const vm = (typeof Scratch !== 'undefined' && Scratch.vm) || window.vm;
                const rt = vm && vm.runtime;
                const renderer = rt && rt.renderer;
                if (!renderer) return null;

                const penId = renderer._penSkinId;
                if (penId === undefined || penId === null) return null;

                let skin = null;
                if (renderer._allSkins) {
                    if (renderer._allSkins instanceof Map) skin = renderer._allSkins.get(penId);
                    else skin = renderer._allSkins[penId];
                }
                if (!skin) return null;

                if (skin._penCanvas && skin._penCanvas.getContext) return skin._penCanvas;
                if (skin.canvas && skin.canvas.tagName === 'CANVAS') return skin.canvas;
                if (skin._canvas && skin._canvas.tagName === 'CANVAS') return skin._canvas;

                // Last resort: readPixels from framebuffer
                const gl = renderer.gl;
                if (gl && skin._framebuffer) {
                    const w = renderer._nativeSize ? renderer._nativeSize[0] : 480;
                    const h = renderer._nativeSize ? renderer._nativeSize[1] : 360;
                    const c = createCanvas(w, h);
                    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, skin._framebuffer);
                    const px = new Uint8Array(w * h * 4);
                    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
                    // Flip vertically (WebGL bottom-up)
                    const flipped = new Uint8ClampedArray(w * h * 4);
                    for (let y = 0; y < h; y++) {
                        const src = (h - 1 - y) * w * 4;
                        flipped.set(px.subarray(src, src + w * 4), y * w * 4);
                    }
                    c.getContext('2d').putImageData(new ImageData(flipped, w, h), 0, 0);
                    return c;
                }
            } catch (e) {
                console.warn('[CanvasEffects] Pen canvas access failed:', e);
            }
            return null;
        }

        _quickPenHash(penCanvas) {
            try {
                const ctx = penCanvas.getContext && penCanvas.getContext('2d');
                if (!ctx) return 0;
                const w = penCanvas.width, h = penCanvas.height;
                const data = ctx.getImageData(0, 0, w, h).data;
                let hash = 2166136261 >>> 0;
                const step = Math.max(4, Math.floor(data.length / 4000)) & ~3;
                for (let i = 0; i < data.length; i += step) {
                    hash = ((hash ^ data[i]) * 16777619) >>> 0;
                }
                return hash;
            } catch (e) { return 0; }
        }

        _refreshPenMask(force) {
            if (this.targetLayer === 'both') {
                this.penMaskUri = null;
                return;
            }

            const now = performance.now();
            if (!force && now - this._lastPenCheck < 250) return;
            this._lastPenCheck = now;

            const penCanvas = this._getPenCanvas();
            if (!penCanvas) {
                if (!this._penUnavailableWarned) {
                    console.warn('[CanvasEffects] Pen canvas not accessible; layer targeting falls back to whole-canvas.');
                    this._penUnavailableWarned = true;
                }
                this.penMaskUri = null;
                return;
            }

            const hash = this._quickPenHash(penCanvas);
            if (!force && hash === this._lastPenHash) return;
            this._lastPenHash = hash;

            const canvas = this.canvas || this._findCanvas();
            if (!canvas) return;
            const cw = canvas.width, ch = canvas.height;

            const maskCanvas = createCanvas(cw, ch);
            const mctx = maskCanvas.getContext('2d');
            mctx.imageSmoothingEnabled = false;
            mctx.drawImage(penCanvas, 0, 0, cw, ch);

            const imgData = mctx.getImageData(0, 0, cw, ch);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                const v = d[i + 3] > 10 ? 255 : 0;
                d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
            }
            mctx.putImageData(imgData, 0, 0);

            this.penMaskUri = maskCanvas.toDataURL('image/png');
            this.filterDirty = true;
        }

        // ---------- Watcher ----------
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
                this._lastPenHash = -1;
                this.lastCW = 0;
                this.lastCH = 0;
            }
            if (canvas.width !== this.lastCW || canvas.height !== this.lastCH) {
                this.lastCW = canvas.width;
                this.lastCH = canvas.height;
                this.filterDirty = true;
                this._lastPenHash = -1;
            }
            if (this.filterId && (!this.filterElement || !this.filterElement.parentNode)) {
                this.filterDirty = true;
            }

            // Pen mask refresh (throttled inside)
            if (this.targetLayer !== 'both') this._refreshPenMask(false);

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

        // ---------- Rebuild ----------
        _rebuildFilter() {
            this._ensureSvg();

            if (this.filterElement && this.filterElement.parentNode) {
                this.filterElement.parentNode.removeChild(this.filterElement);
            }
            this.filterElement = null;
            this.filterId = null;

            if (Object.keys(this.effects).length === 0) {
                this.filterDirty = false;
                return;
            }
            const canvas = this.canvas || this._findCanvas();
            if (!canvas) { this.filterDirty = false; return; }
            const cw = canvas.width || 480;
            const ch = canvas.height || 360;

            // Fresh unique ID → forces compositor to re-evaluate
            const fid = 'canvas-fx-' + Math.random().toString(36).slice(2, 10);
            const filter = svg('filter', {
                id: fid,
                x: '-25%', y: '-25%', width: '150%', height: '150%',
                filterUnits: 'objectBoundingBox',
                primitiveUnits: 'userSpaceOnUse',
                'color-interpolation-filters': 'sRGB',
            });
            buildFilter(filter, cw, ch, this.effects, {
                penMaskUri: this.penMaskUri,
                targetLayer: this.targetLayer,
            });
            this.svgRoot.appendChild(filter);
            this.filterElement = filter;
            this.filterId = fid;
            this.filterDirty = false;
        }

        // ---------- Background fill ----------
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

        // ---------- State ----------
        _setEffect(name, params) { this.effects[name] = params; this.filterDirty = true; }
        _clearEffect(name) {
            if (name in this.effects) { delete this.effects[name]; this.filterDirty = true; }
        }
        _clearAll() { this.effects = {}; this.filterDirty = true; }
        _setTargetLayer(layer) {
            if (layer !== 'both' && layer !== 'pen' && layer !== 'sprites') layer = 'both';
            if (layer === this.targetLayer) return;
            this.targetLayer = layer;
            this._lastPenHash = -1;
            this.penMaskUri = null;
            if (layer !== 'both') this._refreshPenMask(true);
            this.filterDirty = true;
        }

        // ---------- Capture ----------
        _capture(withEffects) {
            const canvas = this._findCanvas();
            if (!canvas) return '';

            if (withEffects && this.filterDirty) this._rebuildFilter();

            if (withEffects && this.filterId && Object.keys(this.effects).length > 0) {
                try {
                    const off = createCanvas(canvas.width, canvas.height);
                    const ctx = off.getContext('2d');
                    ctx.filter = `url(#${this.filterId})`;
                    ctx.drawImage(canvas, 0, 0);
                    const uri = off.toDataURL('image/png');
                    if (uri && uri.length > 200) return uri;
                } catch (e) {
                    console.warn('[CanvasEffects] Bake failed, falling back to unfiltered:', e);
                }
            }
            try { return canvas.toDataURL('image/png'); }
            catch (e) { console.error('[CanvasEffects] Capture failed:', e); return ''; }
        }

        // ============================================================
        // Blocks
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
                    { blockType: LABEL, text: 'Target' },
                    cmd('setTargetLayer', 'apply effects to [LAYER]', {
                        LAYER: argStr('entire stage', 'layerMenu'),
                    }),

                    { blockType: LABEL, text: 'Light & Color' },
                    cmd('applyBlur', 'apply blur strength [STRENGTH]', { STRENGTH: argNum(10) }),
                    cmd('applyBloom', 'apply bloom threshold [THRESHOLD] intensity [INTENSITY] radius [RADIUS] weight r [WR] g [WG] b [WB]', {
                        THRESHOLD: argNum(0.6), INTENSITY: argNum(0.8), RADIUS: argNum(6),
                        WR: argNum(1), WG: argNum(1), WB: argNum(1),
                    }),
                    cmd('applyStreaks', 'apply streaks [MODE] intensity [INTENSITY] length [LENGTH] threshold [THRESHOLD]', {
                        MODE: argStr('horizontal', 'streakModeMenu'),
                        INTENSITY: argNum(0.6), LENGTH: argNum(30), THRESHOLD: argNum(0.7),
                    }),
                    cmd('applyGodRays', 'apply god rays light x [LX] y [LY] intensity [INTENSITY] radius [RADIUS] falloff [FALLOFF] threshold [THRESHOLD]', {
                        LX: argNum(0.5), LY: argNum(0.3), INTENSITY: argNum(0.8),
                        RADIUS: argNum(20), FALLOFF: argNum(0.7), THRESHOLD: argNum(0.4),
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
                    cmd('refreshPenMask', 'refresh pen mask'),
                    cmd('setBgFill', 'set canvas background fill [COLOR]', {
                        COLOR: { type: COLOR, defaultValue: '#000000' },
                    }),
                    cmd('clearBgFill', 'clear canvas background fill'),

                    { blockType: LABEL, text: 'Output' },
                    {
                        opcode: 'stageAsPNG',
                        blockType: REPORTER,
                        text: 'stage as PNG [WITHFX]',
                        arguments: { WITHFX: argStr('with effects', 'captureMenu') },
                    },
                ],
                menus: {
                    layerMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'entire stage',  value: 'both'    },
                            { text: 'pen layer',     value: 'pen'     },
                            { text: 'sprites only',  value: 'sprites' },
                        ],
                    },
                    streakModeMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'horizontal', value: 'horizontal' },
                            { text: 'vertical',   value: 'vertical'   },
                        ],
                    },
                    captureMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'with effects',    value: 'with effects'    },
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
        setTargetLayer(a) {
            const map = { 'entire stage': 'both', 'pen layer': 'pen', 'sprites only': 'sprites' };
            this._setTargetLayer(map[str(a.LAYER)] || str(a.LAYER));
        }

        applyBlur(a) { this._setEffect('blur', { strength: finite(a.STRENGTH, 10, 0, 500) }); }

        applyBloom(a) {
            this._setEffect('bloom', {
                threshold: finite(a.THRESHOLD, 0.6, 0, 1),
                intensity: finite(a.INTENSITY, 0.8, 0, 3),
                radius:    finite(a.RADIUS, 6, 0.1, 200),
                weightR:   finite(a.WR, 1, 0, 5),
                weightG:   finite(a.WG, 1, 0, 5),
                weightB:   finite(a.WB, 1, 0, 5),
            });
        }

        applyStreaks(a) {
            this._setEffect('streaks', {
                mode: str(a.MODE) === 'vertical' ? 'vertical' : 'horizontal',
                intensity: finite(a.INTENSITY, 0.6, 0, 3),
                length:    finite(a.LENGTH, 30, 0, 500),
                threshold: finite(a.THRESHOLD, 0.7, 0, 1),
            });
        }

        applyGodRays(a) {
            this._setEffect('godrays', {
                lx:        finite(a.LX, 0.5, 0, 1),
                ly:        finite(a.LY, 0.3, 0, 1),
                intensity: finite(a.INTENSITY, 0.8, 0, 3),
                radius:    finite(a.RADIUS, 20, 0.1, 400),
                falloff:   finite(a.FALLOFF, 0.7, 0.01, 1),
                threshold: finite(a.THRESHOLD, 0.4, 0, 1),
            });
        }

        applySepia(a)     { this._setEffect('sepia',     { amount: finite(a.AMOUNT, 1, 0, 1) }); }
        applyGrayscale(a) { this._setEffect('grayscale', { amount: finite(a.AMOUNT, 1, 0, 1) }); }

        applyAnaglyph(a) {
            this._setEffect('anaglyph', {
                separation: finite(a.SEPARATION, 4, -100, 100),
                angle:      finite(a.ANGLE, 0, -180, 180),
            });
        }

        applyChromatic(a) { this._setEffect('chromatic', { amount: finite(a.AMOUNT, 20, 0, 100) }); }

        applyGrade(a) {
            this._setEffect('grade', {
                brightness: finite(a.BRIGHTNESS, 0, -1, 1),
                contrast:   finite(a.CONTRAST, 1, 0, 3),
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
        applyBulge(a)   { this._setEffect('bulge',   { strength: finite(a.STRENGTH, 30, 0, 100) }); }
        applyShrink(a)  { this._setEffect('shrink',  { strength: finite(a.STRENGTH, 30, 0, 100) }); }
        applySharpen(a) { this._setEffect('sharpen', { amount:    finite(a.AMOUNT, 1, 0, 10) }); }
        applyEdge(a)    { this._setEffect('edge',    { threshold: finite(a.THRESHOLD, 0.2, 0.01, 1) }); }

        clearEffect(a)   { this._clearEffect(str(a.EFFECT)); }
        clearAll()       { this._clearAll(); }
        refreshPenMask() { this._refreshPenMask(true); }
        setBgFill(a)     { this.bgColor = str(a.COLOR) || '#000000'; }
        clearBgFill()    { this.bgColor = null; }
        stageAsPNG(a)    { return this._capture(str(a.WITHFX) !== 'without effects'); }
    }

    Scratch.extensions.register(new Extension(Scratch.vm && Scratch.vm.runtime));
})(Scratch);
