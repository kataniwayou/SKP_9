import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { extentOf, type Vec } from './layout';
import { arrowKey, BOND, isArrowKey, KINDS, TYPES, type Arrow, type Atom, type AtomType, type Molecule } from './model';

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

/** What the view changes in place, without building the scene again. */
interface Painter {
  highlight(keys: ReadonlySet<string> | null): void;
  /** An atom's or an arrow's key (`arrowKey`), or null. */
  pin(key: string | null): void;
  /** Deleted in Valence and not applied (spec §6): drawn as red ghosts. */
  ghost(ghosts: Ghosts): void;
  /** Labels show the virtual entities' names (decision 8): edited names by atom key. */
  rename(names: ReadonlyMap<string, string>): void;
}

/** What the view tells the page: the atom or arrow under the pointer, and a click's (null: empty canvas). Arrows by `arrowKey`. */
export interface MoleculeEvents { hover(key: string | null): void; pin(key: string | null): void }

/**
 * Ghosts of the virtual changes: atoms and arrows (by key) deleted in Valence — the arrows include those touching a deleted
 * atom (`goneArrows`) — drawn red; and atoms with finished edits, `updated`, drawn amber (a deleted one stays red).
 */
export interface Ghosts { atoms: ReadonlySet<string>; arrows: ReadonlySet<string>; updated?: ReadonlySet<string> }
const NO_GHOSTS: Ghosts = { atoms: new Set(), arrows: new Set() };

/**
 * The whole-project molecule (spec §2.7), drawn as the approved mock draws one workflow (docs/valence/molecule-mock.html),
 * over SKP Studio's dark ground: rows are atoms, foreign keys are arrows whose thickness is the bond class. Hover shows an
 * atom with its one-hop neighbours (no tooltip: the user, 2026-10-15); a drag turns the molecule about fixed axes (it
 * coasts on after a quick release), the wheel (or a pinch) zooms toward the canvas centre, a right drag or Ctrl + drag on empty canvas pans, and Ctrl + drag on
 * an atom moves that atom. A click (no drag) on an atom pins it, on empty canvas unpins; the pinned atom glows and, while
 * nothing is hovered, keeps its neighbours in focus. `highlighted`: the atoms of the chosen workflows stand out and the
 * rest are dimmed; null highlights nothing.
 */
export function MoleculeView({ molecule, positions, highlighted, pinned = null, names, events, ghosts = NO_GHOSTS }: {
  molecule: Molecule; positions: ReadonlyMap<string, Vec>; highlighted: ReadonlySet<string> | null;
  pinned?: string | null; names?: ReadonlyMap<string, string>; events?: MoleculeEvents; ghosts?: Ghosts;
}) {
  const host = useRef<HTMLDivElement>(null);
  const painter = useRef<Painter | null>(null);
  const latest = useRef({ highlighted, pinned, names, events, ghosts });
  latest.current = { highlighted, pinned, names, events, ghosts };

  useEffect(() => {
    const el = host.current!;
    const scene3 = buildScene(el, molecule, positions, {
      hover: (key) => latest.current.events?.hover(key),
      pin: (key) => latest.current.events?.pin(key),
    });
    painter.current = scene3;
    scene3.highlight(latest.current.highlighted);
    scene3.ghost(latest.current.ghosts);
    scene3.pin(latest.current.pinned);
    if (latest.current.names) scene3.rename(latest.current.names);
    return () => { painter.current = null; scene3.dispose(); };
  }, [molecule, positions]);

  useEffect(() => { painter.current?.highlight(highlighted); }, [highlighted]);
  useEffect(() => { painter.current?.pin(pinned); }, [pinned]);
  useEffect(() => { painter.current?.ghost(ghosts); }, [ghosts]);
  useEffect(() => { if (names) painter.current?.rename(names); }, [names]);

  return (
    // focusable: the canvas's keys (Delete, Ctrl+Z / Y) act while it has focus; a press on it gives it focus
    <div className="mol" ref={host} aria-label="Molecule" tabIndex={0}>
      <div className="mol-labels" aria-hidden="true" />
      <div className="mol-legend" aria-label="Atom colours">
        {LEGEND.map((t) => <span key={t}><i className="mol-dot" style={{ background: hex(TYPES[t].color) }} />{TYPES[t].label}</span>)}
      </div>
    </div>
  );
}

interface AtomView { atom: Atom; pos: THREE.Vector3; mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>; label: HTMLDivElement; out: ArrowView[]; in: ArrowView[] }
interface ArrowView { arrow: Arrow; a: AtomView; b: AtomView; mat: THREE.MeshStandardMaterial; shaft: THREE.Mesh; head: THREE.Mesh; sleeve: THREE.Mesh; headLen: number; start: THREE.Vector3; tip: THREE.Vector3 }

/**
 * An arrowhead (the user, 2026-10-16: "isn't elegant"): a slim dart turned on a lathe — flanks curving gently in to a
 * sharp point, about 3.4 times as long as it is wide at the base, smooth with 40 sides, its base closed by a low dome
 * (a hollow-looking dish read as an open bell from behind). Built pointing up (+y) with its point at the origin, so it is placed at the arrow's tip. The head's width grows
 * with the bond, but not below a size that still reads at the whole-project view.
 */
function headOf(shaftR: number): { headGeom: THREE.LatheGeometry; headLen: number } {
  const R = Math.max(shaftR * 2.4, 0.075), L = R * 3.4;
  const profile: THREE.Vector2[] = [new THREE.Vector2(0, -L - R * 0.16)]; // the dome's crown, just behind the base
  profile.push(new THREE.Vector2(R * 0.55, -L - R * 0.11), new THREE.Vector2(R * 0.88, -L - R * 0.04), new THREE.Vector2(R, -L));
  for (let i = 1; i <= 16; i++) {
    const s = i / 16; // 0 at the base, 1 at the point
    profile.push(new THREE.Vector2(R * Math.pow(1 - s, 1.25), -L + s * L));
  }
  const headGeom = new THREE.LatheGeometry(profile, 40);
  headGeom.computeVertexNormals();
  return { headGeom, headLen: L };
}

function buildScene(el: HTMLDivElement, molecule: Molecule, positions: ReadonlyMap<string, Vec>, events: MoleculeEvents): Painter & { dispose(): void } {
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

  // The trackball only pans (right drag, two fingers); turning and zooming are our own, below.
  const controls = new TrackballControls(camera, canvas);
  controls.noRotate = true; controls.noZoom = true; controls.panSpeed = 0.8;
  controls.staticMoving = false; controls.dynamicDampingFactor = 0.12;
  controls.keys = ['', '', '']; // no A/S/D mode keys
  cleanups.push(() => controls.dispose());

  // ---------- Atoms and arrows ----------
  // Lights in physical units (three r155+): the mock's r128 intensities times π.
  scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x1a1420, 0.75 * Math.PI));
  const key1 = new THREE.DirectionalLight(0xffffff, 0.9 * Math.PI); key1.position.set(8, 14, 10); scene.add(key1);
  const rim = new THREE.DirectionalLight(0x8aa0ff, 0.5 * Math.PI); rim.position.set(-10, -4, -12); scene.add(rim);

  const atoms = new Map<string, AtomView>();
  const geoms = new Map<AtomType, THREE.SphereGeometry>();
  molecule.atoms.forEach((atom) => {
    const t = TYPES[atom.type];
    const geom = geoms.get(atom.type) ?? new THREE.SphereGeometry(t.r, 40, 28);
    geoms.set(atom.type, geom);
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.32, metalness: 0.15, transparent: true, opacity: 1 }));
    const p = positions.get(atom.key) ?? [0, 0, 0];
    const pos = new THREE.Vector3(...p);
    mesh.position.copy(pos);
    mesh.userData.atom = atom.key;
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
  const disposables: { dispose(): void }[] = [sleeveGeom, sleeveMat, ...geoms.values()];
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
      x.tip.lerpVectors(x.start, x.tip, lo);
    }
    // the shaft runs into the head's base a little, so no seam shows between them
    const shaftEnd = aEnd.copy(x.tip).addScaledVector(dir, -x.headLen * 0.92);
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
  const arrows: ArrowView[] = molecule.arrows.map((arrow) => {
    const k = KINDS[arrow.kind], bond = BOND[k.bond];
    // one head per bond class, shared by its arrows and disposed with the scene
    const { headGeom, headLen } = headByBond.get(bond.r) ?? headByBond.set(bond.r, headOf(bond.r)).get(bond.r)!;
    const mat = new THREE.MeshStandardMaterial({ color: k.color, transparent: true, opacity: bond.op, roughness: 0.45, metalness: 0.1 });
    // closed, smooth tubes: a close look sees a round rod, never a hollow ring
    const shaftGeom = new THREE.CylinderGeometry(bond.r, bond.r, 1, 24, 1, false);
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
  const tint = new THREE.Color();
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
    atoms.forEach((a) => {
      const on = all || keep.has(a);
      const ghost = ghosts.atoms.has(a.atom.key);
      const updated = !ghost && !!ghosts.updated?.has(a.atom.key);
      const m = a.mesh.material;
      // a delete ghost: the atom's colour pulled to red, faint even when in focus, so it reads as "goes on apply";
      // an update ghost: pulled to amber, half-faint, so it reads as "changes on apply"
      m.color.set(TYPES[a.atom.type].color);
      if (ghost) m.color.lerp(GHOST, 0.65);
      else if (updated) m.color.lerp(UPDATED, 0.6);
      m.opacity = ghost ? (on ? 0.32 : 0.1) : updated ? (on ? 0.6 : 0.12) : on ? 1 : 0.14;
      m.depthWrite = !ghost && !updated;
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
      x.mat.opacity = ghost ? Math.min(op, on ? 0.45 : 0.12) : op;
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
  // Cursors (the user's table, 2026-10-15): canvas slide — open hand ready, closed hand while dragging; moving an atom —
  // the four-way arrow, ready and while dragging; turning — the normal arrow at rest, a circular arrow while dragging.
  let overAtom = false, overCanvas = false, ctrlDown = false;
  let dragging: { id: number; atom: AtomView; grip: THREE.Vector3; arrows: ArrowView[] } | null = null;
  let panning: { id: number; x: number; y: number } | null = null;
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
    events.pin(keyOf(focusOf(pick(e))));
  });

  listen(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' ? e.button !== 0 : !e.isPrimary) { turning = null; return; }
    spin.x = spin.y = 0;
    const hit = (e.pointerType !== 'mouse' || e.ctrlKey) ? pick(e) : null;
    const atom = hit?.object.userData.atom ? atoms.get(hit.object.userData.atom as string) : undefined;
    if (atom && grab(e, atom)) { turning = null; return; }
    if (e.pointerType === 'mouse' && e.ctrlKey) {
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
    // a mouse with no button down: the release happened where we never heard it; end here, without a coast
    if (e.pointerType === 'mouse' && !(e.buttons & 1) && (dragging || turning || panning)) { spin.x = spin.y = 0; drop(e); endPan(e); turning = null; setHand(); return; }
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
  // the dock's own right-click menus are for tabs; on the molecule a right drag pans
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
  function frame() {
    if (!turning && (Math.abs(spin.x) > 1e-4 || Math.abs(spin.y) > 1e-4)) { turn(spin.x, spin.y); spin.x *= 0.9; spin.y *= 0.9; }
    easeZoom();
    controls.update();
    // arrows ending at a ball's outline follow the camera
    if (!lastCam.equals(camera.position)) { lastCam.copy(camera.position); arrows.forEach(placeArrow); }
    renderer.render(scene, camera);
    placeLabels();
    raf = win.requestAnimationFrame(frame);
  }
  raf = win.requestAnimationFrame(frame);

  // the browser checks read the scene from here (dev server only; never in a build)
  if (import.meta.env.DEV) Object.assign(el, { __molecule: { camera, atoms, arrows, radiusOf: (t: AtomType) => TYPES[t].r } });

  return {
    highlight(keys) { lit = keys && keys.size > 0 ? keys : null; paint(); },
    pin(key) { pinnedOne = key === null ? null : isArrowKey(key) ? arrowByKey.get(key) ?? null : atoms.get(key) ?? null; paint(); },
    ghost(next) { ghosts = next; paint(); },
    rename(names) { atoms.forEach((a) => { a.label.textContent = names.get(a.atom.key) ?? a.atom.name; }); },
    dispose() {
      win.cancelAnimationFrame(raf);
      cleanups.forEach((c) => c());
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      canvas.remove();
      labelsEl.replaceChildren();
    },
  };
}
