class OffstageRendering {
  constructor() {
    this.overlays = new Map(); // spriteName -> overlay object
    this.loopId = null;
    this.vm = Scratch.vm;
    this._stageSize = { width: 480, height: 360 };
    this._canvasRect = null;
    this._costumeCache = new Map(); // cache data URIs by asset id
  }

  getInfo() {
    return {
      id: 'offstageOverlay',
      name: 'Offstage Rendering',
      color1: '#0FBD8C',
      color2: '#0DA57A',
      color3: '#0B8C68',
      blocks: [
        {
          opcode: 'start',
          blockType: Scratch.BlockType.COMMAND,
          text: 'render [SPRITE] outside stage',
          arguments: {
            SPRITE: {
              type: Scratch.ArgumentType.STRING,
              menu: 'SPRITE_MENU'
            }
          }
        },
        {
          opcode: 'stop',
          blockType: Scratch.BlockType.COMMAND,
          text: 'stop rendering [SPRITE] outside stage',
          arguments: {
            SPRITE: {
              type: Scratch.ArgumentType.STRING,
              menu: 'SPRITE_MENU'
            }
          }
        },
        {
          opcode: 'stopAll',
          blockType: Scratch.BlockType.COMMAND,
          text: 'stop all offstage rendering'
        }
      ],
      menus: {
        SPRITE_MENU: {
          acceptReporters: true,
          items: '_getSpriteNames'
        }
      }
    };
  }

  _getSpriteNames() {
    const names = [];
    for (const target of this.vm.runtime.targets) {
      if (!target.isStage && target.sprite && target.sprite.name) {
        names.push(target.sprite.name);
      }
    }
    return names.sort();
  }

  _getStageSize() {
    // PenguinMod exposes stageWidth / stageHeight on the runtime.
    const w = this.vm.runtime.stageWidth || 480;
    const h = this.vm.runtime.stageHeight || 360;
    return { width: w, height: h };
  }

  _ensureCanvasRect() {
    const canvas = this.vm.renderer && this.vm.renderer.canvas;
    if (canvas) {
      this._canvasRect = canvas.getBoundingClientRect();
    } else {
      this._canvasRect = null;
    }
  }

  _createOverlayElement() {
    const img = document.createElement('img');
    img.style.position = 'absolute';
    img.style.pointerEvents = 'none';
    img.style.userSelect = 'none';
    img.style.willChange = 'transform, width, height, left, top, opacity, filter';
    return img;
  }

  _createOverlayContainer() {
    if (this._container) return this._container;

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100vw';
    container.style.height = '100vh';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '9999';
    container.style.overflow = 'hidden';
    document.body.appendChild(container);

    this._container = container;
    return container;
  }

  _updateClipPath() {
    if (!this._container) return;

    const rect = this._canvasRect;
    if (!rect) {
      // No stage – show everything
      this._container.style.clipPath = 'none';
      return;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const left = (rect.left / vw) * 100;
    const right = (rect.right / vw) * 100;
    const top = (rect.top / vh) * 100;
    const bottom = (rect.bottom / vh) * 100;

    // Outer rectangle + inner "hole" for the stage.
    // The inner path is traced in reverse order.
    const path = `polygon(
      0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
      ${left}% ${top}%,
      ${right}% ${top}%,
      ${right}% ${bottom}%,
      ${left}% ${bottom}%,
      ${left}% ${top}%
    )`;

    this._container.style.clipPath = path;
  }

  _startLoop() {
    if (this.loopId) return;

    const step = () => {
      this._update();
      this.loopId = requestAnimationFrame(step);
    };
    this.loopId = requestAnimationFrame(step);
  }

  _stopLoopIfEmpty() {
    if (this.overlays.size === 0 && this.loopId) {
      cancelAnimationFrame(this.loopId);
      this.loopId = null;
    }
  }

  _update() {
    if (this.overlays.size === 0) return;

    this._ensureCanvasRect();
    this._updateClipPath();

    const stageSize = this._getStageSize();
    const canvas = this.vm.renderer && this.vm.renderer.canvas;
    if (!canvas) return;

    const rect = this._canvasRect;
    if (!rect) return;

    const scaleX = rect.width / stageSize.width;
    const scaleY = rect.height / stageSize.height;

    for (const [spriteName, overlay] of this.overlays) {
      const target = this.vm.runtime.getSpriteTargetByName(spriteName);
      if (!target) {
        this._removeOverlay(spriteName);
        continue;
      }

      // Visibility
      if (!target.visible) {
        overlay.img.style.display = 'none';
        continue;
      } else {
        overlay.img.style.display = '';
      }

      // Position (Scratch stage coordinates -> screen coordinates)
      const screenX = rect.left + (stageSize.width / 2 + target.x) * scaleX;
      const screenY = rect.top + (stageSize.height / 2 - target.y) * scaleY;

      // Costume data
      const costume = target.getCurrentCostume();
      if (!costume) continue;

      const assetId = costume.asset && costume.asset.assetId;
      if (assetId && this._costumeCache.has(assetId)) {
        overlay.img.src = this._costumeCache.get(assetId);
      } else {
        // Fetch and cache the data URI.
        const uriPromise = costume.asset.encodeDataURI();
        if (uriPromise && typeof uriPromise.then === 'function') {
          uriPromise.then(uri => {
            if (assetId) this._costumeCache.set(assetId, uri);
            if (this.overlays.has(spriteName)) {
              overlay.img.src = uri;
            }
          });
        } else {
          overlay.img.src = costume.asset.encodeDataURI();
        }
      }

      // Wait for the image to load to know its natural size.
      if (!overlay.img.complete || overlay.img.naturalWidth === 0) {
        overlay.img.onload = () => {
          overlay.naturalWidth = overlay.img.naturalWidth;
          overlay.naturalHeight = overlay.img.naturalHeight;
        };
      } else {
        overlay.naturalWidth = overlay.img.naturalWidth;
        overlay.naturalHeight = overlay.img.naturalHeight;
      }

      const nw = overlay.naturalWidth || 0;
      const nh = overlay.naturalHeight || 0;
      if (!nw || !nh) {
        // Skip until the image has loaded.
        continue;
      }

      const bitmapRes = costume.bitmapResolution || 1;
      const spriteScale = (target.size || 100) / 100;

      const width = (nw / bitmapRes) * spriteScale * scaleX;
      const height = (nh / bitmapRes) * spriteScale * scaleY;

      // Rotation centre in image pixels (relative to the top‑left of the image).
      const rotX = (costume.rotationCenterX / bitmapRes) * spriteScale * scaleX;
      const rotY = (costume.rotationCenterY / bitmapRes) * spriteScale * scaleY;

      // Place the image so that its rotation centre sits at the sprite's screen position.
      overlay.img.style.left = `${screenX - rotX}px`;
      overlay.img.style.top = `${screenY - rotY}px`;
      overlay.img.style.width = `${width}px`;
      overlay.img.style.height = `${height}px`;
      overlay.img.style.transformOrigin = `${rotX}px ${rotY}px`;
      overlay.img.style.transform = `rotate(${target.direction}deg)`;

      // Ghost effect (0 = invisible, 100 = opaque in Scratch; CSS opacity is the reverse).
      const ghost = target.effects.ghost || 0;
      overlay.img.style.opacity = `${1 - ghost / 100}`;

      // Brightness effect (Scratch range -100..100 → CSS brightness roughly 0..2).
      const brightness = target.effects.brightness || 0;
      overlay.img.style.filter = `brightness(${1 + brightness / 100})`;

      // Colour effect can be approximated with hue‑rotate.
      const colour = target.effects.color || 0;
      if (colour !== 0) {
        overlay.img.style.filter += ` hue-rotate(${colour * 1.8}deg)`;
      }
    }
  }

  _removeOverlay(spriteName) {
    const overlay = this.overlays.get(spriteName);
    if (!overlay) return;

    if (overlay.img && overlay.img.parentNode) {
      overlay.img.parentNode.removeChild(overlay.img);
    }
    this.overlays.delete(spriteName);
    this._stopLoopIfEmpty();
  }

  _ensureContainer() {
    if (!this._container) {
      this._createOverlayContainer();
    }
    return this._container;
  }

  start(args) {
    const spriteName = args.SPRITE;
    if (!spriteName) return;

    const target = this.vm.runtime.getSpriteTargetByName(spriteName);
    if (!target) {
      console.warn(`Offstage Rendering: sprite "${spriteName}" not found.`);
      return;
    }

    if (this.overlays.has(spriteName)) {
      // Already rendering.
      return;
    }

    const container = this._ensureContainer();
    const img = this._createOverlayElement();
    container.appendChild(img);

    this.overlays.set(spriteName, {
      img,
      naturalWidth: 0,
      naturalHeight: 0
    });

    this._startLoop();
  }

  stop(args) {
    const spriteName = args.SPRITE;
    if (spriteName) {
      this._removeOverlay(spriteName);
    }
  }

  stopAll() {
    for (const spriteName of Array.from(this.overlays.keys())) {
      this._removeOverlay(spriteName);
    }
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
  }
}

// Unsandboxed check
if (!Scratch.extensions.unsandboxed) {
  throw new Error(
    'Offstage Rendering must run unsandboxed. Please enable "Run extension without sandbox".'
  );
}

Scratch.extensions.register(new OffstageRendering());
