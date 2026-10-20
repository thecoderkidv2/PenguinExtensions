/*
   Speedi Blurs v4
   Created for PenguinMod
   Credits: @scaliefanatic47

   Blur methodology: Masaki Kawase "Frame Buffer Postprocessing..." (GDC 2003),
   Marius Bjørge "Bandwidth Efficient Rendering" (SIGGRAPH 2015),
   Jorge Jimenez "Next Generation Post Processing in CoD:AW" (SIGGRAPH 2014).

   Requires unsandboxed execution and a Scratch-compatible renderer.
*/
(async function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('Speedi Blurs needs to run unsandboxed!');
        return;
    }

    const BT = Scratch.BlockType || {};
    const AT = Scratch.ArgumentType || {};
    const REPORTER = BT.REPORTER || 'reporter';
    const STRING = AT.STRING || 'string';
    const NUMBER = AT.NUMBER || 'number';
    const BOOL = AT.BOOLEAN || 'Boolean';

    let lastError = '';
    const setError = (m) => { lastError = m; };

    const arg = (type, defaultValue, menu) => {
        const a = { type, defaultValue };
        if (menu) a.menu = menu;
        return a;
    };
    const s = (v, m) => arg(STRING, v, m);
    const n = (v) => arg(NUMBER, v);
    const b = (v) => arg(BOOL, v);
    const reporter = (opcode, text, args) => ({ opcode, blockType: REPORTER, text, arguments: args || {} });

    const finite = (v, fallback, min, max) => {
        let num = Number(v);
        if (!Number.isFinite(num)) num = fallback;
        if (min !== undefined) num = Math.max(min, num);
        if (max !== undefined) num = Math.min(max, num);
        return num;
    };
    const asString = (v) => v === null || v === undefined ? '' : String(v);
    const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

    // Stage reference size (Scratch/PenguinMod default)
    const STAGE_W = 480;
    const STAGE_H = 360;

    // ------------------------------------------------------------------
    // Canvas helpers
    // ------------------------------------------------------------------
    function createCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    function loadImageFromURI(uri) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = uri;
        });
    }

    function canvasToDataURI(canvas) {
        return canvas.toDataURL('image/png');
    }

    function drawScaled(src, dstW, dstH) {
        const c = createCanvas(dstW, dstH);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, c.width, c.height);
        return c;
    }

    // Returns fit dims if image exceeds stage bounds, else null.
    function computeFit(sourceCanvas) {
        if (sourceCanvas.width <= STAGE_W && sourceCanvas.height <= STAGE_H) return null;
        const r = Math.min(STAGE_W / sourceCanvas.width, STAGE_H / sourceCanvas.height);
        return {
            width: Math.max(1, Math.round(sourceCanvas.width * r)),
            height: Math.max(1, Math.round(sourceCanvas.height * r))
        };
    }

    // Downscale → run → upscale back to native size, if fit is requested.
    function withFit(sourceCanvas, fitDims, fn) {
        if (!fitDims) return fn(sourceCanvas);

        const nativeW = sourceCanvas.width;
        const nativeH = sourceCanvas.height;
        const work = drawScaled(sourceCanvas, fitDims.width, fitDims.height);

        const result = fn(work);

        return drawScaled(result, nativeW, nativeH);
    }

    // ------------------------------------------------------------------
    // Blur algorithms
    // ------------------------------------------------------------------
    function radiusToLevels(radius) {
        const r = Math.max(1, radius);
        return Math.min(6, Math.max(1, Math.ceil(Math.log2(r))));
    }

    function kawaseBlur(sourceCanvas, levels) {
        let current = sourceCanvas;
        const chain = [sourceCanvas];

        for (let i = 0; i < levels; i++) {
            const w = Math.max(1, Math.round(current.width / 2));
            const h = Math.max(1, Math.round(current.height / 2));
            const down = drawScaled(current, w, h);
            chain.push(down);
            current = down;
        }

        for (let i = chain.length - 2; i >= 0; i--) {
            current = drawScaled(current, chain[i].width, chain[i].height);
        }
        return current;
    }

    function dualKawaseBlur(sourceCanvas, levels) {
        let current = sourceCanvas;
        const chain = [sourceCanvas];

        for (let i = 0; i < levels; i++) {
            const w = Math.max(1, Math.round(current.width / 2));
            const h = Math.max(1, Math.round(current.height / 2));
            const down = drawScaled(current, w, h);
            chain.push(down);
            current = down;
        }

        let result = chain[chain.length - 1];
        for (let i = chain.length - 2; i >= 1; i--) {
            const up = drawScaled(result, chain[i].width, chain[i].height);
            const uctx = up.getContext('2d');
            uctx.globalAlpha = 0.5;
            uctx.drawImage(chain[i], 0, 0);
            uctx.globalAlpha = 1;
            result = up;
        }

        if (result.width !== sourceCanvas.width || result.height !== sourceCanvas.height) {
            result = drawScaled(result, sourceCanvas.width, sourceCanvas.height);
        }
        return result;
    }

    function gaussianBlur(sourceCanvas, radius) {
        const out = createCanvas(sourceCanvas.width, sourceCanvas.height);
        const ctx = out.getContext('2d');
        ctx.filter = `blur(${Math.max(0, radius)}px)`;
        ctx.drawImage(sourceCanvas, 0, 0);
        return out;
    }

    function applyBlur(canvas, method, radius) {
        const levels = radiusToLevels(radius);
        if (method === 'Gaussian') return gaussianBlur(canvas, radius);
        if (method === 'Dual Kawase') return dualKawaseBlur(canvas, levels);
        return kawaseBlur(canvas, levels);
    }

    // ------------------------------------------------------------------
    // Bloom
    // ------------------------------------------------------------------
    function bloom(sourceCanvas, threshold, intensity, radius) {
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;

        const brightCanvas = createCanvas(w, h);
        const bctx = brightCanvas.getContext('2d');
        bctx.drawImage(sourceCanvas, 0, 0);
        const imgData = bctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const thresh = finite(threshold, 0.6, 0, 1);
        for (let i = 0; i < data.length; i += 4) {
            const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            if (lum < thresh) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
        }
        bctx.putImageData(imgData, 0, 0);

        const blurred = kawaseBlur(brightCanvas, radiusToLevels(radius));

        const out = createCanvas(w, h);
        const octx = out.getContext('2d');
        octx.drawImage(sourceCanvas, 0, 0);
        octx.globalCompositeOperation = 'lighter';
        octx.globalAlpha = finite(intensity, 0.8, 0, 2);
        octx.drawImage(blurred, 0, 0, w, h);
        octx.globalAlpha = 1;
        octx.globalCompositeOperation = 'source-over';
        return out;
    }

    // ------------------------------------------------------------------
    // Extension
    // ------------------------------------------------------------------
    class Extension {
        getInfo() {
            return {
                id: 'speediBlurs',
                name: 'Speedi Blurs',
                color1: '#536dfe',
                color2: '#3949ab',
                color3: '#283593',
                blocks: [
                    reporter(
                        'blurImage',
                        'blur image [IMAGE] by [RADIUS] using [METHOD] fit to stage? [FIT]',
                        {
                            IMAGE: s(''),
                            RADIUS: n(8),
                            METHOD: s('Kawase', 'blurMethodMenu'),
                            FIT: b(false)
                        }
                    ),
                    reporter(
                        'bloomImage',
                        'bloom image [IMAGE] threshold [THRESHOLD] intensity [INTENSITY] radius [RADIUS] fit to stage? [FIT]',
                        {
                            IMAGE: s(''),
                            THRESHOLD: n(0.6),
                            INTENSITY: n(0.8),
                            RADIUS: n(6),
                            FIT: b(false)
                        }
                    ),
                    reporter('lastError', 'last error')
                ],
                menus: {
                    blurMethodMenu: {
                        acceptReporters: true,
                        items: ['Kawase', 'Dual Kawase', 'Gaussian']
                    }
                }
            };
        }

        async blurImage(args) {
            try {
                if (!args.IMAGE) { setError('No image provided'); return ''; }
                const img = await loadImageFromURI(asString(args.IMAGE));
                const src = createCanvas(img.width, img.height);
                src.getContext('2d').drawImage(img, 0, 0);

                const fitDims = asBool(args.FIT) ? computeFit(src) : null;
                const radius = finite(args.RADIUS, 8, 0, 200);
                const method = asString(args.METHOD);

                const out = withFit(src, fitDims, (work) => applyBlur(work, method, radius));
                setError('');
                return canvasToDataURI(out);
            } catch (e) {
                setError('blurImage: ' + e.message);
                return '';
            }
        }

        async bloomImage(args) {
            try {
                if (!args.IMAGE) { setError('No image provided'); return ''; }
                const img = await loadImageFromURI(asString(args.IMAGE));
                const src = createCanvas(img.width, img.height);
                src.getContext('2d').drawImage(img, 0, 0);

                const fitDims = asBool(args.FIT) ? computeFit(src) : null;
                const threshold = finite(args.THRESHOLD, 0.6, 0, 1);
                const intensity = finite(args.INTENSITY, 0.8, 0, 2);
                const radius = finite(args.RADIUS, 6, 0, 100);

                const out = withFit(src, fitDims, (work) => bloom(work, threshold, intensity, radius));
                setError('');
                return canvasToDataURI(out);
            } catch (e) {
                setError('bloomImage: ' + e.message);
                return '';
            }
        }

        lastError() {
            return lastError || '';
        }
    }

    Scratch.extensions.register(new Extension());
})(Scratch);
