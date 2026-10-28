/*
   Speedi Noise v1.3
   Created for PenguinMod
   WebGL2 noise image generator.
*/

(async function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        alert('Speedi Noise needs to run unsandboxed!');
        return;
    }

    const BT = Scratch.BlockType || {};
    const AT = Scratch.ArgumentType || {};
    const REPORTER = BT.REPORTER || 'reporter';
    const COMMAND = BT.COMMAND || 'command';
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
    const command = (opcode, text, args) => ({ opcode, blockType: COMMAND, text, arguments: args || {} });

    const finite = (v, fallback, min, max) => {
        let num = Number(v);
        if (!Number.isFinite(num)) num = fallback;
        if (min !== undefined) num = Math.max(min, num);
        if (max !== undefined) num = Math.min(max, num);
        return num;
    };
    const asString = (v) => (v === null || v === undefined ? '' : String(v));
    const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

    const hashString32 = (str) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    };

    // Any input -> deterministic float in [0, 1024).
    const seedToFloat = (v) => {
        const str = asString(v);
        return hashString32(str) / 4294967296 * 1024;
    };

    const NOISE_INDEX = {
        white: 0, blue: 1, brown: 2, voronoi: 3, perlin: 4,
        value: 5, 'value (fast)': 5, simplex: 6, 'simplex (fast)': 6
    };
    const DIM_INDEX = { '2d': 2, '2': 2, '3d': 3, '3': 3, '4d': 4, '4': 4 };

    const noiseIndexFromName = (name) => {
        const key = asString(name).trim().toLowerCase();
        return (key in NOISE_INDEX) ? NOISE_INDEX[key] : 4;
    };
    const dimFromName = (name) => {
        const key = asString(name).trim().toLowerCase();
        return (key in DIM_INDEX) ? DIM_INDEX[key] : 2;
    };

    // ------------------------------------------------------------------
    // WebGL2 plumbing
    // ------------------------------------------------------------------
    const glState = {
        canvas: null,
        gl: null,
        vao: null,
        buffer: null,
        programs: {}
    };

    const VS_SRC = [
        '#version 300 es',
        'in vec2 aPos;',
        'out vec2 vUv;',
        'void main(){',
        '  vUv = aPos * 0.5 + 0.5;',
        '  gl_Position = vec4(aPos, 0.0, 1.0);',
        '}'
    ].join('\n');

    // Everything before rawNoise goes in HEAD.
    // A placeholder line marks where user-supplied custom noise is injected.
    const FRAG_HEAD_LINES = [
        'precision highp float;',
        '',
        'in vec2 vUv;',
        'out vec4 outColor;',
        '',
        'uniform float uSeed;',
        'uniform float uScale;',
        'uniform float uUniformity;',
        'uniform int   uOctaves;',
        'uniform float uPersistence;',
        'uniform float uLacunarity;',
        'uniform float uOffsetX;',
        'uniform float uOffsetY;',
        'uniform float uZ;',
        'uniform float uW;',
        'uniform int   uColorMode;',
        'uniform int   uInvert;',
        '',
        '#define PI  3.141592653589793',
        '#define TAU 6.283185307179586',
        '',
        'vec2  gPix;',
        'float gChannel;',
        '',
        'float hash11(float p){',
        '    p = fract(p * 0.1031);',
        '    p *= p + 33.33;',
        '    p *= p + p;',
        '    return fract(p);',
        '}',
        'float hash12(vec2 p){',
        '    vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
        '    p3 += dot(p3, p3.yzx + 33.33);',
        '    return fract((p3.x + p3.y) * p3.z);',
        '}',
        'float hash13(vec3 p3){',
        '    p3 = fract(p3 * 0.1031);',
        '    p3 += dot(p3, p3.zyx + 31.32);',
        '    return fract((p3.x + p3.y) * p3.z);',
        '}',
        'float hash14(vec4 p4){',
        '    p4 = fract(p4 * 0.1031);',
        '    p4 += dot(p4, p4.wzxy + 33.33);',
        '    return fract((p4.x + p4.y) * (p4.z + p4.w));',
        '}',
        '',
        'float valueNoise2(vec2 p){',
        '    vec2 i = floor(p), f = fract(p);',
        '    vec2 u = f * f * (3.0 - 2.0 * f);',
        '    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),',
        '               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);',
        '}',
        'float valueNoise3(vec3 p){',
        '    vec3 i = floor(p), f = fract(p);',
        '    vec3 u = f * f * (3.0 - 2.0 * f);',
        '    float n = 0.0;',
        '    for (int z = 0; z < 2; z++)',
        '    for (int y = 0; y < 2; y++)',
        '    for (int x = 0; x < 2; x++){',
        '        vec3 o = vec3(float(x), float(y), float(z));',
        '        vec3 w = mix(1.0 - u, u, o);',
        '        n += hash13(i + o) * w.x * w.y * w.z;',
        '    }',
        '    return n;',
        '}',
        'float valueNoise4(vec4 p){',
        '    vec4 i = floor(p), f = fract(p);',
        '    vec4 u = f * f * (3.0 - 2.0 * f);',
        '    float n = 0.0;',
        '    for (int w4 = 0; w4 < 2; w4++)',
        '    for (int z = 0; z < 2; z++)',
        '    for (int y = 0; y < 2; y++)',
        '    for (int x = 0; x < 2; x++){',
        '        vec4 o = vec4(float(x), float(y), float(z), float(w4));',
        '        vec4 w = mix(1.0 - u, u, o);',
        '        n += hash14(i + o) * w.x * w.y * w.z * w.w;',
        '    }',
        '    return n;',
        '}',
        '',
        'vec2 grad2(vec2 i){ float a = hash12(i) * TAU; return vec2(cos(a), sin(a)); }',
        'vec3 grad3(vec3 i){',
        '    float a = hash13(i) * TAU;',
        '    float b = hash13(i + 17.17) * PI;',
        '    float sb = sin(b);',
        '    return vec3(cos(a) * sb, sin(a) * sb, cos(b));',
        '}',
        'vec4 grad4v(vec4 i){',
        '    vec4 g = vec4(hash14(i), hash14(i + 11.1), hash14(i + 23.3), hash14(i + 37.7)) * 2.0 - 1.0;',
        '    return normalize(g + vec4(1e-4));',
        '}',
        'float perlin2(vec2 p){',
        '    vec2 i = floor(p), f = fract(p);',
        '    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
        '    float a = dot(grad2(i), f);',
        '    float b = dot(grad2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));',
        '    float c = dot(grad2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));',
        '    float d = dot(grad2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));',
        '    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
        '}',
        'float perlin3(vec3 p){',
        '    vec3 i = floor(p), f = fract(p);',
        '    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
        '    float n = 0.0;',
        '    for (int z = 0; z < 2; z++)',
        '    for (int y = 0; y < 2; y++)',
        '    for (int x = 0; x < 2; x++){',
        '        vec3 o = vec3(float(x), float(y), float(z));',
        '        vec3 w = mix(1.0 - u, u, o);',
        '        n += dot(grad3(i + o), f - o) * w.x * w.y * w.z;',
        '    }',
        '    return n;',
        '}',
        'float perlin4(vec4 p){',
        '    vec4 i = floor(p), f = fract(p);',
        '    vec4 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);',
        '    float n = 0.0;',
        '    for (int w4 = 0; w4 < 2; w4++)',
        '    for (int z = 0; z < 2; z++)',
        '    for (int y = 0; y < 2; y++)',
        '    for (int x = 0; x < 2; x++){',
        '        vec4 o = vec4(float(x), float(y), float(z), float(w4));',
        '        vec4 w = mix(1.0 - u, u, o);',
        '        n += dot(grad4v(i + o), f - o) * w.x * w.y * w.z * w.w;',
        '    }',
        '    return n;',
        '}',
        '',
        'float voronoi2(vec2 p){',
        '    vec2 i = floor(p), f = fract(p);',
        '    float md = 8.0;',
        '    for (int y = -1; y <= 1; y++)',
        '    for (int x = -1; x <= 1; x++){',
        '        vec2 o = vec2(float(x), float(y));',
        '        vec2 h = vec2(hash12(i + o), hash12(i + o + vec2(37.1, 17.7)));',
        '        vec2 r = o + h - f;',
        '        md = min(md, dot(r, r));',
        '    }',
        '    return clamp(sqrt(md), 0.0, 1.0);',
        '}',
        'float voronoi3(vec3 p){',
        '    vec3 i = floor(p), f = fract(p);',
        '    float md = 8.0;',
        '    for (int z = -1; z <= 1; z++)',
        '    for (int y = -1; y <= 1; y++)',
        '    for (int x = -1; x <= 1; x++){',
        '        vec3 o = vec3(float(x), float(y), float(z));',
        '        vec3 h = vec3(hash13(i + o),',
        '            hash13(i + o + vec3(37.1, 17.7, 53.3)),',
        '            hash13(i + o + vec3(11.3, 71.9, 29.1)));',
        '        vec3 r = o + h - f;',
        '        md = min(md, dot(r, r));',
        '    }',
        '    return clamp(sqrt(md), 0.0, 1.0);',
        '}',
        'float voronoi4(vec4 p){',
        '    vec4 i = floor(p), f = fract(p);',
        '    float md = 8.0;',
        '    for (int w4 = -1; w4 <= 1; w4++)',
        '    for (int z = -1; z <= 1; z++)',
        '    for (int y = -1; y <= 1; y++)',
        '    for (int x = -1; x <= 1; x++){',
        '        vec4 o = vec4(float(x), float(y), float(z), float(w4));',
        '        vec4 h = vec4(hash14(i + o),',
        '            hash14(i + o + vec4(37.1, 17.7, 53.3, 11.1)),',
        '            hash14(i + o + vec4(11.3, 71.9, 29.1, 43.7)),',
        '            hash14(i + o + vec4(23.9, 13.1, 61.3, 7.7)));',
        '        vec4 r = o + h - f;',
        '        md = min(md, dot(r, r));',
        '    }',
        '    return clamp(sqrt(md), 0.0, 1.0);',
        '}',
        '',
        'vec2 mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
        'vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
        'vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
        'float mod289(float x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
        'vec3 permute(vec3 x){ return mod289(((x * 34.0) + 1.0) * x); }',
        'vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }',
        'float permute(float x){ return mod289(((x * 34.0) + 1.0) * x); }',
        'vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }',
        '',
        'float snoise2(vec2 v){',
        '    const vec4 C = vec4(0.211324865405187, 0.366025403784439,',
        '                       -0.577350269189626, 0.024390243902439);',
        '    vec2 i  = floor(v + dot(v, C.yy));',
        '    vec2 x0 = v - i + dot(i, C.xx);',
        '    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);',
        '    vec4 x12 = x0.xyxy + C.xxzz;',
        '    x12.xy -= i1;',
        '    i = mod289(i);',
        '    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));',
        '    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);',
        '    m = m * m; m = m * m;',
        '    vec3 x = 2.0 * fract(p * C.www) - 1.0;',
        '    vec3 h = abs(x) - 0.5;',
        '    vec3 ox = floor(x + 0.5);',
        '    vec3 a0 = x - ox;',
        '    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);',
        '    vec3 g;',
        '    g.x  = a0.x * x0.x + h.x * x0.y;',
        '    g.yz = a0.yz * x12.xz + h.yz * x12.yw;',
        '    return 130.0 * dot(m, g);',
        '}',
        'float snoise3(vec3 v){',
        '    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);',
        '    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
        '    vec3 i  = floor(v + dot(v, C.yyy));',
        '    vec3 x0 = v - i + dot(i, C.xxx);',
        '    vec3 g = step(x0.yzx, x0.xyz);',
        '    vec3 l = 1.0 - g;',
        '    vec3 i1 = min(g.xyz, l.zxy);',
        '    vec3 i2 = max(g.xyz, l.zxy);',
        '    vec3 x1 = x0 - i1 + C.xxx;',
        '    vec3 x2 = x0 - i2 + C.yyy;',
        '    vec3 x3 = x0 - D.yyy;',
        '    i = mod289(i);',
        '    vec4 p = permute(permute(permute(',
        '                i.z + vec4(0.0, i1.z, i2.z, 1.0))',
        '              + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
        '              + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
        '    float n_ = 0.142857142857;',
        '    vec3 ns = n_ * D.wyz - D.xzx;',
        '    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
        '    vec4 x_ = floor(j * ns.z);',
        '    vec4 y_ = floor(j - 7.0 * x_);',
        '    vec4 x = x_ * ns.x + ns.yyyy;',
        '    vec4 y = y_ * ns.x + ns.yyyy;',
        '    vec4 h = 1.0 - abs(x) - abs(y);',
        '    vec4 b0 = vec4(x.xy, y.xy);',
        '    vec4 b1 = vec4(x.zw, y.zw);',
        '    vec4 s0 = floor(b0) * 2.0 + 1.0;',
        '    vec4 s1 = floor(b1) * 2.0 + 1.0;',
        '    vec4 sh = -step(h, vec4(0.0));',
        '    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;',
        '    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
        '    vec3 p0 = vec3(a0.xy, h.x);',
        '    vec3 p1 = vec3(a0.zw, h.y);',
        '    vec3 p2 = vec3(a1.xy, h.z);',
        '    vec3 p3 = vec3(a1.zw, h.w);',
        '    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
        '    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
        '    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);',
        '    m = m * m;',
        '    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));',
        '}',
        'vec4 grad4s(float j, vec4 ip){',
        '    const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);',
        '    vec4 p, s;',
        '    p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;',
        '    p.w = 1.5 - dot(abs(p.xyz), ones.xyz);',
        '    s = step(p, vec4(0.0));',
        '    p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;',
        '    return p;',
        '}',
        'float snoise4(vec4 v){',
        '    const vec4 C = vec4(0.138196601125011, 0.276393202250021,',
        '                        0.414589803375032, -0.447213595499958);',
        '    vec4 i  = floor(v + dot(v, vec4(0.309016994374947451)));',
        '    vec4 x0 = v - i + dot(i, C.xxxx);',
        '    vec4 i0;',
        '    vec3 isX = step(x0.yzw, x0.xxx);',
        '    vec3 isYZ = step(x0.zww, x0.yyz);',
        '    i0.x = isX.x + isX.y + isX.z;',
        '    i0.yzw = 1.0 - isX;',
        '    i0.y += isYZ.x + isYZ.y;',
        '    i0.zw += 1.0 - isYZ.xy;',
        '    i0.z += isYZ.z;',
        '    i0.w += 1.0 - isYZ.z;',
        '    vec4 i3 = clamp(i0, 0.0, 1.0);',
        '    vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);',
        '    vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);',
        '    vec4 x1 = x0 - i1 + C.xxxx;',
        '    vec4 x2 = x0 - i2 + C.yyyy;',
        '    vec4 x3 = x0 - i3 + C.zzzz;',
        '    vec4 x4 = x0 + C.wwww;',
        '    i = mod289(i);',
        '    float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);',
        '    vec4 j1 = permute(permute(permute(permute(',
        '                i.w + vec4(i1.w, i2.w, i3.w, 1.0))',
        '              + i.z + vec4(i1.z, i2.z, i3.z, 1.0))',
        '              + i.y + vec4(i1.y, i2.y, i3.y, 1.0))',
        '              + i.x + vec4(i1.x, i2.x, i3.x, 1.0));',
        '    vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);',
        '    vec4 p0 = grad4s(j0, ip);',
        '    vec4 p1 = grad4s(j1.x, ip);',
        '    vec4 p2 = grad4s(j1.y, ip);',
        '    vec4 p3 = grad4s(j1.z, ip);',
        '    vec4 p4 = grad4s(j1.w, ip);',
        '    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
        '    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
        '    p4 *= inversesqrt(dot(p4, p4));',
        '    vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);',
        '    vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);',
        '    m0 = m0 * m0; m1 = m1 * m1;',
        '    return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))',
        '                 + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));',
        '}',
        '',
        'vec4 buildCoord(vec2 uv, float ch){',
        '    vec2 so = vec2(uSeed * 1.61803398875, uSeed * 2.41421356237)',
        '            + vec2(ch * 13.37, ch * 27.73);',
        '    vec2 p = uv * uScale + vec2(uOffsetX, uOffsetY) + so;',
        '    float z = uZ + uSeed * 3.14159265 + ch * 7.7;',
        '    float w = uW + uSeed * 5.79128784 + ch * 9.1;',
        '    return vec4(p, z, w);',
        '}',
        '',
        '//__CUSTOM_NOISE_INJECTION_POINT__',
        ''
    ];

    // Everything from rawNoise onward goes in TAIL.
    const FRAG_TAIL_LINES = [
        'float rawNoise(vec4 p){',
        '#ifdef CUSTOM_NOISE',
        '    return customNoise(p);',
        '#else',
        '    #if NOISE_TYPE == 0',
        '    vec2 seedOff = vec2(uSeed * 71.3 + gChannel * 137.1, uSeed * 37.7 + gChannel * 57.3);',
        '    #if DIM == 2',
        '    return hash12(floor(p.xy) + seedOff);',
        '    #elif DIM == 3',
        '    return hash13(floor(p.xyz) + vec3(seedOff, 0.0));',
        '    #else',
        '    return hash14(floor(p) + vec4(seedOff, 0.0, 0.0));',
        '    #endif',
        '    #elif NOISE_TYPE == 1',
        '    float cell = max(1.0, uScale / 16.0);',
        '    vec2 q = floor(gPix / cell)',
        '           + vec2(uSeed * 71.3 + gChannel * 137.1, uSeed * 37.7 + gChannel * 57.3);',
        '    float c = hash12(q);',
        '    float acc = 0.0;',
        '    for (int y = -1; y <= 1; y++)',
        '    for (int x = -1; x <= 1; x++) acc += hash12(q + vec2(float(x), float(y)));',
        '    return clamp((c - acc / 9.0) * 4.0 + 0.5, 0.0, 1.0);',
        '    #elif NOISE_TYPE == 2',
        '    #if DIM == 2',
        '    return valueNoise2(p.xy);',
        '    #elif DIM == 3',
        '    return valueNoise3(p.xyz);',
        '    #else',
        '    return valueNoise4(p);',
        '    #endif',
        '    #elif NOISE_TYPE == 3',
        '    #if DIM == 2',
        '    return voronoi2(p.xy);',
        '    #elif DIM == 3',
        '    return voronoi3(p.xyz);',
        '    #else',
        '    return voronoi4(p);',
        '    #endif',
        '    #elif NOISE_TYPE == 4',
        '    #if DIM == 2',
        '    return clamp(perlin2(p.xy) * 0.7 + 0.5, 0.0, 1.0);',
        '    #elif DIM == 3',
        '    return clamp(perlin3(p.xyz) * 0.7 + 0.5, 0.0, 1.0);',
        '    #else',
        '    return clamp(perlin4(p) * 0.7 + 0.5, 0.0, 1.0);',
        '    #endif',
        '    #elif NOISE_TYPE == 5',
        '    #if DIM == 2',
        '    return valueNoise2(p.xy);',
        '    #elif DIM == 3',
        '    return valueNoise3(p.xyz);',
        '    #else',
        '    return valueNoise4(p);',
        '    #endif',
        '    #else',
        '    #if DIM == 2',
        '    return clamp(snoise2(p.xy) * 0.5 + 0.5, 0.0, 1.0);',
        '    #elif DIM == 3',
        '    return clamp(snoise3(p.xyz) * 0.5 + 0.5, 0.0, 1.0);',
        '    #else',
        '    return clamp(snoise4(p) * 0.5 + 0.5, 0.0, 1.0);',
        '    #endif',
        '    #endif',
        '#endif',
        '}',
        '',
        'float fbm(vec4 p, float persistence){',
        '    float total = 0.0;',
        '    float amp = 1.0;',
        '    float norm = 0.0;',
        '    vec4 q = p;',
        '    for (int i = 0; i < 8; i++){',
        '        if (i >= uOctaves) break;',
        '        total += rawNoise(q) * amp;',
        '        norm += amp;',
        '        amp *= persistence;',
        '        q = q * uLacunarity + vec4(11.7, 7.3, 5.1, 3.9);',
        '    }',
        '    return total / max(norm, 1e-6);',
        '}',
        '',
        'float sampleNoise(vec2 uv, float ch){',
        '    gChannel = ch;',
        '    vec4 p = buildCoord(uv, ch);',
        '#ifdef CUSTOM_NOISE',
        '    return fbm(p, uPersistence);',
        '#elif NOISE_TYPE == 0',
        '    return rawNoise(p);',
        '#elif NOISE_TYPE == 1',
        '    return rawNoise(p);',
        '#elif NOISE_TYPE == 2',
        '    return fbm(p, 0.25);',
        '#else',
        '    return fbm(p, uPersistence);',
        '#endif',
        '}',
        '',
        'float applyUniformity(float v){',
        '    float t = clamp((uUniformity - 0.5) * 2.0, -1.0, 1.0);',
        '    if (t == 0.0) return v;',
        '    if (t > 0.0){',
        '        float s = v * v * (3.0 - 2.0 * v);',
        '        return mix(v, s, t);',
        '    }',
        '    float inv = 0.5 - sin(asin(clamp(1.0 - 2.0 * v, -1.0, 1.0)) / 3.0);',
        '    return mix(v, inv, -t);',
        '}',
        '',
        'void main(){',
        '    gPix = floor(gl_FragCoord.xy);',
        '    vec2 uv = vUv;',
        '    vec3 col;',
        '    if (uColorMode == 0){',
        '        col = vec3(applyUniformity(sampleNoise(uv, 0.0)));',
        '    } else {',
        '        col = vec3(',
        '            applyUniformity(sampleNoise(uv, 0.0)),',
        '            applyUniformity(sampleNoise(uv, 1.0)),',
        '            applyUniformity(sampleNoise(uv, 2.0)));',
        '    }',
        '    if (uInvert == 1) col = 1.0 - col;',
        '    outColor = vec4(col, 1.0);',
        '}'
    ];

    function buildBuiltinShader(typeIndex, dim) {
        return [
            '#version 300 es',
            '#define NOISE_TYPE ' + typeIndex,
            '#define DIM ' + dim,
            FRAG_HEAD_LINES.join('\n'),
            FRAG_TAIL_LINES.join('\n')
        ].join('\n');
    }

    function buildCustomShader(customCode) {
        return [
            '#version 300 es',
            '#define CUSTOM_NOISE 1',
            '#define NOISE_TYPE -1',
            '#define DIM 2',
            FRAG_HEAD_LINES.join('\n'),
            customCode,
            FRAG_TAIL_LINES.join('\n')
        ].join('\n');
    }

    function compileShader(gl, type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error('Shader compile error: ' + log);
        }
        return sh;
    }

    function initGL() {
        if (glState.gl) return glState.gl;

        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;

        const gl = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true,
            antialias: false,
            alpha: false,
            premultipliedAlpha: false,
            depth: false,
            stencil: false
        });
        if (!gl) throw new Error('WebGL2 is not supported in this environment');

        gl.disable(gl.DITHER);

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        glState.canvas = canvas;
        glState.gl = gl;
        glState.vao = vao;
        glState.buffer = buffer;
        return gl;
    }

    function getProgram(gl, key, fragmentSource) {
        const cached = glState.programs[key];
        if (cached) return cached;

        const vs = compileShader(gl, gl.VERTEX_SHADER, VS_SRC);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            throw new Error('Program link error: ' + log);
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            const name = info.name.replace(/\[0\]$/, '');
            const loc = gl.getUniformLocation(program, info.name);
            uniforms[name] = (loc === null) ? undefined : loc;
        }

        const entry = { program: program, uniforms: uniforms };
        glState.programs[key] = entry;
        return entry;
    }

    function renderNoiseImage(gl, programKey, fragmentSource, opts) {
        const width = Math.max(1, Math.min(2048, Math.round(opts.width)));
        const height = Math.max(1, Math.min(2048, Math.round(opts.height)));

        if (glState.canvas.width !== width || glState.canvas.height !== height) {
            glState.canvas.width = width;
            glState.canvas.height = height;
        }
        gl.viewport(0, 0, width, height);

        const entry = getProgram(gl, programKey, fragmentSource);
        gl.useProgram(entry.program);

        const u = entry.uniforms;
        if (u.uSeed       !== undefined) gl.uniform1f(u.uSeed, opts.seed);
        if (u.uScale      !== undefined) gl.uniform1f(u.uScale, opts.scale);
        if (u.uUniformity !== undefined) gl.uniform1f(u.uUniformity, opts.uniformity);
        if (u.uOctaves    !== undefined) gl.uniform1i(u.uOctaves, opts.octaves);
        if (u.uPersistence!== undefined) gl.uniform1f(u.uPersistence, opts.persistence);
        if (u.uLacunarity !== undefined) gl.uniform1f(u.uLacunarity, opts.lacunarity);
        if (u.uOffsetX    !== undefined) gl.uniform1f(u.uOffsetX, opts.offsetX);
        if (u.uOffsetY    !== undefined) gl.uniform1f(u.uOffsetY, opts.offsetY);
        if (u.uZ          !== undefined) gl.uniform1f(u.uZ, opts.z);
        if (u.uW          !== undefined) gl.uniform1f(u.uW, opts.w);
        if (u.uColorMode  !== undefined) gl.uniform1i(u.uColorMode, opts.colorMode);
        if (u.uInvert     !== undefined) gl.uniform1i(u.uInvert, opts.invert ? 1 : 0);

        gl.bindVertexArray(glState.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.buffer);
        const aPos = gl.getAttribLocation(entry.program, 'aPos');
        if (aPos >= 0) {
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        }

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        return glState.canvas.toDataURL('image/png');
    }

    function parseColor(args) {
        const c = asString(args.COLOR).trim().toLowerCase();
        return (c === 'color' || c === 'colored' || c === 'colour') ? 1 : 0;
    }

    function generateFromOptions(typeName, dimName, args) {
        const gl = initGL();
        const typeIndex = noiseIndexFromName(typeName);
        const dim = dimFromName(dimName);
        const key = typeIndex + ':' + dim;
        const src = buildBuiltinShader(typeIndex, dim);

        return renderNoiseImage(gl, key, src, {
            seed: seedToFloat(args.SEED),
            width: finite(args.WIDTH, 256, 1, 2048),
            height: finite(args.HEIGHT, 256, 1, 2048),
            scale: finite(args.SCALE, 16, 0.001, 4096),
            uniformity: finite(args.UNIFORMITY, 0.5, 0, 1),
            octaves: Math.round(finite(args.OCTAVES, 4, 1, 8)),
            persistence: finite(args.PERSISTENCE, 0.5, 0.01, 0.99),
            lacunarity: finite(args.LACUNARITY, 2, 1.01, 8),
            offsetX: finite(args.OFFSETX, 0, -1e9, 1e9),
            offsetY: finite(args.OFFSETY, 0, -1e9, 1e9),
            colorMode: parseColor(args),
            invert: asBool(args.INVERT),
            z: finite(args.Z, 0, -1e9, 1e9),
            w: finite(args.W4, 0, -1e9, 1e9)
        });
    }

    function generateCustom(args) {
        const code = asString(args.CODE);
        if (!code.trim()) throw new Error('Custom noise code is empty');

        const gl = initGL();
        const key = 'custom:' + hashString32(code).toString(36);
        const src = buildCustomShader(code);

        return renderNoiseImage(gl, key, src, {
            seed: seedToFloat(args.SEED),
            width: finite(args.WIDTH, 256, 1, 2048),
            height: finite(args.HEIGHT, 256, 1, 2048),
            scale: finite(args.SCALE, 16, 0.001, 4096),
            uniformity: 0.5,
            octaves: 4,
            persistence: 0.5,
            lacunarity: 2,
            offsetX: finite(args.OFFSETX, 0, -1e9, 1e9),
            offsetY: finite(args.OFFSETY, 0, -1e9, 1e9),
            colorMode: parseColor(args),
            invert: asBool(args.INVERT),
            z: 0,
            w: 0
        });
    }

    // ------------------------------------------------------------------
    // Documentation
    // ------------------------------------------------------------------
    const DOCS_HTML = [
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
        '<title>Speedi Noise Documentation</title>',
        '<style>',
        '  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
        '    max-width:900px;margin:0 auto;padding:24px;line-height:1.6;color:#222;background:#fafafa;}',
        '  h1{border-bottom:2px solid #00c4a7;padding-bottom:8px;}',
        '  h2{color:#008a75;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px;}',
        '  h3{margin-top:24px;}',
        '  code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:0.9em;}',
        '  pre{background:#1e1e1e;color:#eee;padding:16px;border-radius:8px;overflow-x:auto;}',
        '  pre code{background:none;padding:0;color:inherit;}',
        '  table{border-collapse:collapse;width:100%;margin:12px 0;}',
        '  th,td{border:1px solid #ddd;padding:8px 12px;text-align:left;}',
        '  th{background:#00c4a7;color:#fff;}',
        '  tr:nth-child(even){background:#f5f5f5;}',
        '  .warn{background:#fff3cd;border-left:4px solid #ffc107;padding:12px 16px;margin:16px 0;border-radius:4px;}',
        '  .tip{background:#d1ecf1;border-left:4px solid #17a2b8;padding:12px 16px;margin:16px 0;border-radius:4px;}',
        '  .block{background:#fff;border-left:4px solid #00c4a7;padding:12px 16px;margin:16px 0;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.1);}',
        '</style></head><body>',
        '<h1>Speedi Noise</h1>',
        '<p>Generates noise images as PNG data URIs using WebGL2. Everything is a reporter block &mdash; drop it into an <code>set [costume] to (…)</code> or wherever you need an image URI.</p>',

        '<h2>Blocks at a glance</h2>',
        '<div class="block"><b>noise</b> <i>[TYPE]</i> <b>dims</b> <i>[DIM]</i> <b>seed</b> <i>[SEED]</i> <b>width</b> <i>[WIDTH]</i> <b>height</b> <i>[HEIGHT]</i> <b>zoom</b> <i>[SCALE]</i> <b>offset x</b> <i>[OFFSETX]</i> <b>offset y</b> <i>[OFFSETY]</i> <b>uniformity</b> <i>[UNIFORMITY]</i> <b>colors</b> <i>[COLOR]</i> <b>invert</b> <i>[INVERT]</i></div>',
        '<p>Quick one-shot block. Uses default octaves (4), persistence (0.5) and lacunarity (2).</p>',

        '<div class="block"><b>advanced noise</b> &mdash; same arguments as above, plus <b>octaves</b>, <b>persistence</b>, <b>lacunarity</b>, <b>slice z</b>, <b>slice w</b>.</div>',
        '<p>Exposes the fractal parameters and the 3rd/4th dimension slices.</p>',

        '<div class="block"><b>⚠ custom noise (GLSL)</b> &mdash; <b>code</b> <i>[CODE]</i> <b>seed</b> <i>[SEED]</i> <b>width</b> <i>[WIDTH]</i> <b>height</b> <i>[HEIGHT]</i> <b>zoom</b> <i>[SCALE]</i> <b>offset x</b> <i>[OFFSETX]</i> <b>offset y</b> <i>[OFFSETY]</i> <b>colors</b> <i>[COLOR]</i> <b>invert</b> <i>[INVERT]</i></div>',
        '<p>Write your own GLSL noise function. See the custom section below.</p>',

        '<div class="block"><b>last noise error</b></div>',
        '<p>Returns a human-readable error string from the last failed block call (empty if the last call succeeded).</p>',

        '<div class="block"><b>open Speedi Noise documentation</b></div>',
        '<p>Command block that opens this page in a new tab. Handy fallback if the panel button cannot be injected.</p>',

        '<h2>Arguments in detail</h2>',
        '<table>',
        '<tr><th>Argument</th><th>Meaning</th></tr>',
        '<tr><td>TYPE</td><td>Which noise algorithm to use. See the noise types table.</td></tr>',
        '<tr><td>DIM</td><td>2D, 3D or 4D. Higher dimensions let you slice through a 3D/4D noise field using <code>slice z</code> / <code>slice w</code>. Default is 2D.</td></tr>',
        '<tr><td>SEED</td><td>Any value &mdash; a number, a word, a phrase, blank, whatever. It is hashed into a float so different inputs give different images.</td></tr>',
        '<tr><td>WIDTH / HEIGHT</td><td>Output image size in pixels. Clamped to 1&ndash;2048.</td></tr>',
        '<tr><td>SCALE (zoom)</td><td>How zoomed-in the noise appears. Larger = smaller features. Clamped to 0.001&ndash;4096.</td></tr>',
        '<tr><td>OFFSET X / OFFSET Y</td><td>Pans the noise field in noise units. Animating this gives smooth scrolling.</td></tr>',
        '<tr><td>UNIFORMITY</td><td>0&ndash;1 contrast modifier. 0.5 = unchanged, &gt;0.5 flattens midtones, &lt;0.5 deepens them.</td></tr>',
        '<tr><td>COLOR</td><td><i>Black &amp; White</i> or <i>Color</i>. Color mode renders three independent noise channels.</td></tr>',
        '<tr><td>INVERT</td><td>Flips the final luminance.</td></tr>',
        '<tr><td>OCTAVES</td><td>Fractal detail layers (1&ndash;8). More = more texture, more cost.</td></tr>',
        '<tr><td>PERSISTENCE</td><td>Amplitude falloff per octave. Classic value is 0.5.</td></tr>',
        '<tr><td>LACUNARITY</td><td>Frequency multiplier per octave. Classic value is 2.</td></tr>',
        '<tr><td>SLICE Z / SLICE W</td><td>3rd and 4th coordinate for 3D/4D noise. Animate these to morph the pattern.</td></tr>',
        '</table>',

        '<h2>Noise types</h2>',
        '<table>',
        '<tr><th>Name</th><th>Notes</th></tr>',
        '<tr><td>White</td><td>Pure per-pixel randomness. Perfect for grain, static, and dithering.</td></tr>',
        '<tr><td>Blue</td><td>Approximate high-frequency noise. Good for fine grain that doesn\'t blob.</td></tr>',
        '<tr><td>Brown</td><td>1/f&sup2; spectrum (fractal value noise). Soft cloudy patterns.</td></tr>',
        '<tr><td>Voronoi</td><td>Cellular / Worley noise. Distance-to-nearest-point field.</td></tr>',
        '<tr><td>Perlin</td><td>Classic gradient noise. Excellent all-rounder.</td></tr>',
        '<tr><td>Value (fast)</td><td>Value noise. Similar to Perlin but cheaper; slightly blockier.</td></tr>',
        '<tr><td>Simplex (fast)</td><td>Ashima simplex noise. Smooth, isotropic, great looking.</td></tr>',
        '</table>',

        '<h2>What does SEED do?</h2>',
        '<p>The seed is passed through FNV-1a and mapped to <code>[0, 1024)</code>. Then the shader multiplies it by irrational constants to get offsets into the noise field. That means:</p>',
        '<ul>',
        '<li><code>seed = "hello"</code> and <code>seed = "world"</code> give totally different images.</li>',
        '<li><code>seed = 1</code> and <code>seed = 2</code> give totally different images too.</li>',
        '<li><code>seed = ""</code> works (it just hashes to some fixed value).</li>',
        '</ul>',
        '<div class="tip">To animate without changing the seed, animate <b>offset x</b> / <b>offset y</b> instead. That gives smooth scrolling.</div>',

        '<h2>Custom noise functions (advanced!)</h2>',
        '<div class="warn"><b>Warning:</b> writing a custom noise function requires GLSL knowledge and is not beginner-friendly. If you just want an image, use the built-in noise types.</div>',
        '<p>Your code is spliced into the fragment shader before <code>rawNoise</code>. You must define exactly one function:</p>',
        '<pre><code>float customNoise(vec4 p) {\n    // p = the already-scaled, offset, seed-shifted coordinate\n    // return a value in [0, 1]\n}</code></pre>',
        '<p>The shader will call <code>customNoise(p)</code> once per fractal octave per channel. Everything you return is run through the uniformity and invert controls automatically.</p>',
        '<h3>Coordinate you receive</h3>',
        '<p><code>p</code> is a <code>vec4</code> built from:</p>',
        '<pre><code>p.xy = vUv * uScale + vec2(uOffsetX, uOffsetY)\n     + vec2(uSeed * 1.618, uSeed * 2.414)   // seed offset\n     + vec2(gChannel * 13.37, gChannel * 27.73);  // per-channel offset\np.z  = uZ + uSeed * 3.14 + gChannel * 7.7;\np.w  = uW + uSeed * 5.79 + gChannel * 9.1;</code></pre>',
        '<h3>Uniforms and globals you can read</h3>',
        '<table>',
        '<tr><th>Name</th><th>Type</th><th>Meaning</th></tr>',
        '<tr><td><code>uSeed</code></td><td>float</td><td>Hashed seed value in [0, 1024).</td></tr>',
        '<tr><td><code>uScale</code></td><td>float</td><td>Zoom value.</td></tr>',
        '<tr><td><code>uUniformity</code></td><td>float</td><td>0&ndash;1 uniformity.</td></tr>',
        '<tr><td><code>uOffsetX / uOffsetY</code></td><td>float</td><td>Pan offsets in noise units.</td></tr>',
        '<tr><td><code>uZ / uW</code></td><td>float</td><td>Slice values for 3D/4D.</td></tr>',
        '<tr><td><code>gChannel</code></td><td>float</td><td>0, 1 or 2 = current color channel (0 for B&amp;W).</td></tr>',
        '<tr><td><code>vUv</code></td><td>vec2</td><td>Raw UV in [0,1].</td></tr>',
        '<tr><td><code>gl_FragCoord</code></td><td>vec4</td><td>Pixel coordinate.</td></tr>',
        '</table>',
        '<h3>Helpers you can call</h3>',
        '<p>All of the built-in noise functions are available:</p>',
        '<ul>',
        '<li>Hashes: <code>hash11</code>, <code>hash12</code>, <code>hash13</code>, <code>hash14</code></li>',
        '<li>Value noise: <code>valueNoise2</code>, <code>valueNoise3</code>, <code>valueNoise4</code></li>',
        '<li>Perlin: <code>perlin2</code>, <code>perlin3</code>, <code>perlin4</code></li>',
        '<li>Voronoi: <code>voronoi2</code>, <code>voronoi3</code>, <code>voronoi4</code></li>',
        '<li>Simplex: <code>snoise2</code>, <code>snoise3</code>, <code>snoise4</code></li>',
        '<li>Gradients: <code>grad2</code>, <code>grad3</code>, <code>grad4v</code></li>',
        '</ul>',
        '<h3>Example: value noise</h3>',
        '<pre><code>float customNoise(vec4 p) {\n    vec2 i = floor(p.xy);\n    vec2 f = fract(p.xy);\n    vec2 u = f * f * (3.0 - 2.0 * f);\n    float a = hash12(i);\n    float b = hash12(i + vec2(1.0, 0.0));\n    float c = hash12(i + vec2(0.0, 1.0));\n    float d = hash12(i + vec2(1.0, 1.0));\n    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}</code></pre>',
        '<h3>Example: stripes</h3>',
        '<pre><code>float customNoise(vec4 p) {\n    return 0.5 + 0.5 * sin(p.x * 6.2831853);\n}</code></pre>',
        '<h3>Example: radial pattern</h3>',
        '<pre><code>float customNoise(vec4 p) {\n    vec2 c = vec2(vUv.x - 0.5, vUv.y - 0.5);\n    float r = length(c);\n    return fract(r * uScale + uSeed * 0.1);\n}</code></pre>',
        '<h3>Debugging a custom function</h3>',
        '<p>If compilation fails, the reporter returns an empty string and the <b>last noise error</b> block contains the compiler message (with line numbers). The message is often verbose &mdash; read it from the top, the first error is usually the real one.</p>',

        '<h2>Performance tips</h2>',
        '<ul>',
        '<li>256&times;256 is the sweet spot for most uses. 1024&times;1024 takes ~10&times; longer to encode.</li>',
        '<li>Voronoi 4D is the most expensive type. Prefer 2D Voronoi or Perlin unless you need it.</li>',
        '<li>Color mode is 3&times; the work of B&amp;W. Use B&amp;W when you can.</li>',
        '<li>Use the same seed and just animate <code>offset x</code> for smooth scrolling.</li>',
        '<li>Programs are cached per (type, dimension), so mixing types is cheap after the first call. Custom code is cached by its hash.</li>',
        '</ul>',
        '</body></html>'
    ].join('\n');

    function openDocs() {
        const w = window.open('', '_blank');
        if (!w) {
            alert('Please allow popups to view the Speedi Noise documentation.');
            return;
        }
        try {
            w.document.open();
            w.document.write(DOCS_HTML);
            w.document.close();
        } catch (e) {
            // Very unlikely fallback
            w.location.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(DOCS_HTML);
        }
    }

    function injectDocsButton() {
        let injected = false;

        const tryInject = () => {
            if (injected) return true;
            const els = document.querySelectorAll('[class*="blocklyToolboxCategory"],[class*="toolboxCategory"]');
            for (let i = 0; i < els.length; i++) {
                const el = els[i];
                const text = el.textContent || '';
                if (text.indexOf('Speedi Noise') === -1) continue;
                if (el.querySelector('.speedi-noise-docs-btn')) { injected = true; return true; }

                const btn = document.createElement('button');
                btn.className = 'speedi-noise-docs-btn';
                btn.textContent = '\uD83D\uDCD6 Docs';
                btn.title = 'Open Speedi Noise documentation';
                btn.style.cssText =
                    'margin-left:6px;padding:2px 8px;border-radius:4px;' +
                    'border:1px solid rgba(0,0,0,0.2);background:rgba(255,255,255,0.85);' +
                    'cursor:pointer;font-size:11px;color:#222;font-weight:600;' +
                    'font-family:inherit;line-height:1.3;';
                btn.addEventListener('mousedown', (e) => e.stopPropagation());
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    openDocs();
                });

                const label = el.querySelector('[class*="TreeLabel"],[class*="CategoryLabel"]');
                (label || el).appendChild(btn);
                injected = true;
                return true;
            }
            return false;
        };

        if (tryInject()) return;

        let attempts = 0;
        const iv = setInterval(() => {
            if (injected || ++attempts > 120) { clearInterval(iv); return; }
            tryInject();
        }, 500);

        try {
            const obs = new MutationObserver(() => {
                if (injected) { obs.disconnect(); return; }
                tryInject();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Extension
    // ------------------------------------------------------------------
    class Extension {
        getInfo() {
            return {
                id: 'speediNoise',
                name: 'Speedi Noise',
                color1: '#00c4a7',
                color2: '#00a58c',
                color3: '#008a75',
                blocks: [
                    reporter(
                        'noiseImage',
                        'noise [TYPE] dims [DIM] seed [SEED] width [WIDTH] height [HEIGHT] zoom [SCALE] offset x [OFFSETX] offset y [OFFSETY] uniformity [UNIFORMITY] colors [COLOR] invert [INVERT]',
                        {
                            TYPE: s('Perlin', 'noiseTypeMenu'),
                            DIM: s('2D', 'dimMenu'),
                            SEED: s(''),
                            WIDTH: n(256),
                            HEIGHT: n(256),
                            SCALE: n(16),
                            OFFSETX: n(0),
                            OFFSETY: n(0),
                            UNIFORMITY: n(0.5),
                            COLOR: s('Black & White', 'colorMenu'),
                            INVERT: b(false)
                        }
                    ),
                    reporter(
                        'noiseImageAdvanced',
                        'advanced noise [TYPE] dims [DIM] seed [SEED] width [WIDTH] height [HEIGHT] zoom [SCALE] offset x [OFFSETX] offset y [OFFSETY] uniformity [UNIFORMITY] octaves [OCTAVES] persistence [PERSISTENCE] lacunarity [LACUNARITY] colors [COLOR] invert [INVERT] slice z [Z] slice w [W4]',
                        {
                            TYPE: s('Perlin', 'noiseTypeMenu'),
                            DIM: s('2D', 'dimMenu'),
                            SEED: s(''),
                            WIDTH: n(256),
                            HEIGHT: n(256),
                            SCALE: n(16),
                            OFFSETX: n(0),
                            OFFSETY: n(0),
                            UNIFORMITY: n(0.5),
                            OCTAVES: n(4),
                            PERSISTENCE: n(0.5),
                            LACUNARITY: n(2),
                            COLOR: s('Black & White', 'colorMenu'),
                            INVERT: b(false),
                            Z: n(0),
                            W4: n(0)
                        }
                    ),
                    reporter(
                        'customNoiseImage',
                        '\u26A0 custom noise (GLSL, advanced) code [CODE] seed [SEED] width [WIDTH] height [HEIGHT] zoom [SCALE] offset x [OFFSETX] offset y [OFFSETY] colors [COLOR] invert [INVERT]',
                        {
                            CODE: s('float customNoise(vec4 p) {\n    return hash12(floor(p.xy));\n}'),
                            SEED: s(''),
                            WIDTH: n(256),
                            HEIGHT: n(256),
                            SCALE: n(16),
                            OFFSETX: n(0),
                            OFFSETY: n(0),
                            COLOR: s('Black & White', 'colorMenu'),
                            INVERT: b(false)
                        }
                    ),
                    reporter('lastError', 'last noise error'),
                    command('openDocsCommand', 'open Speedi Noise documentation')
                ],
                menus: {
                    noiseTypeMenu: {
                        acceptReporters: true,
                        items: [
                            'White',
                            'Blue',
                            'Brown',
                            'Voronoi',
                            'Perlin',
                            'Value (fast)',
                            'Simplex (fast)'
                        ]
                    },
                    dimMenu: {
                        acceptReporters: true,
                        items: ['2D', '3D', '4D']
                    },
                    colorMenu: {
                        acceptReporters: true,
                        items: ['Black & White', 'Color']
                    }
                }
            };
        }

        noiseImage(args) {
            try {
                const uri = generateFromOptions(asString(args.TYPE), asString(args.DIM), args);
                setError('');
                return uri;
            } catch (e) {
                setError('noise: ' + (e && e.message ? e.message : String(e)));
                return '';
            }
        }

        noiseImageAdvanced(args) {
            try {
                const uri = generateFromOptions(asString(args.TYPE), asString(args.DIM), args);
                setError('');
                return uri;
            } catch (e) {
                setError('advanced noise: ' + (e && e.message ? e.message : String(e)));
                return '';
            }
        }

        customNoiseImage(args) {
            try {
                const uri = generateCustom(args);
                setError('');
                return uri;
            } catch (e) {
                setError('custom noise: ' + (e && e.message ? e.message : String(e)));
                return '';
            }
        }

        lastError() {
            return lastError || '';
        }

        openDocsCommand() {
            try {
                openDocs();
            } catch (e) {
                setError('openDocs: ' + (e && e.message ? e.message : String(e)));
            }
        }
    }

    Scratch.extensions.register(new Extension());

    // Best-effort: add a Docs button next to the toolbox category header.
    setTimeout(injectDocsButton, 500);
})(Scratch);
