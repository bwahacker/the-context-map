/**
 * graph3d.js — 3D WebGL force-directed graph using Three.js + d3-force-3d
 *
 * Primary view for The Context Map. Files as glowing nodes in 3D space,
 * edges = co-occurrence weight. WASD flight-sim navigation.
 *
 * Usage: window.Graph3D.show() / .hide() / .render(graph) / .highlightNode(id)
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

// ─── State ───
let container, renderer, css2dRenderer, scene, camera, composer, clock;
let running = false, visible = false;
let nodeMesh = null, edgeLines = null;
let nodeData = [], edgeData = [], currentLinks = [];
let adjacency = new Map();   // nodeId → Set<nodeId>
let nodeIndex = new Map();   // nodeId → index in nodeData
let labelObjects = [];
let simulation = null;
let selectedId = null;
let hoveredId = null;
let raycaster, mouse;
let rayThrottle = 0;

// Navigation
let keys = {};
const MOVE_SPEED = 150;
const LOOK_SPEED = 0.002;
let isPointerLocked = false;
let euler = new THREE.Euler(0, 0, 0, "YXZ");

// ─── Colors matching the existing palette ───
function nodeColor(d) {
  if (d.type === "session") return new THREE.Color(0x4a4aaa);
  if (d.shared) return new THREE.Color(0x8a6a30);
  return new THREE.Color(0x2a5a2a);
}

function nodeRadius(d) {
  if (d.type === "session") return 2 + Math.sqrt(d.toolCalls || 0) * 0.3;
  if (d.shared) return 1.5 + Math.sqrt(d.sessionCount || 1) * 0.8;
  return 1.2;
}

function edgeColor(d, maxWeight) {
  const t = Math.min(1, d.weight / Math.max(maxWeight * 0.5, 1));
  return new THREE.Color().setRGB(
    (40 + 180 * t) / 255,
    (50 + 100 * t * t) / 255,
    (60 + 40 * (1 - t)) / 255
  );
}

// ─── Init ───
function init() {
  container = document.getElementById("graph3d-container");
  if (!container) return;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || (window.innerHeight - 52);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x060610);
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.5;
  container.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x060610, 0.0008);

  // Camera
  camera = new THREE.PerspectiveCamera(70, w / h, 0.5, 8000);
  camera.position.set(0, 0, 250);

  // Lights
  const ambient = new THREE.AmbientLight(0x222244, 1.5);
  scene.add(ambient);
  const point = new THREE.PointLight(0x6666ff, 2, 2000);
  point.position.set(0, 100, 200);
  scene.add(point);
  const point2 = new THREE.PointLight(0xff6633, 1, 1500);
  point2.position.set(-200, -50, -100);
  scene.add(point2);

  // Bloom post-processing
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h), 1.2, 0.6, 0.15
  );
  composer.addPass(bloom);

  // CSS2D labels
  css2dRenderer = new CSS2DRenderer();
  css2dRenderer.setSize(w, h);
  css2dRenderer.domElement.style.position = "absolute";
  css2dRenderer.domElement.style.top = "0";
  css2dRenderer.domElement.style.left = "0";
  css2dRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(css2dRenderer.domElement);

  // Raycaster
  raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 3 };
  mouse = new THREE.Vector2(-999, -999);

  // Clock
  clock = new THREE.Clock();

  // Events
  renderer.domElement.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener("click", onClick);
  renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());
  renderer.domElement.addEventListener("mousedown", onMouseDown);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("mousemove", onDocMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", onResize);
}

// ─── WASD Flight Navigation ───
function onKeyDown(e) {
  // Don't capture when typing in inputs
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  keys[e.code] = true;
}
function onKeyUp(e) { keys[e.code] = false; }

function onMouseDown(e) {
  if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
    renderer.domElement.requestPointerLock();
  }
}
function onPointerLockChange() {
  isPointerLocked = document.pointerLockElement === renderer.domElement;
  if (isPointerLocked) {
    euler.setFromQuaternion(camera.quaternion);
  }
}
function onDocMouseMove(e) {
  if (!isPointerLocked) return;
  euler.y -= e.movementX * LOOK_SPEED;
  euler.x -= e.movementY * LOOK_SPEED;
  euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
  camera.quaternion.setFromEuler(euler);
}

function updateNavigation(delta) {
  const speed = MOVE_SPEED * delta * (keys["ShiftLeft"] || keys["ShiftRight"] ? 3 : 1);
  const dir = new THREE.Vector3();

  if (keys["KeyW"] || keys["ArrowUp"]) dir.z -= 1;
  if (keys["KeyS"] || keys["ArrowDown"]) dir.z += 1;
  if (keys["KeyA"] || keys["ArrowLeft"]) dir.x -= 1;
  if (keys["KeyD"] || keys["ArrowRight"]) dir.x += 1;
  if (keys["Space"]) dir.y += 1;
  if (keys["KeyC"] || keys["ControlLeft"]) dir.y -= 1;

  if (dir.lengthSq() > 0) {
    dir.normalize().multiplyScalar(speed);
    dir.applyQuaternion(camera.quaternion);
    camera.position.add(dir);
  }

  // Scroll wheel zoom (handled via wheel event)
}

// ─── Mouse / Ray ───
function onMouseMove(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function onClick(e) {
  if (!nodeMesh || nodeData.length === 0) return;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(nodeMesh);
  if (hits.length > 0) {
    const idx = hits[0].instanceId;
    const d = nodeData[idx];
    if (d) {
      selectedId = d.id;
      highlightConnected(d.id);
      // Call the global showDetail / showFileStory
      if (d.type === "file" && d.fullPath && window.showFileStory) {
        window.showFileStory(d.fullPath);
      } else if (window.showDetail) {
        window.showDetail(d, currentLinks);
      }
    }
  } else {
    selectedId = null;
    restoreColors();
    if (window.closeDetail) window.closeDetail();
  }
}

// Scroll to zoom
function onWheel(e) {
  e.preventDefault();
  const dir = new THREE.Vector3(0, 0, -Math.sign(e.deltaY) * 20);
  dir.applyQuaternion(camera.quaternion);
  camera.position.add(dir);
}

function onResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || (window.innerHeight - 52);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  css2dRenderer.setSize(w, h);
}

// ─── Build Scene from Graph Data ───
function buildGraph(graph) {
  // Clear previous
  clearScene();

  nodeData = graph.nodes;
  edgeData = graph.edges;
  const maxWeight = graph.stats ? graph.stats.maxWeight || 1 : 1;

  // Build adjacency + index
  adjacency.clear();
  nodeIndex.clear();
  for (let i = 0; i < nodeData.length; i++) {
    nodeIndex.set(nodeData[i].id, i);
    adjacency.set(nodeData[i].id, new Set());
  }

  // Build links for simulation (need mutable source/target)
  currentLinks = edgeData.map(e => ({
    source: e.source,
    target: e.target,
    weight: e.weight || 1,
    reads: e.reads || 0,
    writes: e.writes || 0,
  }));

  for (const e of currentLinks) {
    const sid = typeof e.source === "object" ? e.source.id : e.source;
    const tid = typeof e.target === "object" ? e.target.id : e.target;
    if (adjacency.has(sid)) adjacency.get(sid).add(tid);
    if (adjacency.has(tid)) adjacency.get(tid).add(sid);
  }

  // ─── d3-force-3d layout ───
  const d3f = window.d3Force3d || window.d3;
  simulation = d3f.forceSimulation(nodeData)
    .force("link", d3f.forceLink(currentLinks).id(d => d.id).distance(d => {
      return Math.max(15, 60 - (d.weight || 1) * 4);
    }).strength(d => Math.min(1, 0.3 + (d.weight || 1) * 0.05)))
    .force("charge", d3f.forceManyBody().strength(d => {
      return -30 - (d.sessionCount || 1) * 2;
    }))
    .force("center", d3f.forceCenter(0, 0, 0))
    .force("collision", d3f.forceCollide().radius(d => nodeRadius(d) + 1))
    .stop();

  // Pre-settle
  const ticks = Math.min(200, Math.max(80, nodeData.length));
  for (let i = 0; i < ticks; i++) simulation.tick();

  // ─── Build InstancedMesh for nodes ───
  const sphereGeo = new THREE.SphereGeometry(1, 20, 14);
  const nodeMat = new THREE.MeshStandardMaterial({
    roughness: 0.3,
    metalness: 0.6,
    emissiveIntensity: 0.8,
  });
  nodeMesh = new THREE.InstancedMesh(sphereGeo, nodeMat, nodeData.length);
  nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const dummy = new THREE.Object3D();
  for (let i = 0; i < nodeData.length; i++) {
    const d = nodeData[i];
    const r = nodeRadius(d);
    dummy.position.set(d.x || 0, d.y || 0, d.z || 0);
    dummy.scale.setScalar(r);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);
    const c = nodeColor(d);
    nodeMesh.setColorAt(i, c);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.instanceColor.needsUpdate = true;
  scene.add(nodeMesh);

  // ─── Build edges (LineSegments) ───
  const edgePositions = new Float32Array(currentLinks.length * 6);
  const edgeColors = new Float32Array(currentLinks.length * 6);
  for (let i = 0; i < currentLinks.length; i++) {
    const s = currentLinks[i].source;
    const t = currentLinks[i].target;
    const sx = s.x || 0, sy = s.y || 0, sz = s.z || 0;
    const tx = t.x || 0, ty = t.y || 0, tz = t.z || 0;
    edgePositions[i * 6] = sx;
    edgePositions[i * 6 + 1] = sy;
    edgePositions[i * 6 + 2] = sz;
    edgePositions[i * 6 + 3] = tx;
    edgePositions[i * 6 + 4] = ty;
    edgePositions[i * 6 + 5] = tz;

    const c = edgeColor(currentLinks[i], maxWeight);
    edgeColors[i * 6] = c.r;
    edgeColors[i * 6 + 1] = c.g;
    edgeColors[i * 6 + 2] = c.b;
    edgeColors[i * 6 + 3] = c.r;
    edgeColors[i * 6 + 4] = c.g;
    edgeColors[i * 6 + 5] = c.b;
  }

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeo.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  scene.add(edgeLines);

  // ─── CSS2D Labels (LOD: only top nodes get labels) ───
  const labelLimit = Math.min(nodeData.length, nodeData.length > 300 ? 80 : 150);
  // Sort by sessionCount desc, take top N
  const ranked = nodeData.map((d, i) => ({ d, i }))
    .sort((a, b) => (b.d.sessionCount || 0) - (a.d.sessionCount || 0))
    .slice(0, labelLimit);

  for (const { d } of ranked) {
    const div = document.createElement("div");
    div.textContent = d.label;
    div.style.cssText = `
      font-size: 10px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: ${d.shared ? "#cc9944" : (d.type === "session" ? "#9b9bff" : "#88aa88")};
      text-shadow: 0 0 6px rgba(0,0,0,0.9);
      pointer-events: none;
      white-space: nowrap;
    `;
    const label = new CSS2DObject(div);
    label.position.set(d.x || 0, (d.y || 0) + nodeRadius(d) + 2, d.z || 0);
    label.userData.nodeId = d.id;
    scene.add(label);
    labelObjects.push(label);
  }

  // Continue simulation in background for refinement
  simulation.alpha(0.3).restart();
  simulation.on("tick", onSimTick);
}

// ─── Update positions from simulation ───
function onSimTick() {
  if (!nodeMesh || !edgeLines) return;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < nodeData.length; i++) {
    const d = nodeData[i];
    const r = nodeRadius(d);
    dummy.position.set(d.x, d.y, d.z || 0);
    dummy.scale.setScalar(r);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;

  // Update edge positions
  const pos = edgeLines.geometry.attributes.position.array;
  for (let i = 0; i < currentLinks.length; i++) {
    const s = currentLinks[i].source;
    const t = currentLinks[i].target;
    pos[i * 6] = s.x;
    pos[i * 6 + 1] = s.y;
    pos[i * 6 + 2] = s.z || 0;
    pos[i * 6 + 3] = t.x;
    pos[i * 6 + 4] = t.y;
    pos[i * 6 + 5] = t.z || 0;
  }
  edgeLines.geometry.attributes.position.needsUpdate = true;

  // Update label positions
  for (const lbl of labelObjects) {
    const id = lbl.userData.nodeId;
    const idx = nodeIndex.get(id);
    if (idx !== undefined) {
      const d = nodeData[idx];
      lbl.position.set(d.x, d.y + nodeRadius(d) + 2, d.z || 0);
    }
  }
}

// ─── Highlight ───
function highlightConnected(id) {
  if (!nodeMesh) return;
  const connected = adjacency.get(id) || new Set();

  const dimColor = new THREE.Color(0x111118);
  const highlightColor = new THREE.Color(0xffffff);

  for (let i = 0; i < nodeData.length; i++) {
    const d = nodeData[i];
    if (d.id === id) {
      nodeMesh.setColorAt(i, highlightColor);
    } else if (connected.has(d.id)) {
      nodeMesh.setColorAt(i, nodeColor(d).multiplyScalar(1.5));
    } else {
      nodeMesh.setColorAt(i, dimColor);
    }
  }
  nodeMesh.instanceColor.needsUpdate = true;

  // Dim/brighten edges
  if (edgeLines) {
    const colors = edgeLines.geometry.attributes.color.array;
    for (let i = 0; i < currentLinks.length; i++) {
      const s = typeof currentLinks[i].source === "object" ? currentLinks[i].source.id : currentLinks[i].source;
      const t = typeof currentLinks[i].target === "object" ? currentLinks[i].target.id : currentLinks[i].target;
      const active = s === id || t === id;
      const c = active ? new THREE.Color(0xffaa44) : new THREE.Color(0x0a0a10);
      colors[i * 6] = c.r; colors[i * 6 + 1] = c.g; colors[i * 6 + 2] = c.b;
      colors[i * 6 + 3] = c.r; colors[i * 6 + 4] = c.g; colors[i * 6 + 5] = c.b;
    }
    edgeLines.geometry.attributes.color.needsUpdate = true;
    edgeLines.material.opacity = 0.7;
  }

  // Labels
  for (const lbl of labelObjects) {
    const lid = lbl.userData.nodeId;
    lbl.element.style.opacity = (lid === id || connected.has(lid)) ? "1" : "0.1";
  }
}

function restoreColors() {
  if (!nodeMesh) return;
  for (let i = 0; i < nodeData.length; i++) {
    nodeMesh.setColorAt(i, nodeColor(nodeData[i]));
  }
  nodeMesh.instanceColor.needsUpdate = true;

  if (edgeLines) {
    const maxWeight = Math.max(1, ...currentLinks.map(l => l.weight || 1));
    const colors = edgeLines.geometry.attributes.color.array;
    for (let i = 0; i < currentLinks.length; i++) {
      const c = edgeColor(currentLinks[i], maxWeight);
      colors[i * 6] = c.r; colors[i * 6 + 1] = c.g; colors[i * 6 + 2] = c.b;
      colors[i * 6 + 3] = c.r; colors[i * 6 + 4] = c.g; colors[i * 6 + 5] = c.b;
    }
    edgeLines.geometry.attributes.color.needsUpdate = true;
    edgeLines.material.opacity = 0.4;
  }

  for (const lbl of labelObjects) lbl.element.style.opacity = "1";
}

// Fly camera to a specific node
function flyToNode(id) {
  const idx = nodeIndex.get(id);
  if (idx === undefined) return;
  const d = nodeData[idx];
  const target = new THREE.Vector3(d.x, d.y, d.z || 0);
  const offset = new THREE.Vector3(0, 10, 40);
  const dest = target.clone().add(offset);

  // Animate camera
  const start = camera.position.clone();
  const startTime = performance.now();
  const duration = 800;

  function flyStep() {
    const t = Math.min(1, (performance.now() - startTime) / duration);
    const ease = t * (2 - t); // ease-out quad
    camera.position.lerpVectors(start, dest, ease);
    camera.lookAt(target);
    if (t < 1) requestAnimationFrame(flyStep);
  }
  flyStep();

  highlightConnected(id);
  selectedId = id;
}

// ─── Raycasting (throttled) ───
function doRaycast() {
  if (!nodeMesh || nodeData.length === 0) return;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(nodeMesh);

  const tooltip = document.getElementById("tooltip");

  if (hits.length > 0) {
    const idx = hits[0].instanceId;
    const d = nodeData[idx];
    if (d && hoveredId !== d.id) {
      hoveredId = d.id;
      renderer.domElement.style.cursor = "pointer";
      if (tooltip) {
        const conns = adjacency.get(d.id)?.size || 0;
        tooltip.style.display = "block";
        tooltip.textContent = (d.fullPath || d.label) + "\n" +
          (d.sessionCount || 1) + " sessions, " + conns + " linked files";
      }
      if (!selectedId) highlightConnected(d.id);
    }
  } else {
    if (hoveredId) {
      hoveredId = null;
      renderer.domElement.style.cursor = "default";
      if (tooltip) tooltip.style.display = "none";
      if (!selectedId) restoreColors();
    }
  }
}

// ─── Label LOD ───
function updateLabelVisibility() {
  const maxDist = 300;
  for (const lbl of labelObjects) {
    const dist = camera.position.distanceTo(lbl.position);
    lbl.visible = dist < maxDist;
  }
}

// ─── Animation Loop ───
function animate() {
  if (!running) return;
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // WASD navigation
  updateNavigation(delta);

  // Throttled raycasting
  rayThrottle += delta;
  if (rayThrottle > 0.05) {
    rayThrottle = 0;
    doRaycast();
  }

  // Label visibility
  updateLabelVisibility();

  // Render
  composer.render();
  css2dRenderer.render(scene, camera);
}

// ─── Cleanup ───
function clearScene() {
  if (simulation) { simulation.stop(); simulation = null; }
  if (nodeMesh) { scene.remove(nodeMesh); nodeMesh.geometry.dispose(); nodeMesh.material.dispose(); nodeMesh = null; }
  if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines.material.dispose(); edgeLines = null; }
  for (const lbl of labelObjects) { scene.remove(lbl); }
  labelObjects = [];
  nodeData = [];
  edgeData = [];
  currentLinks = [];
  adjacency.clear();
  nodeIndex.clear();
  selectedId = null;
  hoveredId = null;
}

// ─── Public API ───
function show() {
  if (!renderer) init();
  if (!container) return;
  container.style.display = "block";
  visible = true;
  running = true;
  clock.start();
  // Add wheel listener
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  animate();
}

function hide() {
  running = false;
  visible = false;
  if (container) container.style.display = "none";
  if (renderer?.domElement) {
    renderer.domElement.removeEventListener("wheel", onWheel);
  }
  if (document.pointerLockElement === renderer?.domElement) {
    document.exitPointerLock();
  }
}

function renderGraph(graph) {
  if (!renderer) init();
  buildGraph(graph);
}

function highlightNode(id) {
  flyToNode(id);
}

function clearSelection() {
  selectedId = null;
  restoreColors();
}

window.Graph3D = {
  init,
  show,
  hide,
  render: renderGraph,
  highlightNode,
  clearSelection,
};
