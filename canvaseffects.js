/*
   Canvas Distortion for PenguinMod  v1
   made by scaliefanatic47 for the retro remix competition!
*/
(async function(Scratch) {
    const variables = {};

    if (!Scratch.extensions.unsandboxed) {
        alert("This extension needs to be unsandboxed to run!");
        return;
    }

    const ExtForge = {
        Broadcasts: new function() {
            this.raw_ = {};
            this.register = (name, blocks) => { this.raw_[name] = blocks; };
            this.execute  = async (name) => { if (this.raw_[name]) await this.raw_[name](); };
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
                if (v instanceof Array) return new ExtForge.Vector(Number(v[0]), Number(v[1]));
                if (v instanceof Object) return new ExtForge.Vector(Number(v.x), Number(v.y));
                return new ExtForge.Vector();
            }
            add(v) { return new Vector(this.x + v.x, this.y + v.y); }
            set(x, y) { return new Vector(x ?? this.x, y ?? this.y); }
        },
        Utils: {
            setList: (list, index, value) => { [...list][index] = value; return list; },
            lists_foreach: { index: [0], value: [null], depth: 0 },
            countString: (x, y) => y.length == 0 ? 0 : x.split(y).length - 1
        }
    };

    class Extension {
        constructor(runtime) {
            this.runtime = runtime;
            this.effects = { stage: {}, pen: {} };
            this.lastLayer = 'stage';
            this.svgRoot = null;
            this.filterElement = null;
            this.displacementMaps = {};
            this.stageCanvas = null;
            this.filterId = 'pm-canvas-distortion-filter';
            this.debug = true;

            this.bgColor = null;
            this.bgParent = null;
            this.originalParentBg = null;
            this.preserveBackground = false;

            console.log('[Distortion] Extension constructed');
            this.ensureSvg();
            this.findCanvas();
        }

        log(...a)   { if (this.debug) console.log('[Distortion]', ...a); }
        warn(...a)  { console.warn('[Distortion]', ...a); }
        error(...a) { console.error('[Distortion]', ...a); }

        ensureSvg() {
            if (this.svgRoot && this.svgRoot.parentNode) return this.svgRoot;
            try {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '0');
                svg.setAttribute('height', '0');
                svg.setAttribute('aria-hidden', 'true');
                Object.assign(svg.style, {
                    position: 'fixed', left: '-99999px', top: '-99999px',
                    width: '0', height: '0', overflow: 'hidden', pointerEvents: 'none'
                });
                document.body.appendChild(svg);
                this.svgRoot = svg;
                this.log('SVG root created');
            } catch (e) { this.error('Failed to create SVG root:', e); }
            return this.svgRoot;
        }

        findCanvas() {
            if (this.stageCanvas && this.stageCanvas.isConnected) return this.stageCanvas;
            this.stageCanvas = null;
            const vm = (typeof Scratch !== 'undefined' && Scratch.vm) || window.vm;
            const runtime = this.runtime || vm?.runtime;
            const renderer = runtime?.renderer;
            const tryCanvas = (name, c) => {
                if (c && c.tagName === 'CANVAS') {
                    this.log(`Found canvas via ${name}: ${c.width}x${c.height}`);
                    this.stageCanvas = c;
                    return true;
                }
                return false;
            };
            if (renderer) {
                if (tryCanvas('renderer.canvas', renderer.canvas)) return this.stageCanvas;
                if (tryCanvas('renderer.gl.canvas', renderer.gl && renderer.gl.canvas)) return this.stageCanvas;
                if (tryCanvas('renderer._canvas', renderer._canvas)) return this.stageCanvas;
            }
            const all = document.querySelectorAll('canvas');
            for (const c of all) {
                if (c.width === 480 && c.height === 360) { this.stageCanvas = c; return c; }
            }
            let largest = null, largestArea = 0;
            for (const c of all) {
                const area = c.width * c.height;
                if (area > largestArea && c.width >= 100 && c.height >= 100) { largest = c; largestArea = area; }
            }
            if (largest) { this.stageCanvas = largest; return largest; }
            this.warn('Could not find any stage canvas!');
            return null;
        }
        generateMap(effectName, strength, size = 256) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(size, size);
            const data = imageData.data;
            const cx = size / 2, cy = size / 2;
            const maxR = Math.sqrt(cx * cx + cy * cy);
            const s = Math.min(Math.max(Number(strength) || 0, 0), 100) / 100;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const i = (y * size + x) * 4;
                    const dx = x - cx, dy = y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                    const norm = dist / maxR;
                    let mag = 0;
                    if (effectName === 'bulge')          mag =  Math.cos(norm * Math.PI / 2) * s;
                    else if (effectName === 'shrink')    mag = -Math.cos(norm * Math.PI / 2) * s;
                    else if (effectName === 'fisheye')   mag =  Math.pow(norm, 2) * s;
                    data[i]     = Math.max(0, Math.min(255, Math.round(128 + (dx / dist) * mag * 127)));
                    data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + (dy / dist) * mag * 127)));
                    data[i + 2] = 0;
                    data[i + 3] = 255;
                }
            }
            ctx.putImageData(imageData, 0, 0);
            return canvas;
        }

        rebuildFilter() {
            if (!this.ensureSvg()) { this.error('No SVG root'); return; }

            if (this.filterElement && this.filterElement.parentNode) {
                this.filterElement.parentNode.removeChild(this.filterElement);
            }
            this.filterElement = null;

            const allEffects = { ...this.effects.stage, ...this.effects.pen };
            const active = Object.entries(allEffects).filter(([_, s]) => Number(s) > 0);
            this.log('Active effects:', active);

            if (active.length === 0) { this.applyFilter(); return; }

            const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
            filter.setAttribute('id', this.filterId);
            filter.setAttribute('x', '-50%');
            filter.setAttribute('y', '-50%');
            filter.setAttribute('width', '200%');
            filter.setAttribute('height', '200%');
            filter.setAttribute('filterUnits', 'objectBoundingBox');
            filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
            filter.setAttribute('color-interpolation-filters', 'sRGB');

            let prevResult = 'SourceGraphic';

            active.forEach(([name, strength], idx) => {
                const key = `${name}_${strength}`;
                let mapCanvas = this.displacementMaps[key];
                if (!mapCanvas) {
                    mapCanvas = this.generateMap(name, strength);
                    this.displacementMaps[key] = mapCanvas;
                }
                let url;
                try { url = mapCanvas.toDataURL('image/png'); }
                catch (e) { this.error('toDataURL failed:', e); return; }

                const feImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
                feImage.setAttribute('x', '0');
                feImage.setAttribute('y', '0');
                feImage.setAttribute('width', '100%');
                feImage.setAttribute('height', '100%');
                feImage.setAttribute('preserveAspectRatio', 'none');
                feImage.setAttribute('result', `map${idx}`);
                feImage.setAttribute('href', url);
                try { feImage.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url); } catch (_) {}
                filter.appendChild(feImage);

                const disp = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
                disp.setAttribute('in', prevResult);
                disp.setAttribute('in2', `map${idx}`);
                disp.setAttribute('scale', '100');
                disp.setAttribute('xChannelSelector', 'R');
                disp.setAttribute('yChannelSelector', 'G');
                disp.setAttribute('result', `disp${idx}`);
                filter.appendChild(disp);
                prevResult = `disp${idx}`;
            });

            if (this.preserveBackground) {
                const fill = document.createElementNS('http://www.w3.org/2000/svg', 'feComposite');
                fill.setAttribute('in', 'SourceGraphic');
                fill.setAttribute('in2', prevResult);
                fill.setAttribute('operator', 'out');
                fill.setAttribute('result', 'bgFill');
                filter.appendChild(fill);

                const merge = document.createElementNS('http://www.w3.org/2000/svg', 'feComposite');
                merge.setAttribute('in', 'bgFill');
                merge.setAttribute('in2', prevResult);
                merge.setAttribute('operator', 'over');
                filter.appendChild(merge);
            }

            this.svgRoot.appendChild(filter);
            this.filterElement = filter;
            this.log('Filter rebuilt (preserve=' + this.preserveBackground + ')');
            this.applyFilter();
        }

        applyFilter() {
            const canvas = this.findCanvas();
            if (!canvas) { this.warn('No canvas to filter'); return; }

            const layer = this.lastLayer || 'stage';
            const layerEffects = this.effects[layer] || {};
            const hasActive = Object.values(layerEffects).some(s => Number(s) > 0);

            let cssFilter = (hasActive && this.filterElement) ? `url(#${this.filterId})` : '';
            canvas.style.filter = cssFilter;
            canvas.style.webkitFilter = cssFilter;
            this.log(`CSS filter on canvas: "${cssFilter}" (layer=${layer})`);

            this.applyBackgroundColor();
        }

        applyBackgroundColor() {
            const canvas = this.findCanvas();
            if (!canvas) return;
            const parent = canvas.parentElement;
            if (!parent) return;

            if (this.bgColor) {
                if (this.bgParent !== parent) {
                    if (!this.bgParent) {
                        this.originalParentBg = parent.style.backgroundColor || '';
                    }
                    this.bgParent = parent;
                }
                parent.style.backgroundColor = this.bgColor;
                this.log(`Parent background set to ${this.bgColor}`);
            } else if (this.bgParent) {
                this.bgParent.style.backgroundColor = this.originalParentBg || '';
                this.log('Parent background restored');
                this.bgParent = null;
                this.originalParentBg = null;
            }
        }

        setBgColor(color) {
            this.bgColor = color;
            this.applyBackgroundColor();
        }

        clearBgColor() {
            this.bgColor = null;
            this.applyBackgroundColor();
        }

        setPreserveBackground(state) {
            this.preserveBackground = (state === 'on');
            this.rebuildFilter();
        }

        // --------------------------------------------------------------
        // Effect state
        // --------------------------------------------------------------
        setEffect(layer, effectName, strength) {
            if (!this.effects[layer]) this.effects[layer] = {};
            this.effects[layer][effectName] = Math.max(0, Number(strength) || 0);
            this.lastLayer = layer;
            this.rebuildFilter();
        }

        clearEffect(layer, effectName) {
            if (!this.effects[layer]) return;
            if (effectName) delete this.effects[layer][effectName];
            else this.effects[layer] = {};
            this.lastLayer = layer;
            this.rebuildFilter();
        }

        clearAll() {
            this.effects = { stage: {}, pen: {} };
            this.lastLayer = 'stage';
            this.rebuildFilter();
        }

        testFilter() {
            const c = this.findCanvas();
            if (!c) { this.error('No canvas for test'); return; }
            c.style.filter = 'blur(20px)';
            setTimeout(() => { c.style.filter = ''; }, 2000);
        }

        // --------------------------------------------------------------
        // Block definitions
        // --------------------------------------------------------------
        getInfo() {
            return {
                id: 'penguinmodCanvasDistortion',
                name: 'Canvas Distortion',
                color1: '#0fbd8c',
                blocks: [
                    {
                        opcode: 'applyEffect',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'apply [EFFECT] effect with strength [STRENGTH] to [LAYER]',
                        arguments: {
                            EFFECT:   { type: Scratch.ArgumentType.STRING, menu: 'effectMenu',  defaultValue: 'bulge' },
                            STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 60 },
                            LAYER:    { type: Scratch.ArgumentType.STRING, menu: 'layerMenu',   defaultValue: 'stage' }
                        }
                    },
                    {
                        opcode: 'setEffectBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set [EFFECT] effect strength to [STRENGTH] on [LAYER]',
                        arguments: {
                            EFFECT:   { type: Scratch.ArgumentType.STRING, menu: 'effectMenu',  defaultValue: 'fisheye' },
                            STRENGTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 30 },
                            LAYER:    { type: Scratch.ArgumentType.STRING, menu: 'layerMenu',   defaultValue: 'stage' }
                        }
                    },
                    {
                        opcode: 'clearEffectBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'clear [EFFECT] effect on [LAYER]',
                        arguments: {
                            EFFECT: { type: Scratch.ArgumentType.STRING, menu: 'effectMenu', defaultValue: 'bulge' },
                            LAYER:  { type: Scratch.ArgumentType.STRING, menu: 'layerMenu',  defaultValue: 'stage' }
                        }
                    },
                    {
                        opcode: 'clearAllBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'clear all distortion effects'
                    },
                    '---',
                    {
                        opcode: 'setBgColorBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'set canvas background fill to [COLOR]',
                        arguments: {
                            COLOR: { type: Scratch.ArgumentType.COLOR, defaultValue: '#0a0a0a' }
                        }
                    },
                    {
                        opcode: 'clearBgColorBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'clear canvas background fill'
                    },
                    {
                        opcode: 'setPreserveBackgroundBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'preserve background (fill distortion gaps with original): [STATE]',
                        arguments: {
                            STATE: {
                                type: Scratch.ArgumentType.STRING,
                                menu: 'onOffMenu',
                                defaultValue: 'on'
                            }
                        }
                    },
                    '---',
                    {
                        opcode: 'testFilterBlock',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'TEST: flash 20px blur on canvas (debug)'
                    }
                ],
                menus: {
                    effectMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'bulge',   value: 'bulge'   },
                            { text: 'shrink',  value: 'shrink'  },
                            { text: 'fisheye', value: 'fisheye' }
                        ]
                    },
                    layerMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'entire stage', value: 'stage' },
                            { text: 'pen layer',    value: 'pen'   }
                        ]
                    },
                    onOffMenu: {
                        acceptReporters: false,
                        items: [
                            { text: 'on',  value: 'on'  },
                            { text: 'off', value: 'off' }
                        ]
                    }
                }
            };
        }

        // --------------------------------------------------------------
        // Block implementations
        // --------------------------------------------------------------
        applyEffect(args)                { this.setEffect(args.LAYER, args.EFFECT, args.STRENGTH); }
        setEffectBlock(args)             { this.setEffect(args.LAYER, args.EFFECT, args.STRENGTH); }
        clearEffectBlock(args)           { this.clearEffect(args.LAYER, args.EFFECT); }
        clearAllBlock()                  { this.clearAll(); }
        setBgColorBlock(args)            { this.setBgColor(args.COLOR); }
        clearBgColorBlock()              { this.clearBgColor(); }
        setPreserveBackgroundBlock(args) { this.setPreserveBackground(args.STATE); }
        testFilterBlock()                { this.testFilter(); }
    }

    let extension = new Extension(Scratch.vm?.runtime);
    Scratch.extensions.register(extension);
})(Scratch);
