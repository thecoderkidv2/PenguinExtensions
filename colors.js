class colors {
  getInfo() {
    return {
      id: 'colors',
      name: 'Colors',
      color1: '#FF8C00',
      color2: '#FFA533',
      color3: '#FFBF66',
      blocks: [
        {
          opcode: 'rgbaToHex',
          blockType: Scratch.BlockType.REPORTER,
          text: 'RGBA [RGBA] to hex',
          arguments: {
            RGBA: {
              type: Scratch.ArgumentType.STRING,
              defaultValue: '[255, 122, 171, 1]'
            }
          }
        },
        {
          opcode: 'hexToRgba',
          blockType: Scratch.BlockType.REPORTER,
          text: 'hex [HEX] to RGBA',
          arguments: {
            HEX: {
              type: Scratch.ArgumentType.STRING,
              defaultValue: '#ff7aab'
            }
          }
        },
        {
          opcode: 'rgbToHex',
          blockType: Scratch.BlockType.REPORTER,
          text: 'RGB [R] [G] [B] to hex',
          arguments: {
            R: { type: Scratch.ArgumentType.NUMBER, defaultValue: 255 },
            G: { type: Scratch.ArgumentType.NUMBER, defaultValue: 122 },
            B: { type: Scratch.ArgumentType.NUMBER, defaultValue: 171 }
          }
        },
        {
          opcode: 'hexToRgb',
          blockType: Scratch.BlockType.REPORTER,
          text: 'hex [HEX] to RGB array',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' }
          }
        },
        {
          opcode: 'hslToHex',
          blockType: Scratch.BlockType.REPORTER,
          text: 'HSL [H] [S] [L] to hex',
          arguments: {
            H: { type: Scratch.ArgumentType.NUMBER, defaultValue: 338 },
            S: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 },
            L: { type: Scratch.ArgumentType.NUMBER, defaultValue: 74 }
          }
        },
        {
          opcode: 'hexToHsl',
          blockType: Scratch.BlockType.REPORTER,
          text: 'hex [HEX] to HSL array',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' }
          }
        },
        {
          opcode: 'hsvToHex',
          blockType: Scratch.BlockType.REPORTER,
          text: 'HSV [H] [S] [V] to hex',
          arguments: {
            H: { type: Scratch.ArgumentType.NUMBER, defaultValue: 338 },
            S: { type: Scratch.ArgumentType.NUMBER, defaultValue: 52 },
            V: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 }
          }
        },
        {
          opcode: 'hexToHsv',
          blockType: Scratch.BlockType.REPORTER,
          text: 'hex [HEX] to HSV array',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' }
          }
        },
        {
          opcode: 'lighten',
          blockType: Scratch.BlockType.REPORTER,
          text: 'lighten [HEX] by [AMOUNT]%',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' },
            AMOUNT: { type: Scratch.ArgumentType.NUMBER, defaultValue: 20 }
          }
        },
        {
          opcode: 'darken',
          blockType: Scratch.BlockType.REPORTER,
          text: 'darken [HEX] by [AMOUNT]%',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' },
            AMOUNT: { type: Scratch.ArgumentType.NUMBER, defaultValue: 20 }
          }
        },
        {
          opcode: 'mix',
          blockType: Scratch.BlockType.REPORTER,
          text: 'mix [HEX1] with [HEX2] by [WEIGHT]%',
          arguments: {
            HEX1: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' },
            HEX2: { type: Scratch.ArgumentType.STRING, defaultValue: '#7aabff' },
            WEIGHT: { type: Scratch.ArgumentType.NUMBER, defaultValue: 50 }
          }
        },
        {
          opcode: 'invert',
          blockType: Scratch.BlockType.REPORTER,
          text: 'invert [HEX]',
          arguments: {
            HEX: { type: Scratch.ArgumentType.STRING, defaultValue: '#ff7aab' }
          }
        }
      ]
    };
  }

  // --- Helper Functions ---
  _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  _parseHex(hex) {
    hex = Scratch.Cast.toString(hex).replace('#', '');
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length !== 6) {
      return { r: 0, g: 0, b: 0 };
    }
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16)
    };
  }

  _rgbToHex(r, g, b) {
    const toHex = (c) => {
      const hex = this._clamp(Math.round(c), 0, 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  _rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  _hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h, s = max === 0 ? 0 : d / max, v = max;

    if (max === min) {
      h = 0;
    } else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(v * 100)];
  }

  _hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  // --- Block Implementations ---

  rgbaToHex(args) {
    const rgba = Scratch.Cast.toString(args.RGBA);
    let r = 0, g = 0, b = 0;
    // Try to parse common array formats like [255, 122, 171, 1] or 255,122,171
    const values = rgba.replace(/[\[\]\s]/g, '').split(',');
    if (values.length >= 3) {
      r = parseFloat(values[0]);
      g = parseFloat(values[1]);
      b = parseFloat(values[2]);
    }
    return this._rgbToHex(r, g, b);
  }

  hexToRgba(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    return `[${r}, ${g}, ${b}, 1]`;
  }

  rgbToHex(args) {
    return this._rgbToHex(args.R, args.G, args.B);
  }

  hexToRgb(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    return `[${r}, ${g}, ${b}]`;
  }

  hslToHex(args) {
    const [r, g, b] = this._hslToRgb(args.H, args.S, args.L);
    return this._rgbToHex(r, g, b);
  }

  hexToHsl(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    return JSON.stringify(this._rgbToHsl(r, g, b));
  }

  hsvToHex(args) {
    const [r, g, b] = this._hsvToRgb(args.H, args.S, args.V);
    return this._rgbToHex(r, g, b);
  }

  hexToHsv(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    return JSON.stringify(this._rgbToHsv(r, g, b));
  }

  lighten(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    const amount = args.AMOUNT / 100;
    const newR = r + (255 - r) * amount;
    const newG = g + (255 - g) * amount;
    const newB = b + (255 - b) * amount;
    return this._rgbToHex(newR, newG, newB);
  }

  darken(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    const amount = args.AMOUNT / 100;
    const newR = r * (1 - amount);
    const newG = g * (1 - amount);
    const newB = b * (1 - amount);
    return this._rgbToHex(newR, newG, newB);
  }

  mix(args) {
    const c1 = this._parseHex(args.HEX1);
    const c2 = this._parseHex(args.HEX2);
    const weight = args.WEIGHT / 100;

    const r = c1.r * (1 - weight) + c2.r * weight;
    const g = c1.g * (1 - weight) + c2.g * weight;
    const b = c1.b * (1 - weight) + c2.b * weight;

    return this._rgbToHex(r, g, b);
  }

  invert(args) {
    const { r, g, b } = this._parseHex(args.HEX);
    return this._rgbToHex(255 - r, 255 - g, 255 - b);
  }
}

Scratch.extensions.register(new colors());
