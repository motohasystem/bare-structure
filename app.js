import * as THREE from "three";
    import { OrbitControls } from "three/addons/controls/OrbitControls.js";
    import { dump, load } from "js-yaml";

    class F3_Material {
      constructor(width, thickness) {
        this.width = width;
        this.thickness = thickness;
      }
    }

    class F2_Dimensions {
      constructor(w, d, h, material, boardThickness) {
        this.w = w;
        this.d = d;
        this.h = h;
        this.material = material;
        this.boardThickness = boardThickness;
      }
    }

    class F1_ShelfDesign {
      constructor(shelfCount, dimensions) {
        this.shelfCount = shelfCount;
        this.dimensions = dimensions;
      }

      calculateCutList(boardCount = 0) {
        const { w, d, h, material, boardThickness } = this.dimensions;
        const beamW = w - material.width * 2;
        const beamD = d - material.thickness * 2;
        const parts = [
          { partName: "柱", length: h, quantity: 4 },
          { partName: "横枠", length: beamW, quantity: this.shelfCount * 2 },
          { partName: "奥行枠", length: beamD, quantity: this.shelfCount * 2 }
        ];
        if (boardCount > 0) {
          parts.push({
            partName: "棚板",
            sizeText: `${w.toLocaleString()} x ${d.toLocaleString()} x ${boardThickness.toLocaleString()} mm`,
            quantity: boardCount,
            subtotalText: `${boardCount} 枚`
          });
        }
        const totalLength = parts.reduce((sum, item) => {
          if (typeof item.length !== "number") return sum;
          return sum + item.length * item.quantity;
        }, 0);
        return { parts, totalLength };
      }
    }

    const state = {
      scene: null,
      camera: null,
      renderer: null,
      controls: null,
      frameGroup: null,
      shelfGroups: [],
      shelfYPositions: [],
      shelfBoardEnabled: [],
      hoveredGroup: null,
      drag: null,
      raycaster: new THREE.Raycaster(),
      mouse: new THREE.Vector2(),
      lastConfigKey: "",
      cameraMode: "perspective"
    };
    const MIN_SHELVES = 1;
    const MAX_SHELVES = 10;

    const inputs = {
      w: document.getElementById("w"),
      d: document.getElementById("d"),
      h: document.getElementById("h"),
      mw: document.getElementById("mw"),
      mt: document.getElementById("mt"),
      bt: document.getElementById("bt")
    };
    const cutRows = document.getElementById("cutRows");
    const totalEl = document.getElementById("total");
    const viewport = document.getElementById("viewport");
    const shelfList = document.getElementById("shelfList");
    const addShelfBtn = document.getElementById("addShelfBtn");
    const removeShelfBtn = document.getElementById("removeShelfBtn");
    const exportYamlBtn = document.getElementById("exportYamlBtn");
    const importYamlBtn = document.getElementById("importYamlBtn");
    const exportCutlistBtn = document.getElementById("exportCutlistBtn");
    const importYamlFile = document.getElementById("importYamlFile");
    const projectionRadios = document.querySelectorAll('input[name="projectionMode"]');
    const resetBtn = document.getElementById("resetBtn");
    const homeCameraBtn = document.getElementById("homeCameraBtn");

    const STORAGE_KEY = "k-frame-planner-state";

    // ── Dialog API ──
    const dialogOverlay = document.getElementById("dialogOverlay");
    const dialogTitle = document.getElementById("dialogTitle");
    const dialogBody = document.getElementById("dialogBody");
    const dialogActions = document.getElementById("dialogActions");

    function closeDialog() {
      dialogOverlay.hidden = true;
      dialogBody.innerHTML = "";
      dialogActions.innerHTML = "";
    }

    function showDialog({ title, buildBody, buttons }) {
      dialogTitle.textContent = title;
      dialogBody.innerHTML = "";
      dialogActions.innerHTML = "";
      if (buildBody) buildBody(dialogBody);
      buttons.forEach((btn) => {
        const el = document.createElement("button");
        el.textContent = btn.label;
        if (btn.className) el.className = btn.className;
        el.addEventListener("click", () => {
          if (btn.onClick) btn.onClick();
          else closeDialog();
        });
        dialogActions.appendChild(el);
      });
      dialogOverlay.hidden = false;
      // Focus first primary/danger button, or last button
      const focusTarget = dialogActions.querySelector(".dialog-primary, .dialog-danger")
        || dialogActions.lastElementChild;
      if (focusTarget) focusTarget.focus();
    }

    function showConfirmDialog(title, message, onConfirm) {
      showDialog({
        title,
        buildBody(body) {
          const p = document.createElement("div");
          p.className = "dialog-message";
          p.textContent = message;
          body.appendChild(p);
        },
        buttons: [
          { label: "キャンセル", onClick: closeDialog },
          { label: "リセット", className: "dialog-danger", onClick() { closeDialog(); onConfirm(); } }
        ]
      });
    }

    function saveTextAsFile(text, filename) {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function showTextDialog(title, text, statusMessage, saveFilename) {
      showDialog({
        title,
        buildBody(body) {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.readOnly = true;
          ta.spellcheck = false;
          body.appendChild(ta);
          if (statusMessage) {
            const s = document.createElement("div");
            s.className = "dialog-status success";
            s.textContent = statusMessage;
            body.appendChild(s);
          }
          requestAnimationFrame(() => { ta.select(); });
        },
        buttons: [
          ...(saveFilename ? [{
            label: "ファイル保存",
            className: "dialog-primary",
            onClick() { saveTextAsFile(text, saveFilename); }
          }] : []),
          { label: "閉じる", onClick: closeDialog }
        ]
      });
    }

    function showImportDialog(title, onImport) {
      let statusEl = null;
      let ta = null;
      showDialog({
        title,
        buildBody(body) {
          ta = document.createElement("textarea");
          ta.placeholder = "YAMLテキストをここに貼り付けてください...";
          ta.spellcheck = false;
          body.appendChild(ta);
          statusEl = document.createElement("div");
          statusEl.className = "dialog-status";
          body.appendChild(statusEl);
          requestAnimationFrame(() => ta.focus());
        },
        buttons: [
          {
            label: "ファイル読込",
            onClick() {
              const fileInput = document.createElement("input");
              fileInput.type = "file";
              fileInput.accept = ".yaml,.yml,text/yaml,text/x-yaml";
              fileInput.addEventListener("change", async () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                try {
                  ta.value = await file.text();
                  statusEl.className = "dialog-status success";
                  statusEl.textContent = `${file.name} を読み込みました`;
                } catch (error) {
                  statusEl.className = "dialog-status error";
                  statusEl.textContent = "ファイルの読み込みに失敗しました。";
                }
              });
              fileInput.click();
            }
          },
          { label: "キャンセル", onClick: closeDialog },
          {
            label: "インポート",
            className: "dialog-primary",
            onClick() {
              const text = ta.value.trim();
              if (!text) {
                statusEl.className = "dialog-status error";
                statusEl.textContent = "テキストが入力されていません。";
                return;
              }
              try {
                const parsed = load(text);
                closeDialog();
                onImport(parsed);
              } catch (error) {
                statusEl.className = "dialog-status error";
                statusEl.textContent = error instanceof Error ? error.message : String(error);
              }
            }
          }
        ]
      });
    }

    dialogOverlay.addEventListener("click", (e) => {
      if (e.target === dialogOverlay) closeDialog();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dialogOverlay.hidden) closeDialog();
    });

    function numberFromInput(input) {
      const min = Number(input.min);
      const max = Number(input.max);
      const raw = Number(input.value);
      const v = Number.isFinite(raw) ? raw : min;
      return Math.min(max, Math.max(min, v));
    }

    function getShelfYBounds(h, beamHeight) {
      const rawMinY = beamHeight / 2;
      const rawMaxY = h - beamHeight / 2;
      return {
        minY: Math.min(rawMinY, rawMaxY),
        maxY: Math.max(rawMinY, rawMaxY)
      };
    }

    function getConfig() {
      const w = numberFromInput(inputs.w);
      const d = numberFromInput(inputs.d);
      const h = numberFromInput(inputs.h);
      const mw = numberFromInput(inputs.mw);
      const mt = numberFromInput(inputs.mt);
      const bt = numberFromInput(inputs.bt);

      inputs.w.value = w;
      inputs.d.value = d;
      inputs.h.value = h;
      inputs.mw.value = mw;
      inputs.mt.value = mt;
      inputs.bt.value = bt;
      if (!Array.isArray(state.shelfYPositions) || state.shelfYPositions.length === 0) {
        state.shelfYPositions = toShelfYPositions(2, h, mw, null, bt);
      }
      const { minY, maxY } = getShelfYBounds(h, mw);
      state.shelfYPositions = state.shelfYPositions
        .slice(0, MAX_SHELVES)
        .map((y) => {
          const safe = Number.isFinite(y) ? y : minY;
          return THREE.MathUtils.clamp(safe, minY, maxY);
        });
      if (!Array.isArray(state.shelfBoardEnabled)) state.shelfBoardEnabled = [];
      state.shelfBoardEnabled = state.shelfYPositions.map((_, i) => Boolean(state.shelfBoardEnabled[i]));

      const shelfHeights = [...state.shelfYPositions];
      const shelfBoards = [...state.shelfBoardEnabled];
      return { w, d, h, mw, mt, bt, shelves: shelfHeights.length, shelfHeights, shelfBoards };
    }

    function toShelfYPositions(count, h, beamHeight, previousYPositions = null, boardThickness = 0) {
      const { minY, maxY } = getShelfYBounds(h, beamHeight);
      if (Array.isArray(previousYPositions) && previousYPositions.length === count) {
        return previousYPositions.map((y) => THREE.MathUtils.clamp(y, minY, maxY));
      }
      if (count === 1) return [THREE.MathUtils.clamp(h / 2, minY, maxY)];
      const topFitY = THREE.MathUtils.clamp(maxY - boardThickness, minY, maxY);
      return Array.from({ length: count }, (_, i) => (i === 0 ? minY : topFitY));
    }

    function renderShelfEditor(config) {
      const { minY, maxY } = getShelfYBounds(config.h, config.mw);
      shelfList.innerHTML = "";
      state.shelfYPositions.forEach((y, index) => {
        const row = document.createElement("div");
        row.className = "shelf-row";
        const clampedY = THREE.MathUtils.clamp(y, minY, maxY);
        const hasBoard = Boolean(state.shelfBoardEnabled[index]);
        row.innerHTML = `
          <label for="shelfY-${index}">棚 ${index + 1}</label>
          <input id="shelfY-${index}" data-shelf-index="${index}" type="number" min="${Math.round(minY)}" max="${Math.round(maxY)}" step="1" value="${Math.round(clampedY)}">
          <label class="board-check" for="shelfBoard-${index}">
            <input id="shelfBoard-${index}" data-shelf-check-index="${index}" type="checkbox" ${hasBoard ? "checked" : ""}>
            棚板あり
          </label>
        `;
        shelfList.appendChild(row);
      });
      addShelfBtn.disabled = state.shelfYPositions.length >= MAX_SHELVES;
      removeShelfBtn.disabled = state.shelfYPositions.length <= MIN_SHELVES;
    }

    function materialWithBase(color) {
      const mat = new THREE.MeshStandardMaterial({ color });
      mat.userData.baseColorHex = new THREE.Color(color).getHex();
      return mat;
    }

    function setGroupHighlight(group, on, dragging = false) {
      if (!group) return;
      group.traverse((obj) => {
        if (!obj.isMesh) return;
        const baseHex = obj.material?.userData?.baseColorHex;
        if (typeof baseHex !== "number") return;
        const c = new THREE.Color(baseHex);
        if (on) c.lerp(new THREE.Color(0xffffff), dragging ? 0.35 : 0.22);
        obj.material.color.copy(c);
        obj.material.transparent = dragging;
        obj.material.opacity = dragging ? 0.7 : 1;
      });
    }

    function updateCutList(design, boardCount) {
      const result = design.calculateCutList(boardCount);
      cutRows.innerHTML = "";
      result.parts.forEach((part) => {
        const subtotal = typeof part.subtotalText === "string"
          ? part.subtotalText
          : `${(part.length * part.quantity).toLocaleString()} mm`;
        const lengthCell = typeof part.sizeText === "string"
          ? part.sizeText
          : `${part.length.toLocaleString()} mm`;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${part.partName}</td>
          <td>${lengthCell}</td>
          <td>${part.quantity}</td>
          <td>${subtotal}</td>
        `;
        cutRows.appendChild(tr);
      });
      totalEl.textContent = `角材トータル: ${result.totalLength.toLocaleString()} mm`;
    }

    function buildScene(config) {
      if (state.frameGroup) state.scene.remove(state.frameGroup);
      state.frameGroup = new THREE.Group();
      state.frameGroup.name = "frameRoot";
      state.shelfGroups = [];
      state.hoveredGroup = null;
      state.drag = null;

      const pillarMat = materialWithBase("#8B6914");
      const widthMat = materialWithBase("#2E7D32");
      const depthMat = materialWithBase("#1565C0");
      const boardMat = materialWithBase("#d9d4c7");

      const pillarGeo = new THREE.BoxGeometry(config.mw, config.h, config.mt);
      const pillarXs = [-1, 1].map((n) => n * (config.w / 2 - config.mw / 2));
      const pillarZs = [-1, 1].map((n) => n * (config.d / 2 - config.mt / 2));
      pillarXs.forEach((x) => {
        pillarZs.forEach((z) => {
          const m = new THREE.Mesh(pillarGeo, pillarMat.clone());
          m.position.set(x, config.h / 2, z);
          state.frameGroup.add(m);
        });
      });

      const widthLength = config.w - config.mw * 2;
      const depthLength = config.d - config.mt * 2;
      const widthGeo = new THREE.BoxGeometry(widthLength, config.mw, config.mt);
      const depthGeo = new THREE.BoxGeometry(config.mw, config.mw, depthLength);
      const ys = [...config.shelfHeights];
      state.shelfYPositions = [...ys];

      ys.forEach((y, index) => {
        const shelfGroup = new THREE.Group();
        shelfGroup.name = `shelf-${index}`;
        shelfGroup.userData.kind = "shelf";
        shelfGroup.userData.index = index;
        shelfGroup.userData.boardGroup = null;

        const zPositions = [-1, 1].map((n) => n * (config.d / 2 - config.mt / 2));
        zPositions.forEach((z) => {
          const beam = new THREE.Mesh(widthGeo, widthMat.clone());
          beam.position.set(0, 0, z);
          beam.userData.shelfGroup = shelfGroup;
          shelfGroup.add(beam);
        });

        const xPositions = [-1, 1].map((n) => n * (config.w / 2 - config.mw / 2));
        xPositions.forEach((x) => {
          const beam = new THREE.Mesh(depthGeo, depthMat.clone());
          beam.position.set(x, 0, 0);
          beam.userData.shelfGroup = shelfGroup;
          shelfGroup.add(beam);
        });

        shelfGroup.position.y = y;
        state.shelfGroups.push(shelfGroup);
        state.frameGroup.add(shelfGroup);

        if (config.shelfBoards[index]) {
          const boardYLocal = config.mw / 2 + config.bt / 2;
          const innerW = config.w - config.mw * 2;
          const innerD = config.d - config.mt * 2;
          const boardGroup = new THREE.Group();
          boardGroup.position.y = y;

          if (innerW > 0 && innerD > 0) {
            const center = new THREE.Mesh(
              new THREE.BoxGeometry(innerW, config.bt, config.d),
              boardMat.clone()
            );
            center.position.set(0, boardYLocal, 0);
            boardGroup.add(center);

            const left = new THREE.Mesh(
              new THREE.BoxGeometry(config.mw, config.bt, innerD),
              boardMat.clone()
            );
            left.position.set(-(config.w / 2 - config.mw / 2), boardYLocal, 0);
            boardGroup.add(left);

            const right = left.clone();
            right.position.x = config.w / 2 - config.mw / 2;
            boardGroup.add(right);
          } else {
            const fallbackBoard = new THREE.Mesh(
              new THREE.BoxGeometry(config.w, config.bt, config.d),
              boardMat.clone()
            );
            fallbackBoard.position.set(0, boardYLocal, 0);
            boardGroup.add(fallbackBoard);
          }

          shelfGroup.userData.boardGroup = boardGroup;
          state.frameGroup.add(boardGroup);
        }
      });

      state.scene.add(state.frameGroup);
      state.controls.target.set(0, config.h * 0.4, 0);
      state.controls.update();
    }

    function setupThree() {
      state.scene = new THREE.Scene();
      state.scene.background = new THREE.Color("#f7f8fb");

      state.renderer = new THREE.WebGLRenderer({ antialias: true });
      state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      viewport.appendChild(state.renderer.domElement);

      applyCameraMode(state.cameraMode);

      const hemi = new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.05);
      hemi.position.set(0, 1, 0);
      state.scene.add(hemi);

      const dir = new THREE.DirectionalLight(0xffffff, 0.7);
      dir.position.set(500, 1200, 700);
      state.scene.add(dir);

      const grid = new THREE.GridHelper(5000, 50, 0x9ca3af, 0xd1d5db);
      grid.position.y = 0;
      state.scene.add(grid);

      resizeRenderer();
      window.addEventListener("resize", resizeRenderer);
      state.renderer.domElement.addEventListener("pointermove", onPointerMove);
      state.renderer.domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
      state.renderer.domElement.addEventListener("pointerup", onPointerUp);
      state.renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      state.renderer.domElement.addEventListener("lostpointercapture", forceStopDrag);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("blur", forceStopDrag);
      window.addEventListener("keydown", onKeyDown);
    }

    function applyCameraMode(mode) {
      const prevCamera = state.camera;
      const prevControls = state.controls;
      const prevPosition = prevCamera ? prevCamera.position.clone() : INITIAL_CAMERA_POS.clone();
      const prevTarget = prevControls ? prevControls.target.clone() : INITIAL_CAMERA_TARGET.clone();

      state.cameraMode = mode;
      if (mode === "perspective") {
        state.camera = new THREE.PerspectiveCamera(42, 1, 1, 20000);
        state.camera.position.copy(prevPosition);
      } else {
        state.camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 20000);
        state.camera.position.copy(prevPosition);
        state.camera.zoom = 0.9;
      }

      if (prevControls) prevControls.dispose();
      state.controls = new OrbitControls(state.camera, state.renderer.domElement);
      state.controls.enableDamping = true;
      state.controls.dampingFactor = 0.07;
      state.controls.target.copy(prevTarget);
      if (mode === "perspective") {
        state.controls.minDistance = 120;
        state.controls.maxDistance = 6000;
      } else {
        state.controls.minZoom = 0.35;
        state.controls.maxZoom = 3.2;
      }

      resizeRenderer();
      state.controls.update();
    }

    function resizeRenderer() {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      state.renderer.setSize(width, height, false);
      const aspect = width / Math.max(height, 1);
      if (state.camera.isOrthographicCamera) {
        const viewSize = 1400;
        state.camera.left = (-viewSize * aspect) / 2;
        state.camera.right = (viewSize * aspect) / 2;
        state.camera.top = viewSize / 2;
        state.camera.bottom = -viewSize / 2;
      } else {
        state.camera.aspect = aspect;
      }
      state.camera.updateProjectionMatrix();
    }

    function setMouseFromEvent(event) {
      const rect = state.renderer.domElement.getBoundingClientRect();
      state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function pickShelfHit(event) {
      setMouseFromEvent(event);
      state.raycaster.setFromCamera(state.mouse, state.camera);
      const hits = state.raycaster.intersectObjects(state.shelfGroups, true);
      const hit = hits.find((h) => h.object?.userData?.shelfGroup);
      if (!hit) return null;
      return {
        shelfGroup: hit.object.userData.shelfGroup,
        mesh: hit.object
      };
    }

    function pickShelfGroup(event) {
      const hit = pickShelfHit(event);
      return hit ? hit.shelfGroup : null;
    }

    function onPointerDown(event) {
      if (event.button !== 0) return;
      const hit = pickShelfHit(event);
      if (!hit) return;
      const shelfGroup = hit.shelfGroup;

      event.preventDefault();
      event.stopPropagation();

      const planeNormal = new THREE.Vector3();
      state.camera.getWorldDirection(planeNormal);
      planeNormal.y = 0;
      if (planeNormal.lengthSq() < 1e-8) planeNormal.set(1, 0, 0);
      planeNormal.normalize();

      const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        planeNormal,
        shelfGroup.position.clone()
      );

      const startPoint = new THREE.Vector3();
      setMouseFromEvent(event);
      state.raycaster.setFromCamera(state.mouse, state.camera);
      if (!state.raycaster.ray.intersectPlane(dragPlane, startPoint)) return;

      state.drag = {
        shelfGroup,
        dragPlane,
        offsetY: shelfGroup.position.y - startPoint.y,
        pointerId: event.pointerId
      };
      state.renderer.domElement.setPointerCapture(event.pointerId);
      state.controls.enabled = false;
      setGroupHighlight(shelfGroup, true, true);
    }

    function onPointerMove(event) {
      if (state.drag) {
        if (event.pointerId !== state.drag.pointerId) return;
        if ((event.buttons & 1) === 0) {
          stopDrag();
          return;
        }
        event.preventDefault();
        setMouseFromEvent(event);
        state.raycaster.setFromCamera(state.mouse, state.camera);
        const point = new THREE.Vector3();
        if (state.raycaster.ray.intersectPlane(state.drag.dragPlane, point)) {
          const config = getConfig();
          const { minY, maxY } = getShelfYBounds(config.h, config.mw);
          const nextY = THREE.MathUtils.clamp(
            point.y + state.drag.offsetY,
            minY,
            maxY
          );
          state.drag.shelfGroup.position.y = nextY;
          const shelfIndex = state.drag.shelfGroup.userData.index;
          const boardGroup = state.drag.shelfGroup.userData.boardGroup;
          if (boardGroup) boardGroup.position.y = nextY;
          if (Number.isInteger(shelfIndex)) {
            state.shelfYPositions[shelfIndex] = nextY;
            const input = shelfList.querySelector(`input[data-shelf-index="${shelfIndex}"]`);
            if (input) input.value = String(Math.round(nextY));
          }
        }
        return;
      }

      const picked = pickShelfGroup(event);
      if (picked !== state.hoveredGroup) {
        setGroupHighlight(state.hoveredGroup, false);
        state.hoveredGroup = picked;
        setGroupHighlight(state.hoveredGroup, true);
      }
    }

    function stopDrag() {
      if (!state.drag) return;
      const pointerId = state.drag.pointerId;
      if (state.renderer.domElement.hasPointerCapture(pointerId)) {
        state.renderer.domElement.releasePointerCapture(pointerId);
      }
      setGroupHighlight(state.drag.shelfGroup, false, false);
      state.drag = null;
      state.controls.enabled = true;
    }

    function onPointerUp(event) {
      if (!state.drag) return;
      if (event.pointerId !== state.drag.pointerId) return;
      stopDrag();
    }

    function onPointerCancel(event) {
      if (!state.drag) return;
      if (event.pointerId !== state.drag.pointerId) return;
      stopDrag();
    }

    function onPointerLeave(event) {
      if (!state.drag) return;
      if (event.pointerId !== state.drag.pointerId) return;
      if ((event.buttons & 1) === 0) stopDrag();
    }

    function onKeyDown(event) {
      if (event.key === "Escape") stopDrag();
    }

    function forceStopDrag() {
      stopDrag();
    }

    function saveToStorage() {
      try {
        const data = {
          w: Number(inputs.w.value),
          d: Number(inputs.d.value),
          h: Number(inputs.h.value),
          mw: Number(inputs.mw.value),
          mt: Number(inputs.mt.value),
          bt: Number(inputs.bt.value),
          shelfYPositions: state.shelfYPositions.map((y) => Math.round(y)),
          shelfBoardEnabled: [...state.shelfBoardEnabled],
          cameraMode: state.cameraMode
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (_) {}
    }

    function loadFromStorage() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data.w !== undefined) inputs.w.value = String(data.w);
        if (data.d !== undefined) inputs.d.value = String(data.d);
        if (data.h !== undefined) inputs.h.value = String(data.h);
        if (data.mw !== undefined) inputs.mw.value = String(data.mw);
        if (data.mt !== undefined) inputs.mt.value = String(data.mt);
        if (data.bt !== undefined) inputs.bt.value = String(data.bt);
        if (Array.isArray(data.shelfYPositions) && data.shelfYPositions.length >= MIN_SHELVES) {
          state.shelfYPositions = data.shelfYPositions;
        }
        if (Array.isArray(data.shelfBoardEnabled)) {
          state.shelfBoardEnabled = data.shelfBoardEnabled;
        }
        if (data.cameraMode === "orthographic" || data.cameraMode === "perspective") {
          state.cameraMode = data.cameraMode;
          projectionRadios.forEach((r) => { r.checked = r.value === data.cameraMode; });
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    function resetToDefaults() {
      localStorage.removeItem(STORAGE_KEY);
      inputs.w.value = "800";
      inputs.d.value = "600";
      inputs.h.value = "1000";
      inputs.mw.value = "40";
      inputs.mt.value = "40";
      inputs.bt.value = "12";
      state.shelfYPositions = [];
      state.shelfBoardEnabled = [];
      state.cameraMode = "perspective";
      projectionRadios.forEach((r) => { r.checked = r.value === "perspective"; });
      applyCameraMode("perspective");
      state.lastConfigKey = "";
      applyAll();
    }

    function applyAll() {
      const cfg = getConfig();
      const material = new F3_Material(cfg.mw, cfg.mt);
      const dims = new F2_Dimensions(cfg.w, cfg.d, cfg.h, material, cfg.bt);
      const design = new F1_ShelfDesign(cfg.shelves, dims);
      const boardCount = cfg.shelfBoards.filter(Boolean).length;
      updateCutList(design, boardCount);
      renderShelfEditor(cfg);
      const nextConfigKey = JSON.stringify(cfg);
      if (nextConfigKey !== state.lastConfigKey) {
        buildScene(cfg);
        state.lastConfigKey = nextConfigKey;
      }
      saveToStorage();
    }

    function toPortableData() {
      const cfg = getConfig();
      return {
        schema: "k-frame-planner/v1",
        dimensions: { w: cfg.w, d: cfg.d, h: cfg.h },
        material: { width: cfg.mw, thickness: cfg.mt },
        board: { thickness: cfg.bt },
        shelfHeights: cfg.shelfHeights.map((y) => Math.round(y)),
        shelfBoards: cfg.shelfBoards
      };
    }

    function applyImportedData(data) {
      const dims = data?.dimensions ?? {};
      const material = data?.material ?? {};
      const board = data?.board ?? {};
      const shelfHeights = Array.isArray(data?.shelfHeights) ? data.shelfHeights : null;
      const shelfBoards = Array.isArray(data?.shelfBoards) ? data.shelfBoards : null;
      if (!shelfHeights || shelfHeights.length < MIN_SHELVES || shelfHeights.length > MAX_SHELVES) {
        throw new Error("shelfHeights は 1〜10 個の配列で指定してください。");
      }

      if (dims.w !== undefined) inputs.w.value = String(dims.w);
      if (dims.d !== undefined) inputs.d.value = String(dims.d);
      if (dims.h !== undefined) inputs.h.value = String(dims.h);
      if (material.width !== undefined) inputs.mw.value = String(material.width);
      if (material.thickness !== undefined) inputs.mt.value = String(material.thickness);
      if (board.thickness !== undefined) inputs.bt.value = String(board.thickness);

      const cfg = getConfig();
      const { minY, maxY } = getShelfYBounds(cfg.h, cfg.mw);
      state.shelfYPositions = shelfHeights.map((v) => {
        const n = Number(v);
        const safe = Number.isFinite(n) ? n : minY;
        return THREE.MathUtils.clamp(safe, minY, maxY);
      });
      state.shelfBoardEnabled = state.shelfYPositions.map((_, i) => Boolean(shelfBoards?.[i]));

      state.lastConfigKey = "";
      applyAll();
    }

    function copyTextToClipboard(text) {
      const fallbackCopy = () => {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) throw new Error("クリップボードへのコピーに失敗しました。");
      };

      const copy = async () => {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          fallbackCopy();
        }
      };

      return copy().catch(() => {
        fallbackCopy();
      });
    }

    function animate() {
      requestAnimationFrame(animate);
      state.controls.update();
      state.renderer.render(state.scene, state.camera);
    }

    const INITIAL_CAMERA_POS = new THREE.Vector3(2200, 1800, 2600);
    const INITIAL_CAMERA_TARGET = new THREE.Vector3(0, 400, 0);

    function resetCamera() {
      state.camera.position.copy(INITIAL_CAMERA_POS);
      state.controls.target.copy(INITIAL_CAMERA_TARGET);
      state.controls.update();
    }

    loadFromStorage();
    setupThree();
    Object.values(inputs).forEach((el) => el.addEventListener("blur", applyAll));
    homeCameraBtn.addEventListener("click", resetCamera);
    resetBtn.addEventListener("click", () => {
      showConfirmDialog("データリセット", "すべてのパラメータを初期値に戻しますか？", resetToDefaults);
    });
    projectionRadios.forEach((radio) => {
      radio.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (!target.checked) return;
        applyCameraMode(target.value);
      });
    });
    shelfList.addEventListener("blur", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type === "checkbox") return;
      const index = Number(target.dataset.shelfIndex);
      if (!Number.isInteger(index)) return;
      const cfg = getConfig();
      const { minY, maxY } = getShelfYBounds(cfg.h, cfg.mw);
      const parsed = Number(target.value);
      const safe = Number.isFinite(parsed) ? parsed : state.shelfYPositions[index] ?? minY;
      state.shelfYPositions[index] = THREE.MathUtils.clamp(safe, minY, maxY);
      applyAll();
    }, true);
    shelfList.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== "checkbox") return;
      const index = Number(target.dataset.shelfCheckIndex);
      if (!Number.isInteger(index)) return;
      state.shelfBoardEnabled[index] = target.checked;
      applyAll();
    });
    addShelfBtn.addEventListener("click", () => {
      const cfg = getConfig();
      if (state.shelfYPositions.length >= MAX_SHELVES) return;
      const { minY, maxY } = getShelfYBounds(cfg.h, cfg.mw);
      const nextY = THREE.MathUtils.clamp(maxY - cfg.bt, minY, maxY);
      state.shelfYPositions.push(nextY);
      state.shelfBoardEnabled.push(false);
      applyAll();
    });
    removeShelfBtn.addEventListener("click", () => {
      if (state.shelfYPositions.length <= MIN_SHELVES) return;
      state.shelfYPositions.pop();
      state.shelfBoardEnabled.pop();
      applyAll();
    });
    exportYamlBtn.addEventListener("click", () => {
      const yamlText = dump(toPortableData(), { lineWidth: 120 });
      copyTextToClipboard(yamlText)
        .then(() => {
          showTextDialog("YAML Export", yamlText, "クリップボードにコピーしました", "frame-planner.yaml");
        })
        .catch(() => {
          showTextDialog("YAML Export", yamlText, null, "frame-planner.yaml");
        });
    });
    importYamlBtn.addEventListener("click", () => {
      showImportDialog("YAML Import", (parsed) => {
        try {
          applyImportedData(parsed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showTextDialog("Import エラー", message, null);
        }
      });
    });
    exportCutlistBtn.addEventListener("click", () => {
      const cfg = getConfig();
      const material = new F3_Material(cfg.mw, cfg.mt);
      const dims = new F2_Dimensions(cfg.w, cfg.d, cfg.h, material, cfg.bt);
      const design = new F1_ShelfDesign(cfg.shelves, dims);
      const boardCount = cfg.shelfBoards.filter(Boolean).length;
      const result = design.calculateCutList(boardCount);
      const lines = [
        "角材骨組みプランナー - カットリスト",
        `サイズ: W ${cfg.w} mm / D ${cfg.d} mm / H ${cfg.h} mm`,
        `角材断面: ${cfg.mw} x ${cfg.mt} mm`,
        `板厚: ${cfg.bt} mm`,
        `棚枚数: ${cfg.shelves} 枚`,
        `棚板あり: ${boardCount} 枚`,
        "",
        "内訳:"
      ];
      result.parts.forEach((part) => {
        if (typeof part.sizeText === "string") {
          lines.push(`- ${part.partName}: ${part.sizeText} x ${part.quantity} 枚`);
        } else {
          lines.push(
            `- ${part.partName}: ${part.length.toLocaleString()} mm x ${part.quantity} 本 = ${(part.length * part.quantity).toLocaleString()} mm`
          );
        }
      });
      lines.push("");
      lines.push(`角材トータル: ${result.totalLength.toLocaleString()} mm`);
      const text = lines.join("\n");
      copyTextToClipboard(text)
        .then(() => {
          showTextDialog("CutList Copy", text, "クリップボードにコピーしました", "cutlist.txt");
        })
        .catch(() => {
          showTextDialog("CutList Copy", text, null, "cutlist.txt");
        });
    });
    applyAll();
    animate();
