/*
   Created with ExtForge
   https://jwklong.github.io/extforge
*/
(async function(Scratch) {
    var variables = {};

    if (!Scratch.extensions.unsandboxed) {
        alert("This extension needs to be unsandboxed to run!");
        return;
    }

    var ExtForge = {
        Broadcasts: new function() {
            this.raw_ = {};
            this.register = (name, blocks) => { this.raw_[name] = blocks; };
            this.execute = async (name) => {
                if (this.raw_[name]) await this.raw_[name]();
            };
        },
        Variables: new function() {
            this.raw_ = {};
            this.set = (name, value) => { this.raw_[name] = value; };
            this.get = (name) => this.raw_[name] ?? null;
        },
        Vector: class {
            constructor(x, y) { this.x = x; this.y = y; }
            static from(v) {
                if (v instanceof ExtForge.Vector) return v;
                if (v instanceof Array) return new ExtForge.Vector(Number(v[0]) || 0, Number(v[1]) || 0);
                if (v instanceof Object) return new ExtForge.Vector(Number(v.x) || 0, Number(v.y) || 0);
                return new ExtForge.Vector(0, 0);
            }
            add(v) { return new ExtForge.Vector(this.x + v.x, this.y + v.y); }
            set(x, y) { return new ExtForge.Vector(x ?? this.x, y ?? this.y); }
        },
        Utils: {
            setList: (list, index, value) => {
                var copy = [...list];
                copy[index] = value;
                return copy;
            },
            lists_foreach: { index: [0], value: [null], depth: 0 },
            countString: (x, y) => y.length === 0 ? 0 : String(x).split(String(y)).length - 1
        }
    };

    var BT = Scratch.BlockType || {};
    var AT = Scratch.ArgumentType || {};
    var COMMAND = BT.COMMAND || 'command';
    var REPORTER = BT.REPORTER || 'reporter';
    var BOOLEAN = BT.BOOLEAN || 'Boolean';
    var STRING = AT.STRING || 'string';
    var NUMBER = AT.NUMBER || 'number';
    var BOOL = AT.BOOLEAN || 'Boolean';

    var objects = Object.create(null);
    var nextObjectId = 1;
    var renderCache = new Map();
    var measureCache = new Map();
    var cacheEnabled = true;
    var cacheBytes = 0;
    var cacheHits = 0;
    var cacheMisses = 0;
    var measureHits = 0;
    var measureMisses = 0;
    var lastError = '';
    var measureCanvas = null;
    var measureContext = null;
    var defaults = makeDefaultStyle();

    var MAX_CACHE_ENTRIES = 180;
    var MAX_CACHE_BYTES = 48 * 1024 * 1024;
    var MAX_SINGLE_CACHE_BYTES = 5 * 1024 * 1024;
    var MAX_MEASURE_ENTRIES = 12000;
    var MAX_TEXT_CHARS = 50000;
    var MAX_RENDER_DIMENSION = 8192;

    function makeDefaultStyle() {
        return {
            fontFamily: 'Arial, sans-serif',
            fontSize: 24,
            fontWeight: 'normal',
            italic: false,
            fillColor: '#ffffff',
            outlineColor: '#000000',
            outlineWidth: 0,
            shadowColor: 'rgba(0,0,0,0.5)',
            shadowBlur: 0,
            shadowX: 0,
            shadowY: 0,
            backgroundColor: 'transparent',
            backgroundRadius: 0,
            padding: 2,
            align: 'left',
            verticalAlign: 'top',
            wrapWidth: 0,
            boxHeight: 0,
            lineHeight: 0,
            letterSpacing: 0,
            maxLines: 0,
            wrapMode: 'words',
            textTransform: 'none',
            decoration: 'none',
            direction: 'inherit',
            gradientColor2: '',
            gradientAngle: 0,
            opacity: 100,
            rasterScale: 2
        };
    }

    function finite(value, fallback, min, max) {
        var n = Number(value);
        if (!Number.isFinite(n)) n = fallback;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        return n;
    }

    function asString(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function asBoolean(value) {
        return value === true || value === 1 || value === '1' || value === 'true';
    }

    function clampText(value) {
        var text = asString(value);
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '…';
        return text;
    }

    function getRenderer(util) {
        try {
            if (util && util.runtime && util.runtime.renderer) return util.runtime.renderer;
            if (Scratch.vm && Scratch.vm.renderer) return Scratch.vm.renderer;
            if (Scratch.renderer) return Scratch.renderer;
        } catch (e) {}
        return null;
    }

    function getMeasureContext() {
        if (measureContext) return measureContext;
        if (typeof document === 'undefined' || !document.createElement) throw new Error('Canvas is not available in this runtime.');
        measureCanvas = document.createElement('canvas');
        measureCanvas.width = 16;
        measureCanvas.height = 16;
        measureContext = measureCanvas.getContext('2d', { alpha: true, willReadFrequently: false });
        if (!measureContext) throw new Error('The browser could not create a 2D canvas context.');
        return measureContext;
    }

    function fontString(style) {
        var italic = style.italic ? 'italic ' : '';
        var weight = asString(style.fontWeight || 'normal');
        var size = finite(style.fontSize, 24, 1, 512);
        var family = asString(style.fontFamily || 'Arial, sans-serif');
        return italic + weight + ' ' + size + 'px ' + family;
    }

    function graphemes(text) {
        text = asString(text);
        try {
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                var segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                return Array.from(segmenter.segment(text), function(item) { return item.segment; });
            }
        } catch (e) {}
        return Array.from(text);
    }

    function measureTextCached(text, font, spacing) {
        text = asString(text);
        spacing = finite(spacing, 0, -100, 100);
        var key = font + '\u0000' + spacing + '\u0000' + text;

        if (measureCache.has(key)) {
            measureHits++;
            return measureCache.get(key);
        }

        measureMisses++;
        var ctx = getMeasureContext();
        ctx.font = font;

        var width = ctx.measureText(text).width;
        if (spacing !== 0) width += spacing * Math.max(0, graphemes(text).length - 1);
        width = Math.max(0, width);

        if (measureCache.size >= MAX_MEASURE_ENTRIES) {
            var first = measureCache.keys().next().value;
            if (first !== undefined) measureCache.delete(first);
        }

        measureCache.set(key, width);
        return width;
    }

    function applyTransform(text, mode) {
        if (mode === 'uppercase') return text.toUpperCase();
        if (mode === 'lowercase') return text.toLowerCase();
        if (mode === 'title case') {
            return text.toLowerCase().replace(/(^|[\s\-])([^\s\-])/g, function(full, prefix, ch) {
                return prefix + ch.toUpperCase();
            });
        }
        return text;
    }

    function splitLongWord(word, maxWidth, font, spacing) {
        var pieces = [];
        var current = '';
        var chars = graphemes(word);

        for (var i = 0; i < chars.length; i++) {
            var candidate = current + chars[i];

            if (current && measureTextCached(candidate, font, spacing) > maxWidth) {
                pieces.push(current);
                current = chars[i];
            } else {
                current = candidate;
            }
        }

        if (current || pieces.length === 0) pieces.push(current);
        return pieces;
    }

    function wrapParagraph(paragraph, width, font, spacing, mode) {
        if (!(width > 0)) return [paragraph];
        if (paragraph === '') return [''];

        if (mode === 'characters') {
            var units = graphemes(paragraph);
            var charLines = [];
            var currentChars = '';

            for (var c = 0; c < units.length; c++) {
                var candidateChars = currentChars + units[c];

                if (currentChars && measureTextCached(candidateChars, font, spacing) > width) {
                    charLines.push(currentChars);
                    currentChars = units[c];
                } else {
                    currentChars = candidateChars;
                }
            }

            if (currentChars || charLines.length === 0) charLines.push(currentChars);
            return charLines;
        }

        var words = paragraph.replace(/\t/g, '    ').trim().split(/\s+/);
        var lines = [];
        var current = '';

        for (var i = 0; i < words.length; i++) {
            var word = words[i];
            var candidate = current ? current + ' ' + word : word;

            if (measureTextCached(candidate, font, spacing) <= width || !current) {
                if (!current && measureTextCached(word, font, spacing) > width) {
                    var pieces = splitLongWord(word, width, font, spacing);
                    for (var p = 0; p < pieces.length - 1; p++) lines.push(pieces[p]);
                    current = pieces[pieces.length - 1];
                } else {
                    current = candidate;
                }
            } else {
                lines.push(current);

                if (measureTextCached(word, font, spacing) > width) {
                    var parts = splitLongWord(word, width, font, spacing);
                    for (var q = 0; q < parts.length - 1; q++) lines.push(parts[q]);
                    current = parts[parts.length - 1];
                } else {
                    current = word;
                }
            }
        }

        lines.push(current);
        return lines;
    }

    function calculateLines(text, style) {
        var font = fontString(style);
        var width = finite(style.wrapWidth, 0, 0, MAX_RENDER_DIMENSION);
        var paragraphs = asString(text).replace(/\r\n?/g, '\n').split('\n');
        var lines = [];

        for (var i = 0; i < paragraphs.length; i++) {
            var wrapped = wrapParagraph(paragraphs[i], width, font, style.letterSpacing, style.wrapMode);

            for (var j = 0; j < wrapped.length; j++) {
                lines.push(wrapped[j]);
                if (lines.length >= 4096) break;
            }

            if (lines.length >= 4096) break;
        }

        var overflow = style.maxLines > 0 && lines.length > style.maxLines;

        if (overflow) {
            lines = lines.slice(0, style.maxLines);

            if (lines.length) {
                var last = lines.length - 1;
                var suffix = '…';
                var line = lines[last];

                while (line && width > 0 && measureTextCached(line + suffix, font, style.letterSpacing) > width) {
                    line = graphemes(line).slice(0, -1).join('');
                }

                lines[last] = line + suffix;
            }
        }

        if (!lines.length) lines = [''];
        return { lines: lines, font: font };
    }

    function renderKey(text, style) {
        var keyStyle = {};
        var keys = Object.keys(style);

        for (var i = 0; i < keys.length; i++) {
            if (keys[i] !== 'opacity') keyStyle[keys[i]] = style[keys[i]];
        }

        return text + '\u0001' + JSON.stringify(keyStyle);
    }

    function cacheGet(key) {
        if (!cacheEnabled || !renderCache.has(key)) return null;

        var item = renderCache.get(key);
        renderCache.delete(key);
        renderCache.set(key, item);
        cacheHits++;

        return item;
    }

    function cachePut(key, item) {
        if (!cacheEnabled) return;
        if (!item || item.bytes > MAX_SINGLE_CACHE_BYTES) return;

        if (renderCache.has(key)) {
            cacheBytes -= renderCache.get(key).bytes;
            renderCache.delete(key);
        }

        renderCache.set(key, item);
        cacheBytes += item.bytes;

        while (renderCache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
            var oldestKey = renderCache.keys().next().value;
            if (oldestKey === undefined) break;

            var oldest = renderCache.get(oldestKey);
            cacheBytes -= oldest.bytes;
            renderCache.delete(oldestKey);
        }
    }

    function getMaxTextureSize(renderer) {
        try {
            var gl = renderer && renderer.gl;

            if (gl && gl.getParameter && gl.MAX_TEXTURE_SIZE) {
                var n = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
                if (Number.isFinite(n) && n > 0) return Math.min(8192, n);
            }
        } catch (e) {}

        return 4096;
    }

    function roundedRect(ctx, x, y, width, height, radius) {
        radius = Math.max(0, Math.min(radius, width / 2, height / 2));

        if (radius <= 0) {
            ctx.beginPath();
            ctx.rect(x, y, width, height);
            ctx.closePath();
            return;
        }

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, width, height, radius);
            return;
        }

        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function makeFillStyle(ctx, style, x, y, width, height) {
        if (!style.gradientColor2) return style.fillColor || '#ffffff';

        var angle = finite(style.gradientAngle, 0, -3600, 3600) * Math.PI / 180;
        var dx = Math.cos(angle) * width / 2;
        var dy = Math.sin(angle) * height / 2;

        var gradient = ctx.createLinearGradient(
            x + width / 2 - dx,
            y + height / 2 - dy,
            x + width / 2 + dx,
            y + height / 2 + dy
        );

        gradient.addColorStop(0, style.fillColor || '#ffffff');
        gradient.addColorStop(1, style.gradientColor2);
        return gradient;
    }

    function drawTextLine(ctx, line, x, y, align, style, font, fillStyle) {
        var spacing = finite(style.letterSpacing, 0, -100, 100);
        var width = measureTextCached(line, font, spacing);
        var startX = x;

        if (align === 'center') startX -= width / 2;
        else if (align === 'right') startX -= width;

        ctx.lineJoin = 'round';
        ctx.lineWidth = finite(style.outlineWidth, 0, 0, 64);
        ctx.strokeStyle = style.outlineColor || '#000000';
        ctx.fillStyle = fillStyle;

        if (ctx.lineWidth > 0) {
            ctx.shadowColor = 'rgba(0,0,0,0)';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            if (spacing === 0) {
                ctx.textAlign = align;
                ctx.strokeText(line, x, y);
            } else {
                ctx.textAlign = 'left';
                var strokeX = startX;
                var strokeParts = graphemes(line);

                for (var s = 0; s < strokeParts.length; s++) {
                    ctx.strokeText(strokeParts[s], strokeX, y);
                    strokeX += measureTextCached(strokeParts[s], font, 0) + spacing;
                }
            }
        }

        ctx.fillStyle = fillStyle;
        ctx.shadowColor = style.shadowColor || 'rgba(0,0,0,0)';
        ctx.shadowBlur = finite(style.shadowBlur, 0, 0, 128);
        ctx.shadowOffsetX = finite(style.shadowX, 0, -512, 512);
        ctx.shadowOffsetY = finite(style.shadowY, 0, -512, 512);

        if (spacing === 0) {
            ctx.textAlign = align;
            ctx.fillText(line, x, y);
        } else {
            ctx.textAlign = 'left';
            var fillX = startX;
            var fillParts = graphemes(line);

            for (var f = 0; f < fillParts.length; f++) {
                ctx.fillText(fillParts[f], fillX, y);
                fillX += measureTextCached(fillParts[f], font, 0) + spacing;
            }
        }

        ctx.shadowColor = 'rgba(0,0,0,0)';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }

    function renderToCanvas(text, style, requestedScale, renderer) {
        var layout = calculateLines(text, style);
        var lines = layout.lines;
        var font = layout.font;
        var maxLineWidth = 0;

        for (var i = 0; i < lines.length; i++) {
            maxLineWidth = Math.max(maxLineWidth, measureTextCached(lines[i], font, style.letterSpacing));
        }

        var contentWidth = style.wrapWidth > 0 ? style.wrapWidth : maxLineWidth;
        contentWidth = finite(contentWidth, 1, 1, MAX_RENDER_DIMENSION);

        var lineHeight = style.lineHeight > 0
            ? style.lineHeight
            : finite(style.fontSize, 24, 1, 512) * 1.2;

        lineHeight = finite(lineHeight, 28.8, 1, 1024);

        var contentHeight = lines.length * lineHeight;
        var boxHeight = style.boxHeight > 0
            ? Math.max(style.boxHeight, contentHeight)
            : contentHeight;

        boxHeight = finite(boxHeight, contentHeight, 1, MAX_RENDER_DIMENSION);

        var shadowExtent = Math.max(Math.abs(style.shadowX), Math.abs(style.shadowY)) + style.shadowBlur * 2;
        var effectPad = finite(Math.ceil(style.outlineWidth + shadowExtent), 0, 0, 256);
        var margin = finite(style.padding, 0, 0, 256) + effectPad;

        var logicalWidth = finite(contentWidth + margin * 2, 1, 1, MAX_RENDER_DIMENSION);
        var logicalHeight = finite(boxHeight + margin * 2, 1, 1, MAX_RENDER_DIMENSION);

        var maxTexture = getMaxTextureSize(renderer);
        var density = finite(requestedScale, 2, 0.25, 4);
        density = Math.min(density, maxTexture / logicalWidth, maxTexture / logicalHeight);

        var maxArea = 16000000;
        density = Math.min(density, Math.sqrt(maxArea / (logicalWidth * logicalHeight)));
        density = Math.max(0.01, density);

        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.min(maxTexture, Math.ceil(logicalWidth * density)));
        canvas.height = Math.max(1, Math.min(maxTexture, Math.ceil(logicalHeight * density)));

        var ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
        if (!ctx) throw new Error('The browser could not create a rendering canvas context.');

        ctx.setTransform(density, 0, 0, density, 0, 0);
        ctx.clearRect(0, 0, logicalWidth, logicalHeight);
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.direction = style.direction === 'ltr' || style.direction === 'rtl' ? style.direction : 'inherit';
        ctx.imageSmoothingEnabled = true;
        ctx.lineJoin = 'round';

        if (style.backgroundColor && style.backgroundColor !== 'transparent') {
            ctx.fillStyle = style.backgroundColor;
            roundedRect(ctx, 0, 0, logicalWidth, logicalHeight, finite(style.backgroundRadius, 0, 0, 512));
            ctx.fill();
        }

        var contentX = margin;
        var contentY = margin + (
            style.verticalAlign === 'middle'
                ? (boxHeight - contentHeight) / 2
                : style.verticalAlign === 'bottom'
                    ? boxHeight - contentHeight
                    : 0
        );

        var anchorX = style.align === 'center'
            ? contentX + contentWidth / 2
            : style.align === 'right'
                ? contentX + contentWidth
                : contentX;

        var fillStyle = makeFillStyle(ctx, style, contentX, contentY, contentWidth, Math.max(lineHeight, contentHeight));

        for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            var centerY = contentY + lineHeight * (lineIndex + 0.5);

            drawTextLine(ctx, lines[lineIndex], anchorX, centerY, style.align, style, font, fillStyle);

            if (style.decoration !== 'none') {
                var lineWidth = measureTextCached(lines[lineIndex], font, style.letterSpacing);
                var startX = style.align === 'center'
                    ? anchorX - lineWidth / 2
                    : style.align === 'right'
                        ? anchorX - lineWidth
                        : anchorX;

                var underlineY = centerY + finite(style.fontSize, 24, 1, 512) * 0.34;

                ctx.save();
                ctx.shadowColor = 'rgba(0,0,0,0)';
                ctx.strokeStyle = style.gradientColor2 ? style.fillColor : style.fillColor;
                ctx.lineWidth = Math.max(1, finite(style.fontSize, 24, 1, 512) / 18);
                ctx.lineCap = 'round';

                if (style.decoration === 'underline' || style.decoration === 'both') {
                    ctx.beginPath();
                    ctx.moveTo(startX, underlineY);
                    ctx.lineTo(startX + lineWidth, underlineY);
                    ctx.stroke();
                }

                if (style.decoration === 'strikethrough' || style.decoration === 'both') {
                    var strikeY = centerY;
                    ctx.beginPath();
                    ctx.moveTo(startX, strikeY);
                    ctx.lineTo(startX + lineWidth, strikeY);
                    ctx.stroke();
                }

                ctx.restore();
            }
        }

        return {
            canvas: canvas,
            resolution: density,
            logicalWidth: canvas.width / density,
            logicalHeight: canvas.height / density,
            lineCount: lines.length,
            bytes: canvas.width * canvas.height * 4
        };
    }

    function destroyRendererAssets(obj) {
        if (!obj) return;

        var renderer = obj.renderer;

        try {
            if (renderer && obj.drawableId !== null && renderer.destroyDrawable) {
                renderer.destroyDrawable(obj.drawableId, obj.group);
            }
        } catch (e) {}

        try {
            if (renderer && obj.skinId !== null && renderer.destroySkin) {
                renderer.destroySkin(obj.skinId);
            }
        } catch (e) {}

        obj.drawableId = null;
        obj.skinId = null;
        obj.renderer = null;
        obj.lastRenderKey = '';
    }

    function applyDrawable(obj) {
        var renderer = obj && obj.renderer;
        if (!renderer || obj.drawableId === null) return false;

        try {
            renderer.updateDrawableProperties(obj.drawableId, {
                position: [
                    finite(obj.x, 0, -1000000, 1000000),
                    finite(obj.y, 0, -1000000, 1000000)
                ],
                direction: 90 + finite(obj.rotation, 0, -360000, 360000),
                scale: [
                    finite(obj.scaleX, 100, -10000, 10000),
                    finite(obj.scaleY, 100, -10000, 10000)
                ],
                visible: !!obj.visible,
                ghost: 100 - finite(obj.style.opacity, 100, 0, 100)
            });

            return true;
        } catch (e) {
            lastError = 'Renderer update failed: ' + (e && e.message ? e.message : String(e));
            return false;
        }
    }

    function ensureRenderer(obj, util) {
        var renderer = getRenderer(util) || obj.renderer;
        if (!renderer) {
            lastError = 'No Scratch renderer was found. Run this extension unsandboxed in a compatible Scratch runtime.';
            return false;
        }

        if (obj.renderer && obj.renderer !== renderer) destroyRendererAssets(obj);
        obj.renderer = renderer;

        if (obj.drawableId === null) {
            try {
                obj.drawableId = renderer.createDrawable(obj.group || 'sprite');

                if (obj.skinId !== null) {
                    renderer.updateDrawableSkinId(obj.drawableId, obj.skinId);
                }

                try {
                    if (renderer.setDrawableOrder && obj.group === 'sprite') {
                        renderer.setDrawableOrder(obj.drawableId, Infinity, obj.group);
                    }
                } catch (e) {}
            } catch (e) {
                obj.drawableId = null;
                lastError = 'Could not create a text drawable: ' + (e && e.message ? e.message : String(e));
                return false;
            }
        }

        return true;
    }

    function createEntry(id, util) {
        var key = asString(id).trim();

        if (!key) {
            key = 'text_' + nextObjectId++;
            while (Object.prototype.hasOwnProperty.call(objects, key)) {
                key = 'text_' + nextObjectId++;
            }
        }

        if (Object.prototype.hasOwnProperty.call(objects, key)) return objects[key];

        var obj = {
            id: key,
            text: '',
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 100,
            scaleY: 100,
            visible: true,
            group: 'sprite',
            renderer: null,
            drawableId: null,
            skinId: null,
            skinResolution: 0,
            style: Object.assign({}, defaults),
            lastRenderKey: '',
            renderedWidth: 0,
            renderedHeight: 0,
            renderedLines: 0
        };

        objects[key] = obj;
        ensureRenderer(obj, util);
        return obj;
    }

    function findEntry(id) {
        var key = asString(id).trim();
        return key && Object.prototype.hasOwnProperty.call(objects, key) ? objects[key] : null;
    }

    function renderObject(obj, util, force) {
        if (!obj) return false;
        if (!ensureRenderer(obj, util)) return false;

        var text = clampText(applyTransform(obj.text, obj.style.textTransform));
        var key = renderKey(text, obj.style) + '\u0002' + finite(obj.style.rasterScale, 2, 0.25, 4);

        if (!force && obj.lastRenderKey === key && obj.skinId !== null) {
            applyDrawable(obj);
            return true;
        }

        var image = cacheGet(key);

        if (!image) {
            cacheMisses++;

            try {
                image = renderToCanvas(text, obj.style, obj.style.rasterScale, obj.renderer);
                cachePut(key, image);
            } catch (e) {
                lastError = 'Text rasterization failed: ' + (e && e.message ? e.message : String(e));
                return false;
            }
        }

        try {
            var center = [image.logicalWidth / 2, image.logicalHeight / 2];

            if (obj.skinId === null) {
                obj.skinId = obj.renderer.createBitmapSkin(image.canvas, image.resolution, center);
                obj.renderer.updateDrawableSkinId(obj.drawableId, obj.skinId);
            } else {
                obj.renderer.updateBitmapSkin(obj.skinId, image.canvas, image.resolution, center);
            }

            obj.skinResolution = image.resolution;
            obj.renderedWidth = image.logicalWidth;
            obj.renderedHeight = image.logicalHeight;
            obj.renderedLines = image.lineCount;
            obj.lastRenderKey = key;
            lastError = '';

            applyDrawable(obj);
            return true;
        } catch (e) {
            lastError = 'Could not upload the text image to the renderer: ' + (e && e.message ? e.message : String(e));
            return false;
        }
    }

    function updateStyle(args, key, value, util, rerender) {
        var obj = findEntry(args.ID);
        if (!obj) return;

        obj.style[key] = value;

        if (rerender === false) {
            applyDrawable(obj);
        } else {
            renderObject(obj, util, false);
        }
    }

    function deleteEntry(id) {
        var obj = findEntry(id);
        if (!obj) return;

        destroyRendererAssets(obj);
        delete objects[obj.id];
    }

    function applyFontStyle(style, family, size) {
        style.fontFamily = asString(family || 'Arial, sans-serif');
        style.fontSize = finite(size, 24, 1, 512);
    }

    function freshMeasureStyle(family, size) {
        var style = Object.assign({}, defaults);
        applyFontStyle(style, family, size);
        style.wrapWidth = 0;
        style.maxLines = 0;
        return style;
    }

    function safeBase64Encode(text) {
        try {
            if (typeof TextEncoder !== 'undefined') {
                var bytes = new TextEncoder().encode(text);
                var binary = '';

                for (var i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode.apply(
                        null,
                        bytes.subarray(i, Math.min(i + 0x8000, bytes.length))
                    );
                }

                return btoa(binary);
            }

            return btoa(unescape(encodeURIComponent(text)));
        } catch (e) {
            lastError = 'Base64 encoding failed: ' + e.message;
            return '';
        }
    }

    function safeBase64Decode(text) {
        try {
            var binary = atob(asString(text));

            if (typeof TextDecoder !== 'undefined') {
                var bytes = new Uint8Array(binary.length);

                for (var i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }

                return new TextDecoder().decode(bytes);
            }

            return decodeURIComponent(escape(binary));
        } catch (e) {
            lastError = 'Base64 decoding failed: ' + e.message;
            return '';
        }
    }

    function argument(type, defaultValue, menu) {
        var result = { type: type, defaultValue: defaultValue };
        if (menu) result.menu = menu;
        return result;
    }

    function s(value, menu) { return argument(STRING, value, menu); }
    function n(value) { return argument(NUMBER, value); }
    function b(value) { return argument(BOOL, value); }

    function command(opcode, text, args) {
        return { opcode: opcode, blockType: COMMAND, text: text, arguments: args || {} };
    }

    function reporter(opcode, text, args) {
        return { opcode: opcode, blockType: REPORTER, text: text, arguments: args || {} };
    }

    function booleanBlock(opcode, text, args) {
        return { opcode: opcode, blockType: BOOLEAN, text: text, arguments: args || {} };
    }

    class Extension {
        getInfo() {
            return {
                id: 'extforgeTextEngine',
                name: 'Text Engine',
                color1: '#536dfe',
                color2: '#3949ab',
                color3: '#283593',
                blocks: [
                    command('drawQuickText', 'draw text [TEXT] at x [X] y [Y]', {
                        TEXT: s('Hello, world!'), X: n(0), Y: n(0)
                    }),
                    reporter('newText', 'new text object [TEXT] at x [X] y [Y]', {
                        TEXT: s('Hello, world!'), X: n(0), Y: n(0)
                    }),
                    command('createOrReplace', 'create/update text object [ID] text [TEXT] at x [X] y [Y]', {
                        ID: s('label'), TEXT: s('Hello!'), X: n(0), Y: n(0)
                    }),
                    command('setContent', 'set text object [ID] text to [TEXT]', {
                        ID: s('label'), TEXT: s('New text')
                    }),
                    reporter('getContent', 'text of object [ID]', {
                        ID: s('label')
                    }),
                    command('deleteText', 'delete text object [ID]', {
                        ID: s('label')
                    }),
                    command('clearQuickText', 'clear quick text'),
                    command('clearAllText', 'delete all text objects'),
                    command('showText', 'show text object [ID]', {
                        ID: s('label')
                    }),
                    command('hideText', 'hide text object [ID]', {
                        ID: s('label')
                    }),
                    command('setTextVisibility', 'set text object [ID] visible? [VISIBLE]', {
                        ID: s('label'), VISIBLE: b(true)
                    }),
                    booleanBlock('isTextVisible', 'text object [ID] is visible?', {
                        ID: s('label')
                    }),
                    booleanBlock('objectExists', 'text object [ID] exists?', {
                        ID: s('label')
                    }),
                    reporter('textCount', 'number of text objects'),
                    reporter('lastError', 'text engine last error'),

                    command('setPosition', 'set text [ID] position x [X] y [Y]', {
                        ID: s('label'), X: n(0), Y: n(0)
                    }),
                    command('setX', 'set text [ID] x to [X]', {
                        ID: s('label'), X: n(0)
                    }),
                    command('setY', 'set text [ID] y to [Y]', {
                        ID: s('label'), Y: n(0)
                    }),
                    command('changeX', 'change text [ID] x by [X]', {
                        ID: s('label'), X: n(10)
                    }),
                    command('changeY', 'change text [ID] y by [Y]', {
                        ID: s('label'), Y: n(10)
                    }),
                    command('moveText', 'move text [ID] by x [X] y [Y]', {
                        ID: s('label'), X: n(10), Y: n(10)
                    }),
                    command('setRotation', 'set text [ID] rotation to [ROTATION] degrees', {
                        ID: s('label'), ROTATION: n(0)
                    }),
                    command('changeRotation', 'rotate text [ID] by [ROTATION] degrees', {
                        ID: s('label'), ROTATION: n(15)
                    }),
                    command('setScale', 'set text [ID] scale x [SX]% y [SY]%', {
                        ID: s('label'), SX: n(100), SY: n(100)
                    }),
                    command('setUniformScale', 'set text [ID] scale to [SCALE]%', {
                        ID: s('label'), SCALE: n(100)
                    }),
                    command('setOpacity', 'set text [ID] opacity to [OPACITY]%', {
                        ID: s('label'), OPACITY: n(100)
                    }),
                    command('setLayer', 'put text [ID] [LAYER]', {
                        ID: s('label'), LAYER: s('over sprites', 'layerMenu')
                    }),
                    command('bringToFront', 'bring text [ID] to front', {
                        ID: s('label')
                    }),
                    command('sendToBack', 'send text [ID] to back', {
                        ID: s('label')
                    }),

                    command('setFontFamily', 'set text [ID] font to [FONT]', {
                        ID: s('label'), FONT: s('Arial, sans-serif')
                    }),
                    command('setFontSize', 'set text [ID] font size to [SIZE]', {
                        ID: s('label'), SIZE: n(24)
                    }),
                    command('setFontWeight', 'set text [ID] font weight to [WEIGHT]', {
                        ID: s('label'), WEIGHT: s('bold', 'weightMenu')
                    }),
                    command('setBold', 'set text [ID] bold? [BOLD]', {
                        ID: s('label'), BOLD: b(true)
                    }),
                    command('setItalic', 'set text [ID] italic? [ITALIC]', {
                        ID: s('label'), ITALIC: b(false)
                    }),
                    command('setTextColor', 'set text [ID] color to [COLOR]', {
                        ID: s('label'), COLOR: s('#ffffff')
                    }),
                    command('setAlignment', 'set text [ID] alignment to [ALIGN]', {
                        ID: s('label'), ALIGN: s('left', 'alignMenu')
                    }),
                    command('setVerticalAlignment', 'set text [ID] vertical alignment to [ALIGN]', {
                        ID: s('label'), ALIGN: s('top', 'verticalMenu')
                    }),
                    command('setWrapWidth', 'set text [ID] wrap width to [WIDTH] (0 = off)', {
                        ID: s('label'), WIDTH: n(0)
                    }),
                    command('setBoxHeight', 'set text [ID] box height to [HEIGHT] (0 = auto)', {
                        ID: s('label'), HEIGHT: n(0)
                    }),
                    command('setLineHeight', 'set text [ID] line height to [HEIGHT] (0 = auto)', {
                        ID: s('label'), HEIGHT: n(0)
                    }),
                    command('setPadding', 'set text [ID] padding to [PADDING]', {
                        ID: s('label'), PADDING: n(2)
                    }),
                    command('setLetterSpacing', 'set text [ID] letter spacing to [SPACING]', {
                        ID: s('label'), SPACING: n(0)
                    }),
                    command('setTextTransform', 'set text [ID] transform to [TRANSFORM]', {
                        ID: s('label'), TRANSFORM: s('none', 'transformMenu')
                    }),
                    command('setMaxLines', 'set text [ID] maximum lines to [LINES] (0 = unlimited)', {
                        ID: s('label'), LINES: n(0)
                    }),
                    command('setWrapMode', 'set text [ID] wrapping mode to [MODE]', {
                        ID: s('label'), MODE: s('words', 'wrapModeMenu')
                    }),
                    command('setDirection', 'set text [ID] direction to [DIRECTION]', {
                        ID: s('label'), DIRECTION: s('inherit', 'directionMenu')
                    }),
                    command('setDecoration', 'set text [ID] decoration to [DECORATION]', {
                        ID: s('label'), DECORATION: s('none', 'decorationMenu')
                    }),
                    command('setOutline', 'set text [ID] outline color [COLOR] width [WIDTH]', {
                        ID: s('label'), COLOR: s('#000000'), WIDTH: n(0)
                    }),
                    command('setShadow', 'set text [ID] shadow color [COLOR] blur [BLUR] x [X] y [Y]', {
                        ID: s('label'), COLOR: s('rgba(0,0,0,0.5)'), BLUR: n(0), X: n(0), Y: n(0)
                    }),
                    command('setBackground', 'set text [ID] background [COLOR] radius [RADIUS]', {
                        ID: s('label'), COLOR: s('transparent'), RADIUS: n(0)
                    }),
                    command('setGradient', 'set text [ID] gradient from [COLOR1] to [COLOR2] angle [ANGLE]', {
                        ID: s('label'), COLOR1: s('#ffffff'), COLOR2: s('#00c8ff'), ANGLE: n(0)
                    }),
                    command('clearGradient', 'clear text [ID] gradient', {
                        ID: s('label')
                    }),
                    command('setRasterQuality', 'set text [ID] raster quality to [QUALITY]x', {
                        ID: s('label'), QUALITY: n(2)
                    }),
                    command('refreshText', 're-render text object [ID]', {
                        ID: s('label')
                    }),
                    command('refreshAllText', 're-render all text objects'),

                    reporter('textWidth', 'rendered width of text [ID]', {
                        ID: s('label')
                    }),
                    reporter('textHeight', 'rendered height of text [ID]', {
                        ID: s('label')
                    }),
                    reporter('renderedLineCount', 'rendered line count of text [ID]', {
                        ID: s('label')
                    }),
                    reporter('measureTextWidth', 'measure [TEXT] in font [FONT] size [SIZE]', {
                        TEXT: s('Hello!'), FONT: s('Arial, sans-serif'), SIZE: n(24)
                    }),
                    reporter('wrapText', 'wrap text [TEXT] to width [WIDTH] font [FONT] size [SIZE]', {
                        TEXT: s('Some text to wrap'), WIDTH: n(160), FONT: s('Arial, sans-serif'), SIZE: n(24)
                    }),
                    reporter('wrappedLineCount', 'line count of [TEXT] at width [WIDTH] font [FONT] size [SIZE]', {
                        TEXT: s('Some text to wrap'), WIDTH: n(160), FONT: s('Arial, sans-serif'), SIZE: n(24)
                    }),
                    command('prewarmText', 'pre-cache text [TEXT] font [FONT] size [SIZE] color [COLOR]', {
                        TEXT: s('Frequently used text'), FONT: s('Arial, sans-serif'), SIZE: n(24), COLOR: s('#ffffff')
                    }),
                    command('setCacheEnabled', 'text image cache enabled? [ENABLED]', {
                        ENABLED: b(true)
                    }),
                    command('clearTextCache', 'clear text image cache'),
                    reporter('cacheStats', 'text cache statistics (JSON)'),
                    command('setDefaultFont', 'set default text font [FONT] size [SIZE] color [COLOR]', {
                        FONT: s('Arial, sans-serif'), SIZE: n(24), COLOR: s('#ffffff')
                    }),
                    command('setDefaultQuality', 'set default text raster quality to [QUALITY]x', {
                        QUALITY: n(2)
                    }),
                    command('resetDefaults', 'reset default text style'),

                    reporter('uppercase', 'uppercase [TEXT]', {
                        TEXT: s('hello')
                    }),
                    reporter('lowercase', 'lowercase [TEXT]', {
                        TEXT: s('HELLO')
                    }),
                    reporter('titleCase', 'title case [TEXT]', {
                        TEXT: s('hello world')
                    }),
                    reporter('trimText', 'trim whitespace around [TEXT]', {
                        TEXT: s(' hello ')
                    }),
                    reporter('reverseText', 'reverse text [TEXT]', {
                        TEXT: s('hello')
                    }),
                    reporter('replaceAllText', 'in [TEXT] replace every [FIND] with [REPLACEMENT]', {
                        TEXT: s('a-b-a'), FIND: s('a'), REPLACEMENT: s('x')
                    }),
                    booleanBlock('textContains', '[TEXT] contains [FIND]?', {
                        TEXT: s('hello'), FIND: s('ell')
                    }),
                    reporter('textIndexOf', 'index of [FIND] in [TEXT] (0-based; -1 if missing)', {
                        TEXT: s('hello'), FIND: s('e')
                    }),
                    reporter('characterAt', 'character [INDEX] of [TEXT] (1-based)', {
                        INDEX: n(1), TEXT: s('hello')
                    }),
                    reporter('textLength', 'length of [TEXT] (Unicode characters)', {
                        TEXT: s('hello')
                    }),
                    reporter('substringText', 'substring of [TEXT] from [START] to [END] (1-based)', {
                        TEXT: s('hello'), START: n(1), END: n(3)
                    }),
                    reporter('countOccurrences', 'count [FIND] in [TEXT]', {
                        TEXT: s('banana'), FIND: s('an')
                    }),
                    reporter('removeWhitespace', 'remove all whitespace from [TEXT]', {
                        TEXT: s('a b c')
                    }),
                    reporter('escapeHTML', 'HTML-escape [TEXT]', {
                        TEXT: s('<hello>')
                    }),
                    reporter('encodeURI', 'URL-encode [TEXT]', {
                        TEXT: s('hello world')
                    }),
                    reporter('decodeURI', 'URL-decode [TEXT]', {
                        TEXT: s('hello%20world')
                    }),
                    reporter('base64Encode', 'Base64-encode [TEXT]', {
                        TEXT: s('hello')
                    }),
                    reporter('base64Decode', 'Base64-decode [TEXT]', {
                        TEXT: s('aGVsbG8=')
                    })
                ],
                menus: {
                    alignMenu: { acceptReporters: true, items: ['left', 'center', 'right'] },
                    verticalMenu: { acceptReporters: true, items: ['top', 'middle', 'bottom'] },
                    transformMenu: { acceptReporters: true, items: ['none', 'uppercase', 'lowercase', 'title case'] },
                    wrapModeMenu: { acceptReporters: true, items: ['words', 'characters'] },
                    weightMenu: {
                        acceptReporters: true,
                        items: ['normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900']
                    },
                    decorationMenu: { acceptReporters: true, items: ['none', 'underline', 'strikethrough', 'both'] },
                    directionMenu: { acceptReporters: true, items: ['inherit', 'ltr', 'rtl'] },
                    layerMenu: {
                        acceptReporters: true,
                        items: [
                            { text: 'over sprites', value: 'sprite' },
                            { text: 'behind sprites', value: 'pen' }
                        ]
                    }
                }
            };
        }

        drawQuickText(args, util) {
            var obj = createEntry('__quick_text__', util);
            obj.text = clampText(args.TEXT);
            obj.x = finite(args.X, 0, -1000000, 1000000);
            obj.y = finite(args.Y, 0, -1000000, 1000000);
            renderObject(obj, util, false);
        }

        newText(args, util) {
            var obj = createEntry('', util);
            obj.text = clampText(args.TEXT);
            obj.x = finite(args.X, 0, -1000000, 1000000);
            obj.y = finite(args.Y, 0, -1000000, 1000000);
            renderObject(obj, util, false);
            return obj.id;
        }

        createOrReplace(args, util) {
            var id = asString(args.ID).trim() || 'default';
            var obj = findEntry(id) || createEntry(id, util);

            obj.text = clampText(args.TEXT);
            obj.x = finite(args.X, 0, -1000000, 1000000);
            obj.y = finite(args.Y, 0, -1000000, 1000000);
            renderObject(obj, util, false);
        }

        setContent(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.text = clampText(args.TEXT);
            renderObject(obj, util, false);
        }

        getContent(args) {
            var obj = findEntry(args.ID);
            return obj ? obj.text : '';
        }

        deleteText(args) {
            deleteEntry(args.ID);
        }

        clearQuickText() {
            deleteEntry('__quick_text__');
        }

        clearAllText() {
            var keys = Object.keys(objects);
            for (var i = 0; i < keys.length; i++) deleteEntry(keys[i]);
        }

        showText(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.visible = true;
            if (!ensureRenderer(obj, util)) return;
            applyDrawable(obj);
        }

        hideText(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.visible = false;
            applyDrawable(obj);
        }

        setTextVisibility(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.visible = asBoolean(args.VISIBLE);
            if (!ensureRenderer(obj, util)) return;
            applyDrawable(obj);
        }

        isTextVisible(args) {
            var obj = findEntry(args.ID);
            return !!(obj && obj.visible);
        }

        objectExists(args) {
            return !!findEntry(args.ID);
        }

        textCount() {
            return Object.keys(objects).length;
        }

        lastError() {
            return lastError || '';
        }

        setPosition(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.x = finite(args.X, obj.x, -1000000, 1000000);
            obj.y = finite(args.Y, obj.y, -1000000, 1000000);
            applyDrawable(obj);
        }

        setX(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.x = finite(args.X, obj.x, -1000000, 1000000);
                applyDrawable(obj);
            }
        }

        setY(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.y = finite(args.Y, obj.y, -1000000, 1000000);
                applyDrawable(obj);
            }
        }

        changeX(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.x = finite(obj.x + finite(args.X, 0, -1000000, 1000000), obj.x, -1000000, 1000000);
                applyDrawable(obj);
            }
        }

        changeY(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.y = finite(obj.y + finite(args.Y, 0, -1000000, 1000000), obj.y, -1000000, 1000000);
                applyDrawable(obj);
            }
        }

        moveText(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.x = finite(obj.x + finite(args.X, 0, -1000000, 1000000), obj.x, -1000000, 1000000);
            obj.y = finite(obj.y + finite(args.Y, 0, -1000000, 1000000), obj.y, -1000000, 1000000);
            applyDrawable(obj);
        }

        setRotation(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.rotation = finite(args.ROTATION, 0, -360000, 360000);
                applyDrawable(obj);
            }
        }

        changeRotation(args) {
            var obj = findEntry(args.ID);
            if (obj) {
                obj.rotation = finite(obj.rotation + finite(args.ROTATION, 0, -360000, 360000), obj.rotation, -360000, 360000);
                applyDrawable(obj);
            }
        }

        setScale(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.scaleX = finite(args.SX, 100, -10000, 10000);
            obj.scaleY = finite(args.SY, 100, -10000, 10000);
            applyDrawable(obj);
        }

        setUniformScale(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            var scale = finite(args.SCALE, 100, -10000, 10000);
            obj.scaleX = scale;
            obj.scaleY = scale;
            applyDrawable(obj);
        }

        setOpacity(args) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.style.opacity = finite(args.OPACITY, 100, 0, 100);
            applyDrawable(obj);
        }

        setLayer(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            var group = asString(args.LAYER) === 'pen' ? 'pen' : 'sprite';
            if (group === obj.group) return;

            var renderer = getRenderer(util) || obj.renderer;

            try {
                if (obj.drawableId !== null && renderer && renderer.destroyDrawable) {
                    renderer.destroyDrawable(obj.drawableId, obj.group);
                }
            } catch (e) {}

            obj.drawableId = null;
            obj.group = group;

            if (ensureRenderer(obj, util)) {
                if (obj.skinId !== null) {
                    try {
                        renderer.updateDrawableSkinId(obj.drawableId, obj.skinId);
                    } catch (e) {}
                }

                applyDrawable(obj);
            }
        }

        bringToFront(args) {
            var obj = findEntry(args.ID);
            if (!obj || !obj.renderer || obj.drawableId === null) return;

            try {
                if (obj.renderer.setDrawableOrder) {
                    obj.renderer.setDrawableOrder(obj.drawableId, Infinity, obj.group);
                }
            } catch (e) {}
        }

        sendToBack(args) {
            var obj = findEntry(args.ID);
            if (!obj || !obj.renderer || obj.drawableId === null) return;

            try {
                if (obj.renderer.setDrawableOrder) {
                    obj.renderer.setDrawableOrder(obj.drawableId, 1, obj.group);
                }
            } catch (e) {}
        }

        setFontFamily(args, util) {
            updateStyle(args, 'fontFamily', asString(args.FONT || 'Arial, sans-serif'), util);
        }

        setFontSize(args, util) {
            updateStyle(args, 'fontSize', finite(args.SIZE, 24, 1, 512), util);
        }

        setFontWeight(args, util) {
            var value = asString(args.WEIGHT || 'normal');
            if (!/^(normal|bold|bolder|lighter|[1-9]00)$/.test(value)) value = 'normal';
            updateStyle(args, 'fontWeight', value, util);
        }

        setBold(args, util) {
            updateStyle(args, 'fontWeight', asBoolean(args.BOLD) ? 'bold' : 'normal', util);
        }

        setItalic(args, util) {
            updateStyle(args, 'italic', asBoolean(args.ITALIC), util);
        }

        setTextColor(args, util) {
            updateStyle(args, 'fillColor', asString(args.COLOR || '#ffffff'), util);
        }

        setAlignment(args, util) {
            var value = asString(args.ALIGN);
            if (!['left', 'center', 'right'].includes(value)) value = 'left';
            updateStyle(args, 'align', value, util);
        }

        setVerticalAlignment(args, util) {
            var value = asString(args.ALIGN);
            if (!['top', 'middle', 'bottom'].includes(value)) value = 'top';
            updateStyle(args, 'verticalAlign', value, util);
        }

        setWrapWidth(args, util) {
            updateStyle(args, 'wrapWidth', finite(args.WIDTH, 0, 0, MAX_RENDER_DIMENSION), util);
        }

        setBoxHeight(args, util) {
            updateStyle(args, 'boxHeight', finite(args.HEIGHT, 0, 0, MAX_RENDER_DIMENSION), util);
        }

        setLineHeight(args, util) {
            updateStyle(args, 'lineHeight', finite(args.HEIGHT, 0, 0, 1024), util);
        }

        setPadding(args, util) {
            updateStyle(args, 'padding', finite(args.PADDING, 2, 0, 256), util);
        }

        setLetterSpacing(args, util) {
            updateStyle(args, 'letterSpacing', finite(args.SPACING, 0, -100, 100), util);
        }

        setTextTransform(args, util) {
            var value = asString(args.TRANSFORM);
            if (!['none', 'uppercase', 'lowercase', 'title case'].includes(value)) value = 'none';
            updateStyle(args, 'textTransform', value, util);
        }

        setMaxLines(args, util) {
            updateStyle(args, 'maxLines', Math.floor(finite(args.LINES, 0, 0, 4096)), util);
        }

        setWrapMode(args, util) {
            var value = asString(args.MODE) === 'characters' ? 'characters' : 'words';
            updateStyle(args, 'wrapMode', value, util);
        }

        setDirection(args, util) {
            var value = asString(args.DIRECTION);
            if (!['inherit', 'ltr', 'rtl'].includes(value)) value = 'inherit';
            updateStyle(args, 'direction', value, util);
        }

        setDecoration(args, util) {
            var value = asString(args.DECORATION);
            if (!['none', 'underline', 'strikethrough', 'both'].includes(value)) value = 'none';
            updateStyle(args, 'decoration', value, util);
        }

        setOutline(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.style.outlineColor = asString(args.COLOR || '#000000');
            obj.style.outlineWidth = finite(args.WIDTH, 0, 0, 64);
            renderObject(obj, util, false);
        }

        setShadow(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.style.shadowColor = asString(args.COLOR || 'rgba(0,0,0,0.5)');
            obj.style.shadowBlur = finite(args.BLUR, 0, 0, 128);
            obj.style.shadowX = finite(args.X, 0, -512, 512);
            obj.style.shadowY = finite(args.Y, 0, -512, 512);
            renderObject(obj, util, false);
        }

        setBackground(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.style.backgroundColor = asString(args.COLOR || 'transparent');
            obj.style.backgroundRadius = finite(args.RADIUS, 0, 0, 512);
            renderObject(obj, util, false);
        }

        setGradient(args, util) {
            var obj = findEntry(args.ID);
            if (!obj) return;

            obj.style.fillColor = asString(args.COLOR1 || '#ffffff');
            obj.style.gradientColor2 = asString(args.COLOR2 || '#00c8ff');
            obj.style.gradientAngle = finite(args.ANGLE, 0, -3600, 3600);
            renderObject(obj, util, false);
        }

        clearGradient(args, util) {
            updateStyle(args, 'gradientColor2', '', util);
        }

        setRasterQuality(args, util) {
            updateStyle(args, 'rasterScale', finite(args.QUALITY, 2, 0.25, 4), util);
        }

        refreshText(args, util) {
            var obj = findEntry(args.ID);
            if (obj) renderObject(obj, util, true);
        }

        refreshAllText(args, util) {
            var keys = Object.keys(objects);
            for (var i = 0; i < keys.length; i++) {
                renderObject(objects[keys[i]], util, true);
            }
        }

        textWidth(args) {
            var obj = findEntry(args.ID);
            return obj ? obj.renderedWidth : 0;
        }

        textHeight(args) {
            var obj = findEntry(args.ID);
            return obj ? obj.renderedHeight : 0;
        }

        renderedLineCount(args) {
            var obj = findEntry(args.ID);
            return obj ? obj.renderedLines : 0;
        }

        measureTextWidth(args) {
            try {
                var style = freshMeasureStyle(args.FONT, args.SIZE);
                return measureTextCached(asString(args.TEXT), fontString(style), 0);
            } catch (e) {
                lastError = 'Text measurement failed: ' + e.message;
                return 0;
            }
        }

        wrapText(args) {
            try {
                var style = freshMeasureStyle(args.FONT, args.SIZE);
                style.wrapWidth = finite(args.WIDTH, 160, 1, MAX_RENDER_DIMENSION);
                return calculateLines(clampText(args.TEXT), style).lines.join('\n');
            } catch (e) {
                lastError = 'Text wrapping failed: ' + e.message;
                return asString(args.TEXT);
            }
        }

        wrappedLineCount(args) {
            try {
                var style = freshMeasureStyle(args.FONT, args.SIZE);
                style.wrapWidth = finite(args.WIDTH, 160, 1, MAX_RENDER_DIMENSION);
                return calculateLines(clampText(args.TEXT), style).lines.length;
            } catch (e) {
                lastError = 'Text wrapping failed: ' + e.message;
                return 0;
            }
        }

        prewarmText(args, util) {
            try {
                var style = Object.assign({}, defaults);
                style.fontFamily = asString(args.FONT || 'Arial, sans-serif');
                style.fontSize = finite(args.SIZE, 24, 1, 512);
                style.fillColor = asString(args.COLOR || '#ffffff');

                var text = clampText(args.TEXT);
                var key = renderKey(text, style) + '\u0002' + style.rasterScale;

                if (cacheGet(key)) return;

                cacheMisses++;
                var image = renderToCanvas(text, style, style.rasterScale, getRenderer(util));
                cachePut(key, image);
            } catch (e) {
                lastError = 'Pre-caching text failed: ' + e.message;
            }
        }

        setCacheEnabled(args) {
            cacheEnabled = asBoolean(args.ENABLED);
        }

        clearTextCache() {
            renderCache.clear();
            cacheBytes = 0;
        }

        cacheStats() {
            return JSON.stringify({
                enabled: cacheEnabled,
                imageEntries: renderCache.size,
                imageBytes: cacheBytes,
                imageCacheHits: cacheHits,
                imageCacheMisses: cacheMisses,
                measureEntries: measureCache.size,
                measureCacheHits: measureHits,
                measureCacheMisses: measureMisses
            });
        }

        setDefaultFont(args) {
            defaults.fontFamily = asString(args.FONT || 'Arial, sans-serif');
            defaults.fontSize = finite(args.SIZE, 24, 1, 512);
            defaults.fillColor = asString(args.COLOR || '#ffffff');
        }

        setDefaultQuality(args) {
            defaults.rasterScale = finite(args.QUALITY, 2, 0.25, 4);
        }

        resetDefaults() {
            defaults = makeDefaultStyle();
        }

        uppercase(args) {
            return asString(args.TEXT).toUpperCase();
        }

        lowercase(args) {
            return asString(args.TEXT).toLowerCase();
        }

        titleCase(args) {
            return applyTransform(asString(args.TEXT), 'title case');
        }

        trimText(args) {
            return asString(args.TEXT).trim();
        }

        reverseText(args) {
            return graphemes(asString(args.TEXT)).reverse().join('');
        }

        replaceAllText(args) {
            var text = asString(args.TEXT);
            var find = asString(args.FIND);
            var replacement = asString(args.REPLACEMENT);
            return find === '' ? text : text.split(find).join(replacement);
        }

        textContains(args) {
            return asString(args.TEXT).includes(asString(args.FIND));
        }

        textIndexOf(args) {
            return asString(args.TEXT).indexOf(asString(args.FIND));
        }

        characterAt(args) {
            var list = graphemes(asString(args.TEXT));
            var index = Math.floor(finite(args.INDEX, 1, 1, 10000000)) - 1;
            return list[index] || '';
        }

        textLength(args) {
            return graphemes(asString(args.TEXT)).length;
        }

        substringText(args) {
            var list = graphemes(asString(args.TEXT));
            var start = Math.floor(finite(args.START, 1, 1, 10000000)) - 1;
            var end = Math.floor(finite(args.END, list.length, 0, 10000000));

            if (end < start) return '';
            return list.slice(start, end).join('');
        }

        countOccurrences(args) {
            var text = asString(args.TEXT);
            var find = asString(args.FIND);
            return find === '' ? 0 : text.split(find).length - 1;
        }

        removeWhitespace(args) {
            return asString(args.TEXT).replace(/\s+/g, '');
        }

        escapeHTML(args) {
            return asString(args.TEXT)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        encodeURI(args) {
            try {
                return encodeURIComponent(asString(args.TEXT));
            } catch (e) {
                return '';
            }
        }

        decodeURI(args) {
            try {
                return decodeURIComponent(asString(args.TEXT));
            } catch (e) {
                lastError = 'URL decoding failed: ' + e.message;
                return asString(args.TEXT);
            }
        }

        base64Encode(args) {
            return safeBase64Encode(asString(args.TEXT));
        }

        base64Decode(args) {
            return safeBase64Decode(asString(args.TEXT));
        }
    }

    var extension = new Extension();
    (async () => {})();
    Scratch.extensions.register(extension);
})(Scratch);
