
import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";
import { Line2 } from "https://unpkg.com/three@0.165.0/examples/jsm/lines/Line2.js";
import { LineGeometry } from "https://unpkg.com/three@0.165.0/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "https://unpkg.com/three@0.165.0/examples/jsm/lines/LineMaterial.js";
import { mergeGeometries } from "https://unpkg.com/three@0.165.0/examples/jsm/utils/BufferGeometryUtils.js";

// WebXR AR support check
async function supportsAR() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
    try {
    return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
    return false;
    }
}
// Initialize the AR session
(async function init() {
    // Get the buttons and elements
    const enterARButton = document.getElementById("enter-ar");
    const unsupportedEl = document.getElementById("unsupported");
    const placementToggleButton = document.getElementById("placement-toggle"); // Toggle placement mode
    const centerReticleEl = document.getElementById("center-reticle"); // Center reticle
    const visibilityTogglesEl = document.getElementById("visibility-toggles");
    const toggleMapSurfaceBtn = document.getElementById("toggle-map-surface");
    const toggleGuideTimelinesBtn = document.getElementById("toggle-guide-timelines");
    const toggleRoadsBtn = document.getElementById("toggle-roads");
    const toggleHeightModeBtn = document.getElementById("toggle-height-mode");
    const timeWindowFilterEl = document.getElementById("time-window-filter");
    const timeWindowStartEl = document.getElementById("time-window-start");
    const timeWindowEndEl = document.getElementById("time-window-end");
    const timeWindowStartLabelEl = document.getElementById("time-window-start-label");
    const timeWindowEndLabelEl = document.getElementById("time-window-end-label");

    // Check if the browser/device supports AR
    if (!(await supportsAR())) {
    enterARButton.style.display = "none";
    unsupportedEl.style.display = "flex";
    return;
    }

    // Initialize the renderer, scene, and camera
    let renderer, scene, camera;
    let xrSession = null;
    let referenceSpace = null;
    let hitTestSource = null;
    let hitTestSourceRequested = false;
    let reticle = null;
    let placedPlane = null;
    let planeAnchor = null; // XRAnchor if available
    let planeOrientationOffset = null; // Align PlaneGeometry with detected surface
    let placementMode = true; // If false: no reticle + taps don't move plane
    let mapTexture = null; // Shared texture for reticle + placed plane
    let blockNextSelect = false; // Prevent UI taps from placing/moving plane

    // Raycaster for tap-to-inspect (elevated line)
    const raycaster = new THREE.Raycaster();
    const rayCenter = new THREE.Vector2(0, 0); // center of view (NDC)
    let lastViewerPosition = null;
    let lastViewerQuaternion = null;
    let tapMarkerMesh = null; // small sphere at tapped location

    // Tap-inspect markers (sampled across all trips for fast nearest-point lookup)
    const tapMarkersByTrip = new Map(); // trip_id -> marker[]
    const allEvents = [];
    let eventsLoaded = false;
    let activeEventDate = null;
    // Points to show: first + last always, plus sampled middle. Built from data size, steps of 50.
    let pointsOptions = [2, 810];
    let pointsToShowIndex = 0;
    const roadMeshes = [];
    let roadsLoaded = false;

    // Visibility toggles: map surface and guide timelines
    let showMapSurface = true;
    let showGuideTimelines = false;
    let showRoads = true;
    let highlightedTripId = null;
    // Height mode: "trip" (relative to longest trip duration) vs "clock" (absolute 20:00→21:00)
    let heightMode = "trip";
    // Time window filter: minutes offset from 20:00
    let timeWindowStartMin = 0;
    let timeWindowEndMin = 60;
    if (toggleGuideTimelinesBtn) toggleGuideTimelinesBtn.classList.toggle("off", !showGuideTimelines);

    function applyHeightModeButton() {
    if (!toggleHeightModeBtn) return;
    toggleHeightModeBtn.textContent = heightMode === "clock" ? "Height: 20–21" : "Height: Trip";
    }
    applyHeightModeButton();

    // Map image bounds in WGS84 (lat, lon). viscenter-norrkoping-map.png
    const mapCorners = {
    topLeft: [58.606672, 16.143959],
    topRight: [58.607120, 16.232280],
    bottomRight: [58.572833, 16.232774],
    bottomLeft: [58.572298, 16.144648]
    };

    // Same corners in EPSG:3006 (easting, northing, metres) — SWEREF 99 TM, for OSM / Lantmäteriet GeoJSON.
    // If you change mapCorners, recompute (e.g. QGIS reproject) and update these min/max.
    const MAP_SWEREF_EN_EXTENTS = {
    minE: 566469.0442700484,
    maxE: 571698.4256929675,
    minN: 6492996.223257078,
    maxN: 6496963.233584756
    };

    /** Roads GeoJSON file (WGS84 lon/lat or EPSG:3006 easting/northing). */
    const ROADS_GEOJSON_URL = "OSMroads-nkpg-new.geojson";

    // Physical map: 3.2m wide × 2.4m tall (wider than tall)
    const MAP_WIDTH = 3.2;
    const MAP_HEIGHT = 2.4;
    const MAP_HALF_X = MAP_WIDTH / 2;   // 1.59
    const MAP_HALF_Y = MAP_HEIGHT / 2;  // 1.18

    // Build point-count options for data size: 2, 52, 102, 152... step 50, then total.
    function buildPointsOptions(total) {
    if (total <= 2) return [2];
    const opts = [2];
    for (let n = 52; n < total; n += 50) opts.push(n);
    opts.push(total);
    return [...new Set(opts)].sort((a, b) => a - b);
    }

    // "extract" "HH:MM" from "YYYY/MM/DD HH:MM:SS.sss" (for labels)
    function formatEventTime(dateTimeEvent) {
    if (!dateTimeEvent) return "";
    const part = dateTimeEvent.split(" ")[1];
    if (!part) return "";
    const [hms] = part.split(".");
    return hms ? hms.substring(0, 5) : part.substring(0, 5); // "HH:MM"
    }

    // Format date for display: "Mar 31, 2025" from "YYYY-MM-DD HH:MM:SS.sss"
    function formatEventDate(dateTimeEvent) {
    if (!dateTimeEvent) return "";
    const dateStr = dateTimeEvent.split(" ")[0]?.replace(/\//g, "-") || "";
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    }

    // Find the closest marker to a hit position (in plane local space).
    // Uses 3D distance when marker has localH (height) to disambiguate vertical "stopped" columns.
    function findClosestEventToHit(hitWorld, placedPlane, markers) {
    if (!placedPlane || !markers?.length) return null;
    const inv = new THREE.Matrix4().copy(placedPlane.matrixWorld).invert();
    const hitLocal = new THREE.Vector3(
        hitWorld.x, hitWorld.y, hitWorld.z
    ).applyMatrix4(inv);
    const maxDistSq = 0.5 * 0.5; // 0.5m threshold (trip is on ~2m plane)
    let best = null;
    let bestDistSq = maxDistSq;
    for (const m of markers) {
        const x = m.userData?.localX;
        const y = m.userData?.localZ;
        const h = m.userData?.localH;
        if (x == null || y == null) continue;
        const dx = hitLocal.x - x;
        const dy = hitLocal.y - y;
        const dz = h == null ? 0 : (hitLocal.z - h);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = m;
        }
    }
    return best;
    }

    function findTripIdFromHitObject(obj) {
    let cur = obj;
    while (cur && !cur.isLine2 && cur.parent) cur = cur.parent;
    if (!cur || !cur.isLine2) return null;
    const udTrip = cur.userData?.trip_id;
    if (udTrip != null) return String(udTrip);
    const name = cur.name || "";
    const m = name.match(/^(?:tripLine|tripShadow)_\d+_(.+)$/);
    return m ? m[1] : null;
    }

    function applyMapSurfaceVisibility() {
    if (!placedPlane?.material) return;
    placedPlane.material.opacity = showMapSurface ? 0.9 : 0;
    placedPlane.material.depthWrite = showMapSurface;
    }

    function applyGuideTimelinesVisibility() {
    const tl = placedPlane?.userData?.timeLinesGroup;
    if (tl) tl.visible = showGuideTimelines;
    }

    function applyRoadsVisibility() {
    const rg = placedPlane?.userData?.roadsGroup;
    if (rg) rg.visible = showRoads;
    }

    function applyOverlayUiVisibility() {
    const inAr = !!xrSession;
    const showOverlays = inAr && !placementMode;
    const pointsFilterEl = document.getElementById("event-date-filter");
    const tripDetailsEl = document.getElementById("trip-details");
    if (visibilityTogglesEl) visibilityTogglesEl.style.display = showOverlays ? "flex" : "none";
    if (timeWindowFilterEl) timeWindowFilterEl.style.display = showOverlays ? "flex" : "none";
    if (pointsFilterEl) pointsFilterEl.style.display = showOverlays ? "flex" : "none";
    if (tripDetailsEl && !showOverlays) tripDetailsEl.classList.remove("visible");
    }

    function setPlacementMode(enabled) {
    placementMode = !!enabled;
    placementToggleButton.textContent = placementMode ? "Placement: ON" : "Placement: OFF";
    if (!placementMode && reticle) reticle.visible = false;
    applyOverlayUiVisibility();
    }

    function applyTripHighlight() {
    const eventsGroup = placedPlane?.userData?.eventsGroup;
    if (!eventsGroup) return;
    eventsGroup.traverse((obj) => {
        if (!obj.isLine2 || !obj.material) return;
        const tripId = obj.userData?.trip_id != null ? String(obj.userData.trip_id) : null;
        if (!tripId) return;
        const baseWidth = obj.userData?.baseLinewidth ?? obj.material.linewidth ?? 0.006;
        const isShadow = (obj.name || "").startsWith("tripShadow_");
        const selected = highlightedTripId && tripId === highlightedTripId;
        obj.material.transparent = true;
        // Use tint instead of opacity (easier to perceive in AR): non-selected become dark green.
        // Black (stopped) stays black since vertex colors multiply with material color.
        if (obj.material.color) {
            if (!highlightedTripId) {
                obj.material.color.setHex(0xffffff);
            } else if (selected) {
                obj.material.color.setHex(0xffffff);
            } else {
                obj.material.color.setHex(isShadow ? 0x14532d : 0x166534);
            }
        }
        // Lift selected shadow (2x) to reduce z-fighting with other shadows.
        if (isShadow) obj.position.z = highlightedTripId && selected ? 0.004 : 0;
        obj.material.opacity = highlightedTripId ? (selected ? 1 : 0.5) : 1;
        obj.material.linewidth = highlightedTripId ? (selected ? baseWidth * 1.25 : baseWidth) : baseWidth;
        obj.material.needsUpdate = true;
    });
    }

    function showTripDetails(eventMarker) {
    const el = document.getElementById("trip-details");
    if (!el) return;
    if (!eventMarker?.userData) {
        el.classList.remove("visible");
        return;
    }
    const ud = eventMarker.userData;
    const tripId = ud.trip_id != null ? String(ud.trip_id) : "";
    const dateStr = formatEventDate(ud.dateTimeEvent);
    const timeStr = formatEventTime(ud.dateTimeEvent);
    const speedVal = typeof ud.speed_value === "number" ? ud.speed_value : null;
    const speedStr = speedVal != null ? ` · ${speedVal} m/s` : "";
    el.innerHTML = `<strong>${dateStr}</strong>${timeStr ? ` · ${timeStr}` : ""}${tripId ? ` · Trip ${tripId}` : ""}${speedStr}`;
    el.classList.add("visible");
    }

    // Setup the three.js renderer, scene, and camera
    function setupThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(0.5, 1, 0.5);
    scene.add(dirLight);

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
        "viscenter-norrkoping-map.png",
        (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        mapTexture = tex;
        if (reticle && reticle.material) { reticle.material.map = mapTexture; reticle.material.needsUpdate = true; }
        if (placedPlane && placedPlane.material) { placedPlane.material.map = mapTexture; placedPlane.material.needsUpdate = true; }
        },
        undefined,
        (err) => console.warn("Failed to load viscenter-norrkoping-map.png texture", err)
    );

    reticle = new THREE.Mesh(
        new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT),
        new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: mapTexture || null,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6
        })
    );
    reticle.visible = false;
    scene.add(reticle);

    planeOrientationOffset = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 2, 0, 0)
    );

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        updateLineMaterialsResolution(placedPlane?.userData?.eventsGroup, renderer);
    });
    }

    // Start the AR session
    async function startAR() {
    if (!renderer) setupThree();

    xrSession = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["anchors", "local-floor", "dom-overlay"],
        domOverlay: { root: document.body }
    });

    xrSession.addEventListener("end", () => {
        xrSession = null;
        hitTestSourceRequested = false;
        hitTestSource = null;
        planeAnchor = null;
        // End the session
        if (renderer && renderer.xr) renderer.xr.setSession(null);

        enterARButton.style.display = "block";
        // Hide the buttons
        placementToggleButton.style.display = "none";
        centerReticleEl.style.display = "none";
        applyOverlayUiVisibility();
        const tapEl = document.getElementById("tap-capture");
        if (tapEl) tapEl.style.display = "none";
    });

    // Set the reference space type
    renderer.xr.setReferenceSpaceType("local-floor");
    // Set the session
    await renderer.xr.setSession(xrSession);
    referenceSpace = await xrSession.requestReferenceSpace("local-floor");

    // Preload + preprocess trips during placement mode so placement feels instant.
    // (This does fetch+JSON parse + longest-trip duration computation once.)
    loadEvents().catch((err) => console.error("Preload trips failed:", err));

    // Request an animation frame
    xrSession.requestAnimationFrame(onXRFrame);

    // Show the buttons
    enterARButton.style.display = "none";
    placementToggleButton.style.display = "block";
    centerReticleEl.style.display = "block";

    // Set the placement mode
    setPlacementMode(true);

    // On select event
    const onSelect = (event) => {
        if (blockNextSelect) { blockNextSelect = false; return; }

        const frame = event.frame;
        if (!frame || !referenceSpace) return;

        if (placementMode) {
        // Placement ON: need hit test to place plane on a real surface
        if (!hitTestSource) return;
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length === 0) return;
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        if (!pose) return;
        if (xrSession.requestAnchor) {
            // Anchor at plane center so top-left stays at hit; pass offset transform
            const planeQuat = new THREE.Quaternion(
                pose.transform.orientation.x, pose.transform.orientation.y,
                pose.transform.orientation.z, pose.transform.orientation.w
            ).multiply(planeOrientationOffset);
            const cornerToCenter = new THREE.Vector3(MAP_HALF_X, -MAP_HALF_Y, 0).applyQuaternion(planeQuat);
            const centerPos = {
                x: pose.transform.position.x + cornerToCenter.x,
                y: pose.transform.position.y + cornerToCenter.y,
                z: pose.transform.position.z + cornerToCenter.z
            };
            const anchorTransform = new XRRigidTransform(centerPos, {
                x: planeQuat.x, y: planeQuat.y, z: planeQuat.z, w: planeQuat.w
            });
            xrSession.requestAnchor(anchorTransform, referenceSpace)
            .then((anchor) => {
                // Set the plane anchor
                planeAnchor = anchor;
                // Place or move the plane from the pose
                placeOrMovePlaneFromPose(pose);
                setPlacementMode(false);
                anchor.context = { threeObject: placedPlane };
                anchor.addEventListener("remove", () => { planeAnchor = null; });
            })
            .catch(() => {
                planeAnchor = null;
                placeOrMovePlaneFromPose(pose);
                setPlacementMode(false);
            });
        } else {
            // Set the plane anchor to null
            planeAnchor = null;
            // Place or move the plane from the pose
            placeOrMovePlaneFromPose(pose);
            setPlacementMode(false);
        }
        } else {
        // Placement mode OFF: use stored viewer pose (select event's frame can't call getViewerPose)
        runTapToInspect();
        }
    };

    xrSession.addEventListener("select", onSelect);

    // Fallback: some devices don't fire WebXR select; use click/touch when placement OFF
    function runTapToInspect() {
        if (!placedPlane || placementMode || !lastViewerPosition || !lastViewerQuaternion) return;
        camera.position.copy(lastViewerPosition);
        camera.quaternion.copy(lastViewerQuaternion);
        camera.updateMatrixWorld(true);
        raycaster.setFromCamera(rayCenter, camera);
        const eventsGroup = placedPlane.userData?.eventsGroup;
        const pickTargets = eventsGroup ? [eventsGroup, placedPlane] : [placedPlane];
        const intersects = raycaster.intersectObjects(pickTargets, true);
        const hitPoint = intersects.length > 0 ? intersects[0].point : null;
        const hitObject = intersects.length > 0 ? intersects[0].object : null;
        // Only show trip info when sphere is on the elevated line or its shadow (Line2), not on the map plane
        const tripIdFromHit = hitObject ? findTripIdFromHitObject(hitObject) : null;
        const hitLineOrShadow = !!tripIdFromHit;
        if (!hitLineOrShadow) {
            // Tapped the map surface (or nothing): clear highlight + hide details
            highlightedTripId = null;
            applyTripHighlight();
            showTripDetails(null);
            return;
        }

        // Always highlight the trip we actually hit, even if we can’t find a close sampled marker.
        highlightedTripId = String(tripIdFromHit);
        applyTripHighlight();

        const markersForTrip = tapMarkersByTrip.get(String(tripIdFromHit)) || [];
        const closest = hitPoint ? findClosestEventToHit(hitPoint, placedPlane, markersForTrip) : null;
        showTripDetails(closest);

        // Update tap marker
        if (eventsGroup) {
            if (tapMarkerMesh) {
                eventsGroup.remove(tapMarkerMesh);
                tapMarkerMesh.geometry.dispose();
                tapMarkerMesh.material.dispose();
                tapMarkerMesh = null;
            }
            if (hitPoint) {
                const inv = new THREE.Matrix4().copy(placedPlane.matrixWorld).invert();
                const hitLocal = hitPoint.clone().applyMatrix4(inv);
                const geom = new THREE.SphereGeometry(0.01, 16, 12);
                const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
                tapMarkerMesh = new THREE.Mesh(geom, mat);
                tapMarkerMesh.position.copy(hitLocal);
                tapMarkerMesh.renderOrder = 10;
                eventsGroup.add(tapMarkerMesh);
            }
        }
    }

    const tapCaptureEl = document.getElementById("tap-capture");
    if (tapCaptureEl) {
        const onTap = (e) => {
            if (blockNextSelect) return;
            if (xrSession && !placementMode) runTapToInspect();
        };
        tapCaptureEl.addEventListener("touchend", onTap, { passive: true });
        tapCaptureEl.addEventListener("click", onTap);
    }

    // Show tap-capture when in AR (for fallback tap-to-inspect)
    tapCaptureEl.style.display = "block";
    }

    // Place or move the plane from the pose
    function placeOrMovePlaneFromPose(pose) {
    // Check if the plane is new
    const wasNewPlane = !placedPlane;

    if (!placedPlane) {
        // Create the plane geometry
        const geometry = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT);
        // Create the plane material
        const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: mapTexture || null,
        metalness: 0.1,
        roughness: 0.5,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9
        });

        // Create the plane
        placedPlane = new THREE.Mesh(geometry, material);
        // Cast and receive shadows
        placedPlane.castShadow = true;
        placedPlane.receiveShadow = true;

        // Create the axes helper to see orientation of the plane
        const axesHelper = new THREE.AxesHelper(0.5);
        axesHelper.name = "planeDebugAxes";
        axesHelper.raycast = () => {}; // Disable raycast so tap-sphere isn't placed at (0,0) when center is tapped
        placedPlane.add(axesHelper);

        scene.add(placedPlane);
        applyMapSurfaceVisibility();
    }

    // Get the position and orientation of the pose (hit = where top-left corner should be)
    const { position, orientation } = pose.transform;
    if (planeOrientationOffset) {
        placedPlane.quaternion
        .set(orientation.x, orientation.y, orientation.z, orientation.w)
        .multiply(planeOrientationOffset);
    } else {
        placedPlane.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    }
    // Offset so top-left corner is at hit point (align corner with table edge)
    const cornerToCenter = new THREE.Vector3(MAP_HALF_X, -MAP_HALF_Y, 0);
    cornerToCenter.applyQuaternion(placedPlane.quaternion);
    placedPlane.position.set(
        position.x + cornerToCenter.x,
        position.y + cornerToCenter.y,
        position.z + cornerToCenter.z
    );

    if (wasNewPlane) {
        loadEvents().then(() => addTripsToPlane());
        loadRoads().then(() => addRoadsToPlane());
    } else {
        if (allTrips.size > 0) addTripsToPlane();
        if (roadMeshes.length > 0) addRoadsToPlane();
    }
    }

    // XR frame loop: hit-test reticle, anchor updates, render
    function onXRFrame(time, frame) {
    const session = frame.session;
    session.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) return;
    const t = pose.transform;
    lastViewerPosition = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
    lastViewerQuaternion = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);

    if (!hitTestSourceRequested) {
        session.requestReferenceSpace("viewer")
        .then((viewerSpace) => session.requestHitTestSource({ space: viewerSpace }))
        .then((source) => { hitTestSource = source; });
        hitTestSourceRequested = true;
    }

    // Check if the hit test source, reference space, reticle, and placement mode are valid
    if (hitTestSource && referenceSpace && reticle && placementMode) {
        // Get the hit test results
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const hitPose = hit.getPose(referenceSpace);
        if (hitPose) {
            const { position, orientation } = hitPose.transform;
            reticle.visible = true;
            if (planeOrientationOffset) {
            reticle.quaternion
                .set(orientation.x, orientation.y, orientation.z, orientation.w)
                .multiply(planeOrientationOffset);
            } else {
            reticle.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
            }
            // Offset so top-left corner is at hit point (align corner with table edge)
            const cornerToCenter = new THREE.Vector3(MAP_HALF_X, -MAP_HALF_Y, 0);
            cornerToCenter.applyQuaternion(reticle.quaternion);
            reticle.position.set(position.x + cornerToCenter.x, position.y + cornerToCenter.y, position.z + cornerToCenter.z);
        }
        } else {
        reticle.visible = false;
        }
    }

    if (planeAnchor && placedPlane) {
        // Get the anchor pose
        const anchorPose = frame.getPose(
        planeAnchor.anchorSpace || planeAnchor.space || planeAnchor,
        referenceSpace
        );
        if (anchorPose) {
        const t = anchorPose.transform;
        placedPlane.position.set(t.position.x, t.position.y, t.position.z);

        if (planeOrientationOffset) {
            placedPlane.quaternion
            .set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w)
            .multiply(planeOrientationOffset);
        } else {
            placedPlane.quaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        }

        if (allTrips.size > 0) addTripsToPlane();
        if (roadMeshes.length > 0) addRoadsToPlane();
        }
    }

    // Move time-label sprites to the map edge furthest from the camera (full walk-around support)
    if (placedPlane && placedPlane.userData?.timeLinesGroup && camera) {
        const camWorld = new THREE.Vector3();
        camera.getWorldPosition(camWorld);

        // Camera position in plane-local space (X/Y edges, Z = height)
        const inv = new THREE.Matrix4().copy(placedPlane.matrixWorld).invert();
        const camLocal = camWorld.clone().applyMatrix4(inv);

        const timeLinesGroup = placedPlane.userData.timeLinesGroup;

        // Count sprites first so we can spread them evenly along the chosen edge
        let spriteCount = 0;
        for (const child of timeLinesGroup.children) {
        if (child.isSprite) spriteCount++;
        }

        if (spriteCount > 0) {
        // Decide which edge is \"back\": horizontal (±Y) or vertical (±X)
        const useVerticalEdge = Math.abs(camLocal.x) >= Math.abs(camLocal.y);

        let spriteIndex = 0;
        for (const child of timeLinesGroup.children) {
            if (!child.isSprite) continue;

            const t = spriteCount === 1 ? 0.5 : spriteIndex / (spriteCount - 1);
            let x = 0;
            let y = 0;

            if (useVerticalEdge) {
            // Camera is more on +X / -X side → place labels on opposite X edge, spread along Y
            const edgeX = camLocal.x >= 0 ? -MAP_HALF_X : MAP_HALF_X;
            x = edgeX;
            y = -MAP_HALF_Y + t * (2 * MAP_HALF_Y);
            } else {
            // Camera is more on +Y / -Y side → place labels on opposite Y edge, spread along X
            const edgeY = camLocal.y >= 0 ? -MAP_HALF_Y : MAP_HALF_Y;
            y = edgeY;
            x = -MAP_HALF_X + t * (2 * MAP_HALF_X);
            }

            child.position.x = x;
            child.position.y = y;
            spriteIndex++;
        }
        }
    }

    renderer.render(scene, camera);
    }

    function clamp01(x) {
    return Math.min(1, Math.max(0, x));
    }

    function lerp(a, b, t) {
    return a + (b - a) * t;
    }

    function lerpHex(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const rr = Math.round(lerp(ar, br, t));
    const rg = Math.round(lerp(ag, bg, t));
    const rb = Math.round(lerp(ab, bb, t));
    return (rr << 16) | (rg << 8) | rb;
    }

    function scaleHex(hex, s) {
    const r = Math.round(((hex >> 16) & 255) * s);
    const g = Math.round(((hex >> 8) & 255) * s);
    const b = Math.round((hex & 255) * s);
    return ((Math.min(255, Math.max(0, r))) << 16) | ((Math.min(255, Math.max(0, g))) << 8) | (Math.min(255, Math.max(0, b)));
    }

    // Speed color: black when stopped, blue when moving fast (smooth in-between)
    const TRIP_COLOR_BLUE = 0x00bfff;
    const TRIP_COLOR_STOPPED = 0x000000;
    function getTripSpeedColor(speed, maxSpeed) {
    if (maxSpeed <= 0) return TRIP_COLOR_BLUE;
    // sqrt curve: makes low speeds less "too black"
    const t = Math.pow(clamp01(speed / maxSpeed), 0.5);
    return lerpHex(TRIP_COLOR_STOPPED, TRIP_COLOR_BLUE, t);
    }

    // Line2/LineGeometry/LineMaterial for pathway (adopted from threejs.org/examples webgl_lines_fat)
    function createFatLinePathway(pathwayPoints, pointColors, lineWidth, parent, renderer, opts = {}) {
    if (!pathwayPoints || pathwayPoints.length < 2 || !pointColors) return null;

    const positions = [];
    const colors = [];

    for (let i = 0; i < pathwayPoints.length; i++) {
        const p = pathwayPoints[i];
        positions.push(p.x, p.y, p.z);
        const hex = pointColors[i] ?? 0x0088ff;
        colors.push(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
    }
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const resolution = new THREE.Vector2();
    renderer.getSize(resolution);
    const matLine = new LineMaterial({
        color: 0xffffff,
        linewidth: lineWidth,
        vertexColors: true,
        dashed: false,
        alphaToCoverage: true,
        worldUnits: true,
        resolution
    });
    const line = new Line2(geometry, matLine);
    line.computeLineDistances();
    line.name = opts.name || "pathway";
    line.userData.baseLinewidth = lineWidth;
    if (opts.renderOrder !== undefined) line.renderOrder = opts.renderOrder;
    parent.add(line);
    return line;
    }

    function updateFatLinePathway(line, pathwayPoints, pointColors) {
    if (!line || !line.geometry || !pathwayPoints || pathwayPoints.length < 2 || !pointColors) return false;
    const positions = [];
    const colors = [];
    for (let i = 0; i < pathwayPoints.length; i++) {
        const p = pathwayPoints[i];
        positions.push(p.x, p.y, p.z);
        const hex = pointColors[i] ?? 0x0088ff;
        colors.push(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
    }
    line.geometry.setPositions(positions);
    line.geometry.setColors(colors);
    line.computeLineDistances();
    line.visible = true;
    return true;
    }

    function disposeLine2(line) {
    if (!line) return;
    if (line.geometry) line.geometry.dispose();
    if (line.material) line.material.dispose();
    }

    // Update LineMaterial resolution for all Line2 in a group (call on resize)
    function updateLineMaterialsResolution(group, renderer) {
    if (!group || !renderer) return;
    const resolution = new THREE.Vector2();
    renderer.getSize(resolution);
    group.traverse((obj) => {
        if (obj.isLine2 && obj.material && obj.material.resolution) {
        obj.material.resolution.copy(resolution);
        }
    });
    }

    // Project WGS84 lat/lon -> plane local X/Z (meters), plane is MAP_WIDTH × MAP_HEIGHT centered at origin
    function projectToMapSurface(lat, lon) {
    const { topLeft, topRight, bottomLeft, bottomRight } = mapCorners;

    const minLat = Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
    const maxLat = Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
    const minLon = Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
    const maxLon = Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);

    const normalizedLat = (lat - minLat) / (maxLat - minLat);
    const normalizedLon = (lon - minLon) / (maxLon - minLon);

    const x = (normalizedLon - 0.5) * MAP_WIDTH;
    const z = (normalizedLat - 0.5) * MAP_HEIGHT;
    return [x, z];
    }

    // EPSG:3006 → plane X/Z using same separable linear model as projectToMapSurface (no external proj lib).
    function projectSwerefToMapSurface(easting, northing) {
    const { minE, maxE, minN, maxN } = MAP_SWEREF_EN_EXTENTS;
    const normalizedLon = (easting - minE) / (maxE - minE);
    const normalizedLat = (northing - minN) / (maxN - minN);
    const x = (normalizedLon - 0.5) * MAP_WIDTH;
    const z = (normalizedLat - 0.5) * MAP_HEIGHT;
    return [x, z];
    }

    // Bus trips (all trip_id) from GeoJSON
    // trip_id (string) -> array of {dateTimeEvent, tMs, localX, localZ, speed_value}
    const allTrips = new Map();
    // trip_id (string) -> { startMs, endMs, durationMs }
    const tripMeta = new Map();
    let longestTripDurationMs = 0;
    let globalMaxSpeed = 0;
    // Cache sampled index sets: key = "total:target"
    const sampledIndicesCache = new Map();

    const H_MIN = 0.01;
    const H_LONGEST = 0.6; // meters: tallest endpoint (clock-mode reaches this at 21:00)
    const CLOCK_START_HOUR = 20;
    const CLOCK_END_HOUR = 21;

    function fmtClockMin(minOffset) {
    const totalMin = CLOCK_START_HOUR * 60 + Math.round(minOffset);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }

    function applyTimeWindowLabels() {
    if (timeWindowStartLabelEl) timeWindowStartLabelEl.textContent = fmtClockMin(timeWindowStartMin);
    if (timeWindowEndLabelEl) timeWindowEndLabelEl.textContent = fmtClockMin(timeWindowEndMin);
    }

    function getClockWindowMs(tMs) {
    const d = new Date(tMs);
    if (Number.isNaN(d.getTime())) return null;
    const start = new Date(d);
    start.setHours(CLOCK_START_HOUR, 0, 0, 0);
    const end = new Date(d);
    end.setHours(CLOCK_END_HOUR, 0, 0, 0);
    return { startMs: start.getTime(), endMs: end.getTime() };
    }

    function isWithinTimeWindow(tMs) {
    const win = getClockWindowMs(tMs);
    if (!win) return true;
    const startMs = win.startMs + timeWindowStartMin * 60_000;
    const endMs = win.startMs + timeWindowEndMin * 60_000;
    return tMs >= startMs && tMs <= endMs;
    }

    function computeTripPointHeight(tripId, p) {
    if (!p) return H_MIN;
    const meta = tripMeta.get(tripId);
    const startMs = meta?.startMs ?? p.tMs ?? 0;
    const durationMs = meta?.durationMs ?? 0;

    if (heightMode === "clock") {
        const win = getClockWindowMs(p.tMs ?? startMs);
        if (!win || win.endMs <= win.startMs) return H_MIN;
        const tNorm = clamp01(((p.tMs ?? win.startMs) - win.startMs) / (win.endMs - win.startMs));
        return lerp(H_MIN, H_LONGEST, tNorm);
    }

    // heightMode === "trip"
    const denom = longestTripDurationMs > 0 ? longestTripDurationMs : 1;
    const durationRatio = clamp01((durationMs ?? 0) / denom);
    const hEnd = lerp(H_MIN, H_LONGEST, durationRatio);
    const tNorm = durationMs > 0 ? clamp01(((p.tMs ?? startMs) - startMs) / durationMs) : 0;
    return lerp(H_MIN, hEnd, tNorm);
    }

    function getPerTripSampleTarget() {
    // Reuse points UI as a per-trip sampling control; keep bounded for performance.
    return Math.max(2, Math.min(400, pointsOptions[pointsToShowIndex] ?? 102));
    }

    function buildTapMarkersFromTrips() {
    tapMarkersByTrip.clear();
    if (allTrips.size === 0) return;

    // Sample up to N points per trip (first+last always) for fast nearest lookup.
    const perTripTarget = getPerTripSampleTarget();

    for (const [tripId, pts] of allTrips) {
        if (!pts || pts.length < 2) continue;
        const target = Math.min(perTripTarget, pts.length);
        const indices = getSampledIndicesCached(pts.length, target);
        for (const idx of indices) {
        const p = pts[idx];
        if (p?.tMs != null && !isWithinTimeWindow(p.tMs)) continue;
        const localH = computeTripPointHeight(tripId, p);
        const marker = {
            userData: {
            isEventMarker: true,
            trip_id: tripId,
            dateTimeEvent: p.dateTimeEvent,
            tMs: p.tMs,
            localX: p.localX,
            localZ: p.localZ,
            localH,
            speed_value: p.speed_value
            }
        };
        if (!tapMarkersByTrip.has(tripId)) tapMarkersByTrip.set(tripId, []);
        tapMarkersByTrip.get(tripId).push(marker);
        }
    }
    }

    async function loadEvents() {
    if (eventsLoaded) return;

    try {
        const response = await fetch("bus_data_trimmed.geojson");
        const geojson = await response.json();

        if (!geojson.features || !Array.isArray(geojson.features)) {
        console.error("Invalid GeoJSON structure");
        return;
        }

        allTrips.clear();
        tripMeta.clear();
        allEvents.length = 0;
        globalMaxSpeed = 0;
        longestTripDurationMs = 0;
        sampledIndicesCache.clear();

        for (const feature of geojson.features) {
        const props = feature.properties || {};
        const dateTimeEvent = props.time;
        const coords = feature.geometry?.coordinates;
        if (!dateTimeEvent || !coords || coords.length < 2) continue;

        const tMs = new Date(dateTimeEvent.replace(/\//g, "-")).getTime();
        if (Number.isNaN(tMs)) continue;

        const lon = coords[0];
        const lat = coords[1];
        if (isNaN(lon) || isNaN(lat)) continue;

        const [x, z] = projectToMapSurface(lat, lon);
        const speedValue = typeof props.speed_value === "number" ? props.speed_value : 0;
        if (speedValue > globalMaxSpeed) globalMaxSpeed = speedValue;

        // Keep old allEvents entries so existing UI code doesn’t crash (but we won’t render via eventMarkers)
        allEvents.push({
            id: props.entity_id || "",
            dateTimeEvent,
            date: "trip",
            lat,
            lon,
            levelcomfort: 4,
            localX: x,
            localZ: z,
            speed_value: speedValue
        });

        const tripIdRaw = props.trip_id;
        const tripKey = tripIdRaw == null ? "unknown" : String(tripIdRaw);
        if (!allTrips.has(tripKey)) allTrips.set(tripKey, []);
        allTrips.get(tripKey).push({
            dateTimeEvent,
            tMs,
            localX: x,
            localZ: z,
            speed_value: speedValue
        });
        }

        // Sort each trip by timestamp so polylines don’t zig-zag,
        // and compute trip duration meta (for duration-based vertical scaling).
        for (const [, pts] of allTrips) {
        pts.sort((a, b) => {
            return (a.tMs ?? 0) - (b.tMs ?? 0);
        });
        }

        for (const [tripId, pts] of allTrips) {
        if (!pts || pts.length < 2) continue;
        const startMs = pts[0].tMs;
        const endMs = pts[pts.length - 1].tMs;
        const durationMs = Math.max(0, endMs - startMs);
        tripMeta.set(tripId, { startMs, endMs, durationMs });
        if (durationMs > longestTripDurationMs) longestTripDurationMs = durationMs;
        }

        eventsLoaded = true;
        activeEventDate = "trip";
        pointsOptions = buildPointsOptions(allEvents.length);
        pointsToShowIndex = Math.min(2, pointsOptions.length - 1);
        populatePointsFilter();

        buildTapMarkersFromTrips();
        if (placedPlane && placedPlane.userData?.eventsGroup) addTripsToPlane();
    } catch (err) {
        console.error("Failed to load bus trip:", err);
    }
    }

    // Sample indices: always first and last, evenly spaced in between
    function getSampledIndices(total, targetCount) {
    if (targetCount >= total) return [...Array(total).keys()];
    if (targetCount <= 2) return [0, total - 1];
    const indices = new Set([0, total - 1]);
    for (let i = 1; i < targetCount - 1; i++) {
        const t = i / (targetCount - 1);
        indices.add(Math.round(t * (total - 1)));
    }
    return [...indices].sort((a, b) => a - b);
    }

    function getSampledIndicesCached(total, targetCount) {
    const key = `${total}:${targetCount}`;
    const cached = sampledIndicesCache.get(key);
    if (cached) return cached;
    const built = getSampledIndices(total, targetCount);
    sampledIndicesCache.set(key, built);
    return built;
    }

    // Recreate event data points for the currently selected date (used for line + time labels)
    function rebuildEventMarkersForActiveDate() {
    // No-op for now: we draw all trips at once (not a single sampled trip).
    // But we DO rebuild tap markers to match the selected sampling density.
    if (eventsLoaded) buildTapMarkersFromTrips();
    if (placedPlane && allTrips.size > 0) addTripsToPlane();
    updatePointsLabel();
    }

    // Add markers as children of the plane (localX/localZ are in plane space)
    function addTripsToPlane() {
    if (!placedPlane || allTrips.size === 0) return;

    if (!placedPlane.userData.eventsGroup) {
        const eventsGroup = new THREE.Group();
        eventsGroup.name = "eventsGroup";
        eventsGroup.rotation.y = 0;
        placedPlane.add(eventsGroup);
        placedPlane.userData.eventsGroup = eventsGroup;
    }

    const eventsGroup = placedPlane.userData.eventsGroup;
    if (!eventsGroup) return;

    // Dispose and remove previous height-lines group
    const prevTimeLines = placedPlane.userData.timeLinesGroup;
    if (prevTimeLines) {
        prevTimeLines.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map && o.material.map.dispose) o.material.map.dispose();
                o.material.dispose();
            }
        });
        eventsGroup.remove(prevTimeLines);
        placedPlane.userData.timeLinesGroup = null;
    }

    // Keep a dedicated subgroup for trip lines so we can reuse geometry between filter changes.
    if (!placedPlane.userData.tripLinesGroup) {
        const tripLinesGroup = new THREE.Group();
        tripLinesGroup.name = "tripLinesGroup";
        eventsGroup.add(tripLinesGroup);
        placedPlane.userData.tripLinesGroup = tripLinesGroup;
    }
    const tripLinesGroup = placedPlane.userData.tripLinesGroup;

    // Persistent line objects keyed by trip id.
    if (!placedPlane.userData.tripLineEntries) {
        placedPlane.userData.tripLineEntries = new Map();
    }
    const tripLineEntries = placedPlane.userData.tripLineEntries;

    // All trips: draw each trip as a speed-colored Line2 (black when stopped, pink when moving),
    // and extend vertically based on travel time vs the longest trip (or absolute 20–21 clock).
    const lineWidth = 0.006;
    const shadowOffset = 0.004;
    const maxSpeedForColors = globalMaxSpeed > 0 ? globalMaxSpeed : 1;

    const perTripTarget = getPerTripSampleTarget();
    const activeTripIds = new Set();
    for (const [tripId, pts] of allTrips) {
        if (!pts || pts.length < 2) continue;
        activeTripIds.add(tripId);

        const linePoints = [];
        const pointColors = [];
        const filtered = [];
        for (const p of pts) {
            if (p?.tMs != null && !isWithinTimeWindow(p.tMs)) continue;
            filtered.push(p);
        }
        if (filtered.length < 2) continue;

        const indices = getSampledIndicesCached(filtered.length, Math.min(perTripTarget, filtered.length));
        for (const idx of indices) {
            const p = filtered[idx];
            const h = computeTripPointHeight(tripId, p);
            linePoints.push(new THREE.Vector3(p.localX, p.localZ, h));
            pointColors.push(getTripSpeedColor(p.speed_value ?? 0, maxSpeedForColors));
        }

        if (!renderer) continue;
        let entry = tripLineEntries.get(tripId);
        const canRender = linePoints.length >= 2;
        if (!canRender) {
        if (entry?.line) entry.line.visible = false;
        if (entry?.shadow) entry.shadow.visible = false;
        continue;
        }

        const shadowPoints = linePoints.map((p) => new THREE.Vector3(p.x, p.y, shadowOffset));
        const shadowColors = pointColors;
        if (!entry) {
        const line = createFatLinePathway(linePoints, pointColors, lineWidth, tripLinesGroup, renderer, {
            name: `tripLine_${tripId}`,
            renderOrder: 0
        });
        const shadow = createFatLinePathway(shadowPoints, shadowColors, lineWidth, tripLinesGroup, renderer, {
            name: `tripShadow_${tripId}`,
            renderOrder: -1
        });
        if (!line || !shadow) continue;
        line.userData.trip_id = tripId;
        shadow.userData.trip_id = tripId;
        entry = { line, shadow };
        tripLineEntries.set(tripId, entry);
        } else {
        updateFatLinePathway(entry.line, linePoints, pointColors);
        updateFatLinePathway(entry.shadow, shadowPoints, shadowColors);
        }
    }

    // Remove trips that are no longer present in current data.
    for (const [tripId, entry] of tripLineEntries) {
        if (activeTripIds.has(tripId)) continue;
        if (entry?.line) {
        tripLinesGroup.remove(entry.line);
        disposeLine2(entry.line);
        }
        if (entry?.shadow) {
        tripLinesGroup.remove(entry.shadow);
        disposeLine2(entry.shadow);
        }
        tripLineEntries.delete(tripId);
    }

    // Only timelines for first and last data point (start and end time)
    const heights = [];
    const timeLabels = [];

    const timeLinesGroup = new THREE.Group();
    timeLinesGroup.name = "timeLinesGroup";
    const contourRibbonWidth = 0.01; // thick line (5x for 2m map)
    const contourMaterial = new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide });

    const nHeights = heights.length;
    for (let i = 0; i < nHeights; i++) {
        const h = heights[i];
        const points = [
            new THREE.Vector3(-MAP_HALF_X, -MAP_HALF_Y, h),
            new THREE.Vector3(MAP_HALF_X, -MAP_HALF_Y, h),
            new THREE.Vector3(MAP_HALF_X, MAP_HALF_Y, h),
            new THREE.Vector3(-MAP_HALF_X, MAP_HALF_Y, h),
            new THREE.Vector3(-MAP_HALF_X, -MAP_HALF_Y, h)
        ];
        const ribbonGeom = createRibbonGeometry(points, contourRibbonWidth);
        if (ribbonGeom) {
            const ribbon = new THREE.Mesh(ribbonGeom, contourMaterial);
            timeLinesGroup.add(ribbon);
        }

        const timeStr = timeLabels[i] || "";
        if (!timeStr) continue;
        // create a canvas for the time label
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const w = 128;
        canvas.width = w;
        canvas.height = 48;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(0, 0, w, 48);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 24px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(timeStr, w / 2, 30);
        // create a texture from the canvas
        const tex = new THREE.CanvasTexture(canvas);
        // force texture update
        tex.needsUpdate = true;
        const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        // Back edge of map (y = MAP_HALF_Y) so labels don’t obstruct the view; spread horizontally
        const labelX = nHeights <= 1 ? 0 : -MAP_HALF_X + (i / (nHeights - 1)) * (2 * MAP_HALF_X);
        sprite.position.set(labelX, MAP_HALF_Y, h);
        sprite.scale.set(0.2, 0.1, 1); // 5x for 2m map
        timeLinesGroup.add(sprite);
    }
    // store a reference to the time lines group in placedPlane.userData
    placedPlane.userData.timeLinesGroup = timeLinesGroup;
    // make timeLinesGroup visible in the scene graph + moves with the plane
    eventsGroup.add(timeLinesGroup);
    applyGuideTimelinesVisibility();
    applyTripHighlight();
    }

    // Build a flat ribbon strip along points (for thick road lines)
    // Optional depth: extrude in Z for vertical thickness (e.g. trip line)
    // computeNormals: false saves memory/CPU when merging many roads (MeshBasicMaterial)
    function createRibbonGeometry(points, width, depth = 0, computeNormals = true) {
    if (!points || points.length < 2) return null;

    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const positions = [];
    const indices = [];
    const eps = 1e-6;
    let lastPerp = null; // reuse when segment is vertical (same lat/lon, different time)

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
        let perp = new THREE.Vector3(-dir.y, dir.x, 0).multiplyScalar(halfWidth);
        if (perp.length() < eps) {
        // Vertical segment (bus stopped: same location, different height) – use previous perp, no subdivision
        perp = lastPerp ? lastPerp.clone() : new THREE.Vector3(halfWidth, 0, 0);
        } else {
        lastPerp = perp.clone();
        }

        const v1 = new THREE.Vector3().addVectors(p1, perp);
        const v2 = new THREE.Vector3().subVectors(p1, perp);
        const v3 = new THREE.Vector3().addVectors(p2, perp);
        const v4 = new THREE.Vector3().subVectors(p2, perp);

        const baseIndex = positions.length / 3;

        if (depth > 0) {
        // Extruded ribbon: top and bottom faces, plus 4 sides
        const top = (v, z) => [v.x, v.y, v.z + z];
        const bot = (v, z) => [v.x, v.y, v.z - z];
        positions.push(
            ...top(v1, halfDepth), ...top(v2, halfDepth), ...top(v3, halfDepth), ...top(v4, halfDepth),
            ...bot(v1, halfDepth), ...bot(v2, halfDepth), ...bot(v3, halfDepth), ...bot(v4, halfDepth)
        );
        // Top, bottom, 4 sides (full box per segment)
        indices.push(
            baseIndex, baseIndex + 1, baseIndex + 2, baseIndex + 1, baseIndex + 3, baseIndex + 2,
            baseIndex + 4, baseIndex + 6, baseIndex + 5, baseIndex + 5, baseIndex + 6, baseIndex + 7,
            baseIndex, baseIndex + 4, baseIndex + 5, baseIndex, baseIndex + 5, baseIndex + 1,
            baseIndex + 1, baseIndex + 5, baseIndex + 6, baseIndex + 1, baseIndex + 6, baseIndex + 2,
            baseIndex + 2, baseIndex + 6, baseIndex + 7, baseIndex + 2, baseIndex + 7, baseIndex + 3,
            baseIndex + 3, baseIndex + 7, baseIndex + 4, baseIndex + 3, baseIndex + 4, baseIndex
        );
        } else {
        positions.push(
            v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z, v4.x, v4.y, v4.z
        );
        indices.push(
            baseIndex, baseIndex + 1, baseIndex + 2, baseIndex + 1, baseIndex + 3, baseIndex + 2
        );
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    if (computeNormals) geometry.computeVertexNormals();
    return geometry;
    }

    function geometryToRoadLineStrings(geometry) {
    if (!geometry?.coordinates) return [];
    if (geometry.type === "LineString") return [geometry.coordinates];
    if (geometry.type === "MultiLineString") return geometry.coordinates;
    return [];
    }

    /** GeoJSON: EPSG:3006 = easting/northing (m); WGS84/4326/CRS84 = [lon, lat] degrees */
    function detectRoadsGeoCrs(geojson) {
    const urn = geojson.crs?.properties?.name || "";
    if (/EPSG::?4326\b/i.test(urn) || /CRS84/i.test(urn) || /WGS\s*84/i.test(urn)) return "CRS84";
    if (/EPSG::?3006\b/i.test(urn)) return "EPSG:3006";

    const f = geojson.features?.find((x) => geometryToRoadLineStrings(x.geometry).length);
    const lines = f ? geometryToRoadLineStrings(f.geometry) : [];
    const pt = lines[0]?.[0];
    if (!pt || pt.length < 2) return "CRS84";
    const a = Math.abs(pt[0]);
    const b = Math.abs(pt[1]);
    if (a > 1e5 && a < 2e6 && b > 5e6 && b < 8e6) return "EPSG:3006";
    return "CRS84";
    }

    function roadCoordToPlaneXZ(coord, crs) {
    if (crs === "EPSG:3006") {
        const [easting, northing] = coord;
        return projectSwerefToMapSurface(easting, northing);
    }
    const lon = coord[0];
    const lat = coord[1];
    return projectToMapSurface(lat, lon);
    }

    // Load roads GeoJSON once and build ribbon meshes in plane local space
    async function loadRoads() {
    if (roadsLoaded) return;

    try {
        const response = await fetch(ROADS_GEOJSON_URL);
        if (!response.ok) {
        console.error("Failed to fetch roads:", response.status, response.statusText);
        return;
        }
        const geojson = await response.json();

        if (!geojson.features || !Array.isArray(geojson.features)) {
        console.error("Invalid GeoJSON structure");
        return;
        }

        const crs = detectRoadsGeoCrs(geojson);
        console.log("Roads GeoJSON CRS mode:", crs);

        const roadGeometries = [];
        let roadCount = 0;

        for (const feature of geojson.features) {
        const lineStrings = geometryToRoadLineStrings(feature.geometry);
        if (lineStrings.length === 0) continue;

        for (const lineString of lineStrings) {
            if (!Array.isArray(lineString) || lineString.length < 2) continue;

            const projectedPoints = [];

            for (const coord of lineString) {
            const [x, z] = roadCoordToPlaneXZ(coord, crs);
            if (isNaN(x) || isNaN(z)) continue;

            projectedPoints.push(new THREE.Vector3(x, z, 0));
            }

            if (projectedPoints.length < 2) continue;

            const geometry = createRibbonGeometry(projectedPoints, 0.0025, 0, false);
            if (!geometry) continue;

            roadGeometries.push(geometry);
            roadCount++;
        }
        }

        roadMeshes.length = 0;

        if (roadGeometries.length > 0) {
        const merged = mergeGeometries(roadGeometries);
        for (const g of roadGeometries) g.dispose();
        if (merged) {
            merged.computeBoundingSphere();
            const roadMaterial = new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
            });
            const roadMesh = new THREE.Mesh(merged, roadMaterial);
            roadMesh.userData = { isRoad: true, mergedRoads: true };
            roadMeshes.push(roadMesh);
        } else {
            console.error("Road merge failed; disposed segment geometries");
        }
        }

        roadsLoaded = true;
        console.log(`Loaded ${roadCount} road segments → ${roadMeshes.length} mesh(es)`);
    } catch (err) {
        console.error("Failed to load roads:", err);
    }
    }

    // Add road meshes as children of the plane
    function addRoadsToPlane() {
    if (!placedPlane || roadMeshes.length === 0) return;

    if (!placedPlane.userData.roadsGroup) {
        const roadsGroup = new THREE.Group();
        roadsGroup.name = "roadsGroup";
        roadsGroup.rotation.y = 0;
        placedPlane.add(roadsGroup);

        for (const road of roadMeshes) {
        road.position.set(0, 0, 0);
        roadsGroup.add(road);
        }

        placedPlane.userData.roadsGroup = roadsGroup;
    }
    applyRoadsVisibility();
    }

    // Visibility toggles: map surface, guide timelines, roads
    if (toggleMapSurfaceBtn) {
        toggleMapSurfaceBtn.addEventListener("click", () => {
            blockNextSelect = true;
            showMapSurface = !showMapSurface;
            applyMapSurfaceVisibility();
            toggleMapSurfaceBtn.classList.toggle("off", !showMapSurface);
        });
    }
    if (toggleGuideTimelinesBtn) {
        toggleGuideTimelinesBtn.addEventListener("click", () => {
            blockNextSelect = true;
            showGuideTimelines = !showGuideTimelines;
            applyGuideTimelinesVisibility();
            toggleGuideTimelinesBtn.classList.toggle("off", !showGuideTimelines);
        });
    }
    if (toggleRoadsBtn) {
        toggleRoadsBtn.addEventListener("click", () => {
            blockNextSelect = true;
            showRoads = !showRoads;
            applyRoadsVisibility();
            toggleRoadsBtn.classList.toggle("off", !showRoads);
        });
    }
    if (toggleHeightModeBtn) {
        toggleHeightModeBtn.addEventListener("click", () => {
            blockNextSelect = true;
            heightMode = heightMode === "clock" ? "trip" : "clock";
            applyHeightModeButton();
            if (allTrips.size > 0) addTripsToPlane();
            if (eventsLoaded) buildTapMarkersFromTrips();
        });
    }

    // Time window UI (20:00–21:00)
    if (timeWindowFilterEl) timeWindowFilterEl.style.display = "none";
    if (timeWindowStartEl) timeWindowStartEl.value = String(timeWindowStartMin);
    if (timeWindowEndEl) timeWindowEndEl.value = String(timeWindowEndMin);
    applyTimeWindowLabels();

    function applyTimeWindowFromInputs() {
    const s = timeWindowStartEl ? Number(timeWindowStartEl.value) : timeWindowStartMin;
    const e = timeWindowEndEl ? Number(timeWindowEndEl.value) : timeWindowEndMin;
    const nextStartMin = Math.max(0, Math.min(60, Math.min(s, e)));
    const nextEndMin = Math.max(0, Math.min(60, Math.max(s, e)));
    const changed = nextStartMin !== timeWindowStartMin || nextEndMin !== timeWindowEndMin;
    timeWindowStartMin = nextStartMin;
    timeWindowEndMin = nextEndMin;
    if (timeWindowStartEl) timeWindowStartEl.value = String(timeWindowStartMin);
    if (timeWindowEndEl) timeWindowEndEl.value = String(timeWindowEndMin);
    applyTimeWindowLabels();
    return changed;
    }

    let timeWindowRebuildTimer = null;
    const TIME_WINDOW_REBUILD_DEBOUNCE_MS = 80;
    function scheduleTimeWindowRebuild(forceImmediate = false) {
    if (timeWindowRebuildTimer) {
        clearTimeout(timeWindowRebuildTimer);
        timeWindowRebuildTimer = null;
    }
    const runRebuild = () => {
        if (allTrips.size > 0) addTripsToPlane();
        if (eventsLoaded) buildTapMarkersFromTrips();
    };
    if (forceImmediate) {
        runRebuild();
        return;
    }
    timeWindowRebuildTimer = setTimeout(runRebuild, TIME_WINDOW_REBUILD_DEBOUNCE_MS);
    }

    if (timeWindowStartEl) {
    ["input", "change"].forEach((evt) => timeWindowStartEl.addEventListener(evt, () => {
        blockNextSelect = true;
        const changed = applyTimeWindowFromInputs();
        if (changed) scheduleTimeWindowRebuild(evt === "change");
    }));
    ["pointerdown", "mousedown", "touchstart"].forEach((evt) => timeWindowStartEl.addEventListener(evt, () => { blockNextSelect = true; }));
    }
    if (timeWindowEndEl) {
    ["input", "change"].forEach((evt) => timeWindowEndEl.addEventListener(evt, () => {
        blockNextSelect = true;
        const changed = applyTimeWindowFromInputs();
        if (changed) scheduleTimeWindowRebuild(evt === "change");
    }));
    ["pointerdown", "mousedown", "touchstart"].forEach((evt) => timeWindowEndEl.addEventListener(evt, () => { blockNextSelect = true; }));
    }

    // Placement mode toggle
    placementToggleButton.addEventListener("click", () => {
    blockNextSelect = true;
    setPlacementMode(!placementMode);
    });

    enterARButton.addEventListener("click", () => {
    startAR().catch((err) => {
        console.error(err);
        alert("Failed to start AR: " + err.message);
    });
    });

    function updatePointsLabel() {
    const labelEl = document.getElementById("event-date-label");
    if (!labelEl) return;
    const count = pointsOptions[pointsToShowIndex] ?? pointsOptions[pointsOptions.length - 1];
    const total = allEvents.length;
    labelEl.textContent = total ? `${count} / ${total} pts` : "—";
    }

    function populatePointsFilter() {
    const filterEl = document.getElementById("event-date-filter");
    if (filterEl) filterEl.style.display = "none";
    applyOverlayUiVisibility();
    updatePointsLabel();
    }

    const eventDatePrev = document.getElementById("event-date-prev");
    const eventDateNext = document.getElementById("event-date-next");
    const eventDateLabel = document.getElementById("event-date-label");

    const dateUiElements = [eventDatePrev, eventDateNext, eventDateLabel].filter(Boolean);
    dateUiElements.forEach((el) => {
    ["pointerdown", "mousedown", "touchstart", "click"].forEach((evt) => {
        el.addEventListener(evt, () => { blockNextSelect = true; });
    });
    });

    // Prev/next points count (rebuild markers with more/fewer points)
    function changePointsCount(direction) {
    pointsToShowIndex = (pointsToShowIndex + direction + pointsOptions.length) % pointsOptions.length;
    updatePointsLabel();
    rebuildEventMarkersForActiveDate();
    }

    if (eventDatePrev) {
    eventDatePrev.addEventListener("click", () => {
        blockNextSelect = true;
        changePointsCount(-1);
    });
    }

    if (eventDateNext) {
    eventDateNext.addEventListener("click", () => {
        blockNextSelect = true;
        changePointsCount(1);
    });
    }
})();
