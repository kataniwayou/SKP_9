import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Health } from '../api/liveness';
import { canvasBridge } from './bridge';
import type { CanvasView } from './view';
import { extentOf, type Vec } from './layout';
import { arrowKey, BOND, isArrowKey, KINDS, TYPES, type Arrow, type ArrowKind, type Atom, type AtomType, type Molecule } from './model';

/** The ground the molecule floats over: SKP Studio's blueprint ground (canvas/tokens.css --ground). */
const GROUND = 0x0a1220;
const HOME = new THREE.Vector3(3, 8, 28).normalize();
/**
 * A narrow, telephoto-like lens (the user, 2026-10-15: "the atom isn't accurate ball"). The mock's 48° lens stretches
 * spheres away from the centre of the view into ovals, and the canvas slide puts most of the picture off-centre; at 15°
 * an atom stays round to a few percent anywhere on screen, and the camera stands further back to frame the same view.
 */
const FOV = 15;
const LEGEND: readonly AtomType[] = ['wf', 'step', 'proc', 'schema', 'asg', 'cache'];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** A processor's health colour (2026-10-18), as SKP Studio's processor art: green, red, grey. */
const HEALTH_HEX: Readonly<Record<Health, number>> = { healthy: 0x4ade80, unhealthy: 0xff5a5a, undetermined: 0x9aa3b2 };
const HEALTH_WORD: Readonly<Record<Health, string>> = { healthy: 'healthy', unhealthy: 'unhealthy', undetermined: 'not known' };

/** What the view changes in place, without building the scene again. */
interface Painter {
  highlight(keys: ReadonlySet<string> | null): void;
  /** An atom's or an arrow's key (`arrowKey`), or null. */
  pin(key: string | null): void;
  /** Deleted in Valence and not applied (spec §6): drawn as red ghosts. */
  ghost(ghosts: Ghosts): void;
  /** Labels show the virtual entities' names (decision 8): edited names by atom key. */
  rename(names: ReadonlyMap<string, string>): void;
  /** Each processor's health by atom key (2026-10-18): it breathes inside the atom in that colour. */
  health(health: ReadonlyMap<string, Health>): void;
}

/** What the view tells the page: the atom or arrow under the pointer, and a click's (null: empty canvas). Arrows by `arrowKey`. */
export interface MoleculeEvents {
  hover(key: string | null): void; pin(key: string | null): void;
  /**
   * The view (the camera and every atom's place) once a turn, zoom, slide or atom move has settled, to keep in this
   * browser (the user, 2026-10-17); `closing`: the page is closing, so it must be written now.
   */
  view?(view: CanvasView, closing: boolean): void;
}

/**
 * Ghosts of the virtual changes: atoms and arrows (by key) deleted in Valence — the arrows include those touching a deleted
 * atom (`goneArrows`) — drawn red; and atoms with finished edits, `updated`, drawn amber (a deleted one stays red).
 */
export interface Ghosts {
  atoms: ReadonlySet<string>; arrows: ReadonlySet<string>; updated?: ReadonlySet<string>;
  /** Made from the Toolbox (2026-10-17): green with a halo, finished or unfinished (`making`). */
  created?: ReadonlySet<string>; making?: ReadonlySet<string>;
}

/** The view kept across a rebuild (an atom made or taken back rebuilds the scene): the camera and where atoms stand. */
interface SavedView { camera: Vec; target: Vec; up: Vec; shift: { x: number; y: number }; atoms: Map<string, Vec> }
/** What a scene keeps for the next one: the view, an apply's renamed keys, and whether the view must be reported again (an apply renamed made atoms). */
interface Kept { view?: SavedView; rename?: ReadonlyMap<string, string>; report?: boolean }
const savedOf = (v: CanvasView): SavedView => ({ camera: v.camera, target: v.target, up: v.up, shift: { ...v.shift }, atoms: new Map(Object.entries(v.atoms)) });
const NO_GHOSTS: Ghosts = { atoms: new Set(), arrows: new Set() };

/**
 * The whole-project molecule (spec §2.7), drawn as the approved mock draws one workflow (docs/valence/molecule-mock.html),
 * over SKP Studio's dark ground: rows are atoms, foreign keys are arrows whose thickness is the bond class. Hover shows an
 * atom with its one-hop neighbours (no tooltip: the user, 2026-10-15); a drag turns the molecule about fixed axes (it
 * coasts on after a quick release), the wheel (or a pinch) zooms toward the canvas centre, Ctrl + drag on empty canvas
 * slides the picture, and Ctrl + drag on an atom moves that atom; a right drag does exactly what Ctrl + drag does. A click (no drag) on an atom pins it, on empty canvas unpins; the pinned atom glows and, while
 * nothing is hovered, keeps its neighbours in focus. `highlighted`: the atoms of the chosen workflows stand out and the
 * rest are dimmed; null highlights nothing.
 */
export function MoleculeView({ molecule, positions, highlighted, pinned = null, names, events, ghosts = NO_GHOSTS, health, view = null }: {
  molecule: Molecule; positions: ReadonlyMap<string, Vec>; highlighted: ReadonlySet<string> | null;
  pinned?: string | null; names?: ReadonlyMap<string, string>; events?: MoleculeEvents; ghosts?: Ghosts;
  /** Each processor's health by atom key (2026-10-18); none: no glow. */
  health?: ReadonlyMap<string, Health>;
  /** The view kept in this browser, to open on (the first build only; later builds keep the view as it stands). */
  view?: CanvasView | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const painter = useRef<Painter | null>(null);
  const kept = useRef<Kept>(view ? { view: savedOf(view) } : {});
  const latest = useRef({ highlighted, pinned, names, events, ghosts, health });
  latest.current = { highlighted, pinned, names, events, ghosts, health };

  useEffect(() => {
    const el = host.current!;
    const scene3 = buildScene(el, molecule, positions, {
      hover: (key) => latest.current.events?.hover(key),
      pin: (key) => latest.current.events?.pin(key),
      view: (v, closing) => latest.current.events?.view?.(v, closing),
    }, kept.current);
    painter.current = scene3;
    scene3.highlight(latest.current.highlighted);
    scene3.ghost(latest.current.ghosts);
    scene3.pin(latest.current.pinned);
    if (latest.current.names) scene3.rename(latest.current.names);
    if (latest.current.health) scene3.health(latest.current.health);
    return () => { painter.current = null; scene3.dispose(); };
  }, [molecule, positions]);

  useEffect(() => { painter.current?.highlight(highlighted); }, [highlighted]);
  useEffect(() => { painter.current?.pin(pinned); }, [pinned]);
  useEffect(() => { painter.current?.ghost(ghosts); }, [ghosts]);
  useEffect(() => { if (names) painter.current?.rename(names); }, [names]);
  useEffect(() => { if (health) painter.current?.health(health); }, [health]);

  return (
    // focusable: the canvas's keys (Delete, Ctrl+Z / Y) act while it has focus; a press on it gives it focus
    <div className="mol" ref={host} aria-label="Molecule" tabIndex={0}>
      <div className="mol-labels" aria-hidden="true" />
      <div className="mol-legend" aria-label="Atom colours">
        {LEGEND.map((t) => <span key={t}><i className="mol-dot" style={{ background: hex(TYPES[t].color) }} />{TYPES[t].label}</span>)}
        <span className="mol-legend-health" aria-label="Processor health">Processor health:
          {(['healthy', 'unhealthy', 'undetermined'] as const).map((h) => <span key={h}><i className="mol-dot ring" style={{ borderColor: hex(HEALTH_HEX[h]) }} />{HEALTH_WORD[h]}</span>)}
        </span>
      </div>
    </div>
  );
}

interface AtomView { atom: Atom; pos: THREE.Vector3; mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; label: HTMLDivElement; out: ArrowView[]; in: ArrowView[] }
interface ArrowView { arrow: Arrow; a: AtomView; b: AtomView; mat: THREE.MeshStandardMaterial; shaft: THREE.Mesh; head: THREE.Mesh; sleeve: THREE.Mesh; headLen: number; start: THREE.Vector3; tip: THREE.Vector3 }

/**
 * An arrowhead (the user, 2026-10-16: "isn't elegant"): a slim cone turned on a lathe, about 3.4 times as long as it is
 * wide at the base, smooth with 40 sides. Its point is a small rounded nose (the user, 2026-10-17: "the tip of the arrow
 * doesn't touch the atom … also the shape of the arrow distorted"): flanks curving in to a needle left the last pixels of
 * the point thinner than a pixel, so the drawn head stopped short of the ball; a nose keeps visible width to the very
 * front. Its base is flat, with a sharp crease at the rim, and the shaft ends exactly there: the arrows are see-through,
 * and a dome with the shaft's stub inside it showed through the head as a lighter ring. Built pointing up (+y) with the
 * nose's front at the origin, so it is placed at the arrow's tip. The head's width grows with the bond, but not below a
 * size that still reads at the whole-project view.
 */
function headOf(shaftR: number): { headGeom: THREE.LatheGeometry; headLen: number } {
  const R = Math.max(shaftR * 2.4, 0.075), L = R * 3.4, nose = R * 0.1;
  const slope = Math.atan2(R, L); // the flank's angle to the axis
  const profile: THREE.Vector2[] = [new THREE.Vector2(0, -L), new THREE.Vector2(R, -L)]; // the flat base, centre to rim
  profile.push(new THREE.Vector2(R, -L)); // the rim again: the base and the flank keep their own normals (a sharp crease)
  // the straight flank, then the nose's arc from where it meets the flank's slope round to the front point
  const arc = Math.PI / 2 - slope;
  for (let i = 8; i >= 0; i--) {
    const t = (arc * i) / 8;
    profile.push(new THREE.Vector2(nose * Math.sin(t), -nose + nose * Math.cos(t)));
  }
  const headGeom = new THREE.LatheGeometry(profile, 40);
  headGeom.computeVertexNormals();
  return { headGeom, headLen: L };
}

function buildScene(el: HTMLDivElement, molecule: Molecule, positions: ReadonlyMap<string, Vec>, events: MoleculeEvents, kept: Kept = {}): Painter & { dispose(): void } {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const labelsEl = el.querySelector<HTMLDivElement>('.mol-labels')!;
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  el.prepend(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.className = 'mol-canvas';
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(GROUND, 0.016);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  const radius = extentOf(positions);
  const spread = [0, 1, 2].map((i) => Math.max(...[...positions.values()].map((p) => Math.abs(p[i]!)), 1));

  // The trackball only pans with two fingers; turning, zooming and the mouse's right drag (= Ctrl + drag) are our own, below.
  const controls = new TrackballControls(camera, canvas);
  controls.noRotate = true; controls.noZoom = true; controls.panSpeed = 0.8;
  controls.mouseButtons.RIGHT = -1 as THREE.MOUSE; // no action: the right button is ours (the user, 2026-10-19)
  controls.staticMoving = false; controls.dynamicDampingFactor = 0.12;
  controls.keys = ['', '', '']; // no A/S/D mode keys
  cleanups.push(() => controls.dispose());

  // ---------- Atoms and arrows ----------
  // Lights in physical units (three r155+): the mock's r128 intensities times π.
  scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x1a1420, 0.75 * Math.PI));
  const key1 = new THREE.DirectionalLight(0xffffff, 0.9 * Math.PI); key1.position.set(8, 14, 10); scene.add(key1);
  const rim = new THREE.DirectionalLight(0x8aa0ff, 0.5 * Math.PI); rim.position.set(-10, -4, -12); scene.add(rim);

  // ---------- Atoms: exact spheres (the user, 2026-10-16: "all atoms and halo must be perfect sphere … zoom in max") ----------
  // A tessellated sphere is a polygon, and perspective draws a near, off-centre ball as an ellipse. Each atom is instead
  // a sphere impostor: a disc facing the camera as the image plane does (so it projects to a true circle wherever it is
  // on screen), sized every frame to the sphere's outline in that plane — the halo's own formula, so the two stay
  // concentric — and shaded per pixel by casting the view ray into the real sphere: its surface point gives the normal,
  // the lighting (three's own standard material) and the depth, so arrows still pierce and hide behind the ball exactly.
  const atomGeom = new THREE.PlaneGeometry(2, 2);
  const IMPOSTOR_VERTEX_DECL = 'varying vec3 vSphereCenter;\nvarying vec3 vQuadPos;\n';
  // projectionMatrix is the program's own uniform; three declares it for the vertex stage only
  const IMPOSTOR_FRAGMENT_DECL = 'uniform float sphereRadius;\nuniform mat4 projectionMatrix;\nuniform vec3 healthColor;\nuniform float healthGlow;\nvarying vec3 vSphereCenter;\nvarying vec3 vQuadPos;\n';
  /** Turns a standard material into a sphere impostor's: the circle, the ray-cast surface, its normal and depth. */
  function asImpostor(mat: THREE.MeshStandardMaterial, radius: number) {
    mat.customProgramCacheKey = () => 'valence-atom-impostor';
    // the health glow's colour and strength, set by breathe() (0: none)
    const glow: Glow = { color: { value: new THREE.Color() }, glow: { value: 0 } };
    mat.userData.health = glow;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.sphereRadius = { value: radius };
      shader.uniforms.healthColor = glow.color;
      shader.uniforms.healthGlow = glow.glow;
      shader.vertexShader = IMPOSTOR_VERTEX_DECL + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vSphereCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vQuadPos = mvPosition.xyz;`);
      shader.fragmentShader = IMPOSTOR_FRAGMENT_DECL + shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        // the outline: the circle the sphere's silhouette cone cuts from the disc's plane (through the centre, facing the camera)
        float sphereDist = length(vSphereCenter);
        float sphereOutline = sphereRadius * sphereDist / sqrt(max(sphereDist * sphereDist - sphereRadius * sphereRadius, 1e-6));
        float sphereOff = length(vQuadPos.xy - vSphereCenter.xy);
        float sphereAa = max(fwidth(sphereOff), 1e-5);
        if (sphereOff > sphereOutline + sphereAa) discard;
        float sphereEdge = 1.0 - smoothstep(sphereOutline - sphereAa, sphereOutline + sphereAa, sphereOff);
        // the view ray through this pixel into the real sphere; where it grazes past (the last pixel of the rim), the
        // sphere's point nearest the ray
        vec3 sphereRay = normalize(vQuadPos);
        float sphereB = dot(sphereRay, vSphereCenter);
        float sphereH = sphereB * sphereB - (dot(vSphereCenter, vSphereCenter) - sphereRadius * sphereRadius);
        vec3 sphereHit = sphereH >= 0.0
          ? sphereRay * (sphereB - sqrt(sphereH))
          : vSphereCenter + normalize(sphereRay * sphereB - vSphereCenter) * sphereRadius;
        vec3 sphereNormal = normalize(sphereHit - vSphereCenter);
        vec4 sphereClip = projectionMatrix * vec4(sphereHit, 1.0);
        // the antialiased rim is partly see-through: it takes the far depth, so what lies behind the ball (an arrowhead
        // tucked behind its outline) still draws there instead of a hairline of background (2026-10-17)
        gl_FragDepth = sphereEdge < 0.999 ? 1.0 : clamp((sphereClip.z / sphereClip.w) * 0.5 + 0.5, 0.0, 1.0);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = sphereNormal;
        nonPerturbedNormal = sphereNormal;`)
        .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(/vViewPosition/g, '(-sphereHit)'))
        .replace('#include <opaque_fragment>', `diffuseColor.a *= sphereEdge;
        // the health glow (2026-10-18: "as the halo breathing just inside the atom boundaries"): the halo's own fall-off,
        // turned inward — brightest on the outline, fading toward the centre
        float healthT = clamp(1.0 - sphereOff / max(sphereOutline, 1e-6), 0.0, 1.0);
        // the glare (2026-10-18: "make the health light more glare"): a wider band at full colour, and light added on top
        // of it, hottest on the rim, so it shines brighter than the colour itself
        float healthA = min(exp(-healthT * 2.6) + 0.35 * (1.0 - healthT) * (1.0 - healthT), 1.0);
        float healthHot = exp(-healthT * 7.0);
        outgoingLight = mix(outgoingLight, healthColor, healthGlow * healthA);
        outgoingLight += healthColor * healthGlow * (0.55 * healthA + 0.9 * healthHot);
        #include <opaque_fragment>`);
    };
  }
  type Glow = { color: { value: THREE.Color }; glow: { value: number } };
  const glowOf = (a: AtomView) => a.mesh.material.userData.health as Glow;
  /** Each processor's health colour, by atom; breathe() makes it breathe. */
  let healthy = new Map<AtomView, THREE.Color>();
  /** Picking meets the real sphere, not the disc's square. */
  const pickBall = new THREE.Sphere(), pickHit = new THREE.Vector3();
  function ballRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]) {
    pickBall.set(this.position, this.userData.radius as number);
    if (!raycaster.ray.intersectSphere(pickBall, pickHit)) return;
    const distance = raycaster.ray.origin.distanceTo(pickHit);
    if (distance < raycaster.near || distance > raycaster.far) return;
    hits.push({ distance, point: pickHit.clone(), object: this });
  }
  const atoms = new Map<string, AtomView>();
  molecule.atoms.forEach((atom) => {
    const t = TYPES[atom.type];
    const mat = new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.32, metalness: 0.15, transparent: true, opacity: 1 });
    asImpostor(mat, t.r);
    const mesh = new THREE.Mesh(atomGeom, mat);
    mesh.raycast = ballRaycast;
    const p = positions.get(atom.key) ?? [0, 0, 0];
    const pos = new THREE.Vector3(...p);
    mesh.position.copy(pos);
    mesh.userData.atom = atom.key;
    mesh.userData.radius = t.r;
    scene.add(mesh);
    const label = doc.createElement('div');
    label.className = `mol-lbl ${atom.type}`;
    label.textContent = atom.name;
    labelsEl.appendChild(label);
    atoms.set(atom.key, { atom, pos, mesh, label, out: [], in: [] });
  });

  const up = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0);
  const aDir = new THREE.Vector3(), aSide = new THREE.Vector3(), aEnd = new THREE.Vector3();
  const sleeveGeom = new THREE.CylinderGeometry(0.16, 0.16, 1, 6, 1, true);
  const sleeveMat = new THREE.MeshBasicMaterial({ visible: false });
  const disposables: { dispose(): void }[] = [sleeveGeom, sleeveMat, atomGeom];
  const toP = new THREE.Vector3(), toC = new THREE.Vector3(), probe = new THREE.Vector3();
  /** Whether the camera's view of `p` is blocked by the ball (c, r): the view ray meets the ball before it reaches p. */
  function hiddenBy(p: THREE.Vector3, c: THREE.Vector3, r: number) {
    toP.subVectors(p, camera.position);
    const len = toP.length();
    toP.divideScalar(len);
    toC.subVectors(c, camera.position);
    const t = toC.dot(toP), d2 = toC.lengthSq() - t * t;
    return d2 < r * r && t - Math.sqrt(r * r - d2) < len - 1e-4;
  }
  // Shaft and sleeve are unit-tall cylinders stretched to length, so an arrow can be re-placed when an atom or the camera
  // moves. Perspective (the user, 2026-10-15): an arrow whose tip the camera sees behind its target ball would lose its
  // head behind the ball, so it ends where it meets the ball's outline instead and its head always shows.
  // Exact ends (the user, 2026-10-16: up close the heads were neither elegant nor accurate): the tip lies on the target
  // ball's surface — also for a side-by-side arrow, whose offset line meets the ball off its centre line — and the shaft
  // starts inside the source ball, so its closed end never shows.
  function placeArrow(x: ArrowView) {
    const span = aDir.subVectors(x.b.pos, x.a.pos);
    const D = span.length();
    const dir = span.divideScalar(D || 1);
    const side = aSide.crossVectors(dir, Math.abs(dir.y) > 0.9 ? xAxis : up).normalize();
    const ra = TYPES[x.a.atom.type].r, rb = TYPES[x.b.atom.type].r;
    const off = (x.arrow.lane - (x.arrow.lanes - 1) / 2) * Math.min(0.22, rb * 0.6, ra * 0.6);
    // the offset line runs parallel to the centre line, so it meets a ball of radius r at ±√(r² − off²) from its centre
    const reachA = Math.sqrt(Math.max(ra * ra - off * off, 0)), reachB = Math.sqrt(Math.max(rb * rb - off * off, 0));
    x.start.copy(x.a.pos).addScaledVector(dir, reachA * 0.6).addScaledVector(side, off);
    x.tip.copy(x.a.pos).addScaledVector(dir, D - reachB).addScaledVector(side, off);
    if (hiddenBy(x.tip, x.b.pos, rb) && !hiddenBy(x.start, x.b.pos, rb)) {
      let lo = 0, hi = 1; // lo: seen; hi: behind the ball
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (hiddenBy(probe.lerpVectors(x.start, x.tip, mid), x.b.pos, rb)) hi = mid; else lo = mid; }
      const full = probe.copy(x.tip);
      x.tip.lerpVectors(x.start, x.tip, lo);
      // on: by the nose's radius, so the nose tucks behind the ball (which hides its front) and the head overlaps the
      // rim instead of touching it at one point, where antialiasing left a hairline of background (2026-10-17)
      const nose = (x.headLen / 3.4) * 0.1;
      x.tip.addScaledVector(dir, Math.min(nose, full.distanceTo(x.tip)));
    }
    // the shaft ends at the head's flat base: nothing of it inside the see-through head
    const shaftEnd = aEnd.copy(x.tip).addScaledVector(dir, -x.headLen);
    // Atoms pushed into each other leave no room for a shaft; it shrinks to nothing rather than turning inside out.
    const len = Math.max(probe.subVectors(shaftEnd, x.start).dot(dir), 0.001);
    x.shaft.position.copy(x.start).add(shaftEnd).multiplyScalar(0.5);
    x.shaft.quaternion.setFromUnitVectors(up, dir); x.shaft.scale.set(1, len, 1);
    // the head's geometry has its point at its origin: placed at the tip, pointing along the arrow
    x.head.position.copy(x.tip);
    x.head.quaternion.setFromUnitVectors(up, dir);
    x.sleeve.position.copy(x.start).add(x.tip).multiplyScalar(0.5);
    x.sleeve.quaternion.setFromUnitVectors(up, dir); x.sleeve.scale.set(1, Math.max(x.start.distanceTo(x.tip), 0.001), 1);
  }
  const headByBond = new Map<number, ReturnType<typeof headOf>>();
  /** A unit-tall tube along +y, its start (−y) closed by a disc, its end (+y) open for the head's base. */
  function shaftOf(r: number): THREE.BufferGeometry {
    const tube = new THREE.CylinderGeometry(r, r, 1, 24, 1, true);
    const cap = new THREE.CircleGeometry(r, 24).rotateX(Math.PI / 2).translate(0, -0.5, 0); // facing −y
    const merged = mergeGeometries([tube.toNonIndexed(), cap.toNonIndexed()]);
    tube.dispose(); cap.dispose();
    return merged;
  }
  const arrows: ArrowView[] = molecule.arrows.map((arrow) => {
    const k = KINDS[arrow.kind], bond = BOND[k.bond];
    // one head per bond class, shared by its arrows and disposed with the scene
    const { headGeom, headLen } = headByBond.get(bond.r) ?? headByBond.set(bond.r, headOf(bond.r)).get(bond.r)!;
    const mat = new THREE.MeshStandardMaterial({ color: k.color, transparent: true, opacity: bond.op, roughness: 0.45, metalness: 0.1 });
    // smooth tubes, closed where they start (inside the source ball, which a ghost shows through): a close look sees a
    // round rod, never a hollow ring; open where they meet the head, whose flat base closes them with no second layer
    const shaftGeom = shaftOf(bond.r);
    disposables.push(mat, shaftGeom);
    const shaft = new THREE.Mesh(shaftGeom, mat), head = new THREE.Mesh(headGeom, mat);
    // A fat invisible sleeve makes thin arrows easy to hover.
    const sleeve = new THREE.Mesh(sleeveGeom, sleeveMat);
    scene.add(shaft, head, sleeve);
    const x: ArrowView = { arrow, a: atoms.get(arrow.from)!, b: atoms.get(arrow.to)!, mat, shaft, head, sleeve, headLen, start: new THREE.Vector3(), tip: new THREE.Vector3() };
    sleeve.userData.arrow = x;
    x.a.out.push(x); x.b.in.push(x);
    placeArrow(x);
    return x;
  });
  atoms.forEach((a) => disposables.push(a.mesh.material));
  headByBond.forEach((h) => disposables.push(h.headGeom));

  // ---------- Paint: hover focus over the highlighted workflows, deleted ones as ghosts ----------
  // In focus: the hovered atom or arrow, else the pinned one. An atom brings its arrows and their ends; an arrow its ends.
  type Focus = AtomView | ArrowView;
  const arrowByKey = new Map(arrows.map((x) => [arrowKey(x.arrow), x] as const));
  const isArrow = (f: Focus): f is ArrowView => 'arrow' in f;
  let focus: Focus | null = null;
  let pinnedOne: Focus | null = null;
  let lit: ReadonlySet<string> | null = null;
  let ghosts: Ghosts = NO_GHOSTS;
  /** What is in focus: the hovered atom or arrow, else the pinned one. */
  const shown = () => focus ?? pinnedOne;
  const GHOST = new THREE.Color(0xff5a5a);
  /** An update ghost's colour: the Inspector's edit amber (--x), apart from the delete ghost's red. */
  const UPDATED = new THREE.Color(0xfbbf24);
  const CREATED = new THREE.Color(0x4ade80);
  const tint = new THREE.Color();

  // ---------- Halos (the user, 2026-10-16: option B of the ghost-styles mock, "breathing halo") ----------
  // A glow around an atom, gently breathing (about 1.6 s; still with reduced motion): red for a deleted atom, amber for
  // one with finished edits, the atom's own colour for the pinned one (a pinned ghost keeps its red or amber, so the
  // change always shows). It never shrinks below about 34 px on screen, so it marks the atom at the whole-project view,
  // and it stays strong while the rest of the molecule is faded.
  // Drawn by a shader on a camera-facing disc (the user, 2026-10-16: "the halo isn't circle like the atom"): its bright
  // edge lies exactly on the atom's outline on screen, at any zoom and any size, and nothing is drawn inside the atom —
  // a texture's ring sat inside the see-through body, which the light covered unevenly into a crescent. Blended as a
  // see-through layer, not added light (added amber saturated to yellow-white and turned crossing arrows white-hot), and
  // drawn before the other see-through things, so it reads as a glow behind the atom and its arrows.
  const haloGeom = new THREE.PlaneGeometry(1, 1);
  disposables.push(haloGeom);
  const HALO_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const HALO_FRAGMENT = `
    uniform vec3 color; uniform float opacity; uniform float edge; varying vec2 vUv;
    void main() {
      float d = length(vUv - 0.5) * 2.0;                  // 0 at the centre, 1 at the disc's rim
      if (d >= 1.0 || d < edge * 0.985) discard;          // nothing inside the atom's outline, nothing past the disc
      float t = clamp((d - edge) / max(1.0 - edge, 1e-3), 0.0, 1.0);   // 0 on the outline, 1 at the disc's rim
      float rise = smoothstep(edge * 0.985, edge * 1.012, d);          // a crisp inner edge on the outline
      float a = rise * (0.9 * exp(-t * 4.5) + 0.5 * (1.0 - t) * (1.0 - t)) * (1.0 - smoothstep(0.85, 1.0, d));
      gl_FragColor = vec4(color, a * opacity);
      #include <colorspace_fragment>
    }`;  // the colour space conversion three's own materials do: amber stays #fbbf24, not orange
  type Halo = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  const halos = new Map<AtomView, Halo>();
  /** Which atoms breathe a halo now, and in what colour: set by paint(), animated by breathe(). */
  let haloed: { a: AtomView; color: THREE.Color }[] = [];
  const stillMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  function haloOf(a: AtomView): Halo {
    let h = halos.get(a);
    if (!h) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color() }, opacity: { value: 1 }, edge: { value: 0.5 } },
        vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      });
      h = new THREE.Mesh(haloGeom, mat);
      // drawn first, behind everything see-through: arrows passing through a halo stay crisp on top of it
      h.renderOrder = -1;
      scene.add(h);
      halos.set(a, h);
      disposables.push(mat);
    }
    return h;
  }
  function breathe(t: number) {
    const pulse = stillMotion ? 1 : 0.72 + 0.28 * Math.sin(t / 255);
    const hPx = Math.max(el.clientHeight, 1), tanHalfFov = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const on = new Set<AtomView>();
    for (const { a, color } of haloed) {
      const h = haloOf(a);
      on.add(a);
      h.visible = true;
      h.position.copy(a.pos);
      h.quaternion.copy(camera.quaternion); // faces the camera as the image plane does, so it draws as a true circle
      const r = TYPES[a.atom.type].r, d = camera.position.distanceTo(a.pos);
      // the sphere's outline, measured in the disc's plane (through its centre, facing the camera)
      const outline = (r * d) / Math.sqrt(Math.max(d * d - r * r, 1e-6));
      const perPx = (2 * d * tanHalfFov) / hPx;
      const size = Math.max(outline * 4.2, outline * 2 + 34 * perPx) * (0.94 + 0.08 * pulse);
      h.scale.set(size, size, 1);
      h.material.uniforms.color.value.copy(color);
      h.material.uniforms.opacity.value = 0.95 * pulse;
      h.material.uniforms.edge.value = Math.min((outline * 2) / size, 0.95);
    }
    halos.forEach((h, a) => { if (!on.has(a)) h.visible = false; });
    // a deleted processor is a red ghost only: its health does not show
    healthy.forEach((color, a) => { const g = glowOf(a); g.color.value.copy(color); g.glow.value = ghosts.atoms.has(a.atom.key) ? 0 : pulse; });
  }

  function paint() {
    const keep = new Set<AtomView>();
    const live = new Set<ArrowView>();
    const f = shown();
    if (f && isArrow(f)) {
      live.add(f); keep.add(f.a); keep.add(f.b);
    } else if (f) {
      keep.add(f);
      [...f.out, ...f.in].forEach((x) => { live.add(x); keep.add(x.a); keep.add(x.b); });
    } else if (lit) {
      atoms.forEach((a) => { if (lit!.has(a.atom.key)) keep.add(a); });
      arrows.forEach((x) => { if (keep.has(x.a) && keep.has(x.b)) live.add(x); });
    }
    const all = !f && !lit;
    haloed = [];
    atoms.forEach((a) => {
      const on = all || keep.has(a);
      const ghost = ghosts.atoms.has(a.atom.key);
      const updated = !ghost && !!ghosts.updated?.has(a.atom.key);
      const m = a.mesh.material;
      // a ghost, deleted or updated, is drawn one way (the user, 2026-10-16: align the update ghost to the delete ghost):
      // the body pulled a little to the ghost's colour and faint, so its halo glows through it — red for "goes on
      // apply", amber for "changes on apply"
      const madeDone = !ghost && !!ghosts.created?.has(a.atom.key);
      const made = madeDone || (!ghost && !!ghosts.making?.has(a.atom.key));
      const ghostly = ghost || updated || made;
      m.color.set(TYPES[a.atom.type].color);
      if (ghostly) m.color.lerp(ghost ? GHOST : made ? CREATED : UPDATED, 0.25);
      m.opacity = ghostly ? (on ? 0.45 : 0.3) : on ? 1 : 0.14;
      m.depthWrite = !ghostly;
      if (ghost) haloed.push({ a, color: GHOST });
      // made atoms breathe green from the moment they land, finished or not (the user, 2026-10-17)
      else if (made) haloed.push({ a, color: CREATED });
      else if (updated) haloed.push({ a, color: UPDATED });
      else if (a === pinnedOne) haloed.push({ a, color: new THREE.Color(TYPES[a.atom.type].color) });
      // the pinned atom glows brighter than a hovered one, so it is found again among its neighbours
      m.emissive.setScalar(a === pinnedOne ? 0.32 : a === focus ? 0.18 : 0);
      a.label.classList.toggle('dim', !on);
      a.label.classList.toggle('ghost', ghost);
      a.label.classList.toggle('updated', updated);
    });
    arrows.forEach((x) => {
      const on = live.has(x);
      const ghost = ghosts.arrows.has(arrowKey(x.arrow));
      tint.set(KINDS[x.arrow.kind].color);
      if (ghost) tint.lerp(GHOST, 0.8);
      x.mat.color.copy(tint);
      const op = all ? BOND[KINDS[x.arrow.kind].bond].op : on ? 1 : 0.05;
      x.mat.opacity = ghost ? (on || all ? 0.6 : 0.3) : op;
      // a pinned or hovered arrow glows; an atom's arrows glow while it is in focus
      const self = x === pinnedOne || x === focus;
      x.mat.emissive.copy(f && (on || self) ? tint : new THREE.Color(0)).multiplyScalar(self ? 0.8 : 0.45);
    });
  }

  // ---------- Pointer ----------
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  const solid = [...atoms.values()].map((a) => a.mesh), sleeves = arrows.map((x) => x.sleeve);
  function pick(e: { clientX: number; clientY: number }) {
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects([...solid, ...sleeves], false);
    if (!hits.length) return null;
    // the nearest thing wins; an atom just behind the front arrow's sleeve still wins, since sleeves are wider than arrows
    const atomHit = hits.find((h) => h.object.userData.atom);
    if (atomHit && atomHit.distance < hits[0]!.distance + 0.35) return atomHit;
    // among the arrows under the pointer, the one whose centre line passes closest to it
    const arrowHits = hits.filter((h) => h.object.userData.arrow && (!atomHit || h.distance < atomHit.distance));
    if (!arrowHits.length) return atomHit ?? hits[0]!;
    const off = (h: THREE.Intersection) => { const x = h.object.userData.arrow as ArrowView; return ray.ray.distanceSqToSegment(x.start, x.tip); };
    return arrowHits.reduce((b, h) => (off(h) < off(b) ? h : b));
  }

  // Turning: each drag direction has a fixed axis, so the molecule never leans sideways (the mock's rule):
  //   left/right about the molecule's own vertical axis (a turntable); up/down about the screen's horizontal axis.
  const VERTICAL = new THREE.Vector3(0, 1, 0), offset = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
  const spin = { x: 0, y: 0 };
  let turning: { id: number; x: number; y: number; at: number } | null = null;
  function turn(ax: number, ay: number) {
    offset.subVectors(camera.position, controls.target);
    // upside down, screen-right is the molecule's left, so the turntable runs the other way
    const yaw = camera.up.dot(VERTICAL) < 0 ? ax : -ax;
    offset.applyAxisAngle(VERTICAL, yaw); camera.up.applyAxisAngle(VERTICAL, yaw);
    fwd.copy(offset).negate().normalize();
    right.crossVectors(fwd, camera.up).normalize();
    offset.applyAxisAngle(right, ay); camera.up.applyAxisAngle(right, ay);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  }
  const perPx = () => (2 * Math.PI) / Math.max(el.clientWidth, 1); // a drag across the full width is one full turn

  // Ctrl + drag moves an atom on a plane facing the camera through its centre; touch has no Ctrl, so a finger on an atom drags it.
  // Ctrl + drag on empty canvas moves the whole molecule along the screen's x and y (the user's, 2026-10-15).
  // A mouse's right drag is exactly a Ctrl + drag, on an atom and on empty canvas (the user, 2026-10-19).
  // Cursors (the user's table, 2026-10-15): canvas slide — open hand ready, closed hand while dragging; moving an atom —
  // the four-way arrow, ready and while dragging; turning — the normal arrow at rest, a circular arrow while dragging.
  let overAtom = false, overCanvas = false, ctrlDown = false;
  let dragging: { id: number; atom: AtomView; grip: THREE.Vector3; arrows: ArrowView[] } | null = null;
  let panning: { id: number; x: number; y: number } | null = null;
  let moves = 0; // atom moves, for the kept view
  const setHand = () => {
    const busy = !!(dragging || panning || turning);
    el.classList.toggle('movable', !!dragging || (overAtom && ctrlDown && !busy));
    el.classList.toggle('panready', overCanvas && !overAtom && ctrlDown && !busy);
    el.classList.toggle('panning', !!panning);
    el.classList.toggle('turning', !!turning);
  };
  // The canvas slide moves the drawn picture itself along the screen's x and y (a lens shift), not the camera through the
  // scene: moving the camera would slide near atoms further than far ones, so the molecule would not follow the pointer.
  const shift = { x: 0, y: 0 };
  function applyShift() {
    const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1);
    if (shift.x === 0 && shift.y === 0) camera.clearViewOffset();
    else camera.setViewOffset(w, h, -shift.x, -shift.y, w, h);
    camera.updateProjectionMatrix();
  }
  function pan(dx: number, dy: number) { shift.x += dx; shift.y += dy; applyShift(); }
  function endPan(e: { pointerId: number }) {
    if (!panning || e.pointerId !== panning.id) return;
    panning = null; controls.enabled = true;
    setHand();
  }
  const dragPlane = new THREE.Plane(), dragHit = new THREE.Vector3(), camDir = new THREE.Vector3();
  function grab(e: PointerEvent, a: AtomView) {
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, a.pos);
    if (!ray.ray.intersectPlane(dragPlane, dragHit)) return false;
    hover(e);
    dragging = { id: e.pointerId, atom: a, grip: a.pos.clone().sub(dragHit), arrows: [...a.out, ...a.in] };
    controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    setHand();
    return true;
  }
  function dragTo(e: PointerEvent) {
    pick(e);
    if (!dragging || !ray.ray.intersectPlane(dragPlane, dragHit)) return;
    const a = dragging.atom;
    a.pos.copy(dragHit).add(dragging.grip);
    a.mesh.position.copy(a.pos);
    dragging.arrows.forEach(placeArrow);
    moves++;
  }
  function drop(e: { pointerId: number }) {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging = null; controls.enabled = true;
    setHand();
  }
  function hover(e: PointerEvent) {
    overCanvas = true;
    if (dragging || turning || panning) return;
    const hit = pick(e);
    overAtom = !!hit?.object.userData.atom;
    ctrlDown = e.ctrlKey;
    setHand();
    setFocus(focusOf(hit));
  }
  /** The atom or arrow a pick found (an arrow by its sleeve). */
  function focusOf(hit: THREE.Intersection | null): Focus | null {
    const atomKey = hit?.object.userData.atom as string | undefined;
    if (atomKey) return atoms.get(atomKey) ?? null;
    return (hit?.object.userData.arrow as ArrowView | undefined) ?? null;
  }
  const keyOf = (f: Focus | null) => (f === null ? null : isArrow(f) ? arrowKey(f.arrow) : f.atom.key);
  function setFocus(f: Focus | null) { if (focus === f) return; focus = f; paint(); events.hover(keyOf(f)); }

  // a click (pressed and let go within 5 px, without Ctrl) pins the atom or arrow under it, or unpins on empty canvas
  let press: { x: number; y: number; ctrl: boolean } | null = null;
  listen(canvas, 'pointerdown', (e) => { press = e.button === 0 ? { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey } : null; });
  // a press gives the canvas focus, where its keys act (Delete, Ctrl+Z / Y); the Inspector's fields keep their own
  listen(canvas, 'pointerdown', () => el.focus({ preventScroll: true }));
  listen(canvas, 'pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || p.ctrl || e.button !== 0 || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
    // an arrow tile is aiming (its tail dropped): the click picks its head instead of pinning
    const aiming = canvasBridge.get()?.onClick;
    if (aiming) { aiming((pick(e)?.object.userData.atom as string | undefined) ?? null); return; }
    events.pin(keyOf(focusOf(pick(e))));
  });

  // the mouse button a gesture was begun with (1 left, 2 right, as in `buttons`): it ends when that one is no longer down
  let held = 1;
  listen(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' ? e.button !== 0 && e.button !== 2 : !e.isPrimary) { turning = null; return; }
    // a right press is a Ctrl press
    const ctrl = e.pointerType === 'mouse' && (e.ctrlKey || e.button === 2);
    held = e.button === 2 ? 2 : 1;
    spin.x = spin.y = 0;
    const hit = (e.pointerType !== 'mouse' || ctrl) ? pick(e) : null;
    const atom = hit?.object.userData.atom ? atoms.get(hit.object.userData.atom as string) : undefined;
    if (atom && grab(e, atom)) { turning = null; return; }
    if (ctrl) {
      turning = null;
      panning = { id: e.pointerId, x: e.clientX, y: e.clientY };
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      setHand();
      return;
    }
    turning = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    setHand();
  });
  listen(win, 'pointermove', (e) => {
    // a mouse without the gesture's button down: the release happened where we never heard it; end here, without a coast
    if (e.pointerType === 'mouse' && !(e.buttons & held) && (dragging || turning || panning)) { spin.x = spin.y = 0; drop(e); endPan(e); turning = null; setHand(); return; }
    if (dragging && e.pointerId === dragging.id) { dragTo(e); return; }
    if (panning && e.pointerId === panning.id) { pan(e.clientX - panning.x, e.clientY - panning.y); panning.x = e.clientX; panning.y = e.clientY; return; }
    if (!turning || e.pointerId !== turning.id) return;
    const k = perPx(), ax = (e.clientX - turning.x) * k, ay = (e.clientY - turning.y) * k;
    turning.x = e.clientX; turning.y = e.clientY; turning.at = performance.now();
    turn(ax, ay);
    spin.x = ax; spin.y = ay;
  });
  // let go while moving and the turn coasts on; let go after holding still (250 ms) and it stops
  const endTurn = (e: PointerEvent) => {
    drop(e);
    endPan(e);
    if (!turning || e.pointerId !== turning.id) return;
    const still = performance.now() - turning.at;
    if (e.type !== 'pointerup' || still > 250) spin.x = spin.y = 0;
    else { const k = Math.pow(0.9, still / 16.7); spin.x *= k; spin.y *= k; }
    turning = null;
    setHand();
  };
  listen(win, 'pointerup', endTurn); listen(win, 'pointercancel', endTurn);
  listen(canvas, 'lostpointercapture', endTurn);
  const ctrlKey = (e: KeyboardEvent) => { if (e.key === 'Control') { ctrlDown = e.type === 'keydown'; setHand(); } };
  listen(win, 'keydown', ctrlKey); listen(win, 'keyup', ctrlKey);
  listen(win, 'blur', () => { spin.x = spin.y = 0; turning = null; if (dragging) drop({ pointerId: dragging.id }); if (panning) endPan({ pointerId: panning.id }); ctrlDown = false; setHand(); });
  listen(canvas, 'pointermove', hover);
  listen(canvas, 'pointerleave', () => { overCanvas = false; if (dragging || panning) return; setFocus(null); overAtom = false; setHand(); });
  // the dock's own right-click menus are for tabs; on the molecule a right drag is a Ctrl + drag
  listen(canvas, 'contextmenu', (e) => e.preventDefault());

  // ---------- Zoom ----------
  // The wheel and a two-finger pinch zoom toward the canvas centre (the user, 2026-10-16). The trackball's zoom moved the
  // camera along its own axis, which a slide (the lens shift) has moved off the centre, so an atom put at the centre drifted
  // away. Here the camera moves along the line from it through the canvas centre: whatever is on that line stays at the
  // centre, at any depth. The view direction and the slide do not change; the target (the turning pivot) keeps its place
  // on the camera's axis, so it moves sideways with the camera and turning pivots nearer to what is looked at.
  const axis = new THREE.Vector3(), centreRay = new THREE.Vector3(), step = new THREE.Vector3();
  /** Zooms by `f` (the new camera-to-target distance over the old one), within the zoom limits. */
  function zoomBy(f: number) {
    const dist = camera.position.distanceTo(controls.target);
    const next = THREE.MathUtils.clamp(dist * f, controls.minDistance, controls.maxDistance);
    if (Math.abs(next - dist) < 1e-9) return;
    camera.updateMatrixWorld();
    camera.getWorldDirection(axis);
    centreRay.set(0, 0, 0.5).unproject(camera).sub(camera.position).normalize(); // NDC (0, 0) is the canvas centre, shift included
    step.copy(centreRay).multiplyScalar((dist - next) / centreRay.dot(axis)); // brings the camera (dist − next) nearer along its axis
    camera.position.add(step);
    controls.target.add(step).addScaledVector(axis, -(dist - next)); // = camera + axis × next
  }
  // The wheel's zoom eases in over a few frames, as the trackball's did: one 100 px notch ends at about 0.78 × the distance.
  let zoomPending = 0; // the log of the zoom factor still to apply
  listen(canvas, 'wheel', (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
    zoomPending += px * 0.0025;
  }, { passive: false });
  function easeZoom() {
    if (zoomPending === 0) return;
    const now = zoomPending * 0.12;
    zoomPending -= now;
    if (Math.abs(zoomPending) < 1e-4) zoomPending = 0;
    zoomBy(Math.exp(now));
  }
  // a pinch: two touches on the canvas; their spread scales the distance at once
  const touches = new Map<number, { x: number; y: number }>();
  const spread2 = () => { const [a, b] = [...touches.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  listen(canvas, 'pointerdown', (e) => { if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
  listen(win, 'pointermove', (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    const before = touches.size === 2 ? spread2() : 0;
    t.x = e.clientX; t.y = e.clientY;
    const after = touches.size === 2 ? spread2() : 0;
    if (before > 0 && after > 0) zoomBy(before / after);
  });
  const untouch = (e: PointerEvent) => { touches.delete(e.pointerId); };
  listen(win, 'pointerup', untouch); listen(win, 'pointercancel', untouch);

  // ---------- Size, camera, frame loop ----------
  /** The distance at which the molecule's width and height both fit the view (its depth is in front of that). */
  function fitDistance() {
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2)), tanH = tanV * camera.aspect;
    return Math.max(spread[0]! / tanH, spread[1]! / tanV) * 1.08 + spread[2]!;
  }
  function resize() {
    const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyShift();
    controls.handleResize();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(el);
  cleanups.push(() => observer.disconnect());
  resize();
  const home = fitDistance();
  camera.position.copy(HOME).multiplyScalar(home);
  camera.lookAt(0, 0, 0);
  // zoomed all the way in, the view is about 3.6 units tall, as the mock's closest view was
  controls.minDistance = 1.8 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)); controls.maxDistance = Math.max(home, radius) * 3;
  camera.far = controls.maxDistance + radius * 2;
  camera.updateProjectionMatrix();
  // rebuilt (an atom made or taken back): the camera and the atoms stay where they were
  if (kept.view) {
    camera.position.set(...kept.view.camera); controls.target.set(...kept.view.target); camera.up.set(...kept.view.up);
    camera.lookAt(controls.target);
    // the pan is a slide of the picture, not a camera move (the user, 2026-10-17: a drop "lost the center")
    shift.x = kept.view.shift.x; shift.y = kept.view.shift.y; applyShift();
    kept.view.atoms.forEach((p, key) => { const a = atoms.get(key); if (a) { a.pos.set(...p); a.mesh.position.copy(a.pos); } });
    arrows.forEach(placeArrow);
    // a rebuilt scene hovers nothing yet, and reports a hover only when it changes: the hover the old scene left (the
    // atom a tile was dropped on) would stay in the Inspector over the new pinned atom until another atom was hovered
    events.hover(null);
  }
  // the mock's fog (0.016 at a 30-unit camera), scaled to this molecule's distance, so its far side fades as gently
  fog.density = 0.48 / home;

  // With the whole project in view, every label at once is unreadable: a label shows once its atom is drawn this many
  // pixels wide (radius), a workflow's always; an atom's own neighbours are labelled while it is hovered.
  const LABEL_AT: Readonly<Record<AtomType, number>> = { wf: 0, proc: 4, step: 4, cache: 4, schema: 6, asg: 7 };
  const v = new THREE.Vector3();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  function placeLabels() {
    const w = el.clientWidth, h = el.clientHeight;
    const near = new Set<AtomView>();
    const f = shown();
    if (f && isArrow(f)) { near.add(f.a); near.add(f.b); }
    else if (f) { near.add(f); [...f.out, ...f.in].forEach((x) => { near.add(x.a); near.add(x.b); }); }
    atoms.forEach((a) => {
      const { pos, label } = a;
      v.copy(pos).project(camera);
      const px = (TYPES[a.atom.type].r / (camera.position.distanceTo(pos) * tanHalf)) * (h / 2);
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && (near.has(a) || px >= LABEL_AT[a.atom.type]);
      label.style.display = vis ? '' : 'none';
      if (vis) { label.style.left = `${((v.x + 1) / 2) * w}px`; label.style.top = `${((1 - v.y) / 2) * h}px`; }
    });
  }
  const lastCam = new THREE.Vector3(NaN, NaN, NaN);
  let raf = 0;
  /** Each atom's disc faces the camera as the image plane does, and covers the sphere's outline in its plane. */
  function faceAtoms() {
    atoms.forEach((a) => {
      const r = TYPES[a.atom.type].r, d = camera.position.distanceTo(a.pos);
      const outline = (r * d) / Math.sqrt(Math.max(d * d - r * r, 1e-6));
      a.mesh.quaternion.copy(camera.quaternion);
      a.mesh.scale.setScalar(outline * 1.04); // a hair of margin for the edge's antialiasing; the shader cuts the circle
    });
  }
  // ---------- The view, kept in this browser (the user, 2026-10-17) ----------
  // The camera, the slide and the atoms' places, reported once they have held still for 400 ms with nothing pressed: a
  // coasting turn, an easing zoom or a damped slide is one change, not one per frame. Rounded, so damping's last vanishing
  // steps end the change instead of keeping it alive.
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const vec4 = (v: THREE.Vector3): Vec => [r4(v.x), r4(v.y), r4(v.z)];
  const signature = () => `${vec4(camera.position)}|${vec4(controls.target)}|${vec4(camera.up)}|${r4(shift.x)},${r4(shift.y)}|${moves}`;
  let lastSig = '', changedAt = 0, unreported = !!kept.report;
  kept.report = false;
  function watchView(now: number) {
    const sig = signature();
    if (sig !== lastSig) { if (lastSig !== '') unreported = true; lastSig = sig; changedAt = now; return; }
    if (!unreported || dragging || turning || panning || now - changedAt < 400) return;
    reportView(false);
  }
  function reportView(closing: boolean) {
    unreported = false;
    lastSig = signature();
    events.view?.({
      camera: vec4(camera.position), target: vec4(controls.target), up: vec4(camera.up), shift: { x: r4(shift.x), y: r4(shift.y) },
      atoms: Object.fromEntries([...atoms].map(([k, a]) => [k, vec4(a.pos)])),
    }, closing);
  }
  // the page closing mid-turn (still coasting) or mid-drag: the view as it stands is kept
  listen(win, 'pagehide', () => { if (unreported || signature() !== lastSig) reportView(true); });
  // the chat's relocation glides to the new places (0.9 s, eased); kept afterwards as a move by hand is
  let gliding: { t0: number; atoms: { a: AtomView; from: THREE.Vector3; to: THREE.Vector3 }[] } | null = null;
  function glide(now: number) {
    if (!gliding) return;
    const t = Math.min(1, (now - gliding.t0) / (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : 900));
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const touched = new Set<ArrowView>();
    for (const g of gliding.atoms) { g.a.pos.lerpVectors(g.from, g.to, e); g.a.mesh.position.copy(g.a.pos); [...g.a.out, ...g.a.in].forEach((x) => touched.add(x)); }
    touched.forEach(placeArrow);
    if (t >= 1) { gliding = null; moves++; }
  }
  function frame() {
    glide(performance.now());
    if (!turning && (Math.abs(spin.x) > 1e-4 || Math.abs(spin.y) > 1e-4)) { turn(spin.x, spin.y); spin.x *= 0.9; spin.y *= 0.9; }
    easeZoom();
    controls.update();
    faceAtoms();
    breathe(performance.now());
    // arrows ending at a ball's outline follow the camera
    if (!lastCam.equals(camera.position)) { lastCam.copy(camera.position); arrows.forEach(placeArrow); }
    renderer.render(scene, camera);
    placeLabels();
    watchView(performance.now());
    raf = win.requestAnimationFrame(frame);
  }
  raf = win.requestAnimationFrame(frame);

  // the browser checks read the scene from here (dev server only; never in a build)
  // the browser suite's hook: always in development; in a production build only on a page opened with ?e2e (the user,
  // 2026-10-17: run the full suite on the deployed Valence), so a normal visit carries nothing extra
  const e2e = (() => { try { return new URLSearchParams(win.location.search).has('e2e'); } catch { return false; } })();
  if (import.meta.env.DEV || e2e) Object.assign(el, { __molecule: { camera, atoms, arrows, halos, radiusOf: (t: AtomType) => TYPES[t].r,
    glowOf: (key: string) => { const a = atoms.get(key); return a ? { color: '#' + glowOf(a).color.value.getHexString(), glow: glowOf(a).glow.value } : null; } } });

  // ---------- The Toolbox's drag (2026-10-17): sizes, targets and the aimed arrow ----------
  const tanHalfView = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const worldPerPx = (d: number) => (2 * d * tanHalfView) / Math.max(el.clientHeight, 1);
  const onCanvas = (x: number, y: number) => { const r = canvas.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const rayTo = (x: number, y: number) => {
    const r = canvas.getBoundingClientRect();
    mouse.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    return ray.ray;
  };
  const viewPlane = new THREE.Plane(), planeHit = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  /** The point under (x, y) on the plane facing the camera through `through`. */
  const pointAt = (x: number, y: number, through: THREE.Vector3) => {
    camera.getWorldDirection(camDir);
    viewPlane.setFromNormalAndCoplanarPoint(camDir, through);
    return rayTo(x, y).intersectPlane(viewPlane, planeHit) ? planeHit.clone() : null;
  };
  let litBefore: ReadonlySet<string> | null = null, spotlit = false;
  // the aimed arrow: one shaft and head, re-shaped as the pointer moves
  let aimed: { shaft: THREE.Mesh; head: THREE.Mesh; mat: THREE.MeshStandardMaterial; kind: ArrowKind } | null = null;
  const clearAim = () => {
    if (!aimed) return;
    scene.remove(aimed.shaft, aimed.head);
    aimed.shaft.geometry.dispose(); aimed.head.geometry.dispose(); aimed.mat.dispose();
    aimed = null;
  };
  canvasBridge.set({
    contains: onCanvas,
    atomAt(x, y) {
      if (!onCanvas(x, y)) return null;
      rayTo(x, y);
      const hit = ray.intersectObjects(solid, false)[0];
      return (hit?.object.userData.atom as string | undefined) ?? null;
    },
    landing(x, y, type, near) {
      if (!onCanvas(x, y)) return null;
      const r = TYPES[type].r;
      let pos: THREE.Vector3 | null;
      const by = near ? atoms.get(near) : undefined;
      if (by) {
        // beside the atom it is dropped on, at its depth, on the side the pointer is
        camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const under = pointAt(x, y, by.pos);
        const side = under && under.clone().sub(by.pos).dot(camRight) < 0 ? -1 : 1;
        // the first free place around it, starting on the pointer's side (a second step on the same processor went exactly
        // on top of the first, the two impossible to tell apart or to click): turning round it in the screen's plane, then
        // a ring further out
        camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const gap = TYPES[by.atom.type].r + r + 0.6;
        const free = (p: THREE.Vector3) => [...atoms.values()].every((o) => o === by || o.pos.distanceTo(p) >= TYPES[o.atom.type].r + r + 0.3);
        pos = null;
        for (let ring = 1; ring <= 4 && !pos; ring++) {
          for (let i = 0; i < 12 && !pos; i++) {
            const a = (i % 2 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI / 6);
            const p = by.pos.clone().addScaledVector(camRight, side * Math.cos(a) * gap * ring).addScaledVector(camUp, Math.sin(a) * gap * ring);
            if (free(p)) pos = p;
          }
        }
        pos ??= by.pos.clone().addScaledVector(camRight, side * gap);
      } else {
        pos = pointAt(x, y, controls.target);
      }
      if (!pos) return null;
      const d = camera.position.distanceTo(pos), outline = (r * d) / Math.sqrt(Math.max(d * d - r * r, 1e-6));
      return { pos: [pos.x, pos.y, pos.z], px: outline / worldPerPx(d) };
    },
    bondPx(x, y, kind) {
      if (!onCanvas(x, y)) return null;
      const p = pointAt(x, y, controls.target);
      return p ? BOND[KINDS[kind].bond].r / worldPerPx(camera.position.distanceTo(p)) : null;
    },
    spotlight(keys) {
      if (keys) { if (!spotlit) { litBefore = lit; spotlit = true; } lit = keys.size > 0 ? keys : null; }
      else if (spotlit) { lit = litBefore; spotlit = false; }
      paint();
    },
    aim(preview) {
      if (!preview) { clearAim(); return; }
      const tail = atoms.get(preview.tail);
      if (!tail) { clearAim(); return; }
      if (!aimed || aimed.kind !== preview.kind) {
        clearAim();
        const k = KINDS[preview.kind], bond = BOND[k.bond];
        const mat = new THREE.MeshStandardMaterial({ color: k.color, emissive: k.color, emissiveIntensity: 0.35, roughness: 0.45, metalness: 0.1 });
        const { headGeom } = headOf(bond.r);
        aimed = { shaft: new THREE.Mesh(shaftOf(bond.r), mat), head: new THREE.Mesh(headGeom, mat), mat, kind: preview.kind };
        scene.add(aimed.shaft, aimed.head);
      }
      const head = preview.head ? atoms.get(preview.head) : undefined;
      const end = head ? head.pos.clone() : pointAt(preview.x, preview.y, tail.pos);
      if (!end) return;
      const dir = end.clone().sub(tail.pos); const D = dir.length(); dir.divideScalar(D || 1);
      const headLen = (Math.max(BOND[KINDS[preview.kind].bond].r * 2.4, 0.075)) * 3.4;
      const start = tail.pos.clone().addScaledVector(dir, TYPES[tail.atom.type].r * 0.6);
      const tip = head ? tail.pos.clone().addScaledVector(dir, D - TYPES[head.atom.type].r) : end;
      const shaftEnd = tip.clone().addScaledVector(dir, -headLen);
      const len = Math.max(shaftEnd.clone().sub(start).dot(dir), 0.001);
      aimed.shaft.position.copy(start).add(shaftEnd).multiplyScalar(0.5);
      aimed.shaft.quaternion.setFromUnitVectors(up, dir); aimed.shaft.scale.set(1, len, 1);
      aimed.head.position.copy(tip); aimed.head.quaternion.setFromUnitVectors(up, dir);
    },
    rekey(rename) { kept.rename = rename; },
    positions: () => new Map([...atoms].map(([k, a]) => [k, a.pos.toArray() as Vec])),
    place(places) {
      const t0 = performance.now();
      gliding = { t0, atoms: [...places].flatMap(([k, to]) => { const a = atoms.get(k); return a ? [{ a, from: a.pos.clone(), to: new THREE.Vector3(...to) }] : []; }) };
    },
    onClick: null,
  });
  cleanups.push(() => { clearAim(); canvasBridge.set(null); });

  return {
    highlight(keys) { if (spotlit) { litBefore = keys && keys.size > 0 ? keys : null; return; } lit = keys && keys.size > 0 ? keys : null; paint(); },
    pin(key) { pinnedOne = key === null ? null : isArrowKey(key) ? arrowByKey.get(key) ?? null : atoms.get(key) ?? null; paint(); },
    ghost(next) { ghosts = next; paint(); },
    health(next) {
      healthy.forEach((_, a) => { glowOf(a).glow.value = 0; });
      healthy = new Map([...next].flatMap(([k, h]) => { const a = atoms.get(k); return a ? [[a, new THREE.Color(HEALTH_HEX[h])] as const] : []; }));
    },
    rename(names) { atoms.forEach((a) => { a.label.textContent = names.get(a.atom.key) ?? a.atom.name; }); },
    dispose() {
      // after an apply, a made atom's place is kept under the id BaseApi gave it
      const rename = kept.rename;
      kept.rename = undefined;
      kept.report = !!rename?.size; // the made atoms' places, under their real ids
      kept.view = { camera: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), shift: { ...shift }, atoms: new Map([...atoms].map(([k, a]) => [rename?.get(k) ?? k, a.pos.toArray()])) };
      win.cancelAnimationFrame(raf);
      cleanups.forEach((c) => c());
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      // dispose() keeps the WebGL context: every rebuild (a drop, an undo, an apply) left one behind until Chrome warned
      // "Too many active WebGL contexts" and the tab could crash (found by the apply e2e, 2026-10-17)
      renderer.forceContextLoss();
      canvas.remove();
      labelsEl.replaceChildren();
    },
  };
}
