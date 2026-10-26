/**
 * The Kiln table surface: a matte graphite play mat (MTGA-style: no lanes) with a pool of light in the
 * centre, a heavy vignette, slate mottling and a fine woven fibre, generated in a fragment shader (no bitmap).
 * Deterministic: the noise is a hash of the position in table units, never random.
 */
import { Container, Filter, GlProgram, Graphics, RenderTexture, Sprite, Texture, defaultFilterVert, type Renderer } from 'pixi.js';
import { table } from '../theme/tokens';
import { geometry, type Geometry } from '../layout/geometry';

const FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform vec2 uResolution;
uniform float uScale;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main(void) {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uResolution;
  vec2 c = uv - 0.5;
  c.x *= uResolution.x / uResolution.y;
  float d = length(c);
  // A pool of light in the centre (#232832) falling off to the mat colour (#13161B), then a heavy vignette
  // that sinks the edges, where the HUD sits.
  vec3 lift = vec3(0.137, 0.157, 0.196);
  vec3 base = vec3(0.075, 0.086, 0.106);
  vec3 col = mix(lift, base, smoothstep(0.0, 0.72, d));
  col *= 1.0 - 0.62 * smoothstep(0.42, 1.2, d);
  // Slate: low-frequency mottling, sized in table units.
  vec2 t = px / max(uScale, 0.25);
  float n = vnoise(t * 0.012) * 0.6 + vnoise(t * 0.045) * 0.4;
  col += (n - 0.5) * 0.028;
  // A fine woven fibre: two stretched noise layers across each other (a cloth mat, not stone).
  // (Coarse enough, ~10 tu a thread, that screenshots stay compressible.)
  float f = vnoise(vec2(t.x * 0.1, t.y * 0.014)) + vnoise(vec2(t.x * 0.014, t.y * 0.1 + 17.0));
  col += (f - 1.0) * 0.01;
  // (No per-pixel hash grain: it reads as noise on screen and makes every screenshot incompressible.)
  finalColor = vec4(col, 1.0);
}
`;

/**
 * The shader runs once per resize into a texture ("baked"); each frame only draws that texture, so the
 * table surface costs one textured quad.
 */
export class TableBackground {
  readonly view = new Container();
  private readonly surface = new Sprite(Texture.WHITE);
  private readonly baked = new Sprite(Texture.EMPTY);
  private target: RenderTexture | null = null;
  private readonly filter: Filter;

  constructor() {
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAGMENT, name: 'kiln-table' }),
      resources: {
        tableUniforms: {
          uResolution: { value: new Float32Array([1920, 1080]), type: 'vec2<f32>' },
          uScale: { value: 1, type: 'f32' },
        },
      },
    });
    this.surface.filters = [this.filter];
    this.view.addChild(this.baked);
  }

  /** @param w,h canvas size in CSS px; @param res renderer resolution; @param s table scale. */
  resize(renderer: Renderer, w: number, h: number, res: number, s: number): void {
    this.surface.width = w;
    this.surface.height = h;
    const u = this.filter.resources.tableUniforms.uniforms as { uResolution: Float32Array; uScale: number };
    u.uResolution[0] = w * res;
    u.uResolution[1] = h * res;
    u.uScale = s * res;
    this.target?.destroy(true);
    this.target = RenderTexture.create({ width: w, height: h, resolution: res });
    renderer.render({ container: this.surface, target: this.target, clear: true });
    this.baked.texture = this.target;
    this.baked.width = w;
    this.baked.height = h;
  }
}

/**
 * Static table markings in table units for a geometry: a thin brass centre line that fades out toward its ends,
 * with a small diamond at the middle. No row lanes (the mat reads as one surface, MTGA-style).
 */
export function tableMarkings(geo: Geometry = geometry(), g = new Graphics()): Graphics {
  const { X, ROW_Y } = geo;
  g.clear();
  const cy = ROW_Y.centre;
  const mid = (X.rowStart + X.rowEnd) / 2;
  const half = (X.rowEnd - X.rowStart) / 2;
  // The line in short segments, each as bright as a sine bump says (0 at the ends, full near the middle).
  const SEG = 32;
  for (const side of [-1, 1]) {
    for (let i = 0; i < SEG; i++) {
      const a = 12 + ((half - 12) * i) / SEG;
      const b = 12 + ((half - 12) * (i + 1)) / SEG;
      const alpha = 0.5 * Math.sin((Math.PI / 2) * (1 - (i + 0.5) / SEG)) ** 0.8;
      g.moveTo(mid + side * a, cy).lineTo(mid + side * b, cy).stroke({ color: table.brass, alpha, width: 1 });
    }
  }
  g.moveTo(mid, cy - 5).lineTo(mid + 5, cy).lineTo(mid, cy + 5).lineTo(mid - 5, cy).closePath().stroke({ color: table.brass, alpha: 0.6, width: 1 });
  return g;
}
